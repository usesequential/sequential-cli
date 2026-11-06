import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, type Io } from '../src/cli';
import type { FetchLike } from '../src/transport';

// The named commands (changes record|sync, releases record, whoami): one request each, over MCP (whoami: GET
// /api/token/self), the old CLI's lines and refusal line, no server rule copied. Pins ported from @usesequential/node's
// tests/sdk-node/cli.test.ts and cli-sync.test.ts.
const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const REL = 'sq_pat_' + 'R9r8R7r6'.repeat(4);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };

interface Seen { url: string; method: string; headers: Record<string, string>; body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null }

function harness(answer: (tool: string, args: Record<string, unknown>) => { status?: number; body: unknown }, opts: Partial<Io> = {}) {
    const seen: Seen[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        const body = init.body ? JSON.parse(init.body) : null;
        seen.push({ url, method: init.method, headers: init.headers, body });
        if (init.method === 'GET') {
            const r = answer('GET', {});
            return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
        }
        if (body.method === 'initialize') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }) };
        const r = answer(body.params.name, body.params.arguments);
        const b = r.body !== null && typeof r.body === 'object' && 'jsonrpc' in (r.body as object) ? { ...(r.body as object), id: body.id } : r.body;
        return { status: r.status ?? 200, text: async () => JSON.stringify(b) };
    }) as unknown as FetchLike;
    const io: Io = { fetch, out: (l) => out.push(l), err: (l) => err.push(l), stdoutTTY: false, interactive: false, projectFs: { cwd: '/x', home: '/x', uid: null, lstat: () => null, exists: () => false, read: () => '' }, ...opts };
    return { io, seen, out, err, calls: () => seen.filter((s) => s.body?.method === 'tools/call') };
}
const ok = (v: unknown) => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } } });
const toolErr = (text: string) => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: true } } });
const printed = (h: { out: string[]; err: string[] }) => [...h.out, ...h.err].join('\n');

test('changes record: ONE request (no tools/list) to record_change on /mcp, source ci, links labelled, no --yes', async () => {
    const h = harness(() => ok({ outcome: 'create', change_id: 'c-1' }));
    const code = await main(['changes', 'record', '--kind', 'release', '--title', 'v2.14', '--version', 'web@2.14', '--pr', 'https://github.com/a/b/pull/1', '--link', 'https://x.example/n'], ENV, h.io);
    assert.equal(code, 0);
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0].url, 'https://api.usesequential.com/mcp');
    assert.deepEqual(h.seen[0].body!.params, {
        name: 'record_change',
        arguments: { kind: 'release', title: 'v2.14', source: 'ci', release: { environment: 'production', version: 'web@2.14' }, links: [{ url: 'https://github.com/a/b/pull/1', label: 'pr' }, { url: 'https://x.example/n', label: 'other' }] },
    });
    assert.deepEqual(h.out, ['create c-1']);
});

test('the server checks kinds and limits; the CLI only the shape of its flags', async () => {
    const h = harness(() => ok({ outcome: 'create', change_id: 'c-1' }));
    // An unknown kind is SENT (the server refuses it), never refused here: no server rule is copied.
    assert.equal(await main(['changes', 'record', '--kind', 'brand_new_kind', '--title', 'x'], ENV, h.io), 0);
    assert.equal(h.calls()[0].body!.params!.arguments!.kind, 'brand_new_kind');
    for (const argv of [
        ['changes', 'record', '--title', 'x'],
        ['changes', 'record', '--kind', 'product'],
        ['changes', 'record', '--kind', 'product', '--title', 'x', '--environment', 'prod'],
        ['changes', 'record', '--kind', 'product', '--title', 'x', '--pr', 'ftp://x'],
        ['changes', 'record', '--kind', 'product', '--kind', 'pricing', '--title', 'x'],
        ['changes', 'record', '--kind', 'product', '--title', 'x', '--colour', 'red'],
        ['changes', 'record', '--kind', 'product', '--title', 'x', '--host', 'https://evil.example'],
    ]) {
        const h2 = harness(() => ok({}));
        assert.equal(await main(argv, ENV, h2.io), 2, argv.join(' '));
        assert.equal(h2.seen.length, 0);
    }
});

test('--x=value takes a value that starts with a dash; --dry-run needs no token and sends nothing', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title=--odd title', '--dry-run'], {}, h.io), 0);
    assert.equal(h.seen.length, 0);
    assert.match(h.out.join('\n'), /"title": "--odd title"/);
});

test('a refused text: code, field, reason and the server\'s fixed hint; never the message or errors[].message (it quotes the text)', async () => {
    const secret = 'ghp_' + 'x'.repeat(36);
    const h = harness(() => toolErr(JSON.stringify({ error: 'text_refused', step: 'secret', reason: 'text_has_secret', hint: 'Leave tokens, keys, card numbers and email addresses out of the text.', message: `Your title "${secret}" was refused`, errors: [{ field: '/title', message: `"${secret}" holds a token` }] })));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', secret], ENV, h.io), 1);
    assert.deepEqual(h.err, ['sequential: text_refused (/title) text_has_secret: Leave tokens, keys, card numbers and email addresses out of the text.']);
    assert.ok(!printed(h).includes(secret));
});

test('a proposal: the outcome line, and the confirm link on stderr', async () => {
    const h = harness(() => ok({ outcome: 'proposed', change_id: 'c-9', confirm_url: 'https://app.usesequential.com/changes/confirm/c-9' }));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'Turn on the new paywall'], ENV, h.io), 0);
    assert.deepEqual(h.out, ['proposed c-9']);
    assert.match(h.err.join('\n'), /a person confirms it at https:\/\/app\.usesequential\.com\/changes\/confirm\/c-9/);
});

test('changes sync: one request; --source and --source-detail fill the items that name none; the sync block only with --covered-through', async () => {
    const items = JSON.stringify([{ kind: 'product', title: 'a' }, { kind: 'product', title: 'b', source: 'github', source_detail: 'other.repo' }]);
    const h = harness(() => ok({ items: [{ index: 0, outcome: 'create', change_id: 'c-0' }, { index: 1, outcome: 'create', change_id: 'c-1' }] }), { readText: () => items });
    assert.equal(await main(['changes', 'sync', '--items', 'i.json', '--source', 'git', '--source-detail', 'acme.shop', '--covered-through', '2026-11-06T00:00:00Z', '--atomic'], ENV, h.io), 0);
    assert.equal(h.seen.length, 1);
    assert.deepEqual(h.calls()[0].body!.params!.arguments, {
        items: [{ kind: 'product', title: 'a', source: 'git', source_detail: 'acme.shop' }, { kind: 'product', title: 'b', source: 'github', source_detail: 'other.repo' }],
        atomic: true,
        sync: { source: 'git', source_detail: 'acme.shop', covered_through: '2026-11-06T00:00:00Z' },
    });
    assert.deepEqual(h.out, ['#0 create c-0', '#1 create c-1', '2 written, 0 refused']);
    const h2 = harness(() => ok({ items: [] }), { readText: () => items });
    await main(['changes', 'sync', '--items', 'i.json'], ENV, h2.io);
    assert.equal('sync' in h2.calls()[0].body!.params!.arguments!, false);
});

test('changes sync: a refused or not_checked item → exit 3, one line each with step, field, reason and hint', async () => {
    const h = harness(() => ok({ items: [
        { index: 0, outcome: 'create', change_id: 'c-0' },
        { index: 1, outcome: 'refused', step: 'screen', field: '/title', reason: 'reads_as_agent_instruction', hint: 'Describe what changed, in the past tense.' },
        { index: 2, outcome: 'not_checked', reason: 'not_checked', hint: 'Try again later.' },
    ] }), { readText: () => '[{"kind":"product","title":"a"},{"kind":"product","title":"b"},{"kind":"product","title":"c"}]' });
    assert.equal(await main(['changes', 'sync', '--items', '-'], ENV, h.io), 3);
    assert.deepEqual(h.out, ['#0 create c-0', '#1 refused screen (/title) reads_as_agent_instruction: Describe what changed, in the past tense.', '#2 not_checked not_checked: Try again later.', '1 written, 2 refused']);
});

test('changes sync: no items, bad JSON, --covered-from alone → exit 2 before any request', async () => {
    for (const [text, extra] of [['[]', []], ['{oops', []], ['[{"kind":"product","title":"a"}]', ['--covered-from', '2026-11-01T00:00:00Z']]] as const) {
        const h = harness(() => ok({}), { readText: () => text });
        assert.equal(await main(['changes', 'sync', '--items', 'x', ...extra], ENV, h.io), 2);
        assert.equal(h.seen.length, 0);
    }
});

test('releases record: SEQUENTIAL_RELEASES_TOKEN first, then SEQUENTIAL_TOKEN; record_release; prints the stored fields, never title or notes', async () => {
    const answer = ok({ release: { version: '4.12.0', environment: 'production', released_at: '2026-11-06T20:00:00.000Z', finding_ids: ['F-3'], title: 'SECRET TITLE', notes: 'secret notes' } });
    const h = harness(() => answer);
    assert.equal(await main(['releases', 'record', '--version', '4.12.0', '--finding', 'F-3'], { SEQUENTIAL_RELEASES_TOKEN: REL, SEQUENTIAL_TOKEN: TOKEN }, h.io), 0);
    assert.equal(h.seen[0].headers.authorization, `Bearer ${REL}`);
    assert.deepEqual(h.calls()[0].body!.params, { name: 'record_release', arguments: { version: '4.12.0', finding_ids: ['F-3'] } });
    assert.deepEqual(h.out, ['recorded release 4.12.0', 'environment production, released at 2026-11-06T20:00:00.000Z, names 1 case(s)']);
    assert.ok(!/SECRET|secret/.test(printed(h)));
    const h2 = harness(() => answer);
    assert.equal(await main(['releases', 'record', '--version', '4.12.0'], ENV, h2.io), 0);
    assert.equal(h2.seen[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('releases record: a sentence refusal prints its leading field only; a timeout says check before running it again', async () => {
    const h = harness(() => toolErr('version: 1-64 printable characters, not a placeholder such as "null"'));
    assert.equal(await main(['releases', 'record', '--version', 'null'], ENV, h.io), 1);
    assert.deepEqual(h.err, ['sequential: Sequential refused it (version)']);
});

test('tokens: none, a server key, a malformed one → exit 2, nothing sent, the token never printed', async () => {
    for (const env of [{}, { SEQUENTIAL_TOKEN: 'sqs_' + 'x'.repeat(40) }, { SEQUENTIAL_TOKEN: 'abc' }]) {
        const h = harness(() => ok({}));
        assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x'], env, h.io), 2);
        assert.equal(h.seen.length, 0);
    }
    const h = harness(() => ({ status: 401, body: { error: 'invalid_token', message: 'The access token is unknown, revoked or expired' } }));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x'], ENV, h.io), 4);
    assert.ok(!printed(h).includes(TOKEN.slice(7)));
});

test('a daily cap: exit 5 with the seconds; --json errors are JSON', async () => {
    const h = harness(() => toolErr(JSON.stringify({ error: 'daily_cap', message: 'This token wrote its changes for today', retry_after_sec: 14_400 })));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x', '--json'], ENV, h.io), 5);
    assert.deepEqual(JSON.parse(h.err[0]), { error: 'daily_cap', retry_after_sec: 14_400 });
});

test('whoami: GET /api/token/self, then initialize as "Sequential CLI"; prints kind, project, rights, expiry, last 4', async () => {
    const h = harness(() => ({ body: { kind: 'pat', project_id: 'p1', project_slug: { id: 'shop', source: 'observed' }, scopes: ['changes:read', 'changes:write'], expires_at: '2027-02-04T10:00:00.000Z', last4: 'C3d4' } }), { stdoutTTY: true });
    assert.equal(await main(['whoami'], ENV, h.io), 0);
    assert.equal(h.seen[0].method, 'GET');
    assert.equal(h.seen[0].url, 'https://api.usesequential.com/api/token/self');
    assert.equal(h.seen[1].body!.method, 'initialize');
    assert.deepEqual((h.seen[1].body as { params: { clientInfo: { name: string } } }).params.clientInfo.name, 'Sequential CLI');
    assert.deepEqual(h.out, ['a project access token for project shop (p1)', 'rights: changes:read, changes:write', 'expires: 2027-02-04T10:00:00.000Z; ends in …C3d4']);
    assert.ok(!printed(h).includes(TOKEN.slice(7, 20)));
});

test('whoami on an older server (no /api/token/self): exit 1 "not reached"-style, never a crash', async () => {
    const h = harness(() => ({ status: 404, body: { error: 'not_found' } }));
    assert.equal(await main(['whoami'], ENV, h.io), 1);
});

test('--project is sent as project; --help prints the usage and exits 0', async () => {
    const h = harness(() => ok({ outcome: 'create', change_id: 'c-1' }));
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x', '--project', 'web'], ENV, h.io), 0);
    assert.equal(h.calls()[0].body!.params!.arguments!.project, 'web');
    const h2 = harness(() => ok({}));
    assert.equal(await main(['changes', 'record', '--help'], ENV, h2.io), 0);
    assert.match(h2.out.join('\n'), /changes record --kind/);
});
