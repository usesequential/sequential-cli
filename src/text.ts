// Text from answers is end-user data, and a tool list from a compromised or overridden host is hostile too. On a terminal,
// controls could move the cursor, rewrite earlier lines, open links or flip the reading order, so they go before printing
// (spec §10). --json on stdout keeps the bytes.
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// C0 except \t and \n, DEL, C1, the bidi and direction marks (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), the
// invisible formatters (U+200B-200D, U+2060-2064, U+206A-206F, U+FEFF) and the Unicode line separators (U+2028-2029).
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

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
