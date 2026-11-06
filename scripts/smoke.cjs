// The built package as npm would ship it. ONE bin, `sequential`: with two, `npx @usesequential/cli …` cannot tell which to
// run (npm picks the bin named after the package, else the only one; "cli" is neither), so every documented command
// would fail. `sequential` prints its version and refuses without a token (exit 2). The alias entry dist/release-bin.js
// (run by @usesequential/release-cli's bin) prints its usage and refuses without a token (exit 1). The tarball holds only
// dist, README, LICENSE and CHANGELOG (no tests, no sources, no fixtures).
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const pkg = path.resolve(__dirname, '..');
const manifest = require(path.join(pkg, 'package.json'));
const version = manifest.version;
assert.deepEqual(Object.keys(manifest.bin), ['sequential'], 'exactly one bin, or `npx @usesequential/cli` cannot pick one');
const bin = path.join(pkg, manifest.bin.sequential);
const release = path.join(pkg, 'dist/release-bin.js');
for (const f of [bin, release]) assert.ok(fs.statSync(f).mode & 0o100, `${f} is not executable`);
const bare = { PATH: process.env.PATH };
assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), version);
const none = spawnSync(process.execPath, [bin, 'tools'], { encoding: 'utf8', env: bare });
assert.equal(none.status, 2);
assert.match(none.stderr, /SEQUENTIAL_TOKEN/);
assert.match(execFileSync(process.execPath, [release, '--help'], { encoding: 'utf8', env: bare }), /^Usage: sequential-release --version/);
const noRel = spawnSync(process.execPath, [release, '--version', '1.0.0'], { encoding: 'utf8', env: { ...bare, SEQUENTIAL_TOKEN: 'sq_pat_' + 'A1b2C3d4'.repeat(4) } });
assert.equal(noRel.status, 1);
assert.match(noRel.stderr, /^SEQUENTIAL_RELEASES_TOKEN is required/);
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkg, encoding: 'utf8' }));
const files = packed[0].files.map((f) => f.path).sort();
for (const f of files) assert.ok(/^(dist\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(f), `unexpected file in the package: ${f}`);
assert.ok(files.includes('dist/bin.js'));
assert.ok(files.includes('dist/release-bin.js'));
assert.ok(!files.some((f) => /test|fixture|\.ts$/.test(f) && !f.endsWith('.d.ts')), 'no tests or sources');
console.log(`smoke ok: ${version}, ${files.length} files, bin: sequential (+ alias entry dist/release-bin.js)`);
