// `sequential-release`: the old @usesequential/release-cli's bin, kept so its workflows run unchanged. It maps its flags
// onto `sequential releases record` and runs the same path (cli.ts runNamed), with the old contract:
// - the token from SEQUENTIAL_RELEASES_TOKEN only (never SEQUENTIAL_TOKEN, the changes token);
// - the host from --host (anywhere in the line), else SEQUENTIAL_API_URL; https, or http only to this machine;
// - --sha is --commit-sha; no project is read from SEQUENTIAL_PROJECT or .sequential.json (--project only);
// - exit 0 or 1, usage mistakes included; on success the old line only.
import { runNamed, namedTimeout, tokenNamed, type Io } from '../cli';
import { parseCurated } from '../curated';
import { UsageError } from '../errors';
import { oneLine } from '../text';
import { apiHost, DEFAULT_HOST } from '../transport';

export const ALIAS_USAGE = `Usage: sequential-release --version <v> [--environment <e>] [--commit-sha <sha>] [--released-at <iso>] [--title <t>]
  [--range <prev..HEAD> | --github-changes [--base auto|<sha>]] [--project-key <key>] [--findings all|qualified] [--host <url>]

The same as \`sequential releases record\` (see sequential help releases record), with the token from
SEQUENTIAL_RELEASES_TOKEN only and the API from --host or SEQUENTIAL_API_URL. --sha is --commit-sha. Exit 0 or 1.`;

const NO_TOKEN = 'SEQUENTIAL_RELEASES_TOKEN is required: a project access token (sq_pat_…) with the releases:write scope, made for one project.';

/** --host out of the line (the old CLI took it anywhere), --sha renamed. */
function mapArgs(argv: readonly string[]): { host?: string; rest: string[] } {
    let host: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--host' || a.startsWith('--host=')) {
            if (host !== undefined) throw new UsageError('--host is given twice');
            if (a === '--host') {
                if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new UsageError('--host needs a URL');
                host = argv[++i];
            } else host = a.slice(7);
            continue;
        }
        if (a === '--sha') rest.push('--commit-sha');
        else if (a.startsWith('--sha=')) rest.push(`--commit-sha=${a.slice(6)}`);
        else rest.push(a);
    }
    return { host, rest };
}

export async function runReleaseAlias(argv: readonly string[], env: Record<string, string | undefined>, io: Io): Promise<0 | 1> {
    try {
        const { host: hostFlag, rest } = mapArgs(argv);
        const f = parseCurated('releases record', rest);
        if (f.has('help')) {
            io.out(ALIAS_USAGE);
            return 0;
        }
        const dry = f.has('dry-run');
        if (!dry && !env.SEQUENTIAL_RELEASES_TOKEN?.trim()) {
            io.err(NO_TOKEN);
            return 1;
        }
        const tok = dry ? undefined : tokenNamed(env, ['SEQUENTIAL_RELEASES_TOKEN'], 'releases:write');
        let host: string;
        try {
            // Unset or empty (the Action's api-url left out): the hosted API.
            host = apiHost(hostFlag || env.SEQUENTIAL_API_URL || undefined);
        } catch (e) {
            throw new UsageError((e as Error).message.replace(/^--host /, 'The API URL (--host or SEQUENTIAL_API_URL) '));
        }
        if (!dry && host !== DEFAULT_HOST) io.err(`sequential: sending the token to ${host}, not ${DEFAULT_HOST}`);
        const timeoutMs = namedTimeout(f);
        const project = f.get('project')?.[0];
        const code = await runNamed('releases record', f, { host, tok, chosen: { project, warnings: [] }, timeoutMs, legacy: true }, env, io);
        return code === 0 ? 0 : 1;
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(`sequential: ${oneLine(e.message)} (see sequential-release --help)`);
            return 1;
        }
        io.err('sequential: an unexpected error');
        return 1;
    }
}
