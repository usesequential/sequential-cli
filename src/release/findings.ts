// Which finding ids a release names, from text people write: `Sequential-Finding: F-12` commit trailers (./trailers.ts)
// and "Fixes F-12" in pull request titles and bodies (findingIdsFromPrText below). Ported from @usesequential/release-cli.
//
// The scope rule (mgmt ruling 2026-11-02): a finding number belongs to ONE Sequential project (F-12 can exist in several),
// and one repository can deploy several projects (a monorepo with several Vercel projects). So:
// - an id qualified with a project key, `web#F-12`, counts only for the release whose --project-key is `web`;
// - an unqualified id, `F-12`, counts only when --findings is `all`. That is the default when no --project-key is given
//   (one repository, one project), and NOT the default when one is: with several projects, write `Fixes web#F-12`.

/** The server's shape (BE src/releases/parse.ts): no leading zero, never F-0. */
const FINDING_ID_RE = /^F-[1-9]\d{0,8}$/;
/** A project key: what the team writes before `#` (letters, digits, . _ -; up to 64). */
const PROJECT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The server's cap on finding_ids: it refuses a release that names more (contract.json finding_ids_max). */
export const MAX_FINDING_IDS = 50;

export interface FindingScope {
    projectKey: string | null;
    unqualified: boolean;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/** The scope a run reads ids in. */
export function findingScope({ projectKey, findings }: { projectKey?: string; findings?: string } = {}): Checked<FindingScope> {
    if (projectKey !== undefined && !PROJECT_KEY_RE.test(projectKey)) {
        return { ok: false, message: '--project-key: letters, digits, . _ - (up to 64), as written before # in "Fixes web#F-12"' };
    }
    if (findings !== undefined && findings !== 'all' && findings !== 'qualified') {
        return { ok: false, message: '--findings: all or qualified' };
    }
    const unqualified = findings !== undefined ? findings === 'all' : projectKey === undefined;
    return { ok: true, value: { projectKey: projectKey === undefined ? null : projectKey.toLowerCase(), unqualified } };
}

export const DEFAULT_SCOPE: Readonly<FindingScope> = Object.freeze({ projectKey: null, unqualified: true });

/** The finding id one written token names in this scope, or null. `F-12` → F-12 when unqualified ids count; `web#F-12` →
 *  F-12 when the scope's project key is `web` (case-insensitive). */
export function idInScope(token: string, scope: Readonly<FindingScope> = DEFAULT_SCOPE): string | null {
    const hash = token.lastIndexOf('#');
    if (hash === -1) return scope.unqualified && FINDING_ID_RE.test(token) ? token : null;
    const key = token.slice(0, hash);
    const id = token.slice(hash + 1);
    if (!FINDING_ID_RE.test(id) || !PROJECT_KEY_RE.test(key)) return null;
    return scope.projectKey !== null && key.toLowerCase() === scope.projectKey ? id : null;
}

/** Adds ids in first-seen order, deduplicated, up to the server's cap. Returns false once the cap is reached. */
export function addIds(into: string[], seen: Set<string>, ids: Iterable<string | null>): boolean {
    for (const id of ids) {
        if (into.length >= MAX_FINDING_IDS) return false;
        if (id === null || seen.has(id)) continue;
        seen.add(id);
        into.push(id);
    }
    return into.length < MAX_FINDING_IDS;
}

// "Fixes F-12", "closes web#F-3, F-4", "Resolved: F-9 and F-10": a closing word, then one or more ids separated by
// commas, spaces or "and". Case-insensitive; the word must stand alone ("prefixes F-1" does not count).
const ID_TOKEN = '(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}#)?F-\\d+';
const CLOSING_RE = new RegExp(`(?<![A-Za-z0-9_])(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\b:?\\s+(${ID_TOKEN}(?:(?:\\s*,\\s*|\\s+)(?:and\\s+)?${ID_TOKEN})*)`, 'gi');

/** The finding ids a pull request's title and body close, in this scope. */
export function findingIdsFromPrText(text: string, scope: Readonly<FindingScope> = DEFAULT_SCOPE): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = new RegExp(CLOSING_RE.source, CLOSING_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(String(text))) !== null) {
        const tokens = match[1].split(/[\s,]+/).filter((t) => t !== '' && t.toLowerCase() !== 'and');
        // An id like F-012 is not one of ours: the server would refuse the whole release, so it is skipped here.
        if (!addIds(ids, seen, tokens.map((t) => idInScope(t.replace(/^(.*#)?f-/i, (m) => m.slice(0, -2) + 'F-'), scope)))) break;
    }
    return ids;
}
