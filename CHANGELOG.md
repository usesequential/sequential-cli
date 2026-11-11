# Changelog

## 0.1.3

- The output says "case" where it said "finding", as the product does. `sequential releases record` and
  `sequential-release` print `Recorded release <v> (2 cases: F-12, F-13)`, `(1 case: F-12)` or `(no cases named)`, and,
  when a GitHub read fails, `…; the release is recorded without changes or case ids from GitHub.` The help of
  `releases record` shows the new line.
- Flags, JSON keys and trailers are unchanged: `--finding`, `--findings all|qualified`, `finding_ids`,
  `Sequential-Finding: F-12`, the ids (`F-12`), `--json` output, the messages Sequential sends and the exit codes.
- `sequential-release` (`dist/release-bin.js`) matches release-cli 0.2.2, which differs from 0.2.1 only in these words.
  The 95 recorded cases, with the new words, are still this package's test (test/release-golden.test.ts). The
  user-agent header is `sequential-cli/0.1.3`.
- `src/contract.json`: `cli_version` 0.1.3.

## 0.1.2

- `sequential-release` (`dist/release-bin.js`, which `@usesequential/release-cli` runs) behaves exactly like
  release-cli 0.2.1 again: `POST /api/releases` (not the record_release tool over MCP), with 0.2.1's flags, checks,
  lines and exit codes (0 or 1). As in 0.2.1: the token from `SEQUENTIAL_RELEASES_TOKEN` only, checked for presence only;
  the API from `--host`, else `SEQUENTIAL_API_URL`, else `https://api.usesequential.com`, `http://` only for `localhost`
  and `127.0.0.1`, and a path in it is kept; `--help`, `--json`, `--dry-run`, `--finding`, `--project`, `--timeout` and
  every `--flag=value` are unknown options; no line about the host. The one difference: the user-agent header is
  `sequential-cli/0.1.2`. Neither token is ever printed: a server or network message that quoted one would show
  `[token]` there (no recorded case prints one). The 95 cases recorded from 0.2.1 are this package's test
  (test/release-golden.test.ts). This undoes the differences from 0.2.x that 0.1.0 listed.
- When Sequential refuses because the person who made the token has not accepted the trial's terms yet (HTTP 403
  `terms_pending`), the CLI prints one line saying so: that person signs in to Sequential and accepts the terms, then the
  same command works. Exit code 4, as before. With `--json`, the error object carries that line as `message`.
- `src/contract.json`: `cli_version` 0.1.2, and two new facts for the server to pin: `terms_pending_error` and
  `release_alias_path` (`/api/releases`). The server does not check them yet.

## 0.1.1

- The npm page links to the repository: package.json names `repository`, `bugs` and `homepage`. No change to the CLI.

## 0.1.0 (2026-11-07)

- `sequential tools` and `sequential tools describe <tool>`: the tools your token can use, from Sequential's live tool list.
- `sequential call <tool>`: call any tool. Its arguments come from the tool's own schema.
- `sequential changes record`, `changes sync`, `releases record` and `whoami`: one request each. They replace the
  commands of `@usesequential/node` 1.x, with these differences:
  - they call the same tools as agents (record_change, record_changes, record_release) over MCP;
  - `releases record` reads `SEQUENTIAL_RELEASES_TOKEN`, else `SEQUENTIAL_TOKEN`;
  - `changes sync` prints proposed items apart (`N written, M proposed, K refused`) and the link to confirm them;
  - `--source-detail` goes into every item that names none. Entries a 1.x run stored with it are not matched again;
  - the CLI checks no kinds or limits: Sequential does, and says why;
  - a token mistake is exit 2 before any request; the token lacking a right is exit 4; try later is exit 5.
- `releases record` takes the options of `@usesequential/release-cli`: `--title`, `--range <prev..HEAD>` (commit
  trailers from `git log`), `--github-changes` with `--base auto|<sha>` (the merged pull requests and the findings they
  close, from the GitHub API), `--project-key` and `--findings all|qualified`. A GitHub failure prints one line and the
  release is recorded without what GitHub would add; a failed `git log` is exit 2. Ids from git or GitHub are sent after the `--finding` ids, each
  once, at most 50; at most 50 changes. On success it also prints the old line,
  `Recorded release <v> (<n> findings: …; <m> changes since <base>)`.
- `sequential-release`: the old `@usesequential/release-cli` command, on the same path. It is not a second bin of this
  package (two bins break `npx @usesequential/cli`): the entry is `dist/release-bin.js`, which the next
  `@usesequential/release-cli` runs. The token from
  `SEQUENTIAL_RELEASES_TOKEN` only, the API from `--host` or `SEQUENTIAL_API_URL`, `--sha` for `--commit-sha`, exit 0 or 1.
  It differs from 0.2.x: it calls the record_release tool over MCP (not `POST /api/releases`); the token must be a
  project access token (`sq_pat_` and 32 letters or digits); the API URL must be an origin (no path); usage mistakes
  print one `sequential: …` line. A value may still start with `--`, and a repeated flag keeps its last value, as in 0.2.x.
- `src/contract.json` names the server's caps the CLI keeps to when it reads ids and changes: `finding_ids_max` and
  `changes_max` (50 each).
- Exit codes: 0 ok, 1 refused or not reached, 2 usage, 3 some changes refused, 4 the token cannot do this, 5 try later.
