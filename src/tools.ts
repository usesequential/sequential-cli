// The token's tools, from the server's tools/list (ruling 4: the CLI copies no server rules).
export interface JsonSchema {
    type?: string | string[];
    enum?: unknown[];
    items?: JsonSchema;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    description?: string;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
}

export interface ToolInfo {
    name: string;
    title: string | undefined;
    description: string;
    inputSchema: JsonSchema;
    /** A write UNLESS the server says readOnlyHint true (fails closed: an entry with no hint is a write). */
    write: boolean;
    idempotent: boolean;
    /** A stand-in for a tool the token lacks: title ends " (not enabled)" AND an empty schema. Never by the schema alone. */
    stub: boolean;
}

const STUB_SUFFIX = ' (not enabled)';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readToolList(result: unknown): ToolInfo[] {
    if (!isObj(result) || !Array.isArray(result.tools)) throw new Error('tools/list: no tools array');
    return result.tools.filter(isObj).map((t) => {
        const ann = isObj(t.annotations) ? t.annotations : {};
        const title = typeof t.title === 'string' ? t.title : typeof ann.title === 'string' ? ann.title : undefined;
        const inputSchema = (isObj(t.inputSchema) ? t.inputSchema : {}) as JsonSchema;
        const empty = Object.keys(inputSchema.properties ?? {}).length === 0;
        return {
            name: String(t.name),
            title,
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema,
            write: ann.readOnlyHint !== true,
            idempotent: ann.idempotentHint === true,
            stub: title !== undefined && title.endsWith(STUB_SUFFIX) && empty,
        };
    });
}
