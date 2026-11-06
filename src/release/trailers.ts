// Reads `Sequential-Finding: F-12` commit trailers out of a git log body (`git log --format=%B <range>`), the way
// `releases record --range` names findings without a person typing ids by hand. Ported from @usesequential/release-cli.
import { addIds, DEFAULT_SCOPE, idInScope, type FindingScope } from './findings';

// Anchored per LINE (not per commit message), case-insensitive, so `sequential-finding:` and `Sequential-Finding:` both
// count and a mid-line mention ("see also Sequential-Finding: F-1") does not. /g + /m walks every matching line in one
// log covering many commits. `[ \t]*`, not `\s*`: \s matches a newline, so a bare `Sequential-Finding:` line would
// capture the NEXT line.
const TRAILER_LINE_RE = /^Sequential-Finding:[ \t]*(.+)$/gim;

/** The finding ids of a log's trailers, deduplicated in first-seen order, capped at the server's 50. `scope`: which ids
 *  count (./findings.ts): `F-12`, or `web#F-12` for the project key `web`. Default: unqualified ids only. */
export function findingIdsFromLog(log: string, scope: Readonly<FindingScope> = DEFAULT_SCOPE): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    // A fresh RegExp per call: a module-level /g regex keeps `lastIndex` between calls, which would silently skip
    // matches on the second and later invocations in the same process.
    const re = new RegExp(TRAILER_LINE_RE.source, TRAILER_LINE_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(log)) !== null) {
        const tokens = match[1].split(/[\s,]+/).filter(Boolean);
        if (!addIds(ids, seen, tokens.map((t) => idInScope(t, scope)))) return ids;
    }
    return ids;
}
