// Text from answers is end-user data, and a tool list from a compromised or overridden host is hostile too. On a terminal,
// controls could move the cursor, rewrite earlier lines, open links or flip the reading order, so they go before printing
// (spec §10). --json on stdout keeps the bytes.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// C0 except \t and \n, DEL, C1, the bidi and direction marks (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), the
// invisible formatters (U+200B-200D, U+2060-2064, U+206A-206F, U+FEFF), the Unicode line separators (U+2028-2029), the
// interlinear annotation marks (U+FFF9-FFFB) and the tag characters (U+E0000-E007F: invisible text an agent could read).
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

export function stripControls(s: string): string {
    return s.replace(OSC, '').replace(CSI, '').replace(CONTROLS, '');
}

/** One line for stderr: stripped, and line breaks and tabs become spaces, so a message cannot fake a second line. */
export function oneLine(s: string): string {
    return stripControls(s).replace(/[\n\t]+/g, ' ');
}

/** stripControls through every string of a JSON value (keys too). */
export function stripDeep(v: unknown): unknown {
    if (typeof v === 'string') return stripControls(v);
    if (Array.isArray(v)) return v.map(stripDeep);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [stripControls(k), stripDeep(x)]));
    return v;
}

/** JSON for a terminal: the same JSON (it parses to the same value), with every control, bidi, invisible and tag character
 *  written as a \u escape, so the bytes reach the reader visibly and never act on the terminal (mgmt review 11-06). */
export function ttySafeJson(text: string): string {
    return text.replace(new RegExp(CONTROLS.source, 'gu'), (c) => {
        const cp = c.codePointAt(0)!;
        if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, '0')}`;
        const v = cp - 0x10000;
        return `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
    });
}
