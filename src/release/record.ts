// `releases record` from git and GitHub (the options of @usesequential/release-cli): --range reads commit trailers from a
// local git log; --github-changes reads the merged pull requests and the findings they close from the GitHub API. The
// flags are checked before anything runs (planRelease); then the reads (gatherRelease). A GitHub failure never stops
// the release: the marker is what the before/after measurement needs, so it is recorded without what GitHub would add.
import { UsageError } from '../errors';
import { oneLine } from '../text';
import { findingScope, type FindingScope } from './findings';
import { findingIdsFromLog } from './trailers';
import { githubContext, GitHubError, releaseChanges, SHA_RE, type GetOptions, type GitHubFetch, type ReleaseChange } from './github';

/** `<40 or 64 zeros>..<head>` (or `...`): git's null object id as the base of a range. */
const ZERO_BASE_RE = /^(?:0{40}|0{64})\.\.\.?(.*)$/;

export interface ReleaseFlags {
    version?: string;
    commitSha?: string;
    range?: string;
    githubChanges: boolean;
    base?: string;
    projectKey?: string;
    findings?: string;
}

export interface ReleasePlan {
    scope: FindingScope;
    /** git's arguments for --range (one argv element each, never a shell string). */
    gitArgs?: string[];
    /** --github-changes: the deployed commit and the base (auto, or a sha). */
    github?: { head: string; base: string };
}

/** The old CLI's checks, in its order, before any request or git run. Throws UsageError. */
export function planRelease(r: ReleaseFlags): ReleasePlan {
    if (!r.version) throw new UsageError('--version is required');
    const s = findingScope({ projectKey: r.projectKey, findings: r.findings });
    if (!s.ok) throw new UsageError(s.message);
    if (r.githubChanges && r.range !== undefined) throw new UsageError('--range and --github-changes both name the commits: use one.');
    if (r.base !== undefined && !r.githubChanges) throw new UsageError('--base needs --github-changes.');
    if (r.githubChanges && (r.commitSha === undefined || !SHA_RE.test(r.commitSha))) throw new UsageError('--github-changes needs --commit-sha: the deployed commit (7-40 hex characters).');
    const base = r.base === undefined ? 'auto' : r.base;
    if (base !== 'auto' && !SHA_RE.test(base)) throw new UsageError('--base: auto, or a commit sha (7-40 hex characters).');
    const plan: ReleasePlan = { scope: s.value };
    if (r.range !== undefined) {
        const notRange = new UsageError(`--range must be a git revision range, not an option: ${r.range}`);
        if (r.range.startsWith('-')) throw notRange;
        // An all-zero base (git's "no previous commit": a first push, or github.event.before on a tag push) is not a
        // revision git can read. Treat it as "no previous" and read only the head commit's message.
        const noPrevious = ZERO_BASE_RE.exec(r.range);
        const head = noPrevious ? noPrevious[1] || 'HEAD' : null;
        if (head !== null && head.startsWith('-')) throw notRange;
        plan.gitArgs = head !== null ? ['log', '-1', '--format=%B', head] : ['log', '--format=%B', r.range];
    }
    if (r.githubChanges) plan.github = { head: r.commitSha!, base };
    return plan;
}

export interface ReleaseIo {
    fetch: GitHubFetch;
    err: (line: string) => void;
    /** `git <args>`'s stdout (child_process.execFileSync in the bin). */
    git?: (args: readonly string[]) => string;
    /** GITHUB_EVENT_PATH's text. */
    readFile?: (path: string) => string;
}

export interface Gathered {
    /** Ids from trailers or pull request text; undefined when nothing was read. */
    findingIds?: string[];
    changes?: ReleaseChange[];
    /** The success line's tail: "; 2 changes since abc1234", or ''. */
    note: string;
}

const FALLBACK = 'the release is recorded without changes or case ids from GitHub.';

/** Runs git (--range) or reads GitHub (--github-changes). A git failure is a UsageError; a GitHub failure one stderr line. */
export async function gatherRelease(plan: ReleasePlan, io: ReleaseIo, env: Record<string, string | undefined>, opts: GetOptions = {}): Promise<Gathered> {
    if (plan.gitArgs) {
        if (!io.git) throw new UsageError('--range: git cannot be run here');
        let log: string;
        try {
            log = io.git(plan.gitArgs);
        } catch (e) {
            throw new UsageError(`git log failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { findingIds: findingIdsFromLog(String(log), plan.scope), note: '' };
    }
    if (!plan.github) return { note: '' };
    const { head, base } = plan.github;
    const ctx = githubContext(env, io.readFile ?? (() => { throw new Error('no event file'); }));
    if (!ctx.ok) {
        io.err(oneLine(`GitHub: ${ctx.message}; ${FALLBACK}`));
        return { note: '' };
    }
    try {
        const read = await releaseChanges(ctx.value, { head, base, scope: plan.scope }, io.fetch, opts);
        const n = read.changes.length;
        const word = n === 1 ? 'change' : 'changes';
        const note = read.base === null ? `; ${n} ${word} from ${head.slice(0, 7)} alone (no earlier release found)` : `; ${n} ${word} since ${read.base.slice(0, 7)}`;
        return { findingIds: read.findingIds, changes: read.changes, note };
    } catch (e) {
        // Ctrl-C: nothing will be recorded, so the fallback line ("the release is recorded without …") would be untrue.
        // The caller sees the abort and answers "Cancelled." alone.
        if (opts.signal?.aborted) return { note: '' };
        const what = e instanceof GitHubError ? e.message : 'request failed';
        io.err(oneLine(`GitHub: could not ${what}; ${FALLBACK}`));
        return { note: '' };
    }
}

/** The old CLI's success line: `Recorded release <v> (<n cases: …|no cases named><note>)`. */
export function successLine(version: string, ids: readonly string[], note: string): string {
    const summary = ids.length === 0 ? 'no cases named' : `${ids.length} ${ids.length === 1 ? 'case' : 'cases'}: ${ids.join(', ')}`;
    return oneLine(`Recorded release ${version} (${summary}${note})`);
}
