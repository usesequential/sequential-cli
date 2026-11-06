import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { cacheKey, CACHE_TTL_MS, defaultCacheDir, readCache, writeCache } from '../src/cache';
import { chooseProject, type ProjectFs } from '../src/project';
import { VERSION } from '../src/version';

const TOKEN = 'sq_pat_' + 'A1b2C3d4'.repeat(4);
const HOST = 'https://api.usesequential.com';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seq-cli-test-'));

test('the cache key and file hold no token bytes', () => {
    const key = cacheKey(HOST, TOKEN);
    assert.ok(!key.includes(TOKEN.slice(7)) && !key.includes('A1b2'));
    const dir = path.join(tmp(), 'c');
    writeCache(dir, HOST, TOKEN, { tools: [] }, 1000);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(7)));
});

test('the directory is 0700 and the file 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
    const dir = path.join(tmp(), 'c');
    writeCache(dir, HOST, TOKEN, { tools: [] }, 1000);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, cacheKey(HOST, TOKEN))).mode & 0o777, 0o600);
});

test('an entry is read back within 10 minutes, not after, not for another host or token, not from the future', () => {
    const dir = path.join(tmp(), 'c');
    writeCache(dir, HOST, TOKEN, { tools: [1] }, 1_000_000);
    assert.deepEqual(readCache(dir, HOST, TOKEN, 1_000_000 + CACHE_TTL_MS - 1), { tools: [1] });
    assert.equal(readCache(dir, HOST, TOKEN, 1_000_000 + CACHE_TTL_MS + 1), undefined);
    assert.equal(readCache(dir, 'http://localhost:8080', TOKEN, 1_000_001), undefined);
    assert.equal(readCache(dir, HOST, 'sq_pat_' + 'Z'.repeat(32), 1_000_001), undefined);
    assert.equal(readCache(dir, HOST, TOKEN, 999_000), undefined);
    assert.equal(readCache(null, HOST, TOKEN, 1_000_001), undefined);
});

test('a symlink is never followed: not at the file, not at the directory', { skip: process.platform === 'win32' }, () => {
    const base = tmp();
    const dir = path.join(base, 'c');
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(base, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ at: 1_000_000, host: HOST, result: { evil: true } }));
    fs.symlinkSync(target, path.join(dir, cacheKey(HOST, TOKEN)));
    assert.equal(readCache(dir, HOST, TOKEN, 1_000_001), undefined, 'a symlinked entry is not read');
    const linkedDir = path.join(base, 'linked');
    fs.symlinkSync(dir, linkedDir);
    writeCache(linkedDir, HOST, 'sq_pat_' + 'Q'.repeat(32), { tools: [] }, 1000);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1, 'nothing written through a symlinked directory');
});

test('a cache that cannot be written is skipped silently', () => {
    const base = tmp();
    const file = path.join(base, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    assert.doesNotThrow(() => writeCache(path.join(file, 'c'), HOST, TOKEN, {}, 1));
});

test('the cache directory by platform', () => {
    assert.equal(defaultCacheDir({ XDG_CACHE_HOME: '/x' }, 'linux', '/h'), path.join('/x', 'sequential'));
    assert.equal(defaultCacheDir({}, 'linux', '/h'), path.join('/h', '.cache', 'sequential'));
    assert.equal(defaultCacheDir({}, 'darwin', '/h'), path.join('/h', 'Library', 'Caches', 'sequential'));
    assert.equal(defaultCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h'), path.join('C:\\L', 'sequential'));
});

/** A fake file system: `files` maps a path to its text (and owner), `git` lists directories holding .git. */
function fakeFs(cwd: string, home: string, files: Record<string, { text: string; uid?: number; link?: boolean }>, git: string[] = []): ProjectFs {
    return {
        cwd, home, uid: 501,
        lstat: (p) => (files[p] ? { isFile: () => !files[p].link, isSymbolicLink: () => files[p].link === true, uid: files[p].uid ?? 501 } : null),
        exists: (p) => git.some((g) => path.join(g, '.git') === p),
        read: (p) => files[p].text,
    };
}

test('project order: --project, then SEQUENTIAL_PROJECT, then .sequential.json, then none (the token\'s own)', () => {
    const f = fakeFs('/h/repo/app', '/h', { '/h/repo/.sequential.json': { text: '{"project":"web"}' } }, ['/h/repo']);
    assert.deepEqual(chooseProject('flag', { SEQUENTIAL_PROJECT: 'env' }, f), { project: 'flag', warnings: [] });
    assert.deepEqual(chooseProject(undefined, { SEQUENTIAL_PROJECT: 'env' }, f), { project: 'env', warnings: [] });
    assert.deepEqual(chooseProject(undefined, {}, f), { project: 'web', from: '/h/repo/.sequential.json', warnings: [] });
    assert.deepEqual(chooseProject(undefined, {}, fakeFs('/h/repo', '/h', {}, ['/h/repo'])), { warnings: [] });
});

test('the search stops at .git, at home and at the root', () => {
    // A file above the git root is never read.
    const above = fakeFs('/h/repo/app', '/h', { '/h/.sequential.json': { text: '{"project":"x"}' } }, ['/h/repo']);
    assert.equal(chooseProject(undefined, {}, above).project, undefined);
    // Outside git: the search stops at home, never above it.
    const outside = fakeFs('/h/work/tmp', '/h/work', { '/h/.sequential.json': { text: '{"project":"x"}' } });
    assert.equal(chooseProject(undefined, {}, outside).project, undefined);
    // Outside home and git (a container's /github/workspace): it stops at the root, finding nothing.
    assert.equal(chooseProject(undefined, {}, fakeFs('/github/workspace', '/root', {})).project, undefined);
});

test('a file of another user, a symlink, other keys and bad JSON are warned about and ignored', () => {
    const at = '/h/repo/.sequential.json';
    const g = ['/h/repo'];
    assert.equal(chooseProject(undefined, {}, fakeFs('/h/repo', '/h', { [at]: { text: '{"project":"x"}', uid: 0 } }, g)).project, undefined);
    assert.equal(chooseProject(undefined, {}, fakeFs('/h/repo', '/h', { [at]: { text: '{"project":"x"}', link: true } }, g)).project, undefined);
    const extra = chooseProject(undefined, {}, fakeFs('/h/repo', '/h', { [at]: { text: '{"project":"web","host":"https://evil.example","token":"x"}' } }, g));
    assert.equal(extra.project, 'web');
    assert.equal(extra.warnings.length, 2);
    assert.match(extra.warnings.join(' '), /"host" is ignored/);
    assert.equal(chooseProject(undefined, {}, fakeFs('/h/repo', '/h', { [at]: { text: '{oops' } }, g)).project, undefined);
});

test('the version equals package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
});
