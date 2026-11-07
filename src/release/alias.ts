// `sequential-release`: the old @usesequential/release-cli command, a line-for-line port of its 0.2.1 (cli/src/cli.cjs
// and cli/src/release.cjs), so every workflow that ran 0.2.1 runs this the same way. test/release-golden.test.ts runs
// dist/release-bin.js against the 95 cases recorded from 0.2.1 and requires the same stdout, stderr, exit code, GitHub
// requests and Sequential request (POST <host>/api/releases). It does NOT share `sequential releases record`'s path:
// - the token from SEQUENTIAL_RELEASES_TOKEN only (never SEQUENTIAL_TOKEN), checked for presence only;
// - the API from --host, else SEQUENTIAL_API_URL, else https://api.usesequential.com; https, http only for localhost and
//   127.0.0.1; a trailing slash is dropped and a path is kept;
// - each flag takes the next word whatever it is, a repeated flag keeps its last value, `--flag=value` and any other
//   option are "Unknown option" with the usage;
// - POST /api/releases with a JSON body that leaves out empty values; a redirect is never followed;
// - exit 0 or 1.
// The one request difference from 0.2.1: the user-agent header is sequential-cli/<version> (0.2.1 sent Node's default).
// What it prints never holds SEQUENTIAL_RELEASES_TOKEN or GITHUB_TOKEN (a server or fetch message that quoted one would
// show [token] there); no recorded case prints either, so no line differs from 0.2.1.
import { findingScope } from './findings';
import { findingIdsFromLog } from './trailers';
import { githubContext, releaseChanges, type LegacyChange, type LegacyFetch } from './legacy-github';
import { VERSION } from '../version';

/** `<40 or 64 zeros>..<head>` (or `...`): git's null object id as the base of a range. */
const ZERO_BASE_RE = /^(?:0{40}|0{64})\.\.\.?(.*)$/;

export const USAGE = 'Usage: sequential-release --version <v> [--environment <e>] [--commit-sha <sha>] [--released-at <iso>] [--title <t>]\n'
    + '  [--range <prev..HEAD> | --github-changes [--base auto|<sha>]] [--project-key <key>] [--findings all|qualified] [--host <url>]';
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Sequential's hosted API. SEQUENTIAL_API_URL overrides it for a self-hosted deployment. */
export const DEFAULT_API_URL = 'https://api.usesequential.com';
const RELEASES_PATH = '/api/releases';

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the alias needs from its process (bin/sequential-release.cjs's deps in 0.2.1). `stdout`/`stderr` get raw text
 *  with its newlines. */
export interface AliasDeps {
    fetchImpl: LegacyFetch;
    execGit: (args: string[]) => string;
    readFile?: (path: string) => string;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
}

/** Strips a trailing slash and refuses a non-https URL unless the host is localhost or 127.0.0.1: the API URL carries a
 *  bearer secret in every request it is used for. */
export function normalizeApiUrl(raw: string): Checked<string> {
    const stripped = raw.replace(/\/+$/, '');
    let parsed: URL;
    try {
        parsed = new URL(stripped);
    } catch {
        return { ok: false, message: `The API URL (--host or SEQUENTIAL_API_URL) is not a valid URL: ${raw}` };
    }
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocal) {
        return {
            ok: false,
            message: 'The API URL (--host or SEQUENTIAL_API_URL) must be https (localhost and 127.0.0.1 excepted) — the token it carries is a bearer secret.',
        };
    }
    return { ok: true, value: stripped };
}

// 0.2.1 looked flags up in plain objects; so does this port (the same answer for every word, inherited names included).
const FLAGS: Record<string, any> = {
    '--version': 'version', '--environment': 'environment', '--commit-sha': 'sha', '--sha': 'sha', '--range': 'range', '--released-at': 'releasedAt',
    '--host': 'host',
    '--title': 'title', '--base': 'base', '--project-key': 'projectKey', '--findings': 'findings',
};
/** Flags that take no value. */
const SWITCHES: Record<string, any> = { '--github-changes': 'githubChanges' };

/** argv after the command: `--flag value` pairs and `--github-changes`. */
export function parseReleaseArgs(argv: readonly string[]): Checked<Record<string, any>> {
    const args: Record<string, any> = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (SWITCHES[flag]) {
            args[SWITCHES[flag]] = 'true';
            continue;
        }
        const key = FLAGS[flag];
        if (!key) return { ok: false, message: `Unknown option: ${flag}\n${USAGE}` };
        const value = argv[i + 1];
        if (value === undefined) return { ok: false, message: `${flag} needs a value.\n${USAGE}` };
        args[key] = value;
        i += 1;
    }
    return { ok: true, value: args };
}

interface PostArgs {
    apiUrl: string;
    token: string;
    version: string;
    environment?: string;
    commitSha?: string;
    findingIds?: string[];
    releasedAt?: string;
    title?: string;
    changes?: LegacyChange[];
    fetchImpl: LegacyFetch;
}

/** POST /api/releases. Empty values are left out; the server checks every field. */
async function postRelease({ apiUrl, token, version, environment, commitSha, findingIds, releasedAt, title, changes, fetchImpl }: PostArgs): Promise<{ status: number; body: unknown }> {
    const body: Record<string, unknown> = { version };
    if (environment) body.environment = environment;
    if (commitSha) body.commit_sha = commitSha;
    if (findingIds && findingIds.length > 0) body.finding_ids = findingIds;
    if (releasedAt) body.released_at = releasedAt;
    if (title) body.title = title;
    if (changes && changes.length > 0) body.changes = changes;

    const res = await fetchImpl(`${apiUrl}${RELEASES_PATH}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': `sequential-cli/${VERSION}`,
        },
        body: JSON.stringify(body),
        // Never follow a redirect: the bearer token must not be replayed toward another location. A redirect is a failed
        // request.
        redirect: 'error',
    });

    let parsedBody: unknown;
    try {
        parsedBody = await res.json();
    } catch {
        parsedBody = undefined;
    }
    return { status: res.status, body: parsedBody };
}

const errMessage = (err: unknown): unknown => (err as { message?: unknown } | null | undefined)?.message;

/** 0.2.1's runRelease: the exit code, 0 or 1. */
export async function runRelease(argv: readonly string[], env: Record<string, string | undefined>, deps: AliasDeps): Promise<0 | 1> {
    const { fetchImpl, execGit, stdout, stderr } = deps;
    const readFile = deps.readFile || (() => { throw new Error('no event file'); });

    const token = env.SEQUENTIAL_RELEASES_TOKEN;
    if (!token) {
        stderr.write('SEQUENTIAL_RELEASES_TOKEN is required: a project access token (sq_pat_…) with the releases:write scope, made for one project.\n');
        return 1;
    }

    const parsedArgs = parseReleaseArgs(argv);
    if (!parsedArgs.ok) {
        stderr.write(`${parsedArgs.message}\n`);
        return 1;
    }
    const args = parsedArgs.value;

    // --host, else SEQUENTIAL_API_URL; unset or empty (the Action's api-url left out): the hosted API.
    const rawApiUrl: string = args.host || env.SEQUENTIAL_API_URL || DEFAULT_API_URL;
    const apiUrlResult = normalizeApiUrl(rawApiUrl);
    if (!apiUrlResult.ok) {
        stderr.write(`${apiUrlResult.message}\n`);
        return 1;
    }

    if (!args.version) {
        stderr.write(`--version is required.\n${USAGE}\n`);
        return 1;
    }

    const scopeResult = findingScope({ projectKey: args.projectKey, findings: args.findings });
    if (!scopeResult.ok) {
        stderr.write(`${scopeResult.message}\n`);
        return 1;
    }
    const scope = scopeResult.value;
    if (args.githubChanges && args.range !== undefined) {
        stderr.write('--range and --github-changes both name the commits: use one.\n');
        return 1;
    }
    if (args.base !== undefined && !args.githubChanges) {
        stderr.write('--base needs --github-changes.\n');
        return 1;
    }
    if (args.githubChanges && (args.sha === undefined || !SHA_RE.test(args.sha))) {
        stderr.write('--github-changes needs --commit-sha: the deployed commit (7-40 hex characters).\n');
        return 1;
    }
    const base: string = args.base === undefined ? 'auto' : args.base;
    if (base !== 'auto' && !SHA_RE.test(base)) {
        stderr.write('--base: auto, or a commit sha (7-40 hex characters).\n');
        return 1;
    }

    if (args.range !== undefined && args.range.startsWith('-')) {
        stderr.write(`--range must be a git revision range, not an option: ${args.range}\n`);
        return 1;
    }

    let findingIds: string[] | undefined;
    if (args.range !== undefined) {
        // An all-zero base (git's "no previous commit": a first push, or github.event.before on a tag push) is not a
        // revision git can read. Treat it as "no previous" and read only the head commit's message.
        const noPrevious = ZERO_BASE_RE.exec(args.range);
        const head = noPrevious ? (noPrevious[1] || 'HEAD') : null;
        if (head !== null && head.startsWith('-')) {
            stderr.write(`--range must be a git revision range, not an option: ${args.range}\n`);
            return 1;
        }
        let log: string;
        try {
            log = execGit(head !== null ? ['log', '-1', '--format=%B', head] : ['log', '--format=%B', args.range]);
        } catch (err) {
            stderr.write(`git log failed: ${errMessage(err)}\n`);
            return 1;
        }
        findingIds = findingIdsFromLog(log, scope);
    }

    // --github-changes: the merged pull requests and the findings they close, from the GitHub API. A GitHub failure
    // never stops the release: the marker is what the before/after measurement needs, so it is recorded without them.
    let changes: LegacyChange[] | undefined;
    let changesNote = '';
    if (args.githubChanges) {
        const ctx = githubContext(env, readFile);
        if (!ctx.ok) {
            stderr.write(`GitHub: ${ctx.message}; the release is recorded without changes or finding ids from GitHub.\n`);
        } else {
            try {
                const read = await releaseChanges(ctx.value, { head: args.sha, base, scope }, fetchImpl);
                changes = read.changes;
                findingIds = read.findingIds;
                changesNote = read.base === null
                    ? `; ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from ${args.sha.slice(0, 7)} alone (no earlier release found)`
                    : `; ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} since ${read.base.slice(0, 7)}`;
            } catch (err) {
                const what = err && (err as { name?: unknown }).name === 'GitHubError' ? errMessage(err) : 'request failed';
                stderr.write(`GitHub: could not ${what}; the release is recorded without changes or finding ids from GitHub.\n`);
            }
        }
    }

    let response: { status: number; body: unknown };
    try {
        response = await postRelease({
            apiUrl: apiUrlResult.value,
            token,
            version: args.version,
            environment: args.environment,
            commitSha: args.sha,
            findingIds,
            releasedAt: args.releasedAt,
            title: args.title,
            changes,
            fetchImpl,
        });
    } catch (err) {
        stderr.write(`${errMessage(err)}\n`);
        return 1;
    }

    if (response.status < 200 || response.status >= 300) {
        const body = response.body as Record<string, unknown> | null | undefined;
        const message = (body && typeof body === 'object' && (body.message || body.error)) || `HTTP ${response.status}`;
        stderr.write(`${message}\n`);
        return 1;
    }

    const ids = findingIds || [];
    const summary = ids.length === 0 ? 'no findings named' : `${ids.length} ${ids.length === 1 ? 'finding' : 'findings'}: ${ids.join(', ')}`;
    stdout.write(`Recorded release ${args.version} (${summary}${changesNote})\n`);
    return 0;
}

/** Shorter than this, a value is not hidden from the printed lines (it would hide ordinary words). */
const MIN_HIDDEN = 8;

/** A writer that shows `[token]` wherever one of `secrets` would be printed. */
function hiding(w: { write(s: string): void }, secrets: readonly string[]): { write(s: string): void } {
    if (secrets.length === 0) return w;
    return { write: (s: string) => w.write(secrets.reduce((acc, t) => acc.split(t).join('[token]'), String(s))) };
}

/** The `sequential-release` command: runRelease, with neither token ever printed. */
export async function runReleaseAlias(argv: readonly string[], env: Record<string, string | undefined>, deps: AliasDeps): Promise<0 | 1> {
    const secrets = [env.SEQUENTIAL_RELEASES_TOKEN, env.GITHUB_TOKEN]
        .filter((t): t is string => typeof t === 'string' && t.length >= MIN_HIDDEN)
        .sort((a, b) => b.length - a.length);
    return runRelease(argv, env, { ...deps, stdout: hiding(deps.stdout, secrets), stderr: hiding(deps.stderr, secrets) });
}
