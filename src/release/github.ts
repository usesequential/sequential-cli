// What a release changed, read from the GitHub API with the workflow's own GITHUB_TOKEN, so a deploy that GitHub Actions
// does not run (Vercel's Git integration: the workflow runs on `deployment_status`) still names its merged pull requests
// and the findings they close. No checkout and no fetch-depth are needed. Ported from @usesequential/release-cli.
//
// The calls, all GETs (the workflow needs `deployments: read`, `contents: read` and `pull-requests: read`):
// 1. base (the previous release's commit): with a deployment event, the newest earlier deployment in the SAME GitHub
//    environment whose newest status is success; with a push event, the event's `before`; otherwise none.
// 2. GET /repos/{repo}/compare/{base}...{head}: the commits between them (GitHub lists at most 250). With no base, only
//    the head commit (GET /repos/{repo}/commits/{head}).
// 3. GET /repos/{repo}/commits/{sha}/pulls for each commit, newest first (at most MAX_COMMITS_READ): the merged pull
//    requests, each once, at most MAX_CHANGES (the server's cap).
// Every value that goes into a URL is checked first (the repo's owner/name shape, hex shas, a numeric deployment id).
// Every GET uses the fetch it is given (never a global), never follows a redirect, and is read under the CLI's size cap.
import { addIds, findingIdsFromPrText, MAX_FINDING_IDS, type FindingScope, type Checked } from './findings';
import { findingIdsFromLog } from './trailers';
import { DEFAULT_TIMEOUT_MS, readCapped } from '../transport';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/i;
const ZERO_SHA_RE = /^0+$/;
/** Deployments read when looking for the previous successful one (one page, newest first). */
export const DEPLOYMENTS_READ = 30;
/** Commits whose pull requests are read, newest first: a release with more names only its newest ones' PRs. */
export const MAX_COMMITS_READ = 100;
/** The server's cap on changes (BE src/releases/human.ts CHANGES_MAX; contract.json changes_max). */
export const MAX_CHANGES = 50;

/** The GET this module makes. The CLI's injected fetch has this shape too. */
export interface GitHubFetch {
    (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }): Promise<{
        status: number;
        text(): Promise<string>;
        headers?: { get(name: string): string | null };
        body?: ReadableStream<Uint8Array> | null;
    }>;
}

export interface GitHubContext {
    apiUrl: string;
    repo: string;
    token: string;
    event: Record<string, any> | null;
}

/** Per request: the wait (default the CLI's 120 s) and Ctrl-C. */
export interface GetOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface ReleaseChange {
    title: string;
    url: string;
    number: number;
}

export class GitHubError extends Error {
    readonly status: number;
    constructor(what: string, status: number) {
        super(`${what} (HTTP ${status})`);
        this.name = 'GitHubError';
        this.status = status;
    }
}

/** The GitHub context from the Actions environment, or a reason it cannot be read. */
export function githubContext(env: Record<string, string | undefined>, readFile: (path: string) => string): Checked<GitHubContext> {
    const token = env.GITHUB_TOKEN;
    if (!token) return { ok: false, message: 'GITHUB_TOKEN is not set: pass it to the step (env: GITHUB_TOKEN: ${{ github.token }})' };
    const repo = env.GITHUB_REPOSITORY || '';
    if (!REPO_RE.test(repo)) return { ok: false, message: 'GITHUB_REPOSITORY is not set to owner/name' };
    const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        return { ok: false, message: 'GITHUB_API_URL is not a valid URL' };
    }
    if (parsed.protocol !== 'https:') return { ok: false, message: 'GITHUB_API_URL must be https: GITHUB_TOKEN travels on every request' };
    let event: GitHubContext['event'] = null;
    if (env.GITHUB_EVENT_PATH) {
        try {
            const v: unknown = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
            event = v !== null && typeof v === 'object' ? (v as GitHubContext['event']) : null;
        } catch {
            event = null; // no event payload: no base from it
        }
    }
    return { ok: true, value: { apiUrl, repo, token, event } };
}

/** One GET. Never follows a redirect (the token must not travel elsewhere); a non-2xx is a GitHubError. */
async function ghGet(ctx: GitHubContext, path: string, what: string, fetchImpl: GitHubFetch, opts: GetOptions): Promise<any> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetchImpl(`${ctx.apiUrl}/repos/${ctx.repo}${path}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
            redirect: 'error',
            signal: ctl.signal,
        });
        if (res.status < 200 || res.status >= 300) throw new GitHubError(what, res.status);
        const text = await readCapped(res, ctl);
        if (text === null) throw new Error('too large');
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

/** The previous release's commit, or null when there is none to compare with. */
export async function findBase(ctx: GitHubContext, head: string, fetchImpl: GitHubFetch, opts: GetOptions = {}): Promise<string | null> {
    const deployment = ctx.event && ctx.event.deployment;
    if (deployment && typeof deployment.environment === 'string' && Number.isSafeInteger(deployment.id)) {
        const list = await ghGet(ctx, `/deployments?environment=${encodeURIComponent(deployment.environment)}&per_page=${DEPLOYMENTS_READ}`, 'list deployments', fetchImpl, opts);
        for (const d of Array.isArray(list) ? list : []) {
            // Earlier deployments only (ids grow), of another commit (a redeploy of the same commit changes nothing).
            if (!Number.isSafeInteger(d.id) || d.id >= deployment.id || typeof d.sha !== 'string' || !SHA_RE.test(d.sha) || d.sha === head) continue;
            const statuses = await ghGet(ctx, `/deployments/${d.id}/statuses?per_page=1`, 'read deployment statuses', fetchImpl, opts);
            if (Array.isArray(statuses) && statuses[0] && statuses[0].state === 'success') return d.sha.toLowerCase();
        }
        return null;
    }
    const before = ctx.event && ctx.event.before;
    return typeof before === 'string' && SHA_RE.test(before) && !ZERO_SHA_RE.test(before) ? before.toLowerCase() : null;
}

/** The changes (merged pull requests) and finding ids of the commits from base (exclusive) to head. */
export async function releaseChanges(
    ctx: GitHubContext,
    { head, base, scope }: { head: string; base: string | 'auto'; scope: Readonly<FindingScope> },
    fetchImpl: GitHubFetch,
    opts: GetOptions = {},
): Promise<{ base: string | null; commits: number; changes: ReleaseChange[]; findingIds: string[] }> {
    if (!SHA_RE.test(head)) throw new GitHubError('head is not a commit sha', 0);
    const from = base === 'auto' ? await findBase(ctx, head, fetchImpl, opts) : base;
    if (from !== null && !SHA_RE.test(from)) throw new GitHubError('base is not a commit sha', 0);
    let commits: any[];
    if (from === null) {
        commits = [await ghGet(ctx, `/commits/${head}`, `read commit ${head.slice(0, 7)}`, fetchImpl, opts)];
    } else {
        const cmp = await ghGet(ctx, `/compare/${from}...${head}`, `compare ${from.slice(0, 7)}...${head.slice(0, 7)}`, fetchImpl, opts);
        commits = Array.isArray(cmp.commits) ? cmp.commits : [];
    }
    const newestFirst = commits.filter((c) => c && typeof c.sha === 'string' && SHA_RE.test(c.sha)).reverse();

    const findingIds: string[] = [];
    const seen = new Set<string>();
    // Commit trailers first (Sequential-Finding: F-12), from the messages the compare already returned.
    addIds(findingIds, seen, findingIdsFromLog(newestFirst.map((c) => (c.commit && typeof c.commit.message === 'string' ? c.commit.message : '')).join('\n'), scope));

    const changes: ReleaseChange[] = [];
    const prSeen = new Set<number>();
    for (const c of newestFirst.slice(0, MAX_COMMITS_READ)) {
        if (changes.length >= MAX_CHANGES && findingIds.length >= MAX_FINDING_IDS) break;
        const pulls = await ghGet(ctx, `/commits/${c.sha}/pulls`, `list pull requests of ${c.sha.slice(0, 7)}`, fetchImpl, opts);
        for (const pr of Array.isArray(pulls) ? pulls : []) {
            if (!pr || !Number.isSafeInteger(pr.number) || !pr.merged_at || prSeen.has(pr.number)) continue;
            prSeen.add(pr.number);
            const title = typeof pr.title === 'string' ? pr.title : '';
            if (changes.length < MAX_CHANGES) changes.push({ title, url: typeof pr.html_url === 'string' ? pr.html_url : '', number: pr.number });
            addIds(findingIds, seen, findingIdsFromPrText(`${title}\n${typeof pr.body === 'string' ? pr.body : ''}`, scope));
        }
    }
    return { base: from, commits: newestFirst.length, changes, findingIds };
}
