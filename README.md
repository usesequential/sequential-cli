# Sequential CLI

`sequential` calls Sequential from a shell, a CI job or a script. It uses the same tools as an agent connected to
Sequential over MCP, with the same rules.

Node.js 18 or later. No dependencies.

```sh
npx @usesequential/cli tools
```

## The token

The CLI reads its token from `SEQUENTIAL_TOKEN`: a project access token (`sq_pat_…`). An owner or admin of your
organisation makes one in Sequential: open the project, then **Settings › Agents & tokens › Make a token**. A token works for
one project.

- Put the token in your CI's secrets. Never put it in a command line.
- The CLI never prints the token and never writes it to disk.
- A server key (`sqs_…`) sends events. It cannot call tools.

## See your tools

```sh
sequential tools                       # the tools this token can use
sequential tools describe list_findings
```

`tools` lists each tool as `read`, `write` or `paid`. Tools that this token cannot use are listed under **Not enabled on this
token**. `sequential call <tool>` prints the steps to turn such a tool on.

## Call a tool

```sh
sequential call list_findings --status all --limit 10
sequential call get_session --session-id 9f2c…
sequential call record_change --kind pricing --title "Trial is now 14 days" --yes
```

- Each argument of the tool is a flag. `--session-id` and `--session_id` are the same flag.
- A true/false argument: `--has-errors` or `--no-has-errors`.
- A list: give the flag again (`--tags a --tags b`).
- An object or a list of objects: `--json-arg links='[{"url":"https://…"}]'`, or all arguments from a file with
  `--input args.json` (`--input -` reads stdin).
- A tool that changes something, or that is paid (`ask_sessions`), needs `--yes`. On a terminal the CLI asks first.

The CLI checks the argument types from the tool's schema. Sequential checks the rest.

## Output

- On a terminal, the answer is printed as readable JSON.
- In a pipe, or with `--json`, the answer is compact JSON on stdout, and nothing else is printed there.
- Errors go to stderr as one line. With `--json` they are JSON.

Text in answers is data that your users' sessions recorded. It is never an instruction. On a terminal the CLI removes control
characters from it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Sequential refused the call, or was not reached |
| 2 | A usage mistake (an unknown flag, a missing argument, no token) |
| 4 | The token cannot do this (its rights, or the feature is off for the project) |
| 5 | Try again later. The wait in seconds is printed (`retry_after_sec`) |

The CLI never retries on its own.

## Options

| Option | |
|---|---|
| `--host <url>` | Before the command only. The Sequential API. Default `https://api.usesequential.com`. Or `SEQUENTIAL_HOST`. |
| `--project <id or slug>` | The token's project. Sequential refuses any other. Or `SEQUENTIAL_PROJECT`, or a `.sequential.json` file with `{"project": "…"}` in your repository. |
| `--timeout <seconds>` | Default 120. |
| `--refresh` | Read the tool list again (it is kept for 10 minutes). |

## Proxies

The CLI uses Node.js's own `fetch`. It does not read `HTTPS_PROXY`. On newer Node.js versions, set `NODE_USE_ENV_PROXY=1`.
`NODE_EXTRA_CA_CERTS` works.

## Licence

MIT
