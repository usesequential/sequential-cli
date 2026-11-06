// The token's tool list, kept 10 minutes (spec 5.4): every request spends the token's 120/min limit, tools/list included.
// The key is the host plus the first 16 hex of sha256(token): never the token. The directory is 0700, the file 0600, a
// write goes to a temp file and is renamed, and a symlink is never followed. Any failure skips the cache silently.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CACHE_TTL_MS = 10 * 60 * 1000;

/** The per-user cache directory, by platform. */
export function defaultCacheDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
    if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'sequential');
    if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'sequential');
    if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'sequential');
    return path.join(home, '.cache', 'sequential');
}

export function cacheKey(host: string, token: string): string {
    const h = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const hostPart = createHash('sha256').update(host).digest('hex').slice(0, 8);
    return `tools-${hostPart}-${h}.json`;
}

/** A real directory (never a symlink) owned by this user, made 0700 when missing. False when it cannot be trusted. */
function safeDir(dir: string): boolean {
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) return false;
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
        return true;
    } catch {
        return false;
    }
}

export function readCache(dir: string | null, host: string, token: string, now: number = Date.now()): unknown | undefined {
    if (!dir) return undefined;
    try {
        const file = path.join(dir, cacheKey(host, token));
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink()) return undefined;
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return undefined;
        const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { at?: unknown; host?: unknown; result?: unknown };
        if (typeof body.at !== 'number' || body.host !== host || now - body.at > CACHE_TTL_MS || now < body.at) return undefined;
        return body.result;
    } catch {
        return undefined;
    }
}

export function writeCache(dir: string | null, host: string, token: string, result: unknown, now: number = Date.now()): void {
    if (!dir || !safeDir(dir)) return;
    const file = path.join(dir, cacheKey(host, token));
    const tmp = `${file}.${process.pid}.${now}.tmp`;
    try {
        // 'wx': fails if anything (a planted symlink included) already sits at the temp name.
        fs.writeFileSync(tmp, JSON.stringify({ at: now, host, result }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* nothing to remove */
        }
    }
}
