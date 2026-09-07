# Plugin Agent tools

The experimental [Protocol v1 contract](https://github.com/cordisx/cordisx-protocol/blob/a535a5b15f78e474e4a5b8248716753c82108370/.agents/docs/agent-tools/README.md)
adds plugin-owned Skill and Node CLI resources and the bound `ctx.agentTools`
service. This Host implementation supports one Skill and command per plugin.
It is an implementation checkpoint, not native integration or user acceptance.

## Resource and call path

Installed packages put `cordisx-agent-tools.json` beside `cordisx-package.json`.
The selected entry must match that exact package's entry. Direct source entries
without a matching package use the adjacent descriptor. CLI/Skill resources
stay outside the browser generation artifact root; package integrity covers
both independently. Never label a Node CLI or Markdown Skill as a browser asset.

The launcher validates descriptor-relative paths and real files, then stages
resources in its own mode-0700 temporary directory on binding. It reuses the
built-in Skill file collection and digest implementation without writing into
user Skill directories. The CLI is bundled with the current installed
`cordisx/agent-tools` client so the command's location does not depend on PATH or
an ancestor development checkout's node_modules.

A plugin registers its declared command, validates current business membership,
and binds a live owned Session before sending its first task. Host renderer
ownership uses the existing Agent/Session Runtime `ownerForSession`; launcher
principals use the existing source/generation lease authority. A private 0600
binding descriptor points to this launcher's private local socket. Only its path
is projected into Agent setup; the bearer credential never enters instructions.

A CLI subprocess calls `invokeAgentTool({bindingPath,input})`. The authority
validates its binding and dispatches through the original CDP target and
execution context to the currently registered renderer handler. The handler
gets frozen business scope independently of untrusted CLI input. This reuses
CDP transport and principal authentication, not document load/replace behavior.
There is no polling process and no second persistent message ledger. The result
is the actual handler JSON receipt. The Host does not write plugin business data.

Timeout or disconnection never retries in another renderer. An already-started
handler may have committed; callers must use plugin operation ids to determine
replay/conflict outcomes. The handler receives cancellation through AbortSignal.
Disposal, expiry, a replaced binding or an unavailable owner fails closed.
Launcher exit closes the socket and removes only its private resource tree.

## Execution and limits

The Host-private `getAgentToolSetup(sessionId)` returns verified Skill path and
content plus the exact executable argv, descriptor path and expiry. The native
transport consumes this before each actual execution. A never-bound ordinary
Session has empty setup; an expired or revoked binding throws and requires
rebind. A 30-minute lease currently bounds each new binding.

The initial supported workflow is create Session, persist the plugin's real
run/Session association, bind, then send. Resuming a revoked CLI-bound Session
remains fail-closed: a controlled recovery stage is still required. Ordinary
never-bound Session resume is unchanged. Dynamic plugin install/update and the
Playground reverse transport are not established by this initial launcher path.

The focused test invokes a real Node CLI subprocess over the real private
socket into the real renderer service; only the CDP call is substituted. It
covers owner mismatch, trusted-scope separation, resource layout, traversal and
revocation, and reruns existing built-in Skill protection checks. This is scoped
evidence. Production CDP/native composition and actual Room/Shell readback must
be validated separately with the integration owners.
