// `sequential call <tool> --<arg> <value> …`: flags bound to the tool's live inputSchema (spec 5.5).
// Hand-written: util.parseArgs is experimental on some Node 18 releases.
import { UsageError } from './errors';
import type { JsonSchema, ToolInfo } from './tools';

/** The CLI's own flags inside `call`. A tool argument with one of these names is sent with --json-arg or --input. */
export const CALL_GLOBALS_VALUED = new Set(['project', 'timeout', 'input', 'json-arg']);
/** Keys that would reach an object's prototype. Never an argument name. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, k: string) => Object.hasOwn(o, k);
const bag = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;
export const CALL_GLOBALS_SWITCH = new Set(['json', 'yes', 'refresh', 'help']);

export interface CallArgs {
    tool: string;
    args: Record<string, unknown>;
    project?: string;
    timeoutSec?: number;
    input?: string;
    json: boolean;
    yes: boolean;
    refresh: boolean;
    help: boolean;
}

const kebabToSnake = (s: string) => s.replace(/-/g, '_');
const flagName = (k: string) => `--${k.replace(/_/g, '-')}`;

function typeOf(s: JsonSchema): string {
    if (s.oneOf || s.anyOf) return 'union';
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    return t ?? 'union';
}

function parseJsonArg(name: string, raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        throw new UsageError(`${name}: not valid JSON`);
    }
}

function scalar(flag: string, s: JsonSchema, raw: string): unknown {
    const t = typeOf(s);
    let v: unknown;
    if (t === 'integer') {
        if (!/^-?\d+$/.test(raw)) throw new UsageError(`${flag} must be a whole number`);
        v = Number(raw);
    } else if (t === 'number') {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${flag} must be a number`);
        v = n;
    } else if (t === 'string') {
        v = raw;
    } else if (t === 'union') {
        // A JSON value when it looks like one, else the text: the server decides.
        v = /^[[{]/.test(raw.trim()) ? parseJsonArg(flag, raw) : raw;
    } else {
        throw new UsageError(`${flag} takes JSON: use --json-arg ${flag.slice(2).replace(/-/g, '_')}=<json> or --input`);
    }
    if (s.enum && !s.enum.includes(v)) throw new UsageError(`${flag} must be one of ${s.enum.join(', ')}`);
    return v;
}

/**
 * Binds argv (the words after `call`) to the tool's schema. argv[0] is the tool name. Checks only what the live schema
 * says: types, enums, required, unknown names. Everything else is the server's to refuse.
 * `lookup` returns undefined for a tool the token does not have: the caller reports that before anything else.
 */
export function bindCall(argv: readonly string[], lookup: (name: string) => ToolInfo | undefined, inputJson?: (path: string) => Record<string, unknown>): CallArgs {
    const toolName = argv[0];
    if (toolName === undefined || toolName.startsWith('--')) throw new UsageError('call needs a tool name first: sequential call <tool> [--arg value]…');
    const out: CallArgs = { tool: toolName, args: bag(), json: false, yes: false, refresh: false, help: false };
    const tool = lookup(toolName);
    const props = tool?.inputSchema.properties ?? {};
    const fromFlags = bag();
    const seen = new Set<string>();
    const seenGlobal = new Set<string>();

    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new UsageError(`unexpected word: ${a}`);
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        const inline = eq < 0 ? undefined : a.slice(eq + 1);
        const take = (): string => {
            if (inline !== undefined) return inline;
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value (for a value that starts with "--", write --${name}=<value>)`);
            i++;
            return next;
        };

        if (name === 'host') {
            // The host decides where the token goes, so it is read before any request: only before the command, or SEQUENTIAL_HOST.
            throw new UsageError('put --host before the command (sequential --host <url> call …), or set SEQUENTIAL_HOST');
        }
        if (CALL_GLOBALS_SWITCH.has(name)) {
            if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
            out[name as 'json' | 'yes' | 'refresh' | 'help'] = true;
            continue;
        }
        if (CALL_GLOBALS_VALUED.has(name)) {
            if (name !== 'json-arg') {
                if (seenGlobal.has(name)) throw new UsageError(`--${name} is given twice`);
                seenGlobal.add(name);
            }
            const v = take();
            if (name === 'project') out.project = v;
            else if (name === 'timeout') {
                if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError('--timeout must be whole seconds, 1 or more');
                out.timeoutSec = Number(v);
            } else if (name === 'input') out.input = v;
            else {
                const at = v.indexOf('=');
                if (at < 1) throw new UsageError('--json-arg needs <name>=<json>');
                const key = v.slice(0, at);
                if (FORBIDDEN.has(key)) throw new UsageError(`${key} is not an argument name`);
                if (tool && !own(props, key)) throw new UsageError(`${toolName} has no argument ${key}`);
                if (seen.has(key)) throw new UsageError(`${key} is given twice`);
                seen.add(key);
                fromFlags[key] = parseJsonArg(`--json-arg ${key}`, v.slice(at + 1));
            }
            continue;
        }
        if (!tool) {
            // Unknown tool: skip a value-looking next word so the caller can report the tool, not a stray word.
            if (inline === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
            continue;
        }
        let key = kebabToSnake(name);
        let negated = false;
        if (FORBIDDEN.has(key)) throw new UsageError(`--${name} is not an argument`);
        if (!own(props, key) && key.startsWith('no_') && own(props, key.slice(3)) && typeOf(props[key.slice(3)]) === 'boolean') {
            negated = true;
            key = key.slice(3);
        }
        const schema = own(props, key) ? props[key] : undefined;
        if (!schema) {
            const known = Object.keys(props).map(flagName).join(' ') || '(none)';
            throw new UsageError(`${toolName} has no argument --${name}. Its arguments: ${known}`);
        }
        const flag = flagName(key);
        const t = typeOf(schema);
        if (t === 'boolean') {
            if (inline !== undefined) {
                if (inline !== 'true' && inline !== 'false') throw new UsageError(`${flag} is true or false`);
                negated = negated !== (inline === 'false');
            }
            if (seen.has(key)) throw new UsageError(`${flag} is given twice`);
            seen.add(key);
            fromFlags[key] = !negated;
            continue;
        }
        if (t === 'array') {
            const item = schema.items ?? {};
            const it = typeOf(item);
            if (it !== 'string' && it !== 'integer' && it !== 'number') throw new UsageError(`${flag} takes JSON: use --json-arg ${key}=<json> or --input`);
            const list = Array.isArray(fromFlags[key]) ? (fromFlags[key] as unknown[]) : [];
            if (seen.has(key) && !Array.isArray(fromFlags[key])) throw new UsageError(`${flag} is given twice`);
            list.push(scalar(flag, item, take()));
            fromFlags[key] = list;
            seen.add(key);
            continue;
        }
        if (seen.has(key)) throw new UsageError(`${flag} is given twice`);
        seen.add(key);
        fromFlags[key] = scalar(flag, schema, take());
    }

    const fromInput = bag();
    if (out.input !== undefined) {
        if (!inputJson) throw new UsageError('--input is not available here');
        const read = inputJson(out.input);
        for (const k of Object.keys(read)) {
            if (FORBIDDEN.has(k)) throw new UsageError(`--input: ${k} is not an argument name`);
            fromInput[k] = read[k];
        }
    }
    for (const k of Object.keys(fromFlags)) {
        if (own(fromInput, k)) throw new UsageError(`${k} is in --input and in a flag: give it once`);
    }
    out.args = Object.assign(bag(), fromInput, fromFlags);
    if (tool && !out.help) {
        for (const r of tool.inputSchema.required ?? []) {
            if (!own(out.args, r)) throw new UsageError(`${toolName} needs ${flagName(r)}`);
        }
    }
    return out;
}
