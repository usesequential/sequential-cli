# Changelog

## 0.1.0 (unreleased)

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
- Exit codes: 0 ok, 1 refused or not reached, 2 usage, 3 some changes refused, 4 the token cannot do this, 5 try later.
