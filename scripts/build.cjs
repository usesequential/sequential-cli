// Builds dist/ (CommonJS + .d.ts) with the repo's TypeScript, and makes dist/bin.js executable.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc', { paths: [pkg] });
fs.rmSync(path.join(pkg, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: pkg, stdio: 'inherit' });
fs.chmodSync(path.join(pkg, 'dist/bin.js'), 0o755);
const first = fs.readFileSync(path.join(pkg, 'dist/bin.js'), 'utf8').split('\n', 1)[0];
if (first !== '#!/usr/bin/env node') throw new Error('dist/bin.js lost its #! line');
