import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAID_READS } from '../src/cli';
import { NOT_AVAILABLE, TERMS_PENDING } from '../src/errors';
import { PROTOCOL_VERSION } from '../src/transport';
import { VERSION } from '../src/version';
import { MAX_FINDING_IDS } from '../src/release/findings';
import { MAX_CHANGES } from '../src/release/github';

// src/contract.json is what the server's repository vendors and pins; the code must say the same.
const facts = JSON.parse(readFileSync(join(__dirname, '../../src/contract.json'), 'utf8')) as Record<string, unknown>;
const src = (f: string) => readFileSync(join(__dirname, '../../src', f), 'utf8');

test('the code says what contract.json says', () => {
    assert.equal(facts.cli_version, VERSION);
    assert.equal(facts.protocol_version, PROTOCOL_VERSION);
    assert.equal(facts.not_available_text, NOT_AVAILABLE);
    assert.deepEqual(facts.paid_reads, [...PAID_READS]);
    assert.ok(src('transport.ts').includes(`accept: '${facts.accept as string}'`));
    assert.ok(src('tools.ts').includes(`'${facts.stub_title_suffix as string}'`));
    assert.ok(src('curated.ts').includes(`'${facts.token_self_path as string}'`));
    for (const t of facts.named_tools as string[]) assert.ok(src('curated.ts').includes(`'${t}'`) || src('cli.ts').includes(`'${t}'`), t);
    for (const k of facts.token_self_keys as string[]) assert.ok(src('curated.ts').includes(k), k);
});

test('the server caps the CLI keeps to (it reads ids and changes from git and GitHub) are contract.json\'s', () => {
    // Not rules of the CLI's own: the server refuses a release over them. The server's repository pins the same values.
    assert.equal(facts.finding_ids_max, 50);
    assert.equal(facts.changes_max, 50);
    assert.equal(MAX_FINDING_IDS, facts.finding_ids_max);
    assert.equal(MAX_CHANGES, facts.changes_max);
});

test('the refusal and the path the CLI reads by name are contract.json\'s', () => {
    // A 403 whose error is terms_pending gets the "accept the trial's terms" line (errors.ts).
    assert.equal(facts.terms_pending_error, TERMS_PENDING);
    // `sequential-release` (release-cli 0.2.2) POSTs here, with SEQUENTIAL_RELEASES_TOKEN (releases:write).
    assert.equal(facts.release_alias_path, '/api/releases');
    assert.ok(src('release/alias.ts').includes(`const RELEASES_PATH = '${facts.release_alias_path as string}';`));
});
