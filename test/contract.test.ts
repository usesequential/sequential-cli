import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAID_READS } from '../src/cli';
import { NOT_AVAILABLE } from '../src/errors';
import { PROTOCOL_VERSION } from '../src/transport';
import { VERSION } from '../src/version';

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
