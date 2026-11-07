import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, type Io } from '../src/cli';
import { TERMS_PENDING_LINE } from '../src/errors';
import type { FetchLike } from '../src/transport';

// The server refuses a token's reads while the PERSON who made it still owes the trial's terms (BE src/trial/terms-gate.ts
// answerTermsPending, reached through src/auth/token-auth.ts on /mcp and on REST routes such as GET /api/token/self):
// HTTP 403 { error: 'terms_pending', message, project_id, organization_id }. The CLI says what to do in one plain line,
// exit 4 (the token cannot do this now). Then the try-later answers (429, 503): exit 5 with the wait, never a retry.
const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };
const TERMS = { error: 'terms_pending', message: 'Accept the trial terms and DPA for this project first.', project_id: 'p_1', organization_id: 'o_1' };

function fake(status: number, body: unknown, headers: Record<string, string> = {}, opts: Partial<Io> = {}) {
    const seen: Array<{ url: string; method: string }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const fetch = (async (url: string, init: { method: string }) => {
        seen.push({ url, method: init.method });
        return { status, text: async () => JSON.stringify(body), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
    }) as unknown as FetchLike;
    const io: Io = {
        fetch, out: (l) => out.push(l), err: (l) => err.push(l), stdoutTTY: false, interactive: false,
        projectFs: { cwd: '/x', home: '/x', uid: null, lstat: () => null, exists: () => false, read: () => '' }, ...opts,
    };
    return { io, seen, out, err };
}

const LINE = `sequential: ${TERMS_PENDING_LINE} (terms_pending)`;

test('the line says who does what: the token\'s maker accepts the trial\'s terms in Sequential, then the same command works', () => {
    assert.match(TERMS_PENDING_LINE, /person who made this token/);
    assert.match(TERMS_PENDING_LINE, /sign in to Sequential and accept/);
    assert.match(TERMS_PENDING_LINE, /then the same command works/);
    assert.ok(!TERMS_PENDING_LINE.includes('\n'));
});

test('terms_pending on /mcp: releases record, changes record, changes sync: the one line, exit 4, one request', async () => {
    for (const argv of [
        ['releases', 'record', '--version', 'v1'],
        ['changes', 'record', '--kind', 'product', '--title', 'Clearer checkout errors'],
    ]) {
        const h = fake(403, TERMS);
        assert.equal(await main(argv, ENV, h.io), 4, argv.join(' '));
        assert.equal(h.err.at(-1), LINE, argv.join(' '));
        assert.deepEqual(h.out, []);
        assert.equal(h.seen.length, 1);
    }
    const s = fake(403, TERMS, {}, { readText: () => JSON.stringify([{ kind: 'product', title: 'x', external_id: 'e1' }]) });
    assert.equal(await main(['changes', 'sync', '--items', 'f.json'], ENV, s.io), 4);
    assert.equal(s.err.at(-1), LINE);
});

test('terms_pending with --json (releases record, changes record, changes sync, whoami): the JSON error carries the line as message, exit 4', async () => {
    const want = { error: 'terms_pending', message: TERMS_PENDING_LINE };
    for (const argv of [
        ['releases', 'record', '--version', 'v1', '--json'],
        ['changes', 'record', '--kind', 'product', '--title', 'Clearer checkout errors', '--json'],
        ['whoami', '--json'],
    ]) {
        const h = fake(403, TERMS);
        assert.equal(await main(argv, ENV, h.io), 4, argv.join(' '));
        assert.deepEqual(JSON.parse(h.err.at(-1)!), want, argv.join(' '));
        assert.deepEqual(h.out, []);
        assert.equal(h.seen.length, 1);
    }
    const s = fake(403, TERMS, {}, { readText: () => JSON.stringify([{ kind: 'product', title: 'x', external_id: 'e1' }]) });
    assert.equal(await main(['changes', 'sync', '--items', 'f.json', '--json'], ENV, s.io), 4);
    assert.deepEqual(JSON.parse(s.err.at(-1)!), want);
});

test('terms_pending on REST: whoami (GET /api/token/self): the same line, exit 4', async () => {
    const h = fake(403, TERMS);
    assert.equal(await main(['whoami'], ENV, h.io), 4);
    assert.equal(h.err.at(-1), LINE);
    assert.deepEqual([h.seen.length, h.seen[0].method, new URL(h.seen[0].url).pathname], [1, 'GET', '/api/token/self']);
});

test('terms_pending on tools and call: the line on a terminal; in a pipe the JSON error carries it as message; exit 4', async () => {
    const t = fake(403, TERMS, {}, { stdoutTTY: true });
    assert.equal(await main(['tools'], ENV, t.io), 4);
    assert.equal(t.err.at(-1), LINE);
    const c = fake(403, TERMS, {}, { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, c.io), 4);
    assert.equal(c.err.at(-1), LINE);
    const p = fake(403, TERMS);
    assert.equal(await main(['call', 'list_findings'], ENV, p.io), 4);
    assert.deepEqual(JSON.parse(p.err.at(-1)!), { error: 'terms_pending', message: TERMS_PENDING_LINE });
});

test('another 403 keeps the server\'s message (only terms_pending gets the line)', async () => {
    const h = fake(403, { error: 'insufficient_scope', message: 'This token lacks the changes:write scope' });
    assert.equal(await main(['changes', 'record', '--kind', 'product', '--title', 'x'], ENV, h.io), 4);
    assert.equal(h.err.at(-1), 'sequential: This token lacks the changes:write scope (insufficient_scope)');
});

test('try later (429, 503): exit 5 with retry_after_sec (the body, else Retry-After), and exactly one request: the CLI never retries', async () => {
    for (const [status, body, headers, wait] of [
        [429, { error: 'rate_limited', message: 'Too many requests for this project. Try again shortly.', retry_after_sec: 30 }, {}, 30],
        [503, { error: 'auth_unavailable', message: 'Sequential could not check this token right now.' }, { 'retry-after': '7' }, 7],
        [503, { error: 'rate_limit_unavailable', message: 'Try again shortly.', retry_after_sec: 5 }, {}, 5],
    ] as const) {
        const h = fake(status, body, headers);
        assert.equal(await main(['releases', 'record', '--version', 'v1'], ENV, h.io), 5, String(status));
        assert.equal(h.err.at(-1), `sequential: ${body.message} (${body.error}) Try again in ${wait} s.`);
        assert.equal(h.seen.length, 1, 'no retry');
        const j = fake(status, body, headers);
        assert.equal(await main(['releases', 'record', '--version', 'v1', '--json'], ENV, j.io), 5);
        assert.deepEqual(JSON.parse(j.err.at(-1)!), { error: body.error, retry_after_sec: wait });
        assert.equal(j.seen.length, 1, 'no retry');
        const c = fake(status, body, headers);
        assert.equal(await main(['call', 'list_findings'], ENV, c.io), 5);
        assert.equal(JSON.parse(c.err.at(-1)!).retry_after_sec, wait);
        assert.equal(c.seen.length, 1, 'no retry (the tool list is the one request)');
    }
});
