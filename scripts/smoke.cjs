// The built package as npm would ship it: both bins run and are executable, `sequential` prints its version and refuses
// without a token (exit 2), `sequential-release` prints its usage and refuses without a token (exit 1), and the tarball
// holds only dist, README, LICENSE and CHANGELOG (no tests, no sources, no fixtures).
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const pkg = path.resolve(__dirname, '..');
const manifest = require(path.join(pkg, 'package.json'));
const version = manifest.version;
assert.deepEqual(Object.keys(manifest.bin).sort(), ['sequential', 'sequential-release']);
for (const bin of Object.values(manifest.bin)) assert.ok(fs.statSync(path.join(pkg, bin)).mode & 0o100, `${bin} is not executable`);
const bin = path.join(pkg, manifest.bin.sequential);
const release = path.join(pkg, manifest.bin['sequential-release']);
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
console.log(`smoke ok: ${version}, ${files.length} files, bins: ${Object.keys(manifest.bin).join(', ')}`);
