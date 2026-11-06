// The named commands (spec 5.5, S1-3): changes record, changes sync, releases record, whoami. Each is ONE request (no
// tools/list), to the same tools agents use (record_change, record_changes, record_release over MCP), and needs no --yes:
// the command's name says what it writes. They copy no server rule (ruling 4): kinds, limits and formats are the
// server's to check; the CLI checks only the shape of its own flags. Their lines are the old CLI's (@usesequential/node
// 1.x), on a terminal or not; --json prints the answer instead.
import { classifyToolResult, EXIT, UsageError, type ExitCode, type Fail } from './errors';
import { oneLine, stripDeep, ttySafeJson } from './text';
import { PROTOCOL_VERSION, rpc, VERSION, getJson, type FetchLike } from './transport';

export interface CuratedIo {
    fetch: FetchLike;
    out: (line: string) => void;
    err: (line: string) => void;
    readText?: (path: string) => string;
    signal?: AbortSignal;
}

type Flags = Map<string, string[]>;
const SWITCHES = new Set(['dry-run', 'json', 'help', 'atomic']);
const REPEATABLE = new Set(['pr', 'commit', 'link', 'finding']);
const TAKES: Record<string, ReadonlySet<string>> = {
    'changes record': new Set(['kind', 'title', 'summary', 'importance', 'occurrence', 'start', 'end', 'version', 'environment', 'external-id', 'pr', 'commit', 'link', 'source', 'source-detail', 'project', 'timeout']),
    'changes sync': new Set(['items', 'source', 'source-detail', 'covered-from', 'covered-through', 'atomic', 'project', 'timeout']),
    'releases record': new Set(['version', 'environment', 'commit-sha', 'released-at', 'finding', 'project', 'timeout']),
    whoami: new Set(['timeout']),
};
const COMMON = new Set(['dry-run', 'json', 'help']);

/** `--name value`, `--name=value` and switches. A value that starts with "--" must use the = form. */
export function parseCurated(cmd: string, argv: readonly string[]): Flags {
    const flags: Flags = new Map();
    const takes = TAKES[cmd];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new UsageError(`unexpected word: ${a}`);
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (name === 'host') throw new UsageError('put --host before the command (sequential --host <url> …), or set SEQUENTIAL_HOST');
        const common = COMMON.has(name) && !(cmd === 'whoami' && name === 'dry-run');
        if (!takes.has(name) && !common) throw new UsageError(`${cmd} takes no --${name}`);
        if (SWITCHES.has(name)) {
            if (eq >= 0) throw new UsageError(`--${name} takes no value`);
            flags.set(name, ['true']);
            continue;
        }
        let value: string;
        if (eq >= 0) value = a.slice(eq + 1);
        else {
            if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`--${name} needs a value (for a value that starts with "--", write --${name}=<value>)`);
            value = argv[++i];
        }
        const had = flags.get(name);
        if (had && !REPEATABLE.has(name)) throw new UsageError(`--${name} is given twice`);
        flags.set(name, [...(had ?? []), value]);
    }
    return flags;
}

const one = (f: Flags, name: string): string | undefined => f.get(name)?.[0];

function linkUrl(name: string, v: string): string {
    let u: URL;
    try {
        u = new URL(v);
    } catch {
        throw new UsageError(`--${name} must be a URL`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError(`--${name} must be an http or https URL`);
    return v;
}

/** record_change's arguments from the flags. */
export function changeArgs(f: Flags): Record<string, unknown> {
    const kind = one(f, 'kind');
    const title = one(f, 'title');
    if (!kind) throw new UsageError('--kind is required (see: sequential tools describe record_change)');
    if (!title || !title.trim()) throw new UsageError('--title is required');
    const a: Record<string, unknown> = { kind, title, source: one(f, 'source') ?? 'ci' };
    for (const [flag, key] of [['summary', 'summary'], ['importance', 'importance'], ['occurrence', 'occurrence'], ['start', 'start'], ['end', 'end'], ['external-id', 'external_id'], ['source-detail', 'source_detail']] as const) {
        const v = one(f, flag);
        if (v !== undefined) a[key] = v;
    }
    const version = one(f, 'version');
    const environment = one(f, 'environment');
    if (version !== undefined) a.release = { environment: environment ?? 'production', version };
    else if (environment !== undefined) throw new UsageError('--environment goes with --version');
    const links: { url: string; label: string }[] = [];
    for (const [flag, label] of [['pr', 'pr'], ['commit', 'commit'], ['link', 'other']] as const) for (const v of f.get(flag) ?? []) links.push({ url: linkUrl(flag, v), label });
    if (links.length) a.links = links;
    return a;
}

/** record_changes' arguments: the items of --items, each given --source (default ci) and --source-detail when it names
 *  none (the server refuses a sync whose items lack the sync's detail), and the sync block only with --covered-through. */
export function syncArgs(f: Flags, text: string): Record<string, unknown> {
    let items: unknown;
    try {
        items = JSON.parse(text);
    } catch {
        throw new UsageError('--items is not JSON: it must hold a JSON array of changes');
    }
    if (!Array.isArray(items) || items.length === 0) throw new UsageError('--items must hold a JSON array of one or more changes');
    const source = one(f, 'source') ?? 'ci';
    const detail = one(f, 'source-detail');
    const out = items.map((it, i) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new UsageError(`item ${i} is not an object`);
        const item = { ...(it as Record<string, unknown>) };
        if (item.source === undefined) item.source = source;
        if (detail !== undefined && item.source_detail === undefined) item.source_detail = detail;
        return item;
    });
    const a: Record<string, unknown> = { items: out };
    if (f.has('atomic')) a.atomic = true;
    const through = one(f, 'covered-through');
    const from = one(f, 'covered-from');
    if (from !== undefined && through === undefined) throw new UsageError('--covered-from needs --covered-through');
    if (through !== undefined) a.sync = { source, ...(detail !== undefined ? { source_detail: detail } : {}), ...(from !== undefined ? { covered_from: from } : {}), covered_through: through };
    return a;
}

/** record_release's arguments. */
export function releaseArgs(f: Flags): Record<string, unknown> {
    const version = one(f, 'version');
    if (!version) throw new UsageError('--version is required');
    const a: Record<string, unknown> = { version };
    for (const [flag, key] of [['environment', 'environment'], ['commit-sha', 'commit_sha'], ['released-at', 'released_at']] as const) {
        const v = one(f, flag);
        if (v !== undefined) a[key] = v;
    }
    const findings = f.get('finding') ?? [];
    if (findings.length) a.finding_ids = findings;
    return a;
}

const WORD = /^[a-z_]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD = /^\/?[a-z_][a-z_/0-9]{0,59}$/;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The old CLI's refusal line: the error code, the first field named, and for a refused text its reason and the server's
 *  fixed hint. Never `message` or `errors[].message`, which can quote the caller's own (secret) text. */
export function refusalLine(f: Fail): string {
    const d = f.detail ?? {};
    const code = WORD.test(f.code) ? f.code : 'refused';
    const first = Array.isArray(d.errors) ? (d.errors[0] as { field?: unknown } | undefined) : undefined;
    const lead = !first && typeof f.message === 'string' ? /^([a-z_]{1,30}):/.exec(f.message)?.[1] : undefined;
    const fv = first && typeof first === 'object' ? first.field : typeof d.field === 'string' ? d.field : lead;
    const field = typeof fv === 'string' && FIELD.test(fv) ? ` (${fv})` : '';
    const step = str(d.step) && WORD.test(d.step as string) ? ` ${d.step as string}` : '';
    const reason = str(d.reason) && WORD.test(d.reason as string) ? ` ${d.reason as string}` : '';
    const hint = reason && str(d.hint) && (d.hint as string).length <= 240 ? `: ${oneLine(d.hint as string)}` : '';
    const later = f.retryAfterSec === undefined ? '' : ` Try again in ${f.retryAfterSec} s.`;
    // A sentence refusal (record_release, argument checks) has no code: only its leading field word, never the rest.
    if (!f.detail) return f.exit === EXIT.refused && f.code === 'refused' ? `sequential: Sequential refused it${field}` : `sequential: ${oneLine(f.message)} (${code})${later}`;
    return `sequential: ${code}${step}${field}${reason}${hint}${later}`;
}

/** A Sequential app link the CLI may print: https, one line, short. */
const confirmLink = (v: unknown): string | undefined => (typeof v === 'string' && /^https:\/\/[^\s]{1,300}$/.test(v) ? v : undefined);

function syncLines(answer: unknown, out: (l: string) => void, err: (l: string) => void): ExitCode {
    const items = (answer && typeof answer === 'object' && Array.isArray((answer as { items?: unknown }).items) ? (answer as { items: unknown[] }).items : []) as Array<Record<string, unknown>>;
    let refused = 0;
    let proposed = 0;
    for (const it of items) {
        const index = typeof it.index === 'number' && Number.isInteger(it.index) ? it.index : '?';
        const outcome = str(it.outcome) && WORD.test(it.outcome as string) ? (it.outcome as string) : 'unknown';
        const id = str(it.change_id) && ID.test(it.change_id as string) ? ` ${it.change_id as string}` : '';
        if (outcome === 'refused' || outcome === 'not_checked') {
            refused++;
            const step = str(it.step) && WORD.test(it.step as string) ? ` ${it.step as string}` : '';
            const field = str(it.field) && FIELD.test(it.field as string) ? ` (${it.field as string})` : '';
            const error = str(it.error) && WORD.test(it.error as string) ? ` ${it.error as string}` : '';
            const reason = str(it.reason) && WORD.test(it.reason as string) ? ` ${it.reason as string}` : '';
            const hint = reason && str(it.hint) && (it.hint as string).length <= 240 ? `: ${oneLine(it.hint as string)}` : '';
            out(`#${index} ${outcome}${step}${field}${error}${reason}${hint}`);
        } else {
            if (outcome === 'proposed') proposed++;
            out(`#${index} ${outcome}${id}`);
        }
    }
    out(`${items.length - refused - proposed} written, ${proposed} proposed, ${refused} refused`);
    const link = confirmLink((answer as { confirm_url?: unknown } | null)?.confirm_url);
    if (proposed > 0 && link) err(`sequential: ${proposed} kept as a proposal; a person confirms them at ${oneLine(link)}`);
    return refused > 0 ? EXIT.partial : EXIT.ok;
}

export interface CuratedContext { host: string; token?: string; project?: string; timeoutMs?: number; stdoutTTY?: boolean }

/** Runs one named command after the flags parsed. The token is checked by the caller (not needed for --dry-run). */
export async function runCurated(cmd: string, f: Flags, ctx: CuratedContext, io: CuratedIo, onFail?: (fail: Fail) => Promise<ExitCode | undefined>): Promise<ExitCode> {
    const json = f.has('json');
    const tool = cmd === 'changes record' ? 'record_change' : cmd === 'changes sync' ? 'record_changes' : 'record_release';
    let args: Record<string, unknown>;
    if (cmd === 'changes record') args = changeArgs(f);
    else if (cmd === 'releases record') args = releaseArgs(f);
    else {
        const path = one(f, 'items');
        if (path === undefined) throw new UsageError('changes sync needs --items <file|->');
        if (!io.readText) throw new UsageError('--items cannot be read here');
        let text: string;
        try {
            text = io.readText(path);
        } catch {
            throw new UsageError(path === '-' ? 'could not read the items from stdin' : `could not read ${path}`);
        }
        args = syncArgs(f, text);
    }
    if (ctx.project !== undefined) args = { ...args, project: ctx.project };
    if (f.has('dry-run')) {
        io.out(`Would call ${tool} on ${ctx.host}/mcp with:`);
        // On a terminal, the arguments are stripped of controls too (a title may hold anything).
        io.out(JSON.stringify(ctx.stdoutTTY ? stripDeep(args) : args, null, 2));
        return EXIT.ok;
    }
    if (!ctx.token) throw new UsageError('no token');
    const r = await rpc(io.fetch, { host: ctx.host, token: ctx.token, readonly: false, method: 'tools/call', params: { name: tool, arguments: args }, timeoutMs: ctx.timeoutMs, signal: io.signal });
    if (!r.ok) {
        if (r.fail.code === 'timeout') r.fail.message += cmd === 'releases record' ? ' The outcome is unknown; check before you run it again.' : ' The outcome is unknown; running it again with the same external_id is safe.';
        return failOut(io, r.fail, json);
    }
    const o = classifyToolResult(r.result);
    if (!o.ok) {
        const handled = onFail ? await onFail(o.fail) : undefined;
        return handled ?? failOut(io, o.fail, json);
    }
    const answer = o.kind === 'json' ? o.value : { text: o.value };
    if (json) {
        io.out(ctx.stdoutTTY ? ttySafeJson(JSON.stringify(answer)) : JSON.stringify(answer));
        return cmd === 'changes sync' ? syncExit(answer) : EXIT.ok;
    }
    if (cmd === 'changes sync') return syncLines(answer, io.out, io.err);
    const a = (answer ?? {}) as Record<string, unknown>;
    if (cmd === 'releases record') {
        const rel = (a.release && typeof a.release === 'object' ? a.release : {}) as Record<string, unknown>;
        const v = str(rel.version) ?? String(args.version);
        io.out(oneLine(`recorded release ${v}`));
        const env = str(rel.environment);
        const at = str(rel.released_at);
        if (env || at) io.out(oneLine(`environment ${env ?? '?'}, released at ${at ?? '?'}${Array.isArray(rel.finding_ids) ? `, names ${rel.finding_ids.length} case(s)` : ''}`));
        return EXIT.ok;
    }
    const outcome = str(a.outcome) && WORD.test(a.outcome as string) ? (a.outcome as string) : 'recorded';
    const id = str(a.change_id) && ID.test(a.change_id as string) ? ` ${a.change_id as string}` : '';
    io.out(`${outcome}${id}`);
    const confirm = confirmLink(a.confirm_url);
    if (confirm) io.err(`sequential: kept as a proposal; a person confirms it at ${oneLine(confirm)}`);
    return EXIT.ok;
}

function syncExit(answer: unknown): ExitCode {
    const items = (answer && typeof answer === 'object' && Array.isArray((answer as { items?: unknown }).items) ? (answer as { items: Array<{ outcome?: unknown }> }).items : []);
    return items.some((i) => i.outcome === 'refused' || i.outcome === 'not_checked') ? EXIT.partial : EXIT.ok;
}

function failOut(io: CuratedIo, f: Fail, json: boolean): ExitCode {
    if (json) io.err(JSON.stringify(stripDeep({ error: f.code, ...(f.retryAfterSec === undefined ? {} : { retry_after_sec: f.retryAfterSec }) })));
    else io.err(refusalLine(f));
    return f.exit;
}

/** whoami: GET /api/token/self (what the token is), then MCP initialize, so the token list shows "Sequential CLI". */
export async function whoami(ctx: CuratedContext & { token: string }, io: CuratedIo, json: boolean): Promise<ExitCode> {
    const r = await getJson(io.fetch, { host: ctx.host, token: ctx.token, path: '/api/token/self', timeoutMs: ctx.timeoutMs, signal: io.signal });
    if (!r.ok) return failOut(io, r.fail, json);
    const b = (r.result ?? {}) as Record<string, unknown>;
    // The client name on the token's row (best effort: a failure here changes nothing).
    await rpc(io.fetch, { host: ctx.host, token: ctx.token, readonly: false, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Sequential CLI', version: VERSION } }, signal: io.signal }).catch(() => undefined);
    if (json) {
        io.out(ctx.stdoutTTY ? ttySafeJson(JSON.stringify(b)) : JSON.stringify(b));
        return EXIT.ok;
    }
    const slug = b.project_slug && typeof b.project_slug === 'object' ? str((b.project_slug as { id?: unknown }).id) : undefined;
    const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s): s is string => typeof s === 'string') : [];
    io.out(oneLine(`a ${str(b.kind) === 'pat' ? 'project access token' : 'token'} for project ${slug ?? '?'} (${str(b.project_id) ?? '?'})`));
    io.out(oneLine(`rights: ${scopes.join(', ') || '(none)'}`));
    io.out(oneLine(`expires: ${str(b.expires_at) ?? 'never'}; ends in …${str(b.last4) ?? '????'}`));
    return EXIT.ok;
}

/** The token's own project slug, for a mismatch line (best effort: null on any failure). */
export async function tokenSelf(fetch: FetchLike, host: string, token: string, signal?: AbortSignal): Promise<{ slug?: string } | null> {
    const r = await getJson(fetch, { host, token, path: '/api/token/self', timeoutMs: 15_000, signal });
    if (!r.ok) return null;
    const b = (r.result ?? {}) as Record<string, unknown>;
    const slug = b.project_slug && typeof b.project_slug === 'object' ? str((b.project_slug as { id?: unknown }).id) : undefined;
    return { slug };
}
