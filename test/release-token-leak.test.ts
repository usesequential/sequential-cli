import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, type Io } from '../src/cli';
import { runReleaseAlias } from '../src/release/alias';
import type { FetchLike } from '../src/transport';

// mgmt 11-06: no failure path of `releases record` or `sequential-release` prints GITHUB_TOKEN, the Sequential token or an
// Authorization header: not a fetch error that quotes them, not an answer that echoes them, not a timeout, not the size
// cap. Every scenario plants both tokens where a careless line would print them, then greps all of stdout and stderr.
const SEQ = 'sq_pat_' + 'L3akT3st'.repeat(4);
const GH = 'ghs_' + 'S3cr3tGitHubWorkflowToken0123456789';
const HEAD = 'a'.repeat(40);
const ENV = { SEQUENTIAL_TOKEN: SEQ, SEQUENTIAL_RELEASES_TOKEN: SEQ, GITHUB_TOKEN: GH, GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: 'https://api.github.test', GITHUB_EVENT_PATH: '/ev.json' };
const ARGS = ['--version', HEAD, '--commit-sha', HEAD, '--github-changes', '--timeout', '1'];
const echo = `Authorization: Bearer ${GH} / Bearer ${SEQ}`;

type Mode = 'gh-throws' | 'gh-401-echo' | 'gh-hangs' | 'gh-huge' | 'seq-throws' | 'seq-500-echo' | 'seq-refusal-echo' | 'seq-hangs' | 'seq-huge';

function fetchFor(mode: Mode): FetchLike {
    const huge = () => new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(echo.repeat(10_000))); } });
    const hang = (signal: AbortSignal) => new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error(`aborted ${echo}`), { name: 'AbortError' }))));
    return (async (url: string, init: { method: string; body?: string; signal: AbortSignal }) => {
        const gh = init.method === 'GET';
        const id = init.body ? JSON.parse(init.body).id : 1;
        if (gh) {
            if (mode === 'gh-throws') throw new Error(`fetch failed ${url} ${echo}`);
            if (mode === 'gh-401-echo') return { status: 401, text: async () => JSON.stringify({ message: echo }) };
            if (mode === 'gh-hangs') return hang(init.signal);
            if (mode === 'gh-huge') return { status: 200, text: async () => '', body: huge() };
            return { status: 404, text: async () => JSON.stringify({ message: echo }) };
        }
        if (mode === 'seq-throws') throw new Error(`fetch failed ${url} ${echo}`);
        if (mode === 'seq-500-echo') return { status: 500, text: async () => `<html>${echo}</html>` };
        if (mode === 'seq-refusal-echo') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'bad_request', message: echo, errors: [{ field: '/version', message: echo }] }) }], isError: true } }) };
        if (mode === 'seq-hangs') return hang(init.signal);
        if (mode === 'seq-huge') return { status: 200, text: async () => '', body: huge() };
        return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ release: { version: HEAD } }) }] } }) };
    }) as unknown as FetchLike;
}

function io(mode: Mode) {
    const lines: string[] = [];
    const i: Io = {
        fetch: fetchFor(mode), out: (l) => lines.push(l), err: (l) => lines.push(l), stdoutTTY: false, interactive: false,
        projectFs: { cwd: '/x', home: '/x', uid: null, lstat: () => null, exists: () => false, read: () => '' },
        git: () => '', readFile: () => JSON.stringify({ before: 'b'.repeat(40) }),
    } as Io;
    return { i, lines };
}

const MODES: Mode[] = ['gh-throws', 'gh-401-echo', 'gh-hangs', 'gh-huge', 'seq-throws', 'seq-500-echo', 'seq-refusal-echo', 'seq-hangs', 'seq-huge'];
const leaks = (text: string) => [SEQ, SEQ.slice(7), GH, GH.slice(4), 'Authorization', 'Bearer'].filter((t) => text.includes(t));

for (const mode of MODES) {
    test(`no token or Authorization header printed: ${mode} (sequential releases record, with --json too)`, async () => {
        for (const extra of [[], ['--json']]) {
            const { i, lines } = io(mode);
            await main(['releases', 'record', ...ARGS, ...extra], ENV, i);
            assert.deepEqual(leaks(lines.join('\n')), [], lines.join('\n'));
        }
    });
    test(`no token or Authorization header printed: ${mode} (sequential-release)`, async () => {
        const { i, lines } = io(mode);
        await runReleaseAlias(ARGS, ENV, i);
        assert.deepEqual(leaks(lines.join('\n')), [], lines.join('\n'));
    });
}
