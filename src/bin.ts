#!/usr/bin/env node
// The `sequential` executable: runs cli.ts with this process's arguments, environment and terminal.
import { main } from './cli';
import { dropFetchWarning, processIo } from './process';

dropFetchWarning();
main(process.argv.slice(2), process.env, processIo()).then(
    (code) => {
        process.exitCode = code;
    },
    () => {
        process.stderr.write('sequential: an unexpected error\n');
        process.exitCode = 1;
    },
);
