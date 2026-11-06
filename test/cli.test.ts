import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, type Io } from '../src/cli';
import type { FetchLike } from '../src/transport';

const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };
// Tests run from build/test (compiled), so the fixture is read from the source tree.
const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/agent-tools.json'), 'utf8')) as {
    tools: { name: string; write: boolean; description: string; inputSchema: Record<string, unknown> }[];
};

// The real idempotentHint values (BE findings-tools.ts:123,165; tools/findings.ts:203; changes-write.ts:131-265;
// change-findings.ts:137; review.ts:159). record_release is NOT idempotent: a repeat replaces the marker.
const IDEMPOTENT = new Set(['get_fix_brief', 'link_fix', 'record_change', 'record_changes', 'update_change', 'retract_change', 'link_change_to_finding', 'review_session']);

/** tools/list as the server builds it for a token: annotations from `write` (get_fix_brief: readOnlyHint false, the
 *  hand-off mark), plus one stub for a tool the token lacks. */
function toolsList(names?: string[]) {
    const tools = fixture.tools
        .filter((t) => (!names || names.includes(t.name)) && t.name !== 'send_feedback') // a stub only stands in for a tool the token lacks
        .map((t) => ({
            name: t.name,
            title: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !t.write && t.name !== 'get_fix_brief', idempotentHint: IDEMPOTENT.has(t.name) },
        }));
    tools.push({
        name: 'send_feedback',
        title: 'Send feedback (not enabled)',
        description: 'Not enabled on this connection: call it for the steps to turn it on.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, idempotentHint: true },
    });
    return { tools };
}

interface Seen { url: string; headers: Record<string, string>; body: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } }; redirect: string }

function harness(onCall: (name: string, args: Record<string, unknown>, url: string) => { status?: number; body: unknown } | Promise<never>, opts: Partial<Io> = {}) {
    const seen: Seen[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const fetch: FetchLike = async (url, init) => {
        const body = JSON.parse(init.body);
        seen.push({ url, headers: init.headers, body, redirect: init.redirect });
        if (body.method === 'tools/list') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toolsList() }) };
        const r = await onCall(body.params.name, body.params.arguments, url);
        // The real server echoes the request id (null only for refusals made before the transport).
        const answer = r.body !== null && typeof r.body === 'object' && 'jsonrpc' in (r.body as object) && (r.body as { id: unknown }).id === 1 ? { ...(r.body as object), id: body.id } : r.body;
        return { status: r.status ?? 200, text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) };
    };
    const io: Io = { fetch, out: (l) => out.push(l), err: (l) => err.push(l), stdoutTTY: false, interactive: false, ...opts };
    return { io, seen, out, err, calls: () => seen.filter((s) => s.body.method === 'tools/call') };
}

const ok = (value: unknown) => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } });
const toolErr = (text: string) => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: true } } });

function noTokenPrinted(h: { out: string[]; err: string[] }) {
    for (const l of [...h.out, ...h.err]) assert.ok(!l.includes(TOKEN) && !l.includes(TOKEN.slice(7)), `token printed: ${l}`);
}

test('a read tool: /mcp/readonly, MCP headers, no redirects, JSON on stdout', async () => {
    const h = harness(() => ok({ total: 0, findings: [] }));
    const code = await main(['call', 'list_findings', '--status', 'all', '--limit', '5'], ENV, h.io);
    assert.equal(code, 0);
    const [list, call] = h.seen;
    assert.equal(list.url, 'https://api.usesequential.com/mcp');
    assert.equal(call.url, 'https://api.usesequential.com/mcp/readonly');
    assert.equal(call.headers.accept, 'application/json, text/event-stream');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.redirect, 'error');
    assert.deepEqual(call.body.params, { name: 'list_findings', arguments: { status: 'all', limit: 5 } });
    assert.deepEqual(JSON.parse(h.out[0]), { total: 0, findings: [] });
    noTokenPrinted(h);
});

test('no token, a server key, or a malformed token: exit 2 and no request', async () => {
    for (const env of [{}, { SEQUENTIAL_TOKEN: 'sqs_' + 'x'.repeat(40) }, { SEQUENTIAL_TOKEN: 'abc' }]) {
        const h = harness(() => ok({}));
        assert.equal(await main(['call', 'list_findings'], env, h.io), 2);
        assert.equal(h.seen.length, 0);
    }
});

test('a write off a terminal needs --yes; with it, it goes to /mcp', async () => {
    const h = harness(() => ok({ outcome: 'written', id: 'c1' }));
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'Trial is now 14 days'], ENV, h.io), 2);
    assert.equal(h.calls().length, 0);
    assert.match(h.err.join('\n'), /add --yes/);
    const h2 = harness(() => ok({ outcome: 'written', id: 'c1' }));
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'Trial is now 14 days', '--yes'], ENV, h2.io), 0);
    assert.equal(h2.calls()[0].url, 'https://api.usesequential.com/mcp');
});

test('get_fix_brief counts as a write (readOnlyHint false); its Markdown comes back as {markdown} in JSON', async () => {
    const h = harness(() => ok('# Brief\n\nText'));
    assert.equal(await main(['call', 'get_fix_brief', '--number', '3'], ENV, h.io), 2);
    const h2 = harness(() => ok('# Brief\n\nText'));
    assert.equal(await main(['call', 'get_fix_brief', '--number', '3', '--yes'], ENV, h2.io), 0);
    assert.deepEqual(JSON.parse(h2.out[0]), { markdown: '# Brief\n\nText' });
});

test('a write on a terminal asks; "no" sends nothing', async () => {
    let asked = '';
    const h = harness(() => ok({}), { interactive: true, confirm: async (q) => ((asked = q), false) });
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x', '--project', 'web'], ENV, h.io), 2);
    assert.match(asked, /record_change on project web/);
    assert.equal(h.calls().length, 0);
});

test('a stub: its steps, exit 4, no call', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'send_feedback'], ENV, h.io), 4);
    assert.equal(h.calls().length, 0);
    assert.match(h.err.at(-1)!, /Not enabled on this connection/);
});

test('tools: stubs listed apart, not as callable', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['tools', '--json'], ENV, h.io), 0);
    const j = JSON.parse(h.out[0]);
    assert.ok(!j.tools.some((t: { name: string }) => t.name === 'send_feedback'));
    assert.deepEqual(j.not_enabled, ['send_feedback']);
    assert.equal(j.tools.find((t: { name: string }) => t.name === 'get_change_schema').write, false, 'an empty schema alone is no stub');
});

test('argument binding from the schema: kebab or snake, --no-x, repeated arrays, types checked before a request', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_sessions', '--has-errors', '--no-judged_only', '--limit', '7'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments, { has_errors: true, judged_only: false, limit: 7 });
    const h2 = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--limit', 'ten'], ENV, h2.io), 2);
    assert.equal(h2.calls().length, 0);
    const h3 = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--colour', 'red'], ENV, h3.io), 2);
    assert.match(h3.err.at(-1)!, /has no argument --colour\. Its arguments: --muted --status --limit --offset/);
    const h4 = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--status', 'maybe'], ENV, h4.io), 2);
});

test('an unknown tool: exit 2, no call', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'drop_tables'], ENV, h.io), 2);
    assert.equal(h.calls().length, 0);
});

test('layer 1 (the auth gate): 401 → 4, 429 with retry → 5', async () => {
    const h = harness(() => ({ status: 401, body: { error: 'invalid_token', message: 'The access token is unknown, revoked or expired' } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 4);
    const h2 = harness(() => ({ status: 429, body: { error: 'rate_limited', message: 'Too many requests', retry_after_sec: 12 } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h2.io), 5);
    assert.deepEqual(JSON.parse(h2.err.at(-1)!), { error: 'rate_limited', message: 'Too many requests', retry_after_sec: 12 });
});

test('layer 2 (JSON-RPC error) → 1; HTML from a proxy → 1 "not reached"', async () => {
    const h = harness(() => ({ status: 406, body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Not Acceptable' } } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 1);
    assert.match(h.err.at(-1)!, /update the CLI/);
    const h2 = harness(() => ({ status: 502, body: '<html>Bad gateway</html>' }));
    assert.equal(await main(['call', 'list_findings'], ENV, h2.io), 1);
    assert.match(h2.err.at(-1)!, /not reached/);
});

test('layer 3 (isError): busy with retry → 5; not available → 4; a sentence → 1; wrong project → 2', async () => {
    const cases: [string, number][] = [
        [JSON.stringify({ error: 'busy', message: "Sequential is busy answering this project's other questions", retry_after_sec: 3 }), 5],
        ['Tool not available for this token', 4],
        ['number must be a whole number', 1],
        [JSON.stringify({ error: 'project_not_in_connection', message: 'That project is not this connection' }), 2],
        [JSON.stringify({ error: 'needs_scope', message: 'needs changes:write' }), 4],
    ];
    for (const [text, code] of cases) {
        const h = harness(() => toolErr(text));
        assert.equal(await main(['call', 'list_findings'], ENV, h.io), code, text);
    }
});

test('a timeout: our own signal decides, a write says the outcome is unknown', async () => {
    const h = harness(
        (_n, _a) =>
            new Promise<never>(() => {
                /* never answers; the abort rejects fetch below */
            }),
    );
    // Wrap fetch so an abort rejects like undici does (a plain AbortError).
    const inner = h.io.fetch;
    h.io.fetch = (url, init) =>
        new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            inner(url, init).then(resolve, reject);
        });
    const code = await main(['call', 'record_release', '--version', '4.12.0', '--yes', '--timeout', '1'], ENV, h.io);
    assert.equal(code, 1);
    assert.match(h.err.at(-1)!, /No answer within 1 s\. The outcome is unknown; check before you run it again\./);
});

test('on a terminal, controls in answers are stripped; --json keeps the bytes', async () => {
    const evil = 'Paywall \u001b[2J\u001b]0;pwned\u0007step ‮evil';
    const h = harness(() => ok({ title: evil }), { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.ok(!/[\u001b\u0007‮]/.test(h.out.join('')));
    const h2 = harness(() => ok({ title: evil }));
    assert.equal(await main(['call', 'list_findings'], ENV, h2.io), 0);
    assert.equal(JSON.parse(h2.out[0]).title, evil);
});

test('--input merges with flags; the same argument twice is a usage error', async () => {
    const readJson = () => ({ kind: 'pricing', title: 'From file' });
    const h = harness(() => ok({}), { readJson });
    assert.equal(await main(['call', 'record_change', '--input', 'c.json', '--summary', 'one line', '--yes'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments, { kind: 'pricing', title: 'From file', summary: 'one line' });
    const h2 = harness(() => ok({}), { readJson });
    assert.equal(await main(['call', 'record_change', '--input', 'c.json', '--title', 'again', '--yes'], ENV, h2.io), 2);
});

test('--json-arg for an object argument; a flag for one is refused with the hint', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'product', '--title', 'x', '--json-arg', 'links=[{"url":"https://a.example"}]', '--yes'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments!.links, [{ url: 'https://a.example' }]);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'product', '--title', 'x', '--links', 'https://a', '--yes'], ENV, h2.io), 2);
    assert.match(h2.err.at(-1)!, /--json-arg links=<json>/);
});

test('--project is sent as project (the server checks it); a tool argument named version still binds', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'record_release', '--version', '4.12.0', '--project', 'web', '--yes'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments, { version: '4.12.0', project: 'web' });
});

test('--host: https only (http for localhost), and a warning when it is not the default', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['--host', 'http://evil.example', 'call', 'list_findings'], ENV, h.io), 2);
    assert.equal(h.seen.length, 0);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['--host', 'http://localhost:8080', 'call', 'list_findings'], ENV, h2.io), 0);
    assert.match(h2.err.at(-1)!, /sending the token to http:\/\/localhost:8080/);
    noTokenPrinted(h2);
});

test('an entry with no readOnlyHint is a write (fails closed)', async () => {
    const { readToolList } = await import('../src/tools');
    const [t] = readToolList({ tools: [{ name: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }] });
    assert.equal(t.write, true);
});

// ---- added by the test-strength review: one test per surviving mutant ----
import { mock } from 'node:test';
import { stripControls } from '../src/text';

const abortingFetch = (h: ReturnType<typeof harness>) => {
    const inner = h.io.fetch;
    h.io.fetch = (url, init) =>
        new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            inner(url, init).then(resolve, reject);
        });
};
const never = () => new Promise<never>(() => {});

test('M02: a "(not enabled)" title with arguments is no stub', async () => {
    const { readToolList } = await import('../src/tools');
    const [t] = readToolList({ tools: [{ name: 'x', title: 'X (not enabled)', inputSchema: { type: 'object', properties: { a: { type: 'string' } } }, annotations: { readOnlyHint: true } }] });
    assert.equal(t.stub, false);
});

test('M08: on a terminal, a try-later refusal names the wait', async () => {
    const h = harness(() => ({ status: 429, body: { error: 'rate_limited', message: 'Too many requests', retry_after_sec: 12 } }), { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 5);
    assert.equal(h.err.at(-1), 'sequential: Too many requests (rate_limited) Try again in 12 s.');
});

test('M10/M11: gate 403 insufficient_scope → 4; gate 503 with retry → 5', async () => {
    const h = harness(() => ({ status: 403, body: { error: 'insufficient_scope', message: 'This token lacks the changes:write scope' } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 4);
    const h2 = harness(() => ({ status: 503, body: { error: 'rate_limit_unavailable', message: 'Try again shortly.', retry_after_sec: 5 } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h2.io), 5);
    assert.equal(JSON.parse(h2.err.at(-1)!).retry_after_sec, 5);
});

test('M12-M16: stripControls removes whole sequences, C1 and every bidi control', () => {
    const s = 'a\u001b[2Jb\u001b]8;;https://x.example\u0007c\u001b]0;t\u001b\\d\u0085\u009be‎‏f⁦⁩g‮h';
    assert.equal(stripControls(s), 'abcdefgh');
});

test('M39-M42: on a terminal, keys, Markdown, stderr messages and stub steps are stripped too', async () => {
    const evil = 'x\u001b[2J‮y';
    const h = harness(() => ok({ [evil]: 1 }), { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.ok(!/[\u001b‮]/.test(h.out.join('')), 'key');
    const h2 = harness(() => ok(`# ${evil}`), { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, h2.io), 0);
    assert.equal(h2.out[0], '# xy');
    const h3 = harness(() => toolErr(`bad ${evil}`), { stdoutTTY: true });
    assert.equal(await main(['call', 'list_findings'], ENV, h3.io), 1);
    assert.ok(!/[\u001b‮]/.test(h3.err.join('')), 'stderr');
    const h4 = harness(() => ok({}), { stdoutTTY: true });
    const fetch4 = h4.io.fetch;
    h4.io.fetch = async (url, init) => {
        const r = await fetch4(url, init);
        if (JSON.parse(init.body).method !== 'tools/list') return r;
        const j = JSON.parse(await r.text());
        j.result.tools.find((t: { name: string }) => t.name === 'send_feedback').description = `Turn it on ${evil}`;
        return { status: 200, text: async () => JSON.stringify(j) };
    };
    assert.equal(await main(['call', 'send_feedback'], ENV, h4.io), 4);
    assert.ok(!/[\u001b‮]/.test(h4.err.join('')), 'stub description');
});

test('M18: a missing required argument is exit 2 before any call', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'get_finding'], ENV, h.io), 2);
    assert.match(h.err.at(-1)!, /get_finding needs --number/);
    assert.equal(h.calls().length, 0);
});

test('M20/M21/M55: token shape is exact; sqs_ gets its own sentence; a trailing newline is trimmed', async () => {
    for (const bad of ['sq_pat_short', 'sq_pat_' + 'A'.repeat(33), 'sq_pat_' + 'A'.repeat(31) + '-']) {
        const h = harness(() => ok({}));
        assert.equal(await main(['call', 'list_findings'], { SEQUENTIAL_TOKEN: bad }, h.io), 2, bad);
        assert.equal(h.seen.length, 0);
    }
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings'], { SEQUENTIAL_TOKEN: 'sqs_' + 'x'.repeat(40) }, h.io), 2);
    assert.match(h.err.at(-1)!, /server key/);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings'], { SEQUENTIAL_TOKEN: TOKEN + '\n' }, h2.io), 0);
    assert.equal(h2.calls()[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('M22/M31: Ctrl-C is "cancelled", never a timeout or "not reached"', async () => {
    const ctl = new AbortController();
    const h = harness(() => (setImmediate(() => ctl.abort()), never()), { signal: ctl.signal });
    abortingFetch(h);
    assert.equal(await main(['call', 'record_release', '--version', '1', '--yes'], ENV, h.io), 1);
    assert.match(h.err.at(-1)!, /"error":"cancelled"/);
    assert.doesNotMatch(h.err.at(-1)!, /outcome is unknown/);
});

test('M26/M27/M28/M58: a terminal "yes" sends; stdin as --input, or no TTY, never prompts', async () => {
    const h = harness(() => ok({}), { interactive: true, confirm: async () => true });
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x'], ENV, h.io), 0);
    assert.equal(h.calls().length, 1);
    let asked = 0;
    const confirm = async () => (asked++, true);
    const h2 = harness(() => ok({}), { interactive: true, confirm, readJson: () => ({ kind: 'pricing', title: 'x' }) });
    assert.equal(await main(['call', 'record_change', '--input', '-'], ENV, h2.io), 2);
    const h3 = harness(() => ok({}), { interactive: false, confirm });
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x'], ENV, h3.io), 2);
    assert.equal(asked, 0);
    assert.equal(h2.calls().length + h3.calls().length, 0);
});

test('M29/M30: a timed-out non-idempotent write says check first; a timed-out read says nothing of outcome', async () => {
    const h = harness(never);
    abortingFetch(h);
    // record_change is idempotent (external_id); request_fix_draft is not.
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x', '--yes', '--timeout', '1'], ENV, h.io), 1);
    assert.match(h.err.at(-1)!, /running it again is safe/);
    const h1 = harness(never);
    abortingFetch(h1);
    assert.equal(await main(['call', 'request_fix_draft', '--number', '3', '--yes', '--timeout', '1'], ENV, h1.io), 1);
    assert.match(h1.err.at(-1)!, /check before you run it again/);
    const h2 = harness(never);
    abortingFetch(h2);
    assert.equal(await main(['call', 'list_findings', '--timeout', '1'], ENV, h2.io), 1);
    assert.doesNotMatch(h2.err.at(-1)!, /outcome is unknown/);
});

test('M32/M33: a scalar or a --json-arg given twice is exit 2', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--limit', '1', '--limit', '2'], ENV, h.io), 2);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'product', '--title', 'x', '--json-arg', 'links=[]', '--json-arg', 'links=[]', '--yes'], ENV, h2.io), 2);
    assert.equal(h.calls().length + h2.calls().length, 0);
});

test('M34: a repeated array flag keeps every value in order', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'product', '--title', 'x', '--tags', 'a', '--tags', 'b', '--yes'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments!.tags, ['a', 'b']);
});

test('M35: --x=false and --no-x=false', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_sessions', '--has-errors=false', '--no-judged-only=false'], ENV, h.io), 0);
    assert.deepEqual(h.calls()[0].body.params!.arguments, { has_errors: false, judged_only: true });
});

test('M36/M47: an integer flag refuses 1.5; --timeout 0 is exit 2', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--limit', '1.5'], ENV, h.io), 2);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings', '--timeout', '0'], ENV, h2.io), 2);
    assert.equal(h.calls().length + h2.calls().length, 0);
});

test('M37/M38: --host must be an origin; http://[::1] is local', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['--host', 'https://api.example/evil', 'call', 'list_findings'], ENV, h.io), 2);
    assert.equal(h.seen.length, 0);
    const h2 = harness(() => ok({}));
    assert.equal(await main(['--host', 'http://[::1]:8080', 'call', 'list_findings'], ENV, h2.io), 0);
    assert.equal(h2.calls()[0].url, 'http://[::1]:8080/mcp/readonly');
});

test('M44: a 415 JSON-RPC error says update the CLI', async () => {
    const h = harness(() => ({ status: 415, body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unsupported Media Type' } } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 1);
    assert.match(h.err.at(-1)!, /update the CLI/);
});

test('M46: the default timeout is 120 s, not less', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const h = harness(never);
        abortingFetch(h);
        let done = false;
        const p = main(['call', 'list_findings'], ENV, h.io).then((c) => ((done = true), c));
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        mock.timers.tick(119_000);
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        assert.equal(done, false);
        mock.timers.tick(1_000);
        assert.equal(await p, 1);
        assert.match(h.err.at(-1)!, /No answer within 120 s/);
    } finally {
        mock.timers.reset();
    }
});

test('M48: a negative retry_after_sec is not passed on', async () => {
    const h = harness(() => ({ status: 429, body: { error: 'rate_limited', message: 'x', retry_after_sec: -1 } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 5);
    assert.equal('retry_after_sec' in JSON.parse(h.err.at(-1)!), false);
});

test('M50: an unknown tool with arguments reports the tool, not a stray word', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'drop_tables', '--table', 'users'], ENV, h.io), 2);
    assert.match(h.err.at(-1)!, /no tool drop_tables/);
});

test('M53: SEQUENTIAL_PROJECT is sent when --project is not', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'list_findings'], { ...ENV, SEQUENTIAL_PROJECT: 'web' }, h.io), 0);
    assert.equal(h.calls()[0].body.params!.arguments!.project, 'web');
});

test('M57: tools --json on a terminal prints JSON', async () => {
    const h = harness(() => ok({}), { stdoutTTY: true });
    assert.equal(await main(['tools', '--json'], ENV, h.io), 0);
    assert.ok(Array.isArray(JSON.parse(h.out[0]).tools));
});

// ---- security review (rev3/security.md) ----

test('SEC1: a word after the command can never move the token to another host; --host only before the command', async () => {
    for (const argv of [
        ['call', 'list_findings', '--status', '--host=https://attacker.example'],
        ['call', 'list_findings', '--host', 'https://attacker.example'],
        ['call', 'record_change', '--title', '--host=https://attacker.example', '--kind', 'pricing', '--yes'],
        ['tools', '--host', 'https://attacker.example'],
    ]) {
        const h = harness(() => ok({}));
        assert.equal(await main(argv, ENV, h.io), 2, argv.join(' '));
        assert.ok(h.seen.every((s) => s.url.startsWith('https://api.usesequential.com/')), `token went to ${h.seen.map((s) => s.url)}`);
    }
    const h = harness(() => ok({}));
    assert.equal(await main(['--host', 'https://a.example', '--host', 'https://b.example', 'call', 'list_findings'], ENV, h.io), 2);
    assert.equal(h.seen.length, 0);
});

test('SEC2: prototype keys are never argument names', async () => {
    for (const argv of [
        ['call', 'list_findings', '--constructor', 'x'],
        ['call', 'list_findings', '--__proto__', '{"status":"all"}'],
        ['call', 'list_findings', '--json-arg', '__proto__={"status":"all"}'],
        ['call', 'list_findings', '--json-arg', 'colour="red"'],
    ]) {
        const h = harness(() => ok({}));
        assert.equal(await main(argv, ENV, h.io), 2, argv.join(' '));
        assert.equal(h.calls().length, 0);
    }
    const h = harness(() => ok({}), { readJson: () => JSON.parse('{"__proto__":{"x":1},"kind":"pricing","title":"t"}') });
    assert.equal(await main(['call', 'record_change', '--input', 'c.json', '--yes'], ENV, h.io), 2);
    assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('SEC3: a hostile tool list cannot write controls to the terminal (names, arguments, enums, usage errors, codes)', async () => {
    const evil = '\u001b]8;;https://x.example\u0007x\u001b[2J';
    const list = { tools: [{ name: `t${evil}`, title: `T${evil}`, description: `d${evil}`, inputSchema: { type: 'object', properties: { [`a${evil}`]: { type: 'string', enum: [`e${evil}`] } } }, annotations: { readOnlyHint: true } }] };
    const mk = () => {
        const out: string[] = [];
        const err: string[] = [];
        const fetch: FetchLike = async (_u, init) => {
            const body = JSON.parse(init.body);
            if (body.method === 'tools/list') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: list }) };
            return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: `c${evil}\nsequential: fake`, message: `m${evil}` }) }], isError: true } }) };
        };
        return { out, err, io: { fetch, out: (l: string) => out.push(l), err: (l: string) => err.push(l), stdoutTTY: true, interactive: false } as Io };
    };
    const a = mk();
    await main(['tools'], ENV, a.io);
    await main(['tools', 'describe', `t${evil}`], ENV, a.io);
    await main(['call', `t${evil}`, '--colour', 'x'], ENV, a.io);
    await main(['call', `t${evil}`], ENV, a.io);
    const all = [...a.out, ...a.err].join('\n');
    assert.ok(!/[\u001b\u0007]/.test(all), all);
    assert.ok(a.err.every((l) => !l.includes('\n')), 'an error line holds no line break');
});

test('SEC5: ask_sessions is paid: asked like a write, sent like a read', async () => {
    const h = harness(() => ok({ answer: 'x' }));
    assert.equal(await main(['call', 'ask_sessions', '--query', 'Why do people leave?'], ENV, h.io), 2);
    assert.match(h.err.at(-1)!, /paid budget/);
    assert.equal(h.calls().length, 0);
    const h2 = harness(() => ok({ answer: 'x' }));
    assert.equal(await main(['call', 'ask_sessions', '--query', 'Why do people leave?', '--yes'], ENV, h2.io), 0);
    assert.equal(h2.calls()[0].url, 'https://api.usesequential.com/mcp/readonly');
});

test('SEC6: the project of a write is shown, from wherever it came (--json-arg included)', async () => {
    const h = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x', '--json-arg', 'project="web"', '--yes'], ENV, h.io), 2, 'project is no tool argument');
    const h2 = harness(() => ok({}), { interactive: true, confirm: async () => true, readJson: () => ({ kind: 'pricing', title: 'x' }) });
    assert.equal(await main(['call', 'record_change', '--input', '/dev/stdin'], ENV, h2.io), 2, '--input never prompts, whatever its path');
    const h3 = harness(() => ok({}));
    assert.equal(await main(['call', 'record_change', '--kind', 'pricing', '--title', 'x', '--yes'], { ...ENV, SEQUENTIAL_PROJECT: 'web' }, h3.io), 0);
    assert.match(h3.err[0], /record_change on project web/);
});

test('SEC9: a huge tool list does not crash the table; an answer over 8 MiB is refused', async () => {
    const huge = { tools: Array.from({ length: 200_000 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) };
    const f2: FetchLike = async (_u, init) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: huge }) });
    const e2: string[] = [];
    assert.equal(await main(['tools'], ENV, { fetch: f2, out: () => {}, err: (l) => e2.push(l), stdoutTTY: true, interactive: false }), 1);
    assert.match(e2.at(-1)!, /too large/);
    const big = { tools: Array.from({ length: 60_000 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) };
    const out: string[] = [];
    const fetch: FetchLike = async (_u, init) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: big }) });
    assert.equal(await main(['tools'], ENV, { fetch, out: (l) => out.push(l), err: () => {}, stdoutTTY: true, interactive: false }), 0);
});

test('FID: Retry-After header when the body has no wait; an answer for another id is not ours; JSON-RPC text shown', async () => {
    const mk = (status: number, body: unknown, headers: Record<string, string> = {}, sameId = true) => {
        const err: string[] = [];
        const fetch: FetchLike = async (_u, init) => {
            const b = JSON.parse(init.body);
            if (b.method === 'tools/list') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: b.id, result: toolsList() }) };
            const out = body && typeof body === 'object' && 'jsonrpc' in body ? { ...body, id: sameId ? b.id : 999 } : body;
            return { status, text: async () => JSON.stringify(out), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
        };
        return { err, io: { fetch, out: () => {}, err: (l: string) => err.push(l), stdoutTTY: false, interactive: false } as Io };
    };
    const a = mk(503, { error: 'auth_unavailable' }, { 'retry-after': '7' });
    assert.equal(await main(['call', 'list_findings'], ENV, a.io), 5);
    assert.equal(JSON.parse(a.err.at(-1)!).retry_after_sec, 7);
    const b = mk(200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: '{}' }] } }, {}, false);
    assert.equal(await main(['call', 'list_findings'], ENV, b.io), 1);
    const c = mk(400, { jsonrpc: '2.0', error: { code: -32000, message: 'Unsupported protocol version' } });
    assert.equal(await main(['call', 'list_findings'], ENV, c.io), 1);
    assert.match(c.err.at(-1)!, /Unsupported protocol version/);
});

test('N69: a JSON error line on stderr is stripped too (C1 and bidi survive JSON.stringify)', async () => {
    const h = harness(() => toolErr(JSON.stringify({ error: 'refused', message: 'bad \u009b2J ‮evil' })));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 1);
    assert.ok(!/[\u009b‮]/.test(h.err.at(-1)!), h.err.at(-1));
});

test('N70: only the first text item is the answer (an org-wide call adds a project item)', async () => {
    const h = harness(() => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"total":1}' }, { type: 'text', text: '{"project":"web"}' }] } } }));
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.deepEqual(JSON.parse(h.out[0]), { total: 1 });
});

// ---- the cache and .sequential.json in the command (PR1) ----
test('CACHE: a second call within 10 minutes sends no tools/list; an unknown argument refreshes the cached list once', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'seq-cli-cache-')), 'c');
    const h = harness(() => ok({}), { cacheDir });
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.equal(h.seen.filter((s) => s.body.method === 'tools/list').length, 1);
    assert.equal(await main(['call', 'list_findings', '--colour', 'red'], ENV, h.io), 2);
    assert.equal(h.seen.filter((s) => s.body.method === 'tools/list').length, 2, 'refreshed once, then refused');
    assert.equal(await main(['call', 'list_findings', '--refresh'], ENV, h.io), 0);
    assert.equal(h.seen.filter((s) => s.body.method === 'tools/list').length, 3);
});

test('PROJECT: from .sequential.json it is sent, and its path is printed', async () => {
    const projectFs = { cwd: '/h/repo', home: '/h', uid: null, lstat: (p: string) => (p === '/h/repo/.sequential.json' ? { isFile: () => true, isSymbolicLink: () => false, uid: 1 } : null), exists: () => false, read: () => '{"project":"web"}' };
    const h = harness(() => ok({}), { projectFs });
    assert.equal(await main(['call', 'list_findings'], ENV, h.io), 0);
    assert.equal(h.calls()[0].body.params!.arguments!.project, 'web');
    assert.match(h.err.join('\n'), /project web \(from \/h\/repo\/\.sequential\.json\)/);
});
