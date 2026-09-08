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
