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

## Record changes and releases (CI and scripts)

These commands send ONE request each and print one line per result, on a terminal or not. `--json` prints Sequential's
answer instead. `--dry-run` prints what would be sent, needs no token, and sends nothing.

```sh
# One change: a campaign, a price, a product change
sequential changes record --kind pricing --title "Trial is now 14 days"

# A batch from a JSON array, once per CI run (one request, never split)
sequential changes sync --items changes.json --source git --source-detail acme.shop

# A release, which Sequential measures fixes against (a release token: SEQUENTIAL_RELEASES_TOKEN, else SEQUENTIAL_TOKEN)
sequential releases record --version "$APP_VERSION"

# What this token is: its project, rights and expiry
sequential whoami
```

- The "CLI and CI" token preset holds what these need: changes:read, changes:write and releases:write.
- Leave `--environment` out of `releases record`: the release then takes your project's environment, the one where fixes
  are measured. Name the version exactly as your app's events carry it.
- A title that reads like an instruction is kept as a proposal. The CLI prints the link where a person confirms it.
- To name the merged pull requests and the findings a release fixes, from GitHub or git, see
  [Record a release from GitHub Actions or Vercel](#record-a-release-from-github-actions-or-vercel).
- `sequential help <command>` lists every option. Sequential checks the values: `sequential tools describe record_change`
  shows the kinds and limits.

## Record a release from GitHub Actions or Vercel

`sequential releases record` can also name what a release changed and the findings it fixes, from git or from GitHub:

- `--github-changes` reads the GitHub API with the workflow's token. It does not need a checkout.
- `--range <prev..HEAD>` reads `Sequential-Finding: F-12` commit trailers with `git log` in a checkout (use
  `actions/checkout` with `fetch-depth: 0`).

Use one of them, not both. Sequential then compares the sessions before and after the release for each finding that the
release names. The release only records what changed. It does not say what caused a result.

### The release version must match your SDK's release

Sequential compares a finding before and after a release. To count a session as "after", Sequential reads the release
that the session's events carry (the browser SDK's `release` option, `data-release` on the script tag, or `$release` that
the page registers; a mobile app's version). The backend SDK's release is not used. Each such session must carry **the
same string** as the `--version` that you record:

- Record `--version <full commit sha>` and set the browser SDK's release to the same full sha. On Vercel with Next.js,
  that is `process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` (turn on "Automatically expose System Environment Variables").
- A short sha in one place and a full sha in the other do not match.
- When no session carries the recorded version, Sequential compares by time: every session that started from 2 hours
  after the release is "after". That works, but it can count sessions on an older build.

### Vercel (Git integration): record each production deployment

Vercel deploys from its own GitHub App, so no workflow of yours runs the deploy. Vercel reports each deployment to
GitHub, and a workflow on `deployment_status` can record the release when Vercel reports success.

Vercel names each GitHub environment `Production – <vercel project>` (and `Preview – <vercel project>`). Each Sequential
project has its own access token. So the workflow maps each Vercel project's environment to the secret that holds that
Sequential project's token.

```yaml
# .github/workflows/sequential-release.yml
name: Sequential release
on: deployment_status

permissions:
  deployments: read     # find the previous successful deployment
  contents: read        # compare the two commits
  pull-requests: read   # the merged pull requests and their text

jobs:
  record:
    # Only a successful production deployment.
    if: github.event.deployment_status.state == 'success' && startsWith(github.event.deployment.environment, 'Production')
    runs-on: ubuntu-latest
    env:
      # Vercel environment -> the secret with that Sequential project's token (releases:write).
      SEQUENTIAL_TOKENS: '{"Production – web": "SEQUENTIAL_RELEASES_TOKEN_WEB", "Production – app": "SEQUENTIAL_RELEASES_TOKEN_APP"}'
      # Vercel environment -> the project key that pull requests use in "Fixes web#F-12".
      SEQUENTIAL_KEYS: '{"Production – web": "web", "Production – app": "app"}'
    steps:
      - name: Skip a Vercel project that has no Sequential project
        id: map
        run: echo "mapped=${{ fromJSON(env.SEQUENTIAL_TOKENS)[github.event.deployment.environment] != null }}" >> "$GITHUB_OUTPUT"

      - if: steps.map.outputs.mapped == 'true'
        # Every value reaches the command as an environment variable, never inside the script.
        run: >-
          npx -y @usesequential/cli releases record
          --version "$SHA" --commit-sha "$SHA" --released-at "$RELEASED_AT"
          --github-changes --project-key "$PROJECT_KEY"
        env:
          SEQUENTIAL_RELEASES_TOKEN: ${{ secrets[fromJSON(env.SEQUENTIAL_TOKENS)[github.event.deployment.environment]] }}
          GITHUB_TOKEN: ${{ github.token }}
          SHA: ${{ github.event.deployment.sha }}
          RELEASED_AT: ${{ github.event.deployment_status.created_at }}
          PROJECT_KEY: ${{ fromJSON(env.SEQUENTIAL_KEYS)[github.event.deployment.environment] }}
```

With **one** Vercel project, set `SEQUENTIAL_RELEASES_TOKEN: ${{ secrets.SEQUENTIAL_RELEASES_TOKEN }}`, and leave out
`--project-key`, the two maps and the first step.

`--environment` is left out: the release then takes your project's environment, the one where fixes are measured.

### What `--github-changes` reads

The workflow gives `GITHUB_TOKEN`. GitHub Actions sets `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH` and `GITHUB_API_URL`
(GitHub Enterprise). `--github-changes` needs `--commit-sha`, the deployed commit. It reads, with GET requests only:

1. **The previous release:** the newest earlier deployment in the same GitHub environment whose newest status is
   `success`. (On a `push` event, it is the push's `before` commit.) You can give a commit with `--base <sha>`.
2. **The commits** from the previous release to this one (GitHub lists at most 250).
3. **The merged pull requests** of these commits, newest first: each one once, at most 50. They go to the release as
   its changes (title, link and number).
4. **The findings:** `Sequential-Finding: F-12` trailers in the commit messages, and "Fixes F-12" in pull request titles
   and bodies (also fix, fixed, close, closes, closed, resolve, resolves, resolved; lists such as "Fixes F-3, F-4 and
   F-5"). They are sent after any `--finding` ids, each once, at most 50.

The job needs the three read permissions above. Without them, GitHub refuses the calls, and the release is recorded
without changes and without finding ids from GitHub.

**When a GitHub read fails** (for example, the previous release is not an ancestor of this commit after a rollback, so
GitHub cannot compare them), the command prints one line and still records the release:

```
GitHub: could not compare bbbbbbb...aaaaaaa (HTTP 404); the release is recorded without changes or finding ids from GitHub.
```

On success, the last line says what was recorded, for example:

```
Recorded release 3f2a… (2 findings: F-1, F-12; 1 change since bbbbbbb)
Recorded release 3f2a… (1 finding: F-12; 1 change from 3f2a9c1 alone (no earlier release found))
```

`--dry-run` reads git and GitHub too, and prints what would be sent. It sends nothing to Sequential.

### Monorepos: which findings belong to which project

A finding number belongs to one Sequential project: `F-12` can exist in each of your projects. When one pull request
changes several apps, write the project key before the number:

```
Fixes web#F-12, app#F-3
```

- With `--project-key web`, only `web#…` ids count for this release. An unqualified `F-12` does not count, because it
  could be another project's finding. To count unqualified ids too, add `--findings all`.
- Without `--project-key` (one repository, one Sequential project), unqualified ids count, and qualified ids do not.
- The same rule applies to trailers: `Sequential-Finding: web#F-12`.

### GitHub Actions on a tag push

```yaml
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  pull-requests: read
jobs:
  record:
    runs-on: ubuntu-latest
    steps:
      - run: >-
          npx -y @usesequential/cli releases record
          --version "$GITHUB_REF_NAME" --commit-sha "$GITHUB_SHA"
          --github-changes --base "$PREVIOUS_SHA"
        env:
          SEQUENTIAL_RELEASES_TOKEN: ${{ secrets.SEQUENTIAL_RELEASES_TOKEN }}
          GITHUB_TOKEN: ${{ github.token }}
          PREVIOUS_SHA: <the previous tag's commit sha>   # a tag push has no useful `before`
```

Or read the trailers from a checkout: `actions/checkout` with `fetch-depth: 0`, then
`--range "$PREVIOUS_TAG..$GITHUB_SHA"` instead of `--github-changes`. An all-zero base (a first push) reads only the
head commit.

### `sequential-release` (the old `@usesequential/release-cli`)

The old command keeps working through `@usesequential/release-cli`, whose next version runs this package's
`dist/release-bin.js` (not published yet). It works exactly as release-cli 0.2.1: `POST /api/releases` with the token
from `SEQUENTIAL_RELEASES_TOKEN` only (never `SEQUENTIAL_TOKEN`); the API from `--host`, else `SEQUENTIAL_API_URL`, else
`https://api.usesequential.com` (`https://`, or `http://` for `localhost` and `127.0.0.1` only); the same flags (`--sha`
is `--commit-sha`; a value may start with `--`; a repeated flag keeps its last value; `--flag=value` and any other option
are refused with the usage); the same lines; exit 0 or 1 only. It is not `sequential releases record`: no `--json`,
`--dry-run`, `--finding`, `--project` or `--timeout`. Only its user-agent header is new (`sequential-cli/<version>`).

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

## Output of `call` and `tools`

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
| 2 | A usage mistake (an unknown flag, a missing argument, no token, a project that is not the token's) |
| 3 | `changes sync`: some changes were refused (each is printed with why) |
| 4 | The token cannot do this (its rights, or the feature is off for the project). On a trial project whose terms the person who made the token has not accepted yet, the CLI says so: that person signs in to Sequential and accepts them, then the same command works |
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
