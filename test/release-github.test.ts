import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findingScope, type FindingScope } from '../src/release/findings';
import { findBase, githubContext, MAX_COMMITS_READ, releaseChanges, type GitHubContext, type GitHubFetch } from '../src/release/github';

// Ported from @usesequential/release-cli's tests/cli/github.test.ts: the GitHub API reads behind --github-changes, on a
// fake fetch: the previous release from deployments (same environment, earlier, newest success), the commits between,
// their merged pull requests as changes, and the findings named in trailers and PR text. No network.
const HEAD = 'a'.repeat(40);
const PREV = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);
const GH_TOKEN = 'ghs_fake_workflow_token';
const CTX: GitHubContext = { apiUrl: 'https://api.github.test', repo: 'acme/mono', token: GH_TOKEN, event: null };
const sc = (o: { projectKey?: string; findings?: string } = {}): FindingScope => {
    const r = findingScope(o);
    if (!r.ok) throw new Error(r.message);
    return r.value;
};
const ALL = sc();

type Route = (url: URL) => { status?: number; body: unknown } | undefined;
interface Call { url: string; init: Parameters<GitHubFetch>[1] }
/** A fake GitHub: each GET is checked (GET, no redirects, the workflow token) and answered from `route`. */
function fakeFetch(route: Route): GitHubFetch & { calls: Call[] } {
    const calls: Call[] = [];
    const f = (async (url: string, init: Parameters<GitHubFetch>[1]) => {
        calls.push({ url, init });
        const u = new URL(url);
        const r = route(u);
        if (!r) throw new Error(`unexpected ${u.pathname}${u.search}`);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, `Bearer ${GH_TOKEN}`);
        assert.equal(init.headers.Accept, 'application/vnd.github+json');
        assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
        assert.ok(init.signal instanceof AbortSignal);
        return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
    }) as GitHubFetch & { calls: Call[] };
    f.calls = calls;
    return f;
}
const commit = (sha: string, message = 'work') => ({ sha, commit: { message } });
const pr = (number: number, title: string, body = '', merged = true) => ({ number, title, body, html_url: `https://github.test/acme/mono/pull/${number}`, merged_at: merged ? '2026-11-02T10:00:00Z' : null });

describe('githubContext', () => {
    const env = { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: 'acme/mono', GITHUB_EVENT_PATH: '/ev.json' };

    test('reads the token, repo, API URL (default api.github.com) and the event payload', () => {
        const r = githubContext(env, () => JSON.stringify({ deployment: { id: 9 } }));
        assert.deepEqual(r, { ok: true, value: { apiUrl: 'https://api.github.com', repo: 'acme/mono', token: GH_TOKEN, event: { deployment: { id: 9 } } } });
        const ghe = githubContext({ ...env, GITHUB_API_URL: 'https://ghe.test/api/v3/' }, () => '{}');
        assert.ok(ghe.ok);
        assert.equal(ghe.value.apiUrl, 'https://ghe.test/api/v3');
    });

    test('refuses no token, a bad repo, or a non-https API URL; an unreadable event is no event', () => {
        assert.equal(githubContext({ ...env, GITHUB_TOKEN: '' }, () => '{}').ok, false);
        assert.equal(githubContext({ ...env, GITHUB_REPOSITORY: 'acme/mono/../x' }, () => '{}').ok, false);
        assert.equal(githubContext({ ...env, GITHUB_API_URL: 'http://ghe.test' }, () => '{}').ok, false);
        assert.equal(githubContext({ ...env, GITHUB_API_URL: 'not a url' }, () => '{}').ok, false);
        const r = githubContext(env, () => {
            throw new Error('ENOENT');
        });
        assert.ok(r.ok);
        assert.equal(r.value.event, null);
        const noPath = githubContext({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: 'acme/mono' }, () => {
            throw new Error('never read');
        });
        assert.ok(noPath.ok);
        assert.equal(noPath.value.event, null);
    });

    test('the messages say what to set, never the token', () => {
        const r = githubContext({ ...env, GITHUB_TOKEN: '' }, () => '{}');
        assert.ok(!r.ok);
        assert.match(r.message, /^GITHUB_TOKEN is not set/);
        const h = githubContext({ ...env, GITHUB_API_URL: 'http://ghe.test' }, () => '{}');
        assert.ok(!h.ok && !h.message.includes(GH_TOKEN));
    });
});

describe('findBase', () => {
    const deployEvent = { deployment: { id: 100, sha: HEAD, environment: 'Production – web' } };

    test('a deployment: the newest EARLIER deployment of another commit in the same environment whose newest status is success', async () => {
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname === '/repos/acme/mono/deployments') {
                assert.equal(u.searchParams.get('environment'), 'Production – web');
                assert.equal(u.searchParams.get('per_page'), '30');
                return {
                    body: [
                        { id: 101, sha: 'd'.repeat(40) }, // later than this one: skipped
                        { id: 100, sha: HEAD }, // this one
                        { id: 99, sha: HEAD }, // a redeploy of the same commit: skipped
                        { id: 98, sha: OLDER }, // failed
                        { id: 97, sha: PREV }, // success
                    ],
                };
            }
            if (u.pathname === '/repos/acme/mono/deployments/98/statuses') return { body: [{ state: 'failure' }] };
            if (u.pathname === '/repos/acme/mono/deployments/97/statuses') return { body: [{ state: 'success' }] };
            return undefined;
        });
        assert.equal(await findBase({ ...CTX, event: deployEvent }, HEAD, fetchImpl), PREV);
        assert.deepEqual(fetchImpl.calls.map((c) => new URL(c.url).pathname), ['/repos/acme/mono/deployments', '/repos/acme/mono/deployments/98/statuses', '/repos/acme/mono/deployments/97/statuses']);
        assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('per_page'), '1');
    });

    test('no earlier success: null', async () => {
        const fetchImpl = fakeFetch((u) => (u.pathname.endsWith('/deployments') ? { body: [{ id: 100, sha: HEAD }] } : undefined));
        assert.equal(await findBase({ ...CTX, event: deployEvent }, HEAD, fetchImpl), null);
    });

    test('a deployment whose sha is not a sha, or whose id is not a number, is skipped (it never reaches a URL)', async () => {
        const fetchImpl = fakeFetch((u) => (u.pathname.endsWith('/deployments') ? { body: [{ id: 99, sha: '../../x' }, { id: '98', sha: PREV }, { id: 1.5, sha: PREV }] } : undefined));
        assert.equal(await findBase({ ...CTX, event: deployEvent }, HEAD, fetchImpl), null);
        assert.equal(fetchImpl.calls.length, 1);
    });

    test('a push: its before (not the all-zero one), lowercased; no event: null', async () => {
        const none = fakeFetch(() => undefined);
        assert.equal(await findBase({ ...CTX, event: { before: PREV } }, HEAD, none), PREV);
        assert.equal(await findBase({ ...CTX, event: { before: PREV.toUpperCase() } }, HEAD, none), PREV);
        assert.equal(await findBase({ ...CTX, event: { before: '0'.repeat(40) } }, HEAD, none), null);
        assert.equal(await findBase({ ...CTX, event: { before: 'main' } }, HEAD, none), null);
        assert.equal(await findBase({ ...CTX, event: null }, HEAD, none), null);
        assert.equal(none.calls.length, 0);
    });

    test('a deployment list error propagates (the caller records the release without changes)', async () => {
        const fetchImpl = fakeFetch(() => ({ status: 403, body: {} }));
        await assert.rejects(findBase({ ...CTX, event: deployEvent }, HEAD, fetchImpl), (e: Error) => e.name === 'GitHubError' && e.message === 'list deployments (HTTP 403)');
    });
});

describe('releaseChanges', () => {
    test("the merged PRs of the compare's commits, newest first, each once; findings from trailers and PR text", async () => {
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname === `/repos/acme/mono/compare/${PREV}...${HEAD}`) {
                return { body: { commits: [commit('1'.repeat(40), 'one\n\nSequential-Finding: F-1'), commit('2'.repeat(40)), commit(HEAD)] } };
            }
            if (u.pathname === `/repos/acme/mono/commits/${HEAD}/pulls`) return { body: [pr(12, 'Checkout button', 'Fixes F-12')] };
            if (u.pathname === `/repos/acme/mono/commits/${'2'.repeat(40)}/pulls`) return { body: [pr(12, 'Checkout button'), pr(11, 'Draft', '', false)] };
            if (u.pathname === `/repos/acme/mono/commits/${'1'.repeat(40)}/pulls`) return { body: [pr(10, 'Closes F-3: menu')] };
            return undefined;
        });
        const r = await releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, fetchImpl);
        assert.deepEqual(r, {
            base: PREV,
            commits: 3,
            changes: [
                { title: 'Checkout button', url: 'https://github.test/acme/mono/pull/12', number: 12 },
                { title: 'Closes F-3: menu', url: 'https://github.test/acme/mono/pull/10', number: 10 },
            ],
            findingIds: ['F-1', 'F-12', 'F-3'],
        });
    });

    test('no base: the head commit alone', async () => {
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname === `/repos/acme/mono/commits/${HEAD}`) return { body: commit(HEAD, 'x\n\nSequential-Finding: F-2') };
            if (u.pathname === `/repos/acme/mono/commits/${HEAD}/pulls`) return { body: [] };
            return undefined;
        });
        assert.deepEqual(await releaseChanges(CTX, { head: HEAD, base: 'auto', scope: ALL }, fetchImpl), { base: null, commits: 1, changes: [], findingIds: ['F-2'] });
    });

    test('a monorepo project key: only its qualified ids', async () => {
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname.includes('/compare/')) return { body: { commits: [commit(HEAD, 'Sequential-Finding: app#F-9')] } };
            if (u.pathname.endsWith('/pulls')) return { body: [pr(5, 'Fixes web#F-1 and app#F-2, F-3')] };
            return undefined;
        });
        assert.deepEqual((await releaseChanges(CTX, { head: HEAD, base: PREV, scope: sc({ projectKey: 'web' }) }, fetchImpl)).findingIds, ['F-1']);
        assert.deepEqual((await releaseChanges(CTX, { head: HEAD, base: PREV, scope: sc({ projectKey: 'app' }) }, fetchImpl)).findingIds, ['F-9', 'F-2']);
    });

    test('reads the pull requests of at most MAX_COMMITS_READ commits and keeps at most 50 changes', async () => {
        const shas = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(40, '0').replace(/^0/, 'e'));
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname.includes('/compare/')) return { body: { commits: shas.map((s) => commit(s)) } };
            const m = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(u.pathname);
            if (m) return { body: [pr(shas.indexOf(m[1]) + 1, `PR ${m[1].slice(-4)}`)] };
            return undefined;
        });
        const r = await releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, fetchImpl);
        assert.equal(r.changes.length, 50);
        assert.equal(r.changes[0].number, 150); // newest first
        const pullCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/pulls')).length;
        assert.ok(pullCalls <= MAX_COMMITS_READ, String(pullCalls));
    });

    test('stops reading pull requests once both caps are full', async () => {
        const shas = Array.from({ length: 80 }, (_, i) => (i + 1).toString(16).padStart(40, 'f'));
        let n = 0;
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname.includes('/compare/')) return { body: { commits: shas.map((s) => commit(s)) } };
            if (u.pathname.endsWith('/pulls')) {
                n++;
                // Each PR closes two new ids: 25 PRs fill both 50s.
                return { body: [pr(n, `Fixes F-${2 * n - 1}, F-${2 * n}`)] };
            }
            return undefined;
        });
        const r = await releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, fetchImpl);
        assert.equal(r.findingIds.length, 50);
        assert.equal(r.changes.length, 50);
        assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/pulls')).length, 50);
    });

    test('a pull request with no title or link is kept with empty strings; one with no number is skipped', async () => {
        const fetchImpl = fakeFetch((u) => {
            if (u.pathname.includes('/compare/')) return { body: { commits: [commit(HEAD)] } };
            if (u.pathname.endsWith('/pulls')) return { body: [{ number: 3, merged_at: '2026-11-02T10:00:00Z' }, { title: 'no number', merged_at: '2026-11-02T10:00:00Z' }, null] };
            return undefined;
        });
        assert.deepEqual((await releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, fetchImpl)).changes, [{ title: '', url: '', number: 3 }]);
    });

    test('a failed compare is an error naming the call (the CLI then records the release without changes)', async () => {
        const fetchImpl = fakeFetch(() => ({ status: 404, body: { message: 'No common ancestor' } }));
        await assert.rejects(releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, fetchImpl), { name: 'GitHubError', message: `compare ${PREV.slice(0, 7)}...${HEAD.slice(0, 7)} (HTTP 404)` });
    });

    test('never puts a value that is not a sha into a URL', async () => {
        const none = fakeFetch(() => undefined);
        await assert.rejects(releaseChanges(CTX, { head: '../../x', base: PREV, scope: ALL }, none));
        await assert.rejects(releaseChanges(CTX, { head: HEAD, base: 'main', scope: ALL }, none));
        assert.equal(none.calls.length, 0);
    });

    test('an answer over the size cap, or not JSON, is a plain error (not a GitHubError)', async () => {
        const big = (async () => ({ status: 200, headers: { get: (n: string) => (n === 'content-length' ? String(64 * 1024 * 1024) : null) }, text: async () => '{}' })) as unknown as GitHubFetch;
        await assert.rejects(releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, big), (e: Error) => e.name !== 'GitHubError');
        const html = (async () => ({ status: 200, text: async () => '<html>' })) as unknown as GitHubFetch;
        await assert.rejects(releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, html), (e: Error) => e.name !== 'GitHubError');
    });

    test('each GET has its own timeout: a GitHub that never answers is given up', async () => {
        const hang = ((_u: string, init: { signal: AbortSignal }) =>
            new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as GitHubFetch;
        await assert.rejects(releaseChanges(CTX, { head: HEAD, base: PREV, scope: ALL }, hang, { timeoutMs: 20 }), /aborted/);
    });
});
