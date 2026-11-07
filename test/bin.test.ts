import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

// The compiled bin (build/src/bin.js): one stderr line, never an ExperimentalWarning, the exit code from main.
const BIN = join(__dirname, '../src/bin.js');
const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, timeout: 20_000 });

test('no token: exit 2, one line on stderr, nothing on stdout, no request', () => {
    const r = run(['call', 'list_findings']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    assert.match(r.stderr, /SEQUENTIAL_TOKEN/);
});

test('--version and --help exit 0; no command exits 2', () => {
    assert.equal(run(['--version']).status, 0);
    assert.equal(run(['--help']).status, 0);
    assert.equal(run([]).status, 2);
});

test('a host that refuses the connection: exit 1 "not reached", no ExperimentalWarning, the token never printed', () => {
    const token = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
    const r = run(['--host', 'http://127.0.0.1:9', 'call', 'list_findings'], { SEQUENTIAL_TOKEN: token, XDG_CACHE_HOME: join(__dirname, 'no-cache') });
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
    assert.match(r.stderr, /not reached/);
    assert.ok(!r.stderr.includes(token.slice(7)) && !r.stdout.includes(token.slice(7)));
});

test('warnings: the Node 18 fetch line goes, others still print, and nothing prints when warnings are turned off', () => {
    const script = `require(${JSON.stringify(join(__dirname, '../src/process.js'))}).dropFetchWarning();
process.emitWarning('The Fetch API is an experimental feature', 'ExperimentalWarning');
process.emitWarning('another warning');`;
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const on = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /Warning: another warning/);
    assert.doesNotMatch(on.stderr, /Fetch API/);
    for (const [args, extra] of [[['-e', script], { NODE_NO_WARNINGS: '1' }], [['--no-warnings', '-e', script], {}]] as const) {
        const off = spawnSync(process.execPath, [...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20_000 });
        assert.equal(off.status, 0, off.stderr);
        assert.equal(off.stderr, '', args.join(' '));
    }
});
