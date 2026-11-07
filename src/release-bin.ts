#!/usr/bin/env node
// The `sequential-release` executable (the old @usesequential/release-cli's name), run by that package's bin: release/alias.ts
// with this process's arguments, environment, fetch, git and stdio, as 0.2.1's bin/sequential-release.cjs wired them.
// Exit 0 or 1 only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runReleaseAlias } from './release/alias';
import type { LegacyFetch } from './release/legacy-github';
import { dropFetchWarning } from './process';

// Node 18 only: its "ExperimentalWarning: The Fetch API is an experimental feature" line goes (Node 20+ prints none).
dropFetchWarning();

async function main(): Promise<void> {
    process.exitCode = await runReleaseAlias(process.argv.slice(2), process.env, {
        fetchImpl: fetch as unknown as LegacyFetch,
        // One argv element per argument, never a shell string; git's own stderr goes to this process's stderr.
        execGit: (args) => execFileSync('git', args, { encoding: 'utf8' }),
        readFile: (path) => readFileSync(path, 'utf8'),
        stdout: process.stdout,
        stderr: process.stderr,
    });
}

main().catch((err: unknown) => {
    // Never a stack trace that might echo request internals; the message only.
    const m = (err as { message?: unknown } | null | undefined)?.message;
    process.stderr.write(`${m ? m : String(err)}\n`);
    process.exitCode = 1;
});
