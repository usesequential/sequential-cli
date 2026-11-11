import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { main, type Io } from '../src/cli';
import { runReleaseAlias, USAGE as ALIAS_USAGE, type AliasDeps } from '../src/release/alias';
import { VERSION } from '../src/version';
import type { FetchLike } from '../src/transport';

// `sequential releases record` with the options of @usesequential/release-cli (--title, --range, --github-changes, --base,
// --project-key, --findings), ported from that package's tests/cli/cli.test.ts and release.test.ts: the record_release
// tool over MCP, so these pins read the tools/call body. Then `sequential-release`, the old command itself, which works
// exactly as release-cli 0.2.2 (POST /api/releases).
const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const OTHER = 'sq_pat_' + 'Z9y8X7w6'.repeat(4);
const GH_TOKEN = 'ghs_fake_workflow_token';
const HEAD = 'a'.repeat(40);
const PREV = 'b'.repeat(40);

type GitHubRoute = (path: string) => { status?: number; body: unknown } | 'throw';
interface Seen { url: string; method: string; headers: Record<string, string>; redirect: string; body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null }

const ok = (v: unknown) => ({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
const STORED = ok({ release: { version: 'v', environment: 'production', released_at: '2026-11-02T10:00:00.000Z' } });

/** A fake Sequential (POST /mcp) and a fake GitHub (GETs), a fake git, captured lines. */
function harness(o: { mcp?: unknown | (() => unknown); mcpStatus?: number; mcpThrows?: boolean; github?: GitHubRoute; git?: (args: readonly string[]) => string; event?: string; io?: Partial<Io> } = {}) {
    const seen: Seen[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const gitCalls: string[][] = [];
    const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: string }) => {
        const body = init.body ? JSON.parse(init.body) : null;
        seen.push({ url, method: init.method, headers: init.headers, redirect: init.redirect, body });
        if (init.method === 'GET') {
            const r = o.github ? o.github(new URL(url).pathname) : 'throw';
            if (r === 'throw') throw new Error('fetch failed: ECONNREFUSED');
            return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
        }
        if (o.mcpThrows) throw new Error('fetch failed: ECONNREFUSED');
        const answer = typeof o.mcp === 'function' ? (o.mcp as () => unknown)() : (o.mcp ?? STORED);
        return { status: o.mcpStatus ?? 200, text: async () => JSON.stringify(answer && typeof answer === 'object' && 'jsonrpc' in answer ? { ...answer, id: body.id } : answer) };
    }) as unknown as FetchLike;
    const io: Io = {
        fetch,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        stdoutTTY: false,
        interactive: false,
        projectFs: { cwd: '/x', home: '/x', uid: null, lstat: () => null, exists: () => false, read: () => '' },
        git: (args) => {
            gitCalls.push([...args]);
            return o.git ? o.git(args) : '';
        },
        readFile: () => o.event ?? '{}',
        ...o.io,
    };
    return {
        io,
        seen,
        out,
        err,
        gitCalls,
        calls: () => seen.filter((s) => s.body?.method === 'tools/call'),
        sent: () => seen.find((s) => s.body?.method === 'tools/call')!.body!.params!.arguments!,
        gets: () => seen.filter((s) => s.method === 'GET'),
        printed: () => [...out, ...err].join('\n'),
    };
}

const ENV = { SEQUENTIAL_TOKEN: TOKEN };
const GH_ENV = { ...ENV, GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: 'acme/mono', GITHUB_API_URL: 'https://api.github.test', GITHUB_EVENT_PATH: '/ev.json' };
const EVENT = JSON.stringify({ deployment: { id: 7, sha: HEAD, environment: 'Production – web' } });
const GH_ARGS = ['--version', HEAD, '--commit-sha', HEAD, '--environment', 'production', '--released-at', '2026-11-02T10:00:00Z', '--title', 'web', '--github-changes'];
const rel = (...a: string[]) => ['releases', 'record', ...a];

/** A GitHub with one earlier successful deployment (PREV) and one merged PR that fixes F-12; HEAD's trailer names F-1. */
const github: GitHubRoute = (p) => {
    if (p.endsWith('/deployments')) return { body: [{ id: 7, sha: HEAD }, { id: 6, sha: PREV }] };
    if (p.endsWith('/deployments/6/statuses')) return { body: [{ state: 'success' }] };
    if (p.endsWith(`/compare/${PREV}...${HEAD}`)) return { body: { commits: [{ sha: HEAD, commit: { message: 'm\n\nSequential-Finding: F-1' } }] } };
    if (p.endsWith(`/commits/${HEAD}/pulls`)) return { body: [{ number: 4, title: 'Fix the menu', body: 'Fixes F-12', html_url: 'https://github.test/acme/mono/pull/4', merged_at: '2026-11-02T09:00:00Z' }] };
    return { status: 404, body: {} };
};

describe('releases record: --title and the success line', () => {
    test('the old success line after the stored release; --title goes in title; one request, the bearer token, no redirects', async () => {
        const h = harness();
        assert.equal(await main(rel('--version', 'fe@2', '--title', 'Clearer checkout errors', '--commit-sha', 'abc1234'), ENV, h.io), 0);
        assert.equal(h.seen.length, 1);
        assert.equal(h.seen[0].url, 'https://api.usesequential.com/mcp');
        assert.equal(h.seen[0].headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(h.seen[0].redirect, 'error');
        assert.deepEqual(h.calls()[0].body!.params, { name: 'record_release', arguments: { version: 'fe@2', commit_sha: 'abc1234', title: 'Clearer checkout errors' } });
        assert.deepEqual(h.out, ['recorded release v', 'environment production, released at 2026-11-02T10:00:00.000Z', 'Recorded release fe@2 (no cases named)']);
    });

    test('empty optional fields are left out rather than sent blank: no title, no finding_ids, no changes', async () => {
        const h = harness();
        assert.equal(await main(rel('--version', 'fe@2', '--title='), ENV, h.io), 0);
        assert.deepEqual(h.sent(), { version: 'fe@2' });
        const h2 = harness({ git: () => 'no trailers here\n' });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'v1..v2'), ENV, h2.io), 0);
        assert.deepEqual(h2.sent(), { version: 'fe@2' });
    });

    test('--json prints the answer only: no old line', async () => {
        const h = harness();
        assert.equal(await main(rel('--version', 'fe@2', '--json'), ENV, h.io), 0);
        assert.equal(h.out.length, 1);
        assert.ok(JSON.parse(h.out[0]).release);
    });

    test('the success line is one line, stripped of controls (the version is the caller\'s text)', async () => {
        const h = harness();
        assert.equal(await main(rel('--version', 'v1\u001b[2J‮'), ENV, h.io), 0);
        assert.equal(h.out.at(-1), 'Recorded release v1 (no cases named)');
    });
});

describe('releases record --range', () => {
    test('names the findings of the trailers, and passes the range as ONE argv element to git (never a shell string)', async () => {
        const h = harness({ git: () => 'fix: x\n\nSequential-Finding: F-1, F-4\n' });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'v1.0.0..v1.1.0'), ENV, h.io), 0);
        assert.deepEqual(h.gitCalls, [['log', '--format=%B', 'v1.0.0..v1.1.0']]);
        assert.deepEqual(h.sent().finding_ids, ['F-1', 'F-4']);
        assert.equal(h.out.at(-1), 'Recorded release fe@2 (2 cases: F-1, F-4)');
    });

    test('trailer ids are sent after the --finding flags, each once, at most 50 (the flags first)', async () => {
        const many = Array.from({ length: 60 }, (_, i) => `Sequential-Finding: F-${i + 1}`).join('\n');
        const h = harness({ git: () => many });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'a..b', '--finding', 'F-77', '--finding', 'F-3', '--finding', 'F-77'), ENV, h.io), 0);
        const ids = h.sent().finding_ids as string[];
        assert.equal(ids.length, 50);
        assert.deepEqual(ids.slice(0, 4), ['F-77', 'F-3', 'F-1', 'F-2']);
        assert.equal(new Set(ids).size, 50);
        assert.match(h.out.at(-1)!, /^Recorded release fe@2 \(50 cases: F-77, F-3, F-1, /);
    });

    test('the --finding flags alone are sent as given (Sequential checks them, the CLI copies no rule)', async () => {
        const h = harness();
        assert.equal(await main(rel('--version', 'fe@2', '--finding', 'F-3', '--finding', 'F-3'), ENV, h.io), 0);
        assert.deepEqual(h.sent().finding_ids, ['F-3', 'F-3']);
        assert.equal(h.gitCalls.length, 0);
    });

    test('an all-zero base (a first push or a tag push) means "no previous": only the head commit is read', async () => {
        const zeros = '0'.repeat(40);
        for (const [range, args] of [
            [`${zeros}..HEAD`, ['log', '-1', '--format=%B', 'HEAD']],
            [`${zeros}..abc1234`, ['log', '-1', '--format=%B', 'abc1234']],
            [`${zeros}...abc1234`, ['log', '-1', '--format=%B', 'abc1234']],
            [`${zeros}..`, ['log', '-1', '--format=%B', 'HEAD']],
            [`${'0'.repeat(64)}..HEAD`, ['log', '-1', '--format=%B', 'HEAD']],
        ] as const) {
            const h = harness({ git: () => 'fix: x\n\nSequential-Finding: F-3\n' });
            assert.equal(await main(rel('--version', 'fe@2', '--range', range), ENV, h.io), 0, range);
            assert.deepEqual(h.gitCalls, [args], range);
            assert.equal(h.out.at(-1), 'Recorded release fe@2 (1 case: F-3)');
        }
    });

    test('a base that is only partly zeros is an ordinary range', async () => {
        const h = harness();
        await main(rel('--version', 'fe@2', '--range', `${'0'.repeat(39)}1..HEAD`), ENV, h.io);
        assert.deepEqual(h.gitCalls, [['log', '--format=%B', `${'0'.repeat(39)}1..HEAD`]]);
    });

    test('a range that starts with "-", or an all-zero base followed by an option: refused without calling git', async () => {
        for (const argv of [
            rel('--version', 'fe@2', '--range=--upload-pack=evil'),
            rel('--version', 'fe@2', '--range=-n1'),
            rel('--version', 'fe@2', '--range', `${'0'.repeat(40)}..--output=/tmp/x`),
            rel('--version', 'fe@2', '--range', '--upload-pack=evil'),
        ]) {
            const h = harness();
            assert.equal(await main(argv, ENV, h.io), 2, argv.join(' '));
            assert.equal(h.gitCalls.length, 0);
            assert.equal(h.seen.length, 0);
            assert.match(h.err.at(-1)!, /--range/);
        }
    });

    test('git fails: one line, exit 2, nothing sent', async () => {
        const h = harness({
            git: () => {
                throw new Error("Command failed: git log --format=%B v1..v2\nfatal: bad revision 'v1..v2'\n");
            },
        });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'v1..v2'), ENV, h.io), 2);
        assert.equal(h.calls().length, 0);
        assert.equal(h.err.at(-1), "sequential: git log failed: Command failed: git log --format=%B v1..v2 fatal: bad revision 'v1..v2' ");
    });
});

describe('releases record --github-changes', () => {
    test('sends changes, finding ids, released_at and title; prints what it found; neither token is printed', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS), GH_ENV, h.io), 0);
        assert.deepEqual(h.sent(), {
            version: HEAD,
            environment: 'production',
            commit_sha: HEAD,
            released_at: '2026-11-02T10:00:00Z',
            title: 'web',
            finding_ids: ['F-1', 'F-12'],
            changes: [{ title: 'Fix the menu', url: 'https://github.test/acme/mono/pull/4', number: 4 }],
        });
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (2 cases: F-1, F-12; 1 change since bbbbbbb)`);
        assert.deepEqual(h.err, ["sequential: releases record on the token's project"]);
        assert.ok(!h.printed().includes(GH_TOKEN) && !h.printed().includes(TOKEN.slice(7)));
        // GitHub gets the workflow token, never Sequential's; Sequential never gets GitHub's.
        for (const g of h.gets()) {
            assert.ok(g.url.startsWith('https://api.github.test/repos/acme/mono/'), g.url);
            assert.equal(g.headers.Authorization, `Bearer ${GH_TOKEN}`);
            assert.equal(g.redirect, 'error');
        }
        assert.equal(h.calls()[0].headers.authorization, `Bearer ${TOKEN}`);
        assert.ok(!JSON.stringify(h.calls()[0]).includes(GH_TOKEN));
    });

    test('GitHub ids join the --finding flags (flags first, each once)', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--finding', 'F-12', '--finding', 'F-40'), GH_ENV, h.io), 0);
        assert.deepEqual(h.sent().finding_ids, ['F-12', 'F-40', 'F-1']);
    });

    test('a failed compare: one line on stderr, and the release is recorded without changes or case ids from GitHub', async () => {
        const h = harness({ github: (p) => (p.includes('/compare/') ? { status: 404, body: { message: 'No common ancestor' } } : github(p)), event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--finding', 'F-9'), GH_ENV, h.io), 0);
        assert.equal(h.err.at(-1), 'GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or case ids from GitHub.');
        const sent = h.sent();
        assert.equal('changes' in sent, false);
        assert.deepEqual(sent.finding_ids, ['F-9']); // the caller's own flags still go
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (1 case: F-9)`);
    });

    test('GitHub not reached (or a redirect): "could not request failed", the old wording; the release is recorded', async () => {
        const h = harness({ github: () => 'throw', event: EVENT });
        assert.equal(await main(rel(...GH_ARGS), GH_ENV, h.io), 0);
        assert.equal(h.err.at(-1), 'GitHub: could not request failed; the release is recorded without changes or case ids from GitHub.');
        assert.equal(h.calls().length, 1);
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (no cases named)`);
    });

    test('no GITHUB_TOKEN: says so, and records the release (one request: Sequential)', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS), { ...GH_ENV, GITHUB_TOKEN: '' }, h.io), 0);
        assert.match(h.err.at(-1)!, /^GitHub: GITHUB_TOKEN is not set: pass it to the step .*; the release is recorded without changes or case ids from GitHub\.$/);
        assert.equal(h.seen.length, 1);
    });

    test('no earlier release: the head commit alone, and the line says so', async () => {
        const h = harness({
            github: (p) => {
                if (p.endsWith('/deployments')) return { body: [{ id: 7, sha: HEAD }] };
                if (p.endsWith(`/commits/${HEAD}`)) return { body: { sha: HEAD, commit: { message: 'first' } } };
                if (p.endsWith(`/commits/${HEAD}/pulls`)) return { body: [] };
                return { status: 404, body: {} };
            },
            event: EVENT,
        });
        assert.equal(await main(rel(...GH_ARGS), GH_ENV, h.io), 0);
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (no cases named; 0 changes from aaaaaaa alone (no earlier release found))`);
    });

    test('--base <sha> compares with it, without reading deployments', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--base', PREV), GH_ENV, h.io), 0);
        assert.ok(!h.gets().some((g) => g.url.includes('/deployments')));
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (2 cases: F-1, F-12; 1 change since bbbbbbb)`);
    });

    test("--project-key reads only that project's qualified ids", async () => {
        const h = harness({
            github: (p) => (p.endsWith(`/commits/${HEAD}/pulls`) ? { body: [{ number: 4, title: 't', body: 'Fixes web#F-2, app#F-3 and F-12', html_url: 'https://github.test/x/4', merged_at: '2026-11-02T09:00:00Z' }] } : github(p)),
            event: EVENT,
        });
        assert.equal(await main(rel(...GH_ARGS, '--project-key', 'web'), GH_ENV, h.io), 0);
        assert.deepEqual(h.sent().finding_ids, ['F-2']);
        const h2 = harness({ github: (p) => (p.endsWith(`/commits/${HEAD}/pulls`) ? { body: [{ number: 4, title: 't', body: 'Fixes web#F-2 and F-12', merged_at: 'x' }] } : github(p)), event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--project-key', 'web', '--findings', 'all'), GH_ENV, h2.io), 0);
        assert.deepEqual(h2.sent().finding_ids, ['F-1', 'F-2', 'F-12']);
    });

    test('--dry-run reads GitHub and prints what would be sent; nothing goes to Sequential; on a terminal PR titles are stripped', async () => {
        const hostile: GitHubRoute = (p) => (p.endsWith(`/commits/${HEAD}/pulls`) ? { body: [{ number: 4, title: 'Menu\u001b[2J‮', merged_at: 'x' }] } : github(p));
        const h = harness({ github: hostile, event: EVENT, io: { stdoutTTY: true } });
        assert.equal(await main(rel(...GH_ARGS, '--dry-run'), { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: 'acme/mono', GITHUB_API_URL: 'https://api.github.test', GITHUB_EVENT_PATH: '/e' }, h.io), 0);
        assert.equal(h.calls().length, 0);
        assert.ok(h.gets().length > 0);
        const text = h.out.join('\n');
        assert.match(text, /"title": "Menu"/);
        assert.ok(!/[\u001b‮]/.test(text));
    });

    test('Ctrl-C while GitHub is read: cancelled, exit 1, nothing recorded', async () => {
        const ctl = new AbortController();
        const h = harness({
            github: () => {
                ctl.abort();
                return 'throw';
            },
            event: EVENT,
            io: { signal: ctl.signal },
        });
        assert.equal(await main(rel(...GH_ARGS), GH_ENV, h.io), 1);
        assert.equal(h.calls().length, 0);
    });

    for (const [why, argv, message] of [
        ['--range with --github-changes', [...GH_ARGS, '--range', 'a..b'], /--range and --github-changes both name the commits: use one\./],
        ['--base without --github-changes', ['--version', 'v1', '--base', PREV], /--base needs --github-changes\./],
        ['--github-changes without --commit-sha', ['--version', 'v1', '--github-changes'], /--github-changes needs --commit-sha: the deployed commit \(7-40 hex characters\)\./],
        ['--github-changes with a --commit-sha that is not one', ['--version', 'v1', '--github-changes', '--commit-sha', 'main'], /needs --commit-sha/],
        ['a --base that is not a sha', [...GH_ARGS, '--base', 'main'], /--base: auto, or a commit sha/],
        ['a bad --project-key', [...GH_ARGS, '--project-key', 'a b'], /--project-key: letters, digits/],
        ['a bad --findings', [...GH_ARGS, '--findings', 'some'], /--findings: all or qualified/],
        ['--github-changes with a value', ['--version', 'v1', '--github-changes=yes'], /takes no value/],
        ['no --version', ['--github-changes', '--commit-sha', HEAD], /--version is required/],
    ] as const) {
        test(`refuses ${why} before any request or git run (exit 2)`, async () => {
            const h = harness({ github, event: EVENT });
            assert.equal(await main(rel(...argv), GH_ENV, h.io), 2);
            assert.match(h.err.at(-1)!, message);
            assert.equal(h.seen.length, 0);
            assert.equal(h.gitCalls.length, 0);
        });
    }

    test('the new flags are only for releases record', async () => {
        const h = harness();
        assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x', '--github-changes'], ENV, h.io), 2);
        assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x', '--range', 'a..b'], ENV, h.io), 2);
        assert.equal(h.seen.length, 0);
    });
});

// `sequential-release`: release-cli 0.2.2 (0.2.1 ported, with the words of 0.2.2; src/release/alias.ts).
// test/release-golden.test.ts runs the built bin against every case of the 0.2.2 record; these pin the same rules in-process, on a fake fetch (POST /api/releases).
interface AliasSeen { url: string; method: string; headers: Record<string, string>; redirect: string; body: Record<string, unknown> | null }

/** A fake Sequential (POST /api/releases) and GitHub (GETs), a fake git, the raw stdout and stderr text. */
function alias(o: { status?: number; answer?: unknown; throws?: string; github?: GitHubRoute; git?: (args: readonly string[]) => string; event?: string } = {}) {
    const seen: AliasSeen[] = [];
    let out = '';
    let err = '';
    const gitCalls: string[][] = [];
    const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: string }) => {
        seen.push({ url, method: init.method, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === 'GET') {
            const r = o.github ? o.github(new URL(url).pathname) : 'throw';
            if (r === 'throw') throw new TypeError('fetch failed');
            return { status: r.status ?? 200, json: async () => r.body };
        }
        if (o.throws !== undefined) throw new TypeError(o.throws);
        const answer = o.answer === undefined ? { release: { id: 'rel_1' } } : o.answer;
        return { status: o.status ?? 201, json: async () => (typeof answer === 'string' ? JSON.parse(answer) : answer) };
    }) as unknown as AliasDeps['fetchImpl'];
    const deps: AliasDeps = {
        fetchImpl,
        execGit: (args) => {
            gitCalls.push([...args]);
            return o.git ? o.git(args) : '';
        },
        readFile: () => o.event ?? '{}',
        stdout: { write: (s) => { out += s; } },
        stderr: { write: (s) => { err += s; } },
    };
    return {
        deps,
        seen,
        gitCalls,
        out: () => out,
        err: () => err,
        posts: () => seen.filter((s) => s.method === 'POST'),
        sent: () => seen.find((s) => s.method === 'POST')!.body!,
    };
}

describe('sequential-release (release-cli 0.2.2, ported)', () => {
    const RENV = { SEQUENTIAL_RELEASES_TOKEN: TOKEN };
    const UNKNOWN = (flag: string) => `Unknown option: ${flag}\n${ALIAS_USAGE}\n`;

    test('success: POST <host>/api/releases, the bearer token, JSON, never a redirect; the old line only; the hosted API by default', async () => {
        for (const env of [RENV, { ...RENV, SEQUENTIAL_API_URL: '' }]) {
            const h = alias();
            assert.equal(await runReleaseAlias(['--version', 'fe@2'], env, h.deps), 0);
            assert.deepEqual([h.out(), h.err()], ['Recorded release fe@2 (no cases named)\n', '']);
            assert.equal(h.seen.length, 1);
            const s = h.seen[0];
            assert.deepEqual([s.method, s.url, s.redirect], ['POST', 'https://api.usesequential.com/api/releases', 'error']);
            assert.deepEqual(s.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': `sequential-cli/${VERSION}` });
            assert.deepEqual(s.body, { version: 'fe@2' });
        }
    });

    test('every field in the body; empty values are left out; --sha is --commit-sha; a commit sha is not checked without --github-changes', async () => {
        const h = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--environment', 'production', '--commit-sha', 'abc1234', '--released-at', '2026-11-07T10:00:00Z', '--title', 'Clearer'], RENV, h.deps), 0);
        assert.deepEqual(h.sent(), { version: 'v1', environment: 'production', commit_sha: 'abc1234', released_at: '2026-11-07T10:00:00Z', title: 'Clearer' });
        const e = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--environment', '', '--commit-sha', '', '--released-at', '', '--title', ''], RENV, e.deps), 0);
        assert.deepEqual(e.sent(), { version: 'v1' });
        const s = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--sha', 'not-a-sha'], RENV, s.deps), 0);
        assert.deepEqual(s.sent(), { version: 'v1', commit_sha: 'not-a-sha' });
    });

    test('reads SEQUENTIAL_RELEASES_TOKEN only: SEQUENTIAL_TOKEN (the changes token) is never used; no shape check', async () => {
        const h = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_TOKEN: TOKEN }, h.deps), 1);
        assert.equal(h.err(), 'SEQUENTIAL_RELEASES_TOKEN is required: a project access token (sq_pat_…) with the releases:write scope, made for one project.\n');
        assert.deepEqual([h.out(), h.seen.length], ['', 0]);
        const h2 = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_RELEASES_TOKEN: OTHER, SEQUENTIAL_TOKEN: TOKEN }, h2.deps), 0);
        assert.equal(h2.seen[0].headers.Authorization, `Bearer ${OTHER}`);
        // 0.2.1 checked presence only: Sequential refuses a token that is not one.
        const h3 = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_RELEASES_TOKEN: 'sq_pat_short' }, h3.deps), 0);
        assert.equal(h3.seen[0].headers.Authorization, 'Bearer sq_pat_short');
    });

    test('the token is checked before anything else: no token, --help, an unknown option: the token line', async () => {
        for (const argv of [['--help'], ['--nope'], []]) {
            const h = alias();
            assert.equal(await runReleaseAlias(argv, {}, h.deps), 1);
            assert.match(h.err(), /^SEQUENTIAL_RELEASES_TOKEN is required/);
        }
    });

    test('the API: --host, else SEQUENTIAL_API_URL; https, http only for localhost and 127.0.0.1 (not [::1]); a trailing slash goes, a path stays', async () => {
        for (const [env, argv, url] of [
            [{ SEQUENTIAL_API_URL: 'http://localhost:3000' }, [], 'http://localhost:3000/api/releases'],
            [{ SEQUENTIAL_API_URL: 'http://127.0.0.1:3000/' }, [], 'http://127.0.0.1:3000/api/releases'],
            [{ SEQUENTIAL_API_URL: 'https://seq.example.test' }, [], 'https://seq.example.test/api/releases'],
            [{ SEQUENTIAL_API_URL: 'https://other.example.test' }, ['--host', 'https://seq.example.test/'], 'https://seq.example.test/api/releases'],
            [{}, ['--host', 'https://seq.example.test/base//'], 'https://seq.example.test/base/api/releases'],
        ] as const) {
            const h = alias();
            assert.equal(await runReleaseAlias(['--version', 'v1', ...argv], { ...RENV, ...env }, h.deps), 0, url);
            assert.equal(h.seen[0].url, url);
            assert.equal(h.err(), '', 'no line about the host');
        }
        const must = 'The API URL (--host or SEQUENTIAL_API_URL) must be https (localhost and 127.0.0.1 excepted) — the token it carries is a bearer secret.\n';
        for (const [env, argv] of [
            [{ SEQUENTIAL_API_URL: 'http://api.example.com' }, []],
            [{}, ['--host', 'http://seq.example.test']],
            [{ SEQUENTIAL_API_URL: 'http://[::1]:3000' }, []],
        ] as const) {
            const h = alias();
            assert.equal(await runReleaseAlias(['--version', 'v1', ...argv], { ...RENV, ...env }, h.deps), 1);
            assert.equal(h.err(), must);
            assert.equal(h.seen.length, 0);
        }
        const bad = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--host', 'not a url'], RENV, bad.deps), 1);
        assert.equal(bad.err(), 'The API URL (--host or SEQUENTIAL_API_URL) is not a valid URL: not a url\n');
    });

    test('the parser: --flag=value, the new CLI\'s options and a subcommand word are unknown options, with the usage; exit 1', async () => {
        for (const word of ['--version=v1', '--host=https://seq.example.test', '--github-changes=true', '--help', '--json', '--dry-run', '--finding', '--project', '--timeout', 'release']) {
            const h = alias();
            const argv = word === 'release' ? ['release', '--version', 'v1'] : word.includes('=') ? [word] : ['--version', 'v1', word, 'x'];
            assert.equal(await runReleaseAlias(argv, RENV, h.deps), 1, word);
            assert.equal(h.err(), UNKNOWN(word), word);
            assert.deepEqual([h.out(), h.seen.length], ['', 0], word);
        }
        const v = alias();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--title'], RENV, v.deps), 1);
        assert.equal(v.err(), `--title needs a value.\n${ALIAS_USAGE}\n`);
        for (const argv of [[], ['--version', ''], ['--project-key', 'a b']]) {
            const m = alias();
            assert.equal(await runReleaseAlias(argv, RENV, m.deps), 1);
            assert.equal(m.err(), `--version is required.\n${ALIAS_USAGE}\n`);
        }
    });

    test('a value may start with "--" (it is never a flag), and a repeated flag keeps its last value', async () => {
        const h = alias();
        assert.equal(await runReleaseAlias(['--version', 'v0', '--version', 'v1', '--title', '--host=https://evil.example', '--environment', 'staging', '--environment', 'production'], RENV, h.deps), 0);
        assert.deepEqual(h.sent(), { version: 'v1', environment: 'production', title: '--host=https://evil.example' });
        assert.equal(h.seen[0].url, 'https://api.usesequential.com/api/releases');
    });

    test('refusals: the server\'s message, else its error, else HTTP <status>; a network failure or a redirect: fetch\'s message; exit 1', async () => {
        for (const [o, line] of [
            [{ status: 400, answer: { error: 'bad_request', message: 'version: 1-64 printable ASCII characters' } }, 'version: 1-64 printable ASCII characters\n'],
            [{ status: 403, answer: { error: 'forbidden' } }, 'forbidden\n'],
            [{ status: 429, answer: { error: 'rate_limited', message: 'Too many requests for this project. Try again shortly.', retry_after_sec: 30 } }, 'Too many requests for this project. Try again shortly.\n'],
            [{ status: 502, answer: 'not json' }, 'HTTP 502\n'],
            [{ throws: 'fetch failed' }, 'fetch failed\n'],
        ] as const) {
            const h = alias(o);
            assert.equal(await runReleaseAlias(['--version', 'v1'], RENV, h.deps), 1, line);
            assert.deepEqual([h.out(), h.err()], ['', line]);
            assert.equal(h.posts().length, 1, 'one request, never a retry');
        }
        const ok200 = alias({ status: 200, answer: 'not json' });
        assert.equal(await runReleaseAlias(['--version', 'v1'], RENV, ok200.deps), 0);
    });

    test('--range: git log of the range (one argv element each), the trailers, the old line; a failed git log is exit 1', async () => {
        const h = alias({ git: () => 'fix: x\n\nSequential-Finding: F-1, F-4\n' });
        assert.equal(await runReleaseAlias(['--version', 'fe@2', '--range', 'v1..v2'], RENV, h.deps), 0);
        assert.deepEqual(h.gitCalls, [['log', '--format=%B', 'v1..v2']]);
        assert.deepEqual(h.sent(), { version: 'fe@2', finding_ids: ['F-1', 'F-4'] });
        assert.equal(h.out(), 'Recorded release fe@2 (2 cases: F-1, F-4)\n');
        const z = alias({ git: () => 'Sequential-Finding: F-3' });
        assert.equal(await runReleaseAlias(['--version', 'v', '--range', `${'0'.repeat(40)}..`], RENV, z.deps), 0);
        assert.deepEqual(z.gitCalls, [['log', '-1', '--format=%B', 'HEAD']]);
        const f = alias({ git: () => { throw new Error('Command failed: git log'); } });
        assert.equal(await runReleaseAlias(['--version', 'v', '--range', 'a..b'], RENV, f.deps), 1);
        assert.deepEqual([f.err(), f.seen.length], ['git log failed: Command failed: git log\n', 0]);
        const opt = alias();
        assert.equal(await runReleaseAlias(['--version', 'v', '--range', '--output=x'], RENV, opt.deps), 1);
        assert.deepEqual([opt.err(), opt.gitCalls.length], ['--range must be a git revision range, not an option: --output=x\n', 0]);
    });

    test('--github-changes with --sha: the GitHub reads, changes and ids in the body, the old line; a GitHub failure is one line and the release is recorded', async () => {
        const h = alias({ github, event: EVENT });
        const argv = ['--version', 'v1', '--sha', HEAD, '--github-changes'];
        assert.equal(await runReleaseAlias(argv, { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, h.deps), 0);
        assert.equal(h.out(), 'Recorded release v1 (2 cases: F-1, F-12; 1 change since bbbbbbb)\n');
        assert.equal(h.err(), '');
        assert.deepEqual(h.sent(), { version: 'v1', commit_sha: HEAD, finding_ids: ['F-1', 'F-12'], changes: [{ title: 'Fix the menu', url: 'https://github.test/acme/mono/pull/4', number: 4 }] });
        const gets = h.seen.filter((s) => s.method === 'GET');
        assert.ok(gets.every((g) => g.redirect === 'error' && g.headers.Authorization === `Bearer ${GH_TOKEN}` && !('User-Agent' in g.headers)));
        const fail = alias({ github: (p) => (p.includes('/compare/') ? { status: 404, body: {} } : github(p)), event: EVENT });
        assert.equal(await runReleaseAlias(argv, { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, fail.deps), 0);
        assert.equal(fail.err(), 'GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or case ids from GitHub.\n');
        assert.deepEqual(fail.sent(), { version: 'v1', commit_sha: HEAD });
        const off = alias({ event: EVENT });
        assert.equal(await runReleaseAlias(argv, { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, off.deps), 0);
        assert.equal(off.err(), 'GitHub: could not request failed; the release is recorded without changes or case ids from GitHub.\n');
    });

    test('neither token is ever printed, even when a server or fetch message quotes it', async () => {
        const quote = `Bearer ${TOKEN} / ${GH_TOKEN}xyz`;
        for (const o of [{ status: 400, answer: { error: 'bad_request', message: quote } }, { throws: `fetch failed ${quote}` }]) {
            const h = alias(o);
            assert.equal(await runReleaseAlias(['--version', 'v1', '--github-changes', '--sha', HEAD], { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, h.deps), 1);
            assert.ok(!h.err().includes(TOKEN) && !h.err().includes(GH_TOKEN), h.err());
            assert.match(h.err(), /Bearer \[token\] \/ \[token\]xyz/);
        }
    });
});

describe('the sequential-release executable (build/src/release-bin.js)', () => {
    const BIN = join(__dirname, '../src/release-bin.js');
    const run = (args: string[], env: Record<string, string> = {}) =>
        spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, timeout: 20_000 });

    test('no token: exit 1, the old line, nothing on stdout', () => {
        const r = run(['--version', 'v1'], { SEQUENTIAL_TOKEN: TOKEN });
        assert.equal(r.status, 1);
        assert.equal(r.stdout, '');
        assert.equal(r.stderr, 'SEQUENTIAL_RELEASES_TOKEN is required: a project access token (sq_pat_…) with the releases:write scope, made for one project.\n');
    });

    test('a usage mistake is exit 1 (never 2); --help is an unknown option (exit 1), as in 0.2.1', () => {
        assert.equal(run(['--nope'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN }).status, 1);
        const h = run(['--help'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN });
        assert.deepEqual([h.status, h.stdout, h.stderr], [1, '', `Unknown option: --help\n${ALIAS_USAGE}\n`]);
    });

    test('a host that refuses the connection: exit 1, "fetch failed", no ExperimentalWarning, the token never printed', () => {
        const r = run(['--version', 'v1', '--host', 'http://127.0.0.1:9'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN });
        assert.equal(r.status, 1, r.stderr);
        assert.equal(r.stderr, 'fetch failed\n');
        assert.ok(!r.stderr.includes(TOKEN.slice(7)) && !r.stdout.includes(TOKEN.slice(7)));
    });
});

// ---- independent review of PR #3 (wf_50c1df2a-979) ----
describe('review fixes', () => {
    test('--range honours --project-key: qualified trailers count, unqualified do not', async () => {
        const h = harness({ git: () => 'Sequential-Finding: F-1, web#F-2\n' });
        assert.equal(await main(rel('--version', 'v', '--range', 'a..b', '--project-key', 'web'), ENV, h.io), 0);
        assert.deepEqual(h.sent().finding_ids, ['F-2']);
    });

    test('Ctrl-C during the GitHub reads: only "Cancelled.", never "the release is recorded …"', async () => {
        const ctl = new AbortController();
        const h = harness({ io: { signal: ctl.signal } });
        h.io.fetch = (async (_u: string, init: { signal: AbortSignal }) => {
            setImmediate(() => ctl.abort());
            return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        }) as unknown as FetchLike;
        assert.equal(await main(rel(...GH_ARGS), { ...GH_ENV }, h.io), 1);
        assert.ok(!h.err.join('\n').includes('is recorded'), h.err.join('|'));
        assert.equal(h.calls().length, 0);
    });
});
