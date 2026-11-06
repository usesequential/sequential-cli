// Which project a call names (spec 5.6 + §10): --project > SEQUENTIAL_PROJECT > .sequential.json > the token's own.
// With a project access token the server accepts only the token's own project (its exact id or slug) and refuses any
// other, so a planted or cloned .sequential.json can only make a run fail, never move a write. The file holds only
// `project`; its search goes up from the working directory and stops at the first directory holding .git, at home, or at
// the root. A file not owned by the current user is skipped.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const PROJECT_FILE = '.sequential.json';

export interface ProjectChoice {
    project?: string;
    /** The file it came from, when it came from one: printed on stderr. */
    from?: string;
    warnings: string[];
}

export interface ProjectFs {
    cwd: string;
    home: string;
    uid: number | null;
    lstat(p: string): { isFile(): boolean; isSymbolicLink(): boolean; uid: number } | null;
    exists(p: string): boolean;
    read(p: string): string;
}

export const realProjectFs = (): ProjectFs => ({
    cwd: process.cwd(),
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    lstat: (p) => {
        try {
            return fs.lstatSync(p);
        } catch {
            return null;
        }
    },
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, 'utf8'),
});

function fromFile(f: ProjectFs): ProjectChoice {
    const warnings: string[] = [];
    let dir = path.resolve(f.cwd);
    for (;;) {
        const file = path.join(dir, PROJECT_FILE);
        const st = f.lstat(file);
        if (st) {
            if (!st.isFile() || st.isSymbolicLink()) warnings.push(`${file} is not a plain file: ignored`);
            else if (f.uid !== null && st.uid !== f.uid) warnings.push(`${file} belongs to another user: ignored`);
            else {
                try {
                    const body = JSON.parse(f.read(file)) as unknown;
                    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
                    const o = body as Record<string, unknown>;
                    for (const k of Object.keys(o)) if (k !== 'project') warnings.push(`${file}: "${k}" is ignored (only "project" is read)`);
                    if (typeof o.project === 'string' && o.project.trim() !== '') return { project: o.project, from: file, warnings };
                    warnings.push(`${file} has no "project": ignored`);
                } catch {
                    warnings.push(`${file} is not valid JSON: ignored`);
                }
            }
            return { warnings };
        }
        if (f.exists(path.join(dir, '.git'))) break;
        if (dir === path.resolve(f.home)) break;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return { warnings };
}

export function chooseProject(flag: string | undefined, env: Record<string, string | undefined>, f: ProjectFs = realProjectFs()): ProjectChoice {
    if (flag !== undefined) return { project: flag, warnings: [] };
    const e = env.SEQUENTIAL_PROJECT;
    if (e !== undefined && e.trim() !== '') return { project: e, warnings: [] };
    return fromFile(f);
}
