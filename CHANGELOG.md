# Changelog

## 0.1.0 (unreleased)

- `sequential tools` and `sequential tools describe <tool>`: the tools your token can use, from Sequential's live tool list.
- `sequential call <tool>`: call any tool. Its arguments come from the tool's own schema.
- Exit codes: 0 ok, 1 refused or not reached, 2 usage, 4 the token cannot do this, 5 try later.
