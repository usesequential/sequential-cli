#!/usr/bin/env node
// The `sequential` executable: runs cli.ts with this process's arguments, environment and terminal.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { askYesNo } from './prompt';
import { main } from './cli';
import { UsageError } from './errors';
import { defaultCacheDir } from './cache';
import type { FetchLike } from './transport';

// Node 18 prints "ExperimentalWarning: The Fetch API is an experimental feature" on the first fetch. That one line only
// goes; every other warning is still printed.
const listeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w: Error & { name: string }) => {
    if (w.name === 'ExperimentalWarning' && /fetch/i.test(w.message)) return;
    if (listeners.length) for (const l of listeners) (l as (w: Error) => void)(w);
    else process.stderr.write(`${w.name}: ${w.message}\n`);
});

/** --input: a file, or stdin for '-'. A JSON object, else a usage error. */
function readJson(p: string): Record<string, unknown> {
    let text: string;
    try {
        text = readFileSync(p === '-' ? 0 : p, 'utf8');
    } catch {
        throw new UsageError(p === '-' ? 'cannot read stdin' : `cannot read ${p}`);
    }
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        throw new UsageError(`--input ${p} is not valid JSON`);
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new UsageError(`--input ${p} must hold a JSON object`);
    return v as Record<string, unknown>;
}

/** changes sync --items: a file's text, or all of stdin for '-'. */
function readText(p: string): string {
    return readFileSync(p === '-' ? 0 : p, 'utf8');
}

const confirm = (question: string): Promise<boolean> => askYesNo(question, createInterface({ input: process.stdin, output: process.stderr }));

const ctl = new AbortController();
process.once('SIGINT', () => ctl.abort());

main(process.argv.slice(2), process.env, {
    fetch: globalThis.fetch as unknown as FetchLike,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    stdoutTTY: process.stdout.isTTY === true,
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    confirm,
    readJson,
    readText,
    signal: ctl.signal,
    cacheDir: defaultCacheDir(),
}).then(
    (code) => {
        process.exitCode = code;
    },
    () => {
        process.stderr.write('sequential: an unexpected error\n');
        process.exitCode = 1;
    },
);
