// MCP 2025 stateless JSON-RPC over one POST (spec 5.2). No SDK: four headers and one JSON body.
import { classifyHttp, EXIT, type Fail, type HttpOutcome } from './errors';

export const DEFAULT_HOST = 'https://api.usesequential.com';
export const PROTOCOL_VERSION = '2025-06-18';
export { VERSION as CLI_VERSION } from './version';
import { VERSION } from './version';
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The largest answer read (a hostile or broken host must not fill memory). */
export const MAX_ANSWER_CHARS = 8 * 1024 * 1024;

export interface FetchLike {
    (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }): Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;
}

export interface RpcRequest {
    host: string;
    token: string;
    readonly: boolean;
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
    /** Ctrl-C. Joined with the timeout by hand: AbortSignal.any is Node 20.3+. */
    signal?: AbortSignal;
}

let nextId = 1;

export async function rpc(fetch: FetchLike, req: RpcRequest): Promise<HttpOutcome> {
    const ctl = new AbortController();
    let timedOut = false;
    const ms = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
    }, ms);
    const onAbort = () => ctl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const url = `${req.host}${req.readonly ? '/mcp/readonly' : '/mcp'}`;
    const id = nextId++;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${req.token}`,
                'mcp-protocol-version': PROTOCOL_VERSION,
                'user-agent': `sequential-cli/${VERSION}`,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method: req.method, ...(req.params ? { params: req.params } : {}) }),
            redirect: 'error',
            signal: ctl.signal,
        });
        const length = Number(res.headers?.get('content-length') ?? '0');
        if (length > MAX_ANSWER_CHARS) return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'The answer is too large.' } };
        const text = await res.text();
        if (text.length > MAX_ANSWER_CHARS) return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'The answer is too large.' } };
        return classifyHttp(res.status, text, { retryAfter: res.headers?.get('retry-after') ?? null, sentId: id });
    } catch {
        // Our own flag, never the error's name: on Node 18 undici may reject a timed-out fetch with a plain AbortError.
        const fail: Fail = timedOut
            ? { exit: EXIT.refused, code: 'timeout', message: `No answer within ${Math.round(ms / 1000)} s.` }
            : req.signal?.aborted
              ? { exit: EXIT.refused, code: 'cancelled', message: 'Cancelled.' }
              : { exit: EXIT.refused, code: 'not_reached', message: 'Sequential was not reached.' };
        // Never the error itself: it can hold the URL, and a redirect error names the Location.
        return { ok: false, fail };
    } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
    }
}

/** The API origin: https, or http only to this machine (a token never crosses a network in clear text). */
export function apiHost(v: string | undefined): string {
    const raw = (v ?? DEFAULT_HOST).replace(/\/+$/, '');
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error('--host must be a URL');
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('--host must be https (http only for localhost)');
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('--host must be an origin, for example https://api.usesequential.com');
    return u.origin;
}
