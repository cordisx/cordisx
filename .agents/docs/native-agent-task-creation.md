# Agent creation with a configured provider

Status: experimental source implementation. Synthetic tests and read-only
source composition are evidence for the adapter; real native task visibility
and first-provider inference remain user acceptance gates.

`cordisx_models.create_thread_with_provider` supplements native `create_thread`.
Use it only for an explicitly requested new task and configured provider/model.
First call `list_model_providers`; its `threadCreation.status` must be
`available`. Pass an exact catalog pair, original prompt, native project/local
or worktree target, or a projectless target. Cloud and remote execution are
unavailable. Native target resolution retains existing cwd, output-directory,
Git starting-state and permission behavior. Callers cannot supply raw config,
endpoints, credentials or a native thread id.

The tool requires executor thread and call metadata plus a retained unique
`operationId`. Equal requests join or read their saved result. Reusing an id
with different input is rejected. The Host writes a private intent before native
dispatch; a timeout, restart, missing receipt or first-turn failure never
automatically creates or sends again. A pending worktree result retains its
native client task id. Pending/unknown operations require native inspection;
changing the operation id is not recovery.
After a successful native receipt is durably saved, completed routing/intent
records retire while the real thread's credential binding remains. Pending or
uncertain operations retain their live correlation, bounded to 128 per launch.
The tool rejects `thinking`; reasoning selection is not part of this initial
creation input and is never silently ignored.

The supplementary tool calls native `mcpServer/tool/call` for `create_thread`
on the existing app-server. It forwards an operation call id derived from the
executor's actual call identity. The exact-source-checked renderer handler
claims a Host-private handle for that call, source thread and arguments. A
renderer-branded handle passes through the original local/projectless and
worktree helpers. Ordinary delegated config remains rejected.

Only the handle reaches renderer config. The intermediary resolves private
credential config before the original native `thread/start`, sets provider and
model, and binds the original credential lease to the acknowledged new thread.
The same handle must reach the original first turn. Native creation still owns
source permissions, user delegation input, project/client task binding, task
callbacks, sidebar updates and settlement results. The tool reports `created`
only with both a native registration/first-send receipt and matching Host route
confirmation; an isolated backend id is insufficient.

Initial admission is restricted to Desktop version `26.1021.31345`, build
`21828`, and the exact initial/execution resource hashes in
`native-agent-task-transform.ts`. Structural anchor counts additionally reject
missing or ambiguous shapes. The task edits compose with existing submission
transforms on one resource, with generation-scoped CDP claim authority and
cleanup fences. Source drift or unavailable native bridges disables this
capability without changing native `create_thread` or global defaults.

The [dated creation assessment](history/agent-provider-task-creation-2026-10-28.md)
retains the investigation and exact source provenance. Focused operation,
credential, transform, stdio and intermediary fixtures cover the integration
boundaries. They do not establish native UI acceptance or real model inference.
No release, installation or live App validation is implied by this source work.

## MCP endpoint source evidence

The actual installed build-21828 CodexCLI executable has SHA-256
`a04752e4d46a4d89e53e6f61c59c5349a638c8ce172ffbf391fd482b4d902a4e`.
A read-only byte inspection confirmed its `mcpServer/tool/call` request name and
five-field `McpServerToolCallParams` declaration. The retained same-version
generated request schema accepts server/threadId/tool/arguments/`_meta`.

The [official request dispatcher](https://github.com/openai/codex/blob/26ad281fd1ca712e4f0c7920a6273cf18c961b8a/codex-rs/app-server/src/message_processor.rs)
routes that request to the MCP processor. Its
[tool-call implementation](https://github.com/openai/codex/blob/26ad281fd1ca712e4f0c7920a6273cf18c961b8a/codex-rs/app-server/src/request_processors/mcp_processor.rs)
preserves supplied metadata, adds the source thread id, and passes it to
`thread.call_mcp_tool`. This public source revision is independent evidence,
not an exact source identity for the installed binary. It also rejects direct
input to native multi-agent-v2 spawned subagents; this entry targets user tasks.

The installed bundled app-tools proxy (SHA-256 in the dated assessment) reads
`openai/threadId`, `openai/turnId`, and `openai/toolCallId` from MCP `_meta` and
places them in its native `tools/call` request. The native main pipe and renderer
dispatchers preserve that call identity to the audited handler. Those source
observations and protocol declarations establish the intended endpoint and
metadata flow. No real endpoint invocation was performed; native execution,
authorization and visible-registration acceptance remain unverified.
