# Controlled AgentLoop Host implementation

[Protocol control v1](https://github.com/cordisx/cordisx-protocol/blob/465c444/.agents/docs/agent-loop/control-v1.md)
extends ordinary user Agent tasks with `ctx.agentLoopControl`. `create` accepts
v4 create commands and returns v4 bindings for existing event subscriptions and
task navigation. The launcher generates a separate empty working directory for
each owner/command pair under its game workspace root. Existing v4 creation
retains its cwd. The provider retains its normal permission and approval behavior.

`submit` requires turns.submit and turns.control approval before dispatch.
Launcher Fleet stores the exact owner, provider generation, task, turn and
absolute deadline in its durable operation authority. Its timer invokes the
real local provider turn/interrupt path independently of renderer polling.
`read` observes exact turn terminal state; late completion is deadline-exceeded.
Unknown provider completion is never accepted as completed. `cancel` is scoped
to the exact recorded target, with command replay protection. Disposal requests
cancellation of that client generation's controlled work.

Targeted Fleet/local-provider-adapter tests use a test RPC transport and real
filesystem authority: independent directories, ordinary cwd compatibility,
submit replay, forged/cross-owner cancellation, deadlines and completion races.
These tests do not themselves prove a paid model run or installed application
approval. Provider crashes and interrupted RPC replies can require reconciliation;
clients must preserve operation identities and never invent a completed turn.
