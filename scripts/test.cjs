// Runs the compiled tests (build/test/*.test.js) one file at a time: `node --test <dir>` is not the same on Node 18-24.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../build/test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
if (!files.length) throw new Error('no compiled tests in build/test');
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
