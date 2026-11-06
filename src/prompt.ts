// The [y/N] question before a write. Only "y" or "yes" says yes. Ctrl-C (readline's SIGINT on a terminal), the end of
// input, or closing it says no: the run then ends with "nothing was done" (exit 2), never as a success (mgmt review 11-06).
export interface YesNoInterface {
    question(q: string, cb: (answer: string) => void): void;
    on(event: 'SIGINT' | 'close', cb: () => void): unknown;
    close(): void;
}

export function askYesNo(question: string, rl: YesNoInterface): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v: boolean) => {
            if (settled) return;
            settled = true;
            rl.close();
            resolve(v);
        };
        rl.on('SIGINT', () => done(false));
        rl.on('close', () => done(false));
        rl.question(question, (answer) => done(/^y(es)?$/i.test(answer.trim())));
    });
}
