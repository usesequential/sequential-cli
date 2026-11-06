import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findingIdsFromPrText, findingScope, idInScope, type FindingScope } from '../src/release/findings';
import { findingIdsFromLog } from '../src/release/trailers';

// Ported from @usesequential/release-cli's tests/cli/findings.test.ts and trailers.test.ts: which finding ids a release
// names from "Fixes F-12" in pull request text and `Sequential-Finding:` commit trailers, and the project scope rule (mgmt
// ruling 2026-11-02): `web#F-12` counts only for --project-key web; unqualified `F-12` only with --findings all, the
// default when no project key is given.
const scope = (opts: { projectKey?: string; findings?: string } = {}): FindingScope => {
    const r = findingScope(opts);
    if (!r.ok) throw new Error(r.message);
    return r.value;
};

describe('findingScope', () => {
    test('no project key: unqualified ids count; a project key: only qualified ones, unless findings is all', () => {
        assert.deepEqual(scope(), { projectKey: null, unqualified: true });
        assert.deepEqual(scope({ projectKey: 'Web' }), { projectKey: 'web', unqualified: false });
        assert.deepEqual(scope({ projectKey: 'web', findings: 'all' }), { projectKey: 'web', unqualified: true });
        assert.deepEqual(scope({ findings: 'qualified' }), { projectKey: null, unqualified: false });
    });

    test('refuses a bad key or a bad findings value', () => {
        assert.equal(findingScope({ projectKey: 'we b' }).ok, false);
        assert.equal(findingScope({ projectKey: '#web' }).ok, false);
        assert.equal(findingScope({ projectKey: 'x'.repeat(65) }).ok, false);
        assert.equal(findingScope({ projectKey: 'x'.repeat(64) }).ok, true);
        assert.equal(findingScope({ findings: 'some' }).ok, false);
    });
});

describe('idInScope', () => {
    test('an unqualified id counts only when unqualified ids do', () => {
        assert.equal(idInScope('F-12', scope()), 'F-12');
        assert.equal(idInScope('F-12', scope({ projectKey: 'web' })), null);
        assert.equal(idInScope('F-12'), 'F-12'); // the default scope: unqualified ids
    });

    test('a qualified id counts only for its own project key (case-insensitive)', () => {
        assert.equal(idInScope('web#F-12', scope({ projectKey: 'web' })), 'F-12');
        assert.equal(idInScope('WEB#F-12', scope({ projectKey: 'web' })), 'F-12');
        assert.equal(idInScope('app#F-12', scope({ projectKey: 'web' })), null);
        assert.equal(idInScope('web#F-12', scope()), null); // no key: a qualified id is for some other release
    });

    test('never an id the server would refuse', () => {
        for (const bad of ['F-0', 'F-012', 'F-1234567890', 'F12', 'web#F-0', 'web#']) assert.equal(idInScope(bad, scope({ projectKey: 'web', findings: 'all' })), null, bad);
    });
});

describe('findingIdsFromPrText', () => {
    test('reads the closing words, lists and qualifiers', () => {
        const text = 'Fixes F-12\nThis closes F-3, F-4 and F-5.\nResolved: F-9\nfixed f-10';
        assert.deepEqual(findingIdsFromPrText(text, scope()), ['F-12', 'F-3', 'F-4', 'F-5', 'F-9', 'F-10']);
    });

    test('a mention without a closing word, or inside another word, does not count', () => {
        assert.deepEqual(findingIdsFromPrText('See F-12. Related to F-3. prefixes F-4. unfixed F-5', scope()), []);
    });

    test("in a monorepo: only this project's qualified ids, unless findings is all", () => {
        const text = 'Fixes web#F-12, app#F-3 and F-7';
        assert.deepEqual(findingIdsFromPrText(text, scope({ projectKey: 'web' })), ['F-12']);
        assert.deepEqual(findingIdsFromPrText(text, scope({ projectKey: 'app' })), ['F-3']);
        assert.deepEqual(findingIdsFromPrText(text, scope({ projectKey: 'web', findings: 'all' })), ['F-12', 'F-7']);
        assert.deepEqual(findingIdsFromPrText(text, scope()), ['F-7']);
    });

    test('deduplicates and stops at 50', () => {
        const many = Array.from({ length: 60 }, (_, i) => `F-${i + 1}`).join(', ');
        assert.equal(findingIdsFromPrText(`Fixes F-1, F-1. Fixes ${many}`, scope()).length, 50);
        assert.deepEqual(findingIdsFromPrText('Fixes F-2. Closes F-2', scope()), ['F-2']);
    });

    test('a second call in the same process reads the same (no regex state kept between calls)', () => {
        assert.deepEqual(findingIdsFromPrText('Fixes F-1', scope()), ['F-1']);
        assert.deepEqual(findingIdsFromPrText('Fixes F-1', scope()), ['F-1']);
    });
});

describe('findingIdsFromLog (commit trailers)', () => {
    test('reads Sequential-Finding trailers, one or many per line, deduplicated, in order', () => {
        const log = 'fix: pay button\n\nSequential-Finding: F-12\n\nfeat: x\n\nsequential-finding: F-4, F-12 F-7\nnot a trailer: F-99\n';
        assert.deepEqual(findingIdsFromLog(log), ['F-12', 'F-4', 'F-7']);
    });

    test('ignores malformed ids and caps at 50', () => {
        assert.deepEqual(findingIdsFromLog('Sequential-Finding: F-x, F-, 12, F-1234567890'), []);
        const many = Array.from({ length: 60 }, (_, i) => `Sequential-Finding: F-${i + 1}`).join('\n');
        assert.equal(findingIdsFromLog(many).length, 50);
    });

    test('refuses F-0 and leading zeros (the server refuses them too), keeping the valid ids beside them', () => {
        assert.deepEqual(findingIdsFromLog('Sequential-Finding: F-0, F-012, F-10, F-999999999'), ['F-10', 'F-999999999']);
    });

    test('an empty array for a log with no trailer', () => {
        assert.deepEqual(findingIdsFromLog('fix: pay button\n\nfeat: x\n'), []);
    });

    test('commas and spaces mixed as separators, and tabs', () => {
        assert.deepEqual(findingIdsFromLog('Sequential-Finding:\tF-1,F-2  F-3,\tF-4'), ['F-1', 'F-2', 'F-3', 'F-4']);
    });

    test('a bare `Sequential-Finding:` line does not capture the next line', () => {
        assert.deepEqual(findingIdsFromLog('fix: x\n\nSequential-Finding:\nF-7\n'), []);
        assert.deepEqual(findingIdsFromLog('Sequential-Finding:   \nF-7 F-8\nSequential-Finding: F-9'), ['F-9']);
    });

    test('the keyword counts only at the start of a line', () => {
        assert.deepEqual(findingIdsFromLog('see also Sequential-Finding: F-1'), []);
    });

    test('the default is unqualified ids; a project key reads its qualified trailers', () => {
        const log = 'x\n\nSequential-Finding: F-1, web#F-2\nSequential-Finding: app#F-3\n';
        assert.deepEqual(findingIdsFromLog(log), ['F-1']);
        assert.deepEqual(findingIdsFromLog(log, scope({ projectKey: 'web' })), ['F-2']);
        assert.deepEqual(findingIdsFromLog(log, scope({ projectKey: 'app', findings: 'all' })), ['F-1', 'F-3']);
    });

    test('a second call in the same process reads the same (no regex state kept between calls)', () => {
        assert.deepEqual(findingIdsFromLog('Sequential-Finding: F-5'), ['F-5']);
        assert.deepEqual(findingIdsFromLog('Sequential-Finding: F-5'), ['F-5']);
    });
});
