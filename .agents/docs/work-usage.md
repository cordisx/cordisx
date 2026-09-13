# Work usage Host projection

[Protocol work v2](https://github.com/cordisx/cordisx-protocol/blob/465c444/.agents/docs/usage-work-v2.md)
is exposed as `ctx.usage.readWork()` under the existing usage.read permission.
A separate SQLite directory and scope produce a new epoch/baseline. v1 read is
unchanged. Initial session metadata must identify a root with an absolute cwd
and recognized source (cli, vscode, exec, mcp). Host-created game workspace
sources, forks/subagents and unknown metadata never add work increments. Normal
root appends retain the reducer's counter/continuity validation.

Classification coverage is explicit and partial. The API is local metadata,
not a signed bill, payment credential or cloud mint authority. Any sponsored
reward service owns its independent limited funding and authorization policy.
Tests derive a game directory using the real Host authority, append normal,
game, fork and unknown rollout metadata and verify separate durable v1/v2
watermarks and restart continuity without exposing paths in public results.

Native development retains its first admitted work ledger in a private Host
profile claim. It preserves the original canonical Codex home, legacy profile
name, cache, scope and epoch; moving the config or plugin entries then reuses
that identity. It does not change the legacy scope hash or copy a database.
Public work reads and private settlement share this reader. Private signing and
reply publication also check that its claim and ledger identity remain current.

Before the first claim, multiple legacy work ledgers require an explicit normal
`cordisx dev --work-scope-guard <scope>/<epoch>` precondition. The normal config
still derives the scope; the existing private ledger supplies its epoch and
counts. The guard cannot select or override a snapshot, account or amount. A
wrong config directory or epoch fails before Vite starts or custody is claimed.
The same preflight runs in `--dry-run` without scanning or writing an anchor.
Use the original canonical config directory and guard when adopting an existing
ledger; absolute plugin entries may point to new reviewed source directories.
Missing started claims, lost ledgers, replaced epochs and changed Codex homes
fail closed. A separately flushed Host state history marker also prevents a
fresh process from selecting a replacement when the claim and its adjacent
started marker are both lost. An accidentally created scope or zero settlement
remains evidence requiring an explicit issuer reconciliation; it is never
erased or treated as proof that the original admitted work did not exist.
