import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, type Io } from '../src/cli';
import { askYesNo, type YesNoInterface } from '../src/prompt';
import { stripControls, ttySafeJson } from '../src/text';
import { classifyHttp } from '../src/errors';
import { readCapped, type FetchLike } from '../src/transport';

// mgmt's review of PR #1/#2 (2026-11-06 ~20:55Z): each confirmed or likely finding, pinned.
const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };
const LIST = { tools: [
    { name: 'list_findings', title: 'List findings', description: 'd', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'w\u001b[2J‮x', title: 'Write', description: 'd', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
] };

function io(answer: (method: string, body: { id: number }) => { status?: number; text: string; body?: ReadableStream<Uint8Array>; headers?: Record<string, string> } | Promise<never>, opts: Partial<Io> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const fetch: FetchLike = async (_u, init) => {
        const b = JSON.parse(init.body);
        const r = await answer(b.method, b);
        return { status: r.status ?? 200, text: async () => r.text, ...(r.body ? { body: r.body } : {}), headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null } };
    };
    return { out, err, io: { fetch, out: (l: string) => out.push(l), err: (l: string) => err.push(l), stdoutTTY: false, interactive: false, projectFs: { cwd: '/x', home: '/x', uid: null, lstat: () => null, exists: () => false, read: () => '' }, ...opts } as Io };
}
const listOk = (b: { id: number }) => ({ text: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: LIST }) });

test('1) the size cap counts decoded bytes of a stream with no content-length, and gives up past it', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { sent++; c.enqueue(chunk); if (sent > 50) c.close(); } });
    const ctl = new AbortController();
    assert.equal(await readCapped({ text: async () => { throw new Error('text() must not be used'); }, body: stream }, ctl, 8 * 1024 * 1024), null);
    assert.ok(sent <= 10, `read ${sent} MiB before giving up`);
    assert.equal(ctl.signal.aborted, true);
    const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"é"}')); c.close(); } });
    assert.equal(await readCapped({ text: async () => '', body: small }, new AbortController()), '{"a":"é"}');
});

test('2) Ctrl-C, or the end of input, at the [y/N] prompt is a no; only y or yes is a yes', async () => {
    const fake = () => {
        const h: Record<string, () => void> = {};
        let ask: (a: string) => void = () => undefined;
        let closed = 0;
        const rl: YesNoInterface = { question: (_q, cb) => { ask = cb; }, on: (e, cb) => { h[e] = cb; return rl; }, close: () => { closed++; } };
        return { rl, h, answer: (a: string) => ask(a), closed: () => closed };
    };
    const a = fake(); const pa = askYesNo('?', a.rl); a.h.SIGINT(); assert.equal(await pa, false); assert.equal(a.closed(), 1);
    const b = fake(); const pb = askYesNo('?', b.rl); b.h.close(); assert.equal(await pb, false);
    const c = fake(); const pc = askYesNo('?', c.rl); c.answer('yes'); assert.equal(await pc, true);
    const d = fake(); const pd = askYesNo('?', d.rl); d.answer('yep'); assert.equal(await pd, false);
});

test('3) the tool name is stripped in the confirm prompt and in the stderr line', async () => {
    let asked = '';
    const h = io((m, b) => (m === 'tools/list' ? listOk(b) : { text: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: '{}' }] } }) }), { interactive: true, confirm: async (q) => ((asked = q), false) });
    await main(['call', 'w\u001b[2J‮x'], ENV, h.io);
    assert.ok(!/[\u001b‮]/.test(asked), asked);
    const h2 = io((m, b) => (m === 'tools/list' ? listOk(b) : { text: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: '{}' }] } }) }));
    await main(['call', 'w\u001b[2J‮x', '--yes'], ENV, h2.io);
    assert.ok(h2.err.every((l) => !/[\u001b‮]/.test(l)), h2.err.join('|'));
});

test('--json on a terminal escapes C1, bidi and tag characters; it parses to the same value; in a pipe the bytes are kept', async () => {
    const evil = 'a\u009b2J‮b\u{e0041}c';
    const answer = (m: string, b: { id: number }) => (m === 'tools/list' ? listOk(b) : { text: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: JSON.stringify({ t: evil }) }] } }) });
    const tty = io(answer, { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings', '--json'], ENV, tty.io), 0);
    assert.ok(!/[\u009b‮]/u.test(tty.out[0]) && !/\u{e0041}/u.test(tty.out[0]), tty.out[0]);
    assert.equal(JSON.parse(tty.out[0]).t, evil);
    const pipe = io(answer);
    await main(['call', 'list_findings'], ENV, pipe.io);
    assert.equal(JSON.parse(pipe.out[0]).t, evil);
    assert.equal(ttySafeJson('"\u{e0041}"'), '"\\udb40\\udc41"');
});

test('the strip set covers the tag characters and the interlinear annotation marks', () => {
    assert.equal(stripControls('a\u{e0001}\u{e0041}\u{e007f}b￹c￻d'), 'abcd');
});

test('a gateway 502/503/504 with no JSON body is "try later" (exit 5), with Retry-After when sent', () => {
    for (const st of [502, 503, 504]) {
        const r = classifyHttp(st, '<html>Bad gateway</html>', { retryAfter: st === 503 ? '30' : null });
        assert.ok(!r.ok && r.fail.exit === 5, String(st));
        if (!r.ok && st === 503) assert.equal(r.fail.retryAfterSec, 30);
    }
    const r = classifyHttp(500, '<html>oops</html>');
    assert.ok(!r.ok && r.fail.exit === 1);
});

test('a JSON-RPC RESULT with a null id is not ours (only an error may carry one)', () => {
    const r = classifyHttp(200, JSON.stringify({ jsonrpc: '2.0', id: null, result: { content: [] } }), { sentId: 3 });
    assert.ok(!r.ok && r.fail.code === 'bad_answer');
    const e = classifyHttp(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { sentId: 3 });
    assert.ok(!e.ok && e.fail.code === 'rpc_-32700');
});

test('call --timeout covers the tool-list request too', async () => {
    const h = io(() => new Promise<never>(() => undefined));
    const inner = h.io.fetch;
    h.io.fetch = (u, init) => new Promise((res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); inner(u, init).then(res, rej); });
    const t0 = Date.now();
    assert.equal(await main(['call', 'list_findings', '--timeout', '1'], ENV, h.io), 1);
    assert.ok(Date.now() - t0 < 5000);
    assert.match(h.err.at(-1)!, /No answer within 1 s/);
});
