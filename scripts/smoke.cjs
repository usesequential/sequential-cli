// The built package as npm would ship it: the bin runs, prints its version, refuses without a token, and the tarball
// holds only dist, README, LICENSE and CHANGELOG (no tests, no sources, no fixtures).
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const pkg = path.resolve(__dirname, '..');
const bin = path.join(pkg, 'dist/bin.js');
const version = require(path.join(pkg, 'package.json')).version;
assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), version);
const none = spawnSync(process.execPath, [bin, 'tools'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(none.status, 2);
assert.match(none.stderr, /SEQUENTIAL_TOKEN/);
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkg, encoding: 'utf8' }));
const files = packed[0].files.map((f) => f.path).sort();
for (const f of files) assert.ok(/^(dist\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(f), `unexpected file in the package: ${f}`);
assert.ok(files.includes('dist/bin.js'));
assert.ok(!files.some((f) => /test|fixture|\.ts$/.test(f) && !f.endsWith('.d.ts')), 'no tests or sources');
console.log(`smoke ok: ${version}, ${files.length} files`);
