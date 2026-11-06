import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { main, type Io } from '../src/cli';
import { runReleaseAlias } from '../src/release/alias';
import type { FetchLike } from '../src/transport';

// `sequential releases record` with the options of @usesequential/release-cli (--title, --range, --github-changes, --base,
// --project-key, --findings), and its old bin `sequential-release`. Ported from that package's tests/cli/cli.test.ts and
// release.test.ts. The old CLI POSTed /api/releases; the new path is the record_release tool over MCP, so these pins
// read the tools/call body.
const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const OTHER = 'sq_pat_' + 'Z9y8X7w6'.repeat(4);
const GH_TOKEN = 'ghs_fake_workflow_token';
const HEAD = 'a'.repeat(40);
const PREV = 'b'.repeat(40);

type GitHubRoute = (path: string) => { status?: number; body: unknown } | 'throw';
interface Seen { url: string; method: string; headers: Record<string, string>; redirect: string; body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null }

const ok = (v: unknown) => ({ jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
const toolErr = (text: string) => ({ jsonrpc: '2.0', result: { content: [{ type: 'text', text }], isError: true } });
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
        assert.deepEqual(h.out, ['recorded release v', 'environment production, released at 2026-11-02T10:00:00.000Z', 'Recorded release fe@2 (no findings named)']);
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
        assert.equal(h.out.at(-1), 'Recorded release v1 (no findings named)');
    });
});

describe('releases record --range', () => {
    test('names the findings of the trailers, and passes the range as ONE argv element to git (never a shell string)', async () => {
        const h = harness({ git: () => 'fix: x\n\nSequential-Finding: F-1, F-4\n' });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'v1.0.0..v1.1.0'), ENV, h.io), 0);
        assert.deepEqual(h.gitCalls, [['log', '--format=%B', 'v1.0.0..v1.1.0']]);
        assert.deepEqual(h.sent().finding_ids, ['F-1', 'F-4']);
        assert.equal(h.out.at(-1), 'Recorded release fe@2 (2 findings: F-1, F-4)');
    });

    test('trailer ids are sent after the --finding flags, each once, at most 50 (the flags first)', async () => {
        const many = Array.from({ length: 60 }, (_, i) => `Sequential-Finding: F-${i + 1}`).join('\n');
        const h = harness({ git: () => many });
        assert.equal(await main(rel('--version', 'fe@2', '--range', 'a..b', '--finding', 'F-77', '--finding', 'F-3', '--finding', 'F-77'), ENV, h.io), 0);
        const ids = h.sent().finding_ids as string[];
        assert.equal(ids.length, 50);
        assert.deepEqual(ids.slice(0, 4), ['F-77', 'F-3', 'F-1', 'F-2']);
        assert.equal(new Set(ids).size, 50);
        assert.match(h.out.at(-1)!, /^Recorded release fe@2 \(50 findings: F-77, F-3, F-1, /);
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
            assert.equal(h.out.at(-1), 'Recorded release fe@2 (1 finding: F-3)');
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
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (2 findings: F-1, F-12; 1 change since bbbbbbb)`);
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

    test('a failed compare: one line on stderr, and the release is recorded without changes or finding ids from GitHub', async () => {
        const h = harness({ github: (p) => (p.includes('/compare/') ? { status: 404, body: { message: 'No common ancestor' } } : github(p)), event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--finding', 'F-9'), GH_ENV, h.io), 0);
        assert.equal(h.err.at(-1), 'GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or finding ids from GitHub.');
        const sent = h.sent();
        assert.equal('changes' in sent, false);
        assert.deepEqual(sent.finding_ids, ['F-9']); // the caller's own flags still go
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (1 finding: F-9)`);
    });

    test('GitHub not reached (or a redirect): "could not request failed", the old wording; the release is recorded', async () => {
        const h = harness({ github: () => 'throw', event: EVENT });
        assert.equal(await main(rel(...GH_ARGS), GH_ENV, h.io), 0);
        assert.equal(h.err.at(-1), 'GitHub: could not request failed; the release is recorded without changes or finding ids from GitHub.');
        assert.equal(h.calls().length, 1);
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (no findings named)`);
    });

    test('no GITHUB_TOKEN: says so, and records the release (one request: Sequential)', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS), { ...GH_ENV, GITHUB_TOKEN: '' }, h.io), 0);
        assert.match(h.err.at(-1)!, /^GitHub: GITHUB_TOKEN is not set: pass it to the step .*; the release is recorded without changes or finding ids from GitHub\.$/);
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
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (no findings named; 0 changes from aaaaaaa alone (no earlier release found))`);
    });

    test('--base <sha> compares with it, without reading deployments', async () => {
        const h = harness({ github, event: EVENT });
        assert.equal(await main(rel(...GH_ARGS, '--base', PREV), GH_ENV, h.io), 0);
        assert.ok(!h.gets().some((g) => g.url.includes('/deployments')));
        assert.equal(h.out.at(-1), `Recorded release ${HEAD} (2 findings: F-1, F-12; 1 change since bbbbbbb)`);
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

describe('sequential-release (the old bin)', () => {
    const RENV = { SEQUENTIAL_RELEASES_TOKEN: TOKEN };

    test('success: the old line only, nothing on stderr; the hosted API by default (SEQUENTIAL_API_URL unset or empty)', async () => {
        for (const env of [RENV, { ...RENV, SEQUENTIAL_API_URL: '' }]) {
            const h = harness();
            assert.equal(await runReleaseAlias(['--version', 'fe@2'], env, h.io), 0);
            assert.deepEqual([h.out, h.err], [['Recorded release fe@2 (no findings named)'], []]);
            assert.equal(h.seen[0].url, 'https://api.usesequential.com/mcp');
            assert.deepEqual(h.calls()[0].body!.params, { name: 'record_release', arguments: { version: 'fe@2' } });
        }
    });

    test('reads SEQUENTIAL_RELEASES_TOKEN only: SEQUENTIAL_TOKEN (the changes token) is never used', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_TOKEN: TOKEN }, h.io), 1);
        assert.deepEqual(h.err, ['SEQUENTIAL_RELEASES_TOKEN is required: a project access token (sq_pat_…) with the releases:write scope, made for one project.']);
        assert.deepEqual([h.out, h.seen.length], [[], 0]);
        const h2 = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_RELEASES_TOKEN: OTHER, SEQUENTIAL_TOKEN: TOKEN }, h2.io), 0);
        assert.equal(h2.seen[0].headers.authorization, `Bearer ${OTHER}`);
    });

    test('a token that is not a project access token: exit 1, nothing sent', async () => {
        for (const t of ['sqs_' + 'x'.repeat(40), 'sq_pat_short']) {
            const h = harness();
            assert.equal(await runReleaseAlias(['--version', 'v1'], { SEQUENTIAL_RELEASES_TOKEN: t }, h.io), 1);
            assert.equal(h.seen.length, 0);
            assert.ok(!h.printed().includes(t));
        }
    });

    test('SEQUENTIAL_API_URL: https, or http only to this machine (a trailing slash is fine); else exit 1 before any request', async () => {
        const bad = harness();
        assert.equal(await runReleaseAlias(['--version', 'fe@2'], { ...RENV, SEQUENTIAL_API_URL: 'http://api.example.com' }, bad.io), 1);
        assert.match(bad.err.join('\n'), /--host or SEQUENTIAL_API_URL\) must be https/);
        assert.equal(bad.seen.length, 0);
        for (const [api, url] of [
            ['http://localhost:3000', 'http://localhost:3000/mcp'],
            ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000/mcp'],
            ['https://seq.example.test', 'https://seq.example.test/mcp'],
        ]) {
            const h = harness();
            assert.equal(await runReleaseAlias(['--version', 'fe@2'], { ...RENV, SEQUENTIAL_API_URL: api }, h.io), 0, api);
            assert.equal(h.seen[0].url, url);
        }
    });

    test('--host sets the API (before SEQUENTIAL_API_URL), anywhere in the line, with the same https rule', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--host', 'https://seq.example.test/'], { ...RENV, SEQUENTIAL_API_URL: 'https://other.example.test' }, h.io), 0);
        assert.equal(h.seen[0].url, 'https://seq.example.test/mcp');
        const h2 = harness();
        assert.equal(await runReleaseAlias(['--host=https://seq.example.test', '--version', 'v1'], RENV, h2.io), 0);
        assert.equal(h2.seen[0].url, 'https://seq.example.test/mcp');
        const bad = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--host', 'http://seq.example.test'], RENV, bad.io), 1);
        assert.match(bad.err.join('\n'), /--host or SEQUENTIAL_API_URL\) must be https/);
        assert.equal(bad.seen.length, 0);
    });

    test('--commit-sha is the flag; --sha is its alias', async () => {
        for (const argv of [['--commit-sha', 'abc1234'], ['--sha', 'abc1234'], ['--sha=abc1234']]) {
            const h = harness();
            assert.equal(await runReleaseAlias(['--version', 'v1', ...argv], RENV, h.io), 0);
            assert.equal(h.sent().commit_sha, 'abc1234');
        }
    });

    test('exit 0 or 1 only: usage mistakes, refusals, not reached, a missing right and try-later are all 1', async () => {
        const cases: Array<[string, string[], Parameters<typeof harness>[0]]> = [
            ['no --version', [], {}],
            ['an unknown option', ['--version', 'fe@2', '--nope', 'x'], {}],
            ['a subcommand word', ['release', '--version', 'v1'], {}],
            ['a refusal', ['--version', 'bad version'], { mcp: toolErr('version: 1-64 printable characters') }],
            ['not reached', ['--version', 'fe@2'], { mcpThrows: true }],
            ['a gateway 502', ['--version', 'fe@2'], { mcp: 'gateway down', mcpStatus: 502 }],
            ['no right', ['--version', 'fe@2'], { mcp: toolErr('Tool not available for this token') }],
            ['try later', ['--version', 'fe@2'], { mcp: toolErr(JSON.stringify({ error: 'daily_cap', message: 'later', retry_after_sec: 60 })) }],
        ];
        for (const [why, argv, o] of cases) {
            const h = harness(o);
            assert.equal(await runReleaseAlias(argv, RENV, h.io), 1, why);
            assert.deepEqual(h.out, [], why);
            assert.ok(h.err.length >= 1, why);
            assert.ok(!h.printed().includes(TOKEN.slice(7)), why);
        }
        const word = harness();
        await runReleaseAlias(['release', '--version', 'v1'], RENV, word.io);
        assert.match(word.err.join('\n'), /release/);
        const unknown = harness();
        await runReleaseAlias(['--version', 'fe@2', '--nope', 'x'], RENV, unknown.io);
        assert.match(unknown.err.join('\n'), /--nope/);
        const right = harness({ mcp: toolErr('Tool not available for this token') });
        await runReleaseAlias(['--version', 'fe@2'], RENV, right.io);
        assert.equal(right.err.at(-1), 'sequential: the token in SEQUENTIAL_RELEASES_TOKEN cannot do this: releases record needs releases:write.');
    });

    test('--range: the trailers, and the old line', async () => {
        const h = harness({ git: () => 'fix: x\n\nSequential-Finding: F-1, F-4\n' });
        assert.equal(await runReleaseAlias(['--version', 'fe@2', '--range', 'v1..v2'], RENV, h.io), 0);
        assert.deepEqual(h.gitCalls, [['log', '--format=%B', 'v1..v2']]);
        assert.deepEqual(h.out, ['Recorded release fe@2 (2 findings: F-1, F-4)']);
    });

    test('--github-changes with --sha: the same as releases record, the old line', async () => {
        const h = harness({ github, event: EVENT });
        const argv = ['--version', HEAD, '--sha', HEAD, '--github-changes'];
        assert.equal(await runReleaseAlias(argv, { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, h.io), 0);
        assert.deepEqual(h.out, [`Recorded release ${HEAD} (2 findings: F-1, F-12; 1 change since bbbbbbb)`]);
        assert.deepEqual(h.err, []);
        const fail = harness({ github: (p) => (p.includes('/compare/') ? { status: 404, body: {} } : github(p)), event: EVENT });
        assert.equal(await runReleaseAlias(argv, { ...GH_ENV, SEQUENTIAL_RELEASES_TOKEN: TOKEN }, fail.io), 0);
        assert.deepEqual(fail.err, ['GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or finding ids from GitHub.']);
    });

    test('no project from SEQUENTIAL_PROJECT or .sequential.json (the old CLI had none); --project is sent', async () => {
        const fs: Io['projectFs'] = { cwd: '/r', home: '/h', uid: null, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, uid: 0 }), exists: () => true, read: () => '{"project":"from-file"}' };
        // Positive control: `sequential releases record` reads that file.
        const control = harness({ io: { projectFs: fs } });
        assert.equal(await main(rel('--version', 'v1'), ENV, control.io), 0);
        assert.equal(control.sent().project, 'from-file');
        const h = harness({ io: { projectFs: fs } });
        assert.equal(await runReleaseAlias(['--version', 'v1'], RENV, h.io), 0);
        assert.equal('project' in h.sent(), false);
        const he = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1'], { ...RENV, SEQUENTIAL_PROJECT: 'web' }, he.io), 0);
        assert.equal('project' in he.sent(), false);
        const h2 = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--project', 'web'], RENV, h2.io), 0);
        assert.equal(h2.sent().project, 'web');
    });

    test('--help: the old usage, exit 0, no token needed', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--help'], {}, h.io), 0);
        assert.match(h.out[0], /^Usage: sequential-release --version <v>/);
        assert.equal(h.seen.length, 0);
    });

    test('the token is never printed: success, refusal, network failure', async () => {
        for (const o of [{}, { mcp: toolErr(JSON.stringify({ error: 'bad_request', message: 'no' })) }, { mcpThrows: true }]) {
            const h = harness(o);
            await runReleaseAlias(['--version', 'fe@2'], RENV, h.io);
            assert.ok(!h.printed().includes(TOKEN.slice(7)));
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

    test('a usage mistake is exit 1 (never 2); --help is 0', () => {
        assert.equal(run(['--nope'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN }).status, 1);
        assert.equal(run(['--help']).status, 0);
    });

    test('a host that refuses the connection: exit 1, no ExperimentalWarning, the token never printed', () => {
        const r = run(['--version', 'v1', '--host', 'http://127.0.0.1:9'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN });
        assert.equal(r.status, 1, r.stderr);
        assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
        assert.match(r.stderr, /not reached/);
        assert.ok(!r.stderr.includes(TOKEN.slice(7)) && !r.stdout.includes(TOKEN.slice(7)));
    });
});

// ---- independent review of PR #3 (wf_50c1df2a-979) ----
describe('review fixes', () => {
    test('sequential-release: a value may start with "--", and a repeated flag keeps its last value (as 0.2.x)', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--title', '--no-verify cleanup', '--environment', 'staging', '--environment', 'production'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN }, h.io), 0);
        const a = h.sent();
        assert.equal(a.title, '--no-verify cleanup');
        assert.equal(a.environment, 'production');
    });

    test('sequential-release: --host only in a flag position; a value "--host=…" is a title, and the token stays home', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--version', 'v1', '--title', '--host=https://evil.example'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN }, h.io), 0);
        assert.equal(h.sent().title, '--host=https://evil.example');
        assert.ok(h.seen.every((s) => s.url.startsWith('https://api.usesequential.com/')));
    });

    test('sequential-release: a non-default host is named on stderr', async () => {
        const h = harness();
        assert.equal(await runReleaseAlias(['--version', 'v'], { SEQUENTIAL_RELEASES_TOKEN: TOKEN, SEQUENTIAL_API_URL: 'https://seq.example.test' }, h.io), 0);
        assert.deepEqual(h.err, ['sequential: sending the token to https://seq.example.test, not https://api.usesequential.com']);
    });

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
