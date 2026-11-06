// `sequential` (prototype of S1-1/S1-2): tools, tools describe, call. Curated commands come in S1-3.
// The token comes from SEQUENTIAL_TOKEN only and is never printed.
// Order inside a command: everything that decides WHERE the token goes (the host) is read before any request.
import { bindCall } from './args';
import { classifyToolResult, EXIT, UsageError, type ExitCode, type Fail } from './errors';
import { oneLine, stripControls, stripDeep, ttySafeJson } from './text';
import { readToolList, type ToolInfo } from './tools';
import { apiHost, CLI_VERSION, DEFAULT_HOST, rpc, type FetchLike } from './transport';
import { readCache, writeCache } from './cache';
import { chooseProject, type ProjectFs } from './project';
import { parseCurated, runCurated, whoami, tokenSelf } from './curated';
import { COMMAND_HELP, HELP } from './help';

export interface Io {
    fetch: FetchLike;
    out: (line: string) => void;
    err: (line: string) => void;
    /** stdout is a terminal: human output. */
    stdoutTTY: boolean;
    /** stdin AND stderr are terminals: a write may ask. */
    interactive: boolean;
    confirm?: (question: string) => Promise<boolean>;
    /** --input: the JSON object in a file, or stdin for '-'. Throws UsageError when it cannot. */
    readJson?: (path: string) => Record<string, unknown>;
    /** changes sync --items: the text of a file, or stdin for '-'. */
    readText?: (path: string) => string;
    signal?: AbortSignal;
    /** The tool-list cache directory; null or absent = no cache (tests). */
    cacheDir?: string | null;
    /** For .sequential.json; absent = the real file system. */
    projectFs?: ProjectFs;
}


const SERVER_KEY = 'sqs_';
const PAT = /^sq_pat_[0-9A-Za-z]{32}$/;
/** Reads that spend the project's paid budget: asked like a write, sent like a read. The BE contract test pins that this
 *  is the whole list (a new paid tool fails it), so the CLI does not drift from the server. */
export const PAID_READS: ReadonlySet<string> = new Set(['ask_sessions']);

function tokenNamed(env: Record<string, string | undefined>, names: readonly string[] = ['SEQUENTIAL_TOKEN'], scope?: string): { token: string; name: string } {
    const name = names.find((n) => env[n]?.trim()) ?? names[names.length - 1];
    const t = env[name]?.trim();
    const needs = scope ? ` with ${scope}` : '';
    if (!t) throw new UsageError(`set ${names.join(' or ')} to a project access token (sq_pat_…)${needs}`);
    if (t.startsWith(SERVER_KEY)) throw new UsageError(`${name} holds a server key (sqs_…): it sends events and cannot call tools. Use a project access token (sq_pat_…)${needs}.`);
    if (!PAT.test(t)) throw new UsageError(`${name} is not a project access token (sq_pat_…)`);
    return { token: t, name };
}
const tokenFrom = (env: Record<string, string | undefined>): string => tokenNamed(env).token;

/** The right each named command needs, for the "cannot" line. */
const NEEDS: Readonly<Record<string, string>> = { 'changes record': 'changes:write', 'changes sync': 'changes:write', 'releases record': 'releases:write' };

/** project_not_in_connection: say which project the token is for (GET /api/token/self, best effort), never just "refused". */
async function mismatchLine(io: Io, host: string, token: string, sent: string | undefined, from: string | undefined): Promise<string> {
    const self = await tokenSelf(io.fetch, host, token, io.signal);
    const where = from ? ` (from ${oneLine(from)})` : '';
    return self?.slug
        ? `sequential: this token is for project ${oneLine(self.slug)}, not ${oneLine(sent ?? '?')}${where}. Pass its id or slug, or leave the project out.`
        : `sequential: this token is not for project ${oneLine(sent ?? '?')}${where}. Pass its own project's id or slug, or leave the project out.`;
}

/** changes record|sync, releases record, whoami: one request each (curated.ts). A release reads SEQUENTIAL_RELEASES_TOKEN
 *  first (the old CLI's variable), then SEQUENTIAL_TOKEN. --dry-run needs no token and sends nothing (not for whoami). */
async function namedCommand(name: string, rest: readonly string[], hostFlag: string | undefined, env: Record<string, string | undefined>, io: Io): Promise<ExitCode> {
    const f = parseCurated(name, rest);
    if (f.has('help')) {
        io.out(COMMAND_HELP[name]);
        return EXIT.ok;
    }
    const dry = f.has('dry-run');
    const tok = dry ? undefined : tokenNamed(env, name === 'releases record' ? ['SEQUENTIAL_RELEASES_TOKEN', 'SEQUENTIAL_TOKEN'] : ['SEQUENTIAL_TOKEN'], NEEDS[name]);
    const host = dry ? (() => { try { return apiHost(hostFlag ?? env.SEQUENTIAL_HOST); } catch (e) { throw new UsageError((e as Error).message); } })() : hostFrom(io, hostFlag, env);
    const t = f.get('timeout')?.[0];
    if (t !== undefined && (!/^\d+$/.test(t) || Number(t) < 1)) throw new UsageError('--timeout must be whole seconds, 1 or more');
    const timeoutMs = t === undefined ? undefined : Number(t) * 1000;
    if (name === 'whoami') return whoami({ host, token: tok!.token, timeoutMs }, io, f.has('json'));
    const chosen = chooseProject(f.get('project')?.[0], env, io.projectFs);
    for (const w of chosen.warnings) io.err(`sequential: ${oneLine(w)}`);
    if (!dry && !f.has('json')) io.err(`sequential: ${name} on ${chosen.project ? `project ${oneLine(chosen.project)}${chosen.from ? ` (from ${oneLine(chosen.from)})` : ''}` : "the token's project"}`);
    const code = await runCurated(name, f, { host, token: tok?.token, project: chosen.project, timeoutMs, stdoutTTY: io.stdoutTTY }, io, async (fail) => {
        if (fail.code === 'project_not_in_connection' && tok) {
            io.err(await mismatchLine(io, host, tok.token, chosen.project, chosen.from));
            return EXIT.usage;
        }
        if (fail.code === 'not_available' && tok) {
            io.err(`sequential: the token in ${tok.name} cannot do this: ${name} needs ${NEEDS[name]}${tok.name === 'SEQUENTIAL_TOKEN' && name === 'releases record' ? ' (or set SEQUENTIAL_RELEASES_TOKEN to a token that has it)' : ''}.`);
            return EXIT.auth;
        }
        return undefined;
    });
    return code;
}

function printFail(io: Io, f: Fail, json: boolean): ExitCode {
    if (json) {
        // Stripped too: stderr is usually a terminal even when stdout is piped, and JSON.stringify leaves C1 and bidi raw.
        io.err(JSON.stringify(stripDeep({ error: f.code, message: f.message, ...(f.retryAfterSec === undefined ? {} : { retry_after_sec: f.retryAfterSec }) })));
    } else {
        const later = f.retryAfterSec === undefined ? '' : ` Try again in ${f.retryAfterSec} s.`;
        io.err(`sequential: ${oneLine(f.message)} (${oneLine(f.code)})${later}`);
    }
    return f.exit;
}

/** The token's tools: from the cache (10 min) unless `fresh`, else tools/list on /mcp (it lists writes and the stubs). */
async function listTools(io: Io, host: string, token: string, fresh = false, timeoutMs?: number): Promise<{ tools: ToolInfo[]; cached: boolean } | Fail> {
    const dir = io.cacheDir ?? null;
    if (!fresh) {
        const hit = readCache(dir, host, token);
        if (hit !== undefined) {
            try {
                return { tools: readToolList(hit), cached: true };
            } catch {
                /* a bad cache entry: ask the server */
            }
        }
    }
    const r = await rpc(io.fetch, { host, token, readonly: false, method: 'tools/list', timeoutMs, signal: io.signal });
    if (!r.ok) return r.fail;
    try {
        const tools = readToolList(r.result);
        writeCache(dir, host, token, r.result);
        return { tools, cached: false };
    } catch {
        return { exit: EXIT.refused, code: 'bad_answer', message: 'Sequential sent a tool list this CLI cannot read: update the CLI.' };
    }
}

/** JSON on stdout: as is in a pipe; on a terminal with every control written as a \u escape (it parses the same). */
const outJson = (io: Io, v: unknown): string => (io.stdoutTTY ? ttySafeJson(JSON.stringify(v)) : JSON.stringify(v));

const isFail = (v: unknown): v is Fail => v !== null && typeof v === 'object' && 'exit' in v && 'code' in v;

function hostFrom(io: Io, flag: string | undefined, env: Record<string, string | undefined>): string {
    let host: string;
    try {
        host = apiHost(flag ?? env.SEQUENTIAL_HOST);
    } catch (e) {
        throw new UsageError((e as Error).message);
    }
    if (host !== DEFAULT_HOST) io.err(`sequential: sending the token to ${host}, not ${DEFAULT_HOST}`);
    return host;
}

/** `--host <url>` / `--host=<url>` before the command: the only place it is read (never from words after the command). */
function leadingGlobals(argv: readonly string[]): { host?: string; rest: string[] } {
    let i = 0;
    let host: string | undefined;
    while (i < argv.length && argv[i].startsWith('--host')) {
        const a = argv[i];
        if (host !== undefined) throw new UsageError('--host is given twice');
        if (a === '--host') {
            if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new UsageError('--host needs a URL');
            host = argv[i + 1];
            i += 2;
        } else if (a.startsWith('--host=')) {
            host = a.slice(7);
            i += 1;
        } else break;
    }
    return { host, rest: argv.slice(i) };
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: Io): Promise<ExitCode> {
    try {
        const { host: hostFlag, rest: words } = leadingGlobals(argv);
        const [cmd, ...rest] = words;
        const json = !io.stdoutTTY || rest.includes('--json');
        if (cmd === undefined) {
            io.err(HELP);
            return EXIT.usage;
        }
        if (cmd === '--help' || cmd === 'help') {
            const which = cmd === 'help' ? rest.join(' ') : '';
            if (which && !Object.hasOwn(COMMAND_HELP, which)) throw new UsageError(`no command ${which}: see sequential --help`);
            io.out(which ? COMMAND_HELP[which] : HELP);
            return EXIT.ok;
        }
        if (cmd === '--version') {
            io.out(CLI_VERSION);
            return EXIT.ok;
        }
        if (cmd === 'tools') return await toolsCommand(rest, hostFlag, env, io, json);
        const sub = rest[0];
        const named = cmd === 'changes' && (sub === 'record' || sub === 'sync') ? `changes ${sub}` : cmd === 'releases' && sub === 'record' ? 'releases record' : cmd === 'whoami' ? 'whoami' : undefined;
        if (named) return await namedCommand(named, named === 'whoami' ? rest : rest.slice(1), hostFlag, env, io);
        if (cmd === 'changes' || cmd === 'releases') throw new UsageError(`unknown command ${cmd} ${sub ?? ''}: see sequential --help`);
        if (cmd === 'call') return await callCommand(rest, hostFlag, env, io, json);
        throw new UsageError(`unknown command ${cmd}: see sequential --help`);
    } catch (e) {
        if (e instanceof UsageError) {
            // A usage message can quote server words (argument names, enum values): one stripped line.
            io.err(`sequential: ${oneLine(e.message)}`);
            return EXIT.usage;
        }
        io.err('sequential: an unexpected error');
        return EXIT.refused;
    }
}

function describeTool(io: Io, t: ToolInfo, json: boolean): void {
    const s = stripControls;
    if (json) {
        io.out(outJson(io, { name: t.name, title: t.title, description: t.description, write: t.write, paid: PAID_READS.has(t.name), enabled: !t.stub, inputSchema: t.inputSchema }));
        return;
    }
    io.out(`${s(t.name)}${t.title ? ` (${s(t.title)})` : ''}${t.write ? ': changes something' : PAID_READS.has(t.name) ? ': paid' : ''}`);
    io.out('');
    io.out(s(t.description));
    const props = t.inputSchema.properties ?? {};
    const req = new Set(t.inputSchema.required ?? []);
    if (Object.keys(props).length) io.out('\nArguments:');
    for (const [k, sc] of Object.entries(props)) {
        const ty = Array.isArray(sc.type) ? sc.type.join('|') : (sc.type ?? 'json');
        io.out(s(`  --${k.replace(/_/g, '-')} <${sc.enum ? sc.enum.join('|') : ty}>${req.has(k) ? ' (required)' : ''}`));
    }
}

async function toolsCommand(rest: readonly string[], hostFlag: string | undefined, env: Record<string, string | undefined>, io: Io, json: boolean): Promise<ExitCode> {
    if (rest.includes('--help')) {
        io.out(COMMAND_HELP.tools);
        return EXIT.ok;
    }
    const ti = rest.findIndex((w) => w === '--timeout' || w.startsWith('--timeout='));
    let timeoutMs: number | undefined;
    let words0 = [...rest];
    if (ti >= 0) {
        const v = rest[ti].includes('=') ? rest[ti].slice(10) : rest[ti + 1];
        if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) throw new UsageError('--timeout must be whole seconds, 1 or more');
        timeoutMs = Number(v) * 1000;
        words0 = rest.filter((_, k) => k !== ti && (rest[ti].includes('=') || k !== ti + 1));
    }
    const words = words0.filter((w) => w !== '--json' && w !== '--refresh');
    const refresh = rest.includes('--refresh');
    if (words.some((w) => w.startsWith('--host'))) throw new UsageError('put --host before the command, or set SEQUENTIAL_HOST');
    const describe = words[0] === 'describe' ? words[1] : undefined;
    if (words[0] === 'describe' && !describe) throw new UsageError('tools describe needs a tool name');
    if (words.length > (describe ? 2 : 0)) throw new UsageError(`unexpected word: ${words[describe ? 2 : 0]}`);
    const token = tokenFrom(env);
    const host = hostFrom(io, hostFlag, env);
    const fresh = await listTools(io, host, token, refresh, timeoutMs);
    if (isFail(fresh)) return printFail(io, fresh, json);
    const list = fresh.tools;
    const s = stripControls;
    if (describe) {
        const t = list.find((x) => x.name === describe);
        if (!t) throw new UsageError(`this token has no tool ${describe}: see sequential tools`);
        describeTool(io, t, json);
        return EXIT.ok;
    }
    const callable = list.filter((t) => !t.stub);
    const stubs = list.filter((t) => t.stub);
    if (json) {
        io.out(outJson(io, { tools: callable.map((t) => ({ name: t.name, title: t.title, write: t.write || PAID_READS.has(t.name) })), not_enabled: stubs.map((t) => t.name) }));
        return EXIT.ok;
    }
    const w = Math.min(40, callable.reduce((m, t) => Math.max(m, t.name.length), 4));
    for (const t of callable) io.out(s(`${t.name.padEnd(w)}  ${t.write ? 'write' : PAID_READS.has(t.name) ? 'paid ' : 'read '}  ${t.title ?? ''}`));
    if (stubs.length) {
        io.out('\nNot enabled on this token:');
        for (const t of stubs) io.out(s(`  ${t.name}`));
    }
    return EXIT.ok;
}

async function callCommand(rest: readonly string[], hostFlag: string | undefined, env: Record<string, string | undefined>, io: Io, json: boolean): Promise<ExitCode> {
    const token = tokenFrom(env);
    const host = hostFrom(io, hostFlag, env);
    // --timeout covers the tool-list request too. Read before binding (the list comes first); harmless: it decides no host.
    const ti = rest.findIndex((w) => w === '--timeout' || w.startsWith('--timeout='));
    const tv = ti < 0 ? undefined : rest[ti].includes('=') ? rest[ti].slice(10) : rest[ti + 1];
    const listTimeout = tv !== undefined && /^\d+$/.test(tv) && Number(tv) >= 1 ? Number(tv) * 1000 : undefined;
    let got = await listTools(io, host, token, rest.includes('--refresh'), listTimeout);
    if (isFail(got)) return printFail(io, got, json);
    let byName = new Map(got.tools.map((t) => [t.name, t]));
    let c;
    try {
        c = bindCall(rest, (n) => byName.get(n), io.readJson);
        if (!byName.has(c.tool)) throw new UsageError(`this token has no tool ${c.tool}: see sequential tools`);
    } catch (e) {
        // A tool or an argument the CACHED list does not know: ask the server once (a tool may have been added), then decide.
        if (!(e instanceof UsageError) || !got.cached) throw e;
        got = await listTools(io, host, token, true, listTimeout);
        if (isFail(got)) return printFail(io, got, json);
        byName = new Map(got.tools.map((t) => [t.name, t]));
        c = bindCall(rest, (n) => byName.get(n), io.readJson);
    }
    const tool = byName.get(c.tool);
    if (!tool) throw new UsageError(`this token has no tool ${c.tool}: see sequential tools`);
    if (c.help) {
        describeTool(io, tool, json || c.json);
        return EXIT.ok;
    }
    if (tool.stub) {
        // A stand-in: its description says how to turn the tool on. Nothing is sent.
        io.err(`sequential: ${oneLine(tool.description)}`);
        return EXIT.auth;
    }
    // A project in --input or --json-arg is the caller's own choice: it wins over SEQUENTIAL_PROJECT and the file, and must
    // agree with --project.
    const own = Object.hasOwn(c.args, 'project') && typeof c.args.project === 'string' ? (c.args.project as string) : undefined;
    if (own !== undefined && c.project !== undefined && own !== c.project) throw new UsageError('project is in the arguments and in --project: give it once');
    const chosen = own !== undefined ? { project: own, warnings: [] as string[], from: undefined } : chooseProject(c.project, env, io.projectFs);
    for (const w of chosen.warnings) io.err(`sequential: ${oneLine(w)}`);
    if (chosen.from && !(tool.write || PAID_READS.has(tool.name))) io.err(`sequential: project ${oneLine(chosen.project ?? '')} (from ${oneLine(chosen.from)})`);
    const project = chosen.project;
    const args = project === undefined ? c.args : Object.assign(Object.create(null) as Record<string, unknown>, c.args, { project });
    const sentProject = typeof args.project === 'string' ? args.project : undefined;
    const asks = tool.write || PAID_READS.has(tool.name);
    if (asks) {
        const where = sentProject ? `project ${sentProject}${chosen.from ? ` (from ${chosen.from})` : ''}` : "the token's project";
        if (!c.yes) {
            // Ask only on a terminal, and never when --input is given (stdin may be the input, under any path name).
            const canAsk = io.interactive && c.input === undefined && io.confirm !== undefined;
            if (!canAsk) throw new UsageError(`${tool.name} ${tool.write ? 'changes something' : 'spends the project’s paid budget'}: add --yes to run it`);
            const ok = await io.confirm!(`Run ${oneLine(tool.name)} on ${oneLine(where)}? [y/N] `);
            if (!ok) {
                io.err('sequential: nothing was done');
                return EXIT.usage;
            }
        } else io.err(`sequential: ${oneLine(tool.name)} on ${oneLine(where)}`);
    }
    const r = await rpc(io.fetch, { host, token, readonly: !tool.write, method: 'tools/call', params: { name: tool.name, arguments: args }, timeoutMs: c.timeoutSec ? c.timeoutSec * 1000 : undefined, signal: io.signal });
    if (!r.ok) {
        if (r.fail.code === 'timeout' && tool.write) {
            r.fail.message += tool.idempotent ? ' The outcome is unknown; running it again is safe.' : ' The outcome is unknown; check before you run it again.';
        }
        return printFail(io, r.fail, json || c.json);
    }
    const o = classifyToolResult(r.result);
    if (!o.ok) {
        if (o.fail.code === 'project_not_in_connection') {
            io.err(await mismatchLine(io, host, token, sentProject, chosen.from));
            return EXIT.usage;
        }
        return printFail(io, o.fail, json || c.json);
    }
    if (json || c.json) io.out(outJson(io, o.kind === 'text' ? { markdown: o.value } : o.value));
    else io.out(o.kind === 'text' ? stripControls(o.value) : JSON.stringify(stripDeep(o.value), null, 2));
    return EXIT.ok;
}
