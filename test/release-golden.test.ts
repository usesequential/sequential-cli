import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { VERSION } from '../src/version';

// The contract of `sequential-release`: dist/release-bin.js (npm run build) does what @usesequential/release-cli 0.2.2 does,
// case for case. test/fixtures/release-cli-0.2.2.golden.json is the record of 0.2.1 (95 cases, made by the server
// repository's tests/cli/fixtures/record-golden.cjs: each case ran 0.2.1's bin as a process against fakes on 127.0.0.1)
// with the words of 0.2.2, which are the only difference between the two versions: "case ids from GitHub", "no cases
// named" and "<n> case(s):" where 0.2.1 printed "finding". No other field of a case changed.
// This file is that recorder's runner, zero-dependency: every case runs the built bin as a process with the same
// environment against the same fakes, and must give the SAME stdout, stderr, exit code, GitHub requests (method, path,
// headers) and Sequential request (method, path, body, headers). The one allowed difference: the user-agent header,
// which 0.2.x leaves to Node ("node") and this package sets to sequential-cli/<version>.
//
// The fakes: a Sequential API over plain http (the bin allows http for 127.0.0.1) answering POST /api/releases with the
// case's answer; a GitHub API over https with a throwaway self-signed certificate (openssl, made per run; the child trusts
// it through NODE_EXTRA_CA_CERTS); a fresh git repository with fixed author, committer and dates for --range. Nothing
// leaves 127.0.0.1, and the tokens are fakes.
const ROOT = path.join(__dirname, '../..');
const BIN = path.join(ROOT, 'dist/release-bin.js');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/release-cli-0.2.2.golden.json'), 'utf8')) as { cases: GoldenCase[] };

const TOKEN = `sq_pat_GoldenFake${'0'.repeat(22)}`;
const GH_TOKEN = 'ghs_golden_fake_workflow_token';

interface Answer { status?: number; body?: unknown; headers?: Record<string, string>; redirect?: number }
interface Logged { method: string; path: string; headers: Record<string, string>; body?: unknown }
interface GoldenCase {
    name: string;
    args: string[];
    env: Record<string, string>;
    git?: { commits: Array<{ message: string; tag?: string }> };
    github?: { event?: unknown; routes: Record<string, Answer> };
    serverResponses: { release: Answer };
    stdout: string;
    stderr: string;
    exitCode: number | string;
    requests: Logged[];
    githubRequests: Logged[];
    tokenPrinted: boolean;
}

const ECHO = '<echo of the sent body plus id: rel_golden>';
const SEQ_HEADERS = ['authorization', 'content-type', 'accept', 'user-agent', 'mcp-protocol-version'];
const GH_HEADERS = ['authorization', 'accept', 'x-github-api-version'];

const redact = (s: string) => s.split(TOKEN).join('<token>').split(GH_TOKEN).join('<github-token>');

function headerSubset(req: http.IncomingMessage, names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names) if (req.headers[n] !== undefined) out[n] = redact(String(req.headers[n]));
    return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

function parseMaybe(text: string): unknown {
    if (text === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function send(res: http.ServerResponse, r: Answer, selfUrl: string): void {
    if (r.redirect) {
        res.writeHead(r.redirect, { location: `${selfUrl}/redirected` });
        res.end();
        return;
    }
    const isText = typeof r.body === 'string';
    res.writeHead(r.status ?? 200, { 'content-type': isText ? 'text/plain' : 'application/json', ...(r.headers ?? {}) });
    res.end(isText ? (r.body as string) : JSON.stringify(r.body));
}

function listen(server: http.Server, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => resolve((server.address() as { port: number }).port));
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
}

async function startSequential(c: GoldenCase, log: Logged[]): Promise<{ server: http.Server; port: number; url: string }> {
    const api = c.serverResponses.release;
    let selfUrl = '';
    const server = http.createServer(async (req, res) => {
        const body = parseMaybe(await readBody(req));
        log.push({ method: req.method ?? '', path: req.url ?? '', headers: headerSubset(req, SEQ_HEADERS), ...(body === undefined ? {} : { body }) });
        if (req.method === 'POST' && req.url === '/api/releases') {
            // The recorder's default answer: 201 with the sent body plus an id.
            const r: Answer = api.redirect || (api.body !== undefined && api.body !== ECHO) ? api : { status: api.status ?? 201, body: { release: { ...(body && typeof body === 'object' ? body : {}), id: 'rel_golden' } } };
            return send(res, r, selfUrl);
        }
        return send(res, { status: 404, body: { error: 'not_found' } }, selfUrl);
    });
    const port = await listen(server, '127.0.0.1');
    selfUrl = `http://127.0.0.1:${port}`;
    return { server, port, url: selfUrl };
}

async function startGitHub(c: GoldenCase, log: Logged[], tls: { key: Buffer; cert: Buffer }): Promise<{ server: https.Server; url: string }> {
    const routes = c.github?.routes ?? {};
    let selfUrl = '';
    const server = https.createServer(tls, async (req, res) => {
        await readBody(req);
        log.push({ method: req.method ?? '', path: redact(req.url ?? ''), headers: headerSubset(req, GH_HEADERS) });
        const pathname = new URL(req.url ?? '/', 'https://x').pathname;
        const r: Answer = Object.hasOwn(routes, pathname) ? routes[pathname] : { status: 404, body: { message: 'Not Found' } };
        return send(res, r, selfUrl);
    });
    const port = await listen(server, '127.0.0.1');
    selfUrl = `https://127.0.0.1:${port}`;
    return { server, url: selfUrl };
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Golden', GIT_AUTHOR_EMAIL: 'golden', GIT_COMMITTER_NAME: 'Golden', GIT_COMMITTER_EMAIL: 'golden' };

function makeRepo(dir: string, spec: NonNullable<GoldenCase['git']>, baseEnv: Record<string, string>): void {
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...baseEnv, ...GIT_ENV };
    const git = (args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'tag.gpgsign', 'false']);
    spec.commits.forEach((c, i) => {
        const date = `2026-11-01T00:00:${String(i).padStart(2, '0')}Z`;
        git(['commit', '-q', '--allow-empty', '-m', c.message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
        if (c.tag) git(['tag', c.tag]);
    });
}

function runBin(args: string[], env: Record<string, string>, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | string }> {
    return new Promise((resolve) => {
        execFile(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string }) | null;
            const exitCode = e ? (typeof e.code === 'number' ? e.code : e.killed ? `killed:${e.signal}` : String(e.code)) : 0;
            resolve({ stdout, stderr, exitCode });
        });
    });
}

interface Ctx { tmp: string; tls: { key: Buffer; cert: Buffer }; baseEnv: Record<string, string>; closed: number }

async function runCase(c: GoldenCase, ctx: Ctx) {
    const seqLog: Logged[] = [];
    const ghLog: Logged[] = [];
    const seq = await startSequential(c, seqLog);
    const gh = c.github ? await startGitHub(c, ghLog, ctx.tls) : null;
    try {
        const caseDir = path.join(ctx.tmp, c.name);
        fs.mkdirSync(caseDir, { recursive: true });
        const repoDir = path.join(caseDir, 'repo');
        if (c.git) makeRepo(repoDir, c.git, ctx.baseEnv);
        const eventPath = path.join(caseDir, 'event.json');
        if (c.github?.event) fs.writeFileSync(eventPath, JSON.stringify(c.github.event));
        const subs: Array<[string, string]> = [
            ['<sequential-localhost>', `http://localhost:${seq.port}`],
            // Not listened on: 0.2.1 refuses [::1] before any request (a bin that sent one would print "fetch failed").
            ['<sequential-v6>', 'http://[::1]:9'],
            ['<sequential>', seq.url],
            ['<closed>', `http://127.0.0.1:${ctx.closed}`],
            ['<github-token>', GH_TOKEN],
            ['<github>', gh ? gh.url : 'https://127.0.0.1:9'],
            ['<event-file>', eventPath],
            ['<repo>', repoDir],
            ['<token>', TOKEN],
        ];
        const fill = (s: string) => subs.reduce((acc, [k, v]) => acc.split(k).join(v), s);
        // Back from real values to placeholders, longest first so a URL is not half-replaced.
        const unfill = (s: string) => [...subs].filter(([, v]) => v).sort((a, b) => b[1].length - a[1].length).reduce((acc, [k, v]) => acc.split(v).join(k), s);
        const unfillDeep = (v: unknown): unknown =>
            typeof v === 'string' ? unfill(v) : Array.isArray(v) ? v.map(unfillDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unfillDeep(x)])) : v;
        const env: Record<string, string> = { ...ctx.baseEnv };
        for (const [k, v] of Object.entries(c.env)) env[k] = fill(v);
        const r = await runBin(c.args.map(fill), env, c.git ? repoDir : caseDir);
        return {
            stdout: unfill(r.stdout),
            stderr: unfill(r.stderr),
            exitCode: r.exitCode,
            requests: unfillDeep(seqLog) as Logged[],
            githubRequests: unfillDeep(ghLog) as Logged[],
            tokenPrinted: [TOKEN, GH_TOKEN].some((t) => r.stdout.includes(t) || r.stderr.includes(t)),
        };
    } finally {
        await close(seq.server);
        if (gh) await close(gh.server);
    }
}

/** The request without its user-agent header (the one allowed difference). */
const withoutUa = (r: Logged): Logged => {
    const { 'user-agent': _ua, ...headers } = r.headers;
    return { ...r, headers };
};

describe('sequential-release = release-cli 0.2.2: every golden case against dist/release-bin.js', () => {
    const ctx = {} as Ctx;

    before(async () => {
        assert.ok(fs.existsSync(BIN), `${BIN} is missing: npm run build first (npm test does)`);
        ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-release-golden-'));
        const key = path.join(ctx.tmp, 'gh-key.pem');
        const cert = path.join(ctx.tmp, 'gh-cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
        ctx.tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
        const home = path.join(ctx.tmp, 'home');
        fs.mkdirSync(home);
        ctx.baseEnv = { PATH: process.env.PATH ?? '', HOME: home, LANG: 'C', LC_ALL: 'C', NODE_EXTRA_CA_CERTS: cert, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
        const s = http.createServer();
        ctx.closed = await listen(s, '127.0.0.1');
        await close(s);
    });

    after(() => {
        if (ctx.tmp) fs.rmSync(ctx.tmp, { recursive: true, force: true });
    });

    test('the fixture is the full record: 95 cases, each name once', () => {
        assert.equal(GOLDEN.cases.length, 95);
        assert.equal(new Set(GOLDEN.cases.map((c) => c.name)).size, 95);
    });

    for (const g of GOLDEN.cases) {
        test(g.name, async () => {
            const a = await runCase(g, ctx);
            assert.equal(a.tokenPrinted, false, 'a token was printed');
            assert.deepEqual(
                { exitCode: a.exitCode, stdout: a.stdout, stderr: a.stderr },
                { exitCode: g.exitCode, stdout: g.stdout, stderr: g.stderr },
            );
            assert.deepEqual(a.githubRequests, g.githubRequests, 'GitHub requests');
            assert.deepEqual(a.requests.map(withoutUa), g.requests.map(withoutUa), 'Sequential requests');
            for (const r of a.requests) assert.equal(r.headers['user-agent'], `sequential-cli/${VERSION}`);
        });
    }
});
