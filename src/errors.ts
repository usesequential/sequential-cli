// What a failed call means for the person: one exit code and one line. Spec 5.8 + §10.
// Codes: 0 ok, 1 refused or unreachable, 2 usage, 3 some items refused, 4 auth, 5 try later.
import { stripControls } from './text';

export const EXIT = { ok: 0, refused: 1, usage: 2, partial: 3, auth: 4, later: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface Fail {
    exit: ExitCode;
    /** A code: the server's `error` when it sent one, else our own (not_reached, timeout, rpc_<n> …). */
    code: string;
    /** Words to print. For a server refusal: the server's `message` — never `errors[].message`. */
    message: string;
    retryAfterSec?: number;
    /** The refusal's JSON body, when it had one: the named commands read `errors[0].field`, `reason` and `hint` from it. */
    detail?: Record<string, unknown>;
}

export class UsageError extends Error {}

const AUTH_STATUSES = new Set([401, 403]);
const LATER_STATUSES = new Set([429, 503]);
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Seconds, from the body's retry_after_sec, else the Retry-After header (503 auth_unavailable has only the header). */
function retryOf(body: Record<string, unknown>, header?: string | null): number | undefined {
    const r = body.retry_after_sec;
    if (typeof r === 'number' && Number.isFinite(r) && r >= 0) return r;
    if (header && /^\d{1,6}$/.test(header.trim())) return Number(header.trim());
    return undefined;
}

export type HttpOutcome = { ok: true; result: unknown } | { ok: false; fail: Fail };

/**
 * Layers 1 and 2: the HTTP answer of POST /mcp. Classified by BODY, never by status alone (a JSON-RPC parse error is a 400
 * too). A `jsonrpc` key → layer 2 (protocol); an `error` string → layer 1 (the auth gate); neither → not Sequential.
 * `sentId`: an answer for another request id is not ours (null is allowed: refusals made before the transport).
 */
export function classifyHttp(status: number, text: string, opts: { retryAfter?: string | null; sentId?: number } = {}): HttpOutcome {
    const body = parseJson(text);
    if (isObj(body) && 'jsonrpc' in body) {
        if (opts.sentId !== undefined && body.id !== null && body.id !== opts.sentId) {
            return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'Sequential answered another request: update the CLI.' } };
        }
        if (isObj(body.error)) {
            const code = typeof body.error.code === 'number' ? body.error.code : 0;
            const said = typeof body.error.message === 'string' ? ` It said: ${stripControls(body.error.message).slice(0, 300)}` : '';
            const why = status === 406 || status === 415 ? 'Sequential refused this request format: update the CLI.' : 'Sequential refused the request.';
            return { ok: false, fail: { exit: EXIT.refused, code: `rpc_${code}`, message: why + said } };
        }
        // Only an error may carry a null id (a refusal written before the transport read the request).
        if ('result' in body) {
            if (body.id === null || body.id === undefined) return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'Sequential sent an answer this CLI cannot read: update the CLI.' } };
            return { ok: true, result: body.result };
        }
        return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'Sequential sent an answer this CLI cannot read: update the CLI.' } };
    }
    if (isObj(body) && typeof body.error === 'string') {
        const code = body.error;
        const message = typeof body.message === 'string' ? body.message : code;
        const retry = retryOf(body, opts.retryAfter);
        if (AUTH_STATUSES.has(status)) return { ok: false, fail: { exit: EXIT.auth, code, message } };
        if (LATER_STATUSES.has(status)) return { ok: false, fail: { exit: EXIT.later, code, message, ...(retry === undefined ? {} : { retryAfterSec: retry }) } };
        return { ok: false, fail: { exit: EXIT.refused, code, message } };
    }
    // A gateway in front of Sequential (502, 503, 504 with no JSON body: a deploy, an overloaded host): try later.
    if (GATEWAY_STATUSES.has(status)) {
        const retry = opts.retryAfter && /^\d{1,6}$/.test(opts.retryAfter.trim()) ? Number(opts.retryAfter.trim()) : undefined;
        return { ok: false, fail: { exit: EXIT.later, code: 'unavailable', message: `Sequential is not answering right now (HTTP ${status}).`, ...(retry === undefined ? {} : { retryAfterSec: retry }) } };
    }
    return { ok: false, fail: { exit: EXIT.refused, code: 'not_reached', message: `Sequential was not reached (HTTP ${status}).` } };
}

export const NOT_AVAILABLE = 'Tool not available for this token';

export type ToolOutcome =
    | { ok: true; kind: 'json'; value: unknown }
    | { ok: true; kind: 'text'; value: string }
    | { ok: false; fail: Fail };

/**
 * Layer 3: a tools/call result. isError with a JSON body (a refusal) or a sentence; else JSON text or Markdown.
 * Only the FIRST text item is the answer: an org-wide call adds a second item naming the project (S3).
 */
export function classifyToolResult(result: unknown): ToolOutcome {
    if (!isObj(result) || !Array.isArray(result.content)) {
        return { ok: false, fail: { exit: EXIT.refused, code: 'bad_answer', message: 'Sequential sent an answer this CLI cannot read: update the CLI.' } };
    }
    const first = result.content.find((c): c is { type: 'text'; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string');
    const text = first?.text ?? '';
    if (result.isError === true) {
        const body = parseJson(text);
        if (isObj(body) && typeof body.error === 'string') {
            const retry = retryOf(body);
            const message = typeof body.message === 'string' ? body.message : body.error;
            if (retry !== undefined) return { ok: false, fail: { exit: EXIT.later, code: body.error, message, retryAfterSec: retry, detail: body } };
            if (body.error === 'needs_scope') return { ok: false, fail: { exit: EXIT.auth, code: body.error, message, detail: body } };
            return { ok: false, fail: { exit: EXIT.refused, code: body.error, message, detail: body } };
        }
        if (text === NOT_AVAILABLE) {
            return { ok: false, fail: { exit: EXIT.auth, code: 'not_available', message: 'This token cannot use this tool (its scopes, or the feature is off for this project).' } };
        }
        return { ok: false, fail: { exit: EXIT.refused, code: 'refused', message: text || 'Sequential refused the call.' } };
    }
    const value = parseJson(text);
    return value === undefined ? { ok: true, kind: 'text', value: text } : { ok: true, kind: 'json', value };
}
