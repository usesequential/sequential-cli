#!/usr/bin/env node
// The `sequential-release` executable (the old @usesequential/release-cli's name): runs release/alias.ts with this
// process's arguments, environment and terminal. Exit 0 or 1 only.
import { runReleaseAlias } from './release/alias';
import { dropFetchWarning, processIo } from './process';

dropFetchWarning();
runReleaseAlias(process.argv.slice(2), process.env, processIo()).then(
    (code) => {
        process.exitCode = code;
    },
    () => {
        process.stderr.write('sequential: an unexpected error\n');
        process.exitCode = 1;
    },
);
