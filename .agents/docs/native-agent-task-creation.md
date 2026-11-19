# Agent creation with a configured provider

Status: experimental implementation. Real native task creation, sidebar
registration and first-provider inference have been verified for the specific
Desktop build and candidate described below; other builds and providers require
their own compatibility evidence.

`cordisx_models.create_thread_with_provider` supplements native `create_thread`.
The [supplemental CLI](codex-cli.md#provider-aware-creation) exposes this same
operation without duplicating native creation or inventing a source turn.
Use it only for an explicitly requested new task. Omitted provider/model/Fast
values use the selected profile's `chatCreation` defaults; explicit fields win.
Changing provider without a model uses that provider's own default. When neither
the request nor defaults resolve a catalog pair, use native `create_thread`.
First call `list_model_providers`; its `threadCreation.status` must be
`available`. Pass an exact catalog pair, original prompt, native project/local
or worktree target, or a projectless target. Cloud and remote execution are
unavailable. Native target resolution retains existing cwd, output-directory,
Git starting-state and permission behavior. Callers cannot supply raw config,
endpoints, credentials or a native thread id.

The tool requires executor thread and call metadata plus a retained unique
`operationId`. Equal requests join or read their saved result. Reusing an id
with different input is rejected. A completed replay retains its original result
even if creation defaults have changed. The Host writes a private intent before native
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
executor's actual call identity. The source-checked renderer handler
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

Admission discovers the native dispatcher and creation helpers by their syntax
and semantic input fields, independently of minified names, resource filenames,
and Desktop version strings. Missing or ambiguous dispatch, native delegated-config
guards, local/worktree helpers, or first-turn seams disable this capability only.
Each resulting transform remains bound to the exact discovered resource bytes;
source changes between discovery and interception are rejected. The Host retains
the discovered execution module URL, verifies the matching renderer marker, and
loads that module before advertising creation availability. The task edits compose with existing submission
transforms on one resource, with generation-scoped CDP claim authority and
cleanup fences. Source drift or unavailable native bridges disables this
capability without changing native `create_thread` or global defaults.

Read-only source composition and offline replay of Desktop `26.1023.51421`
(build `22530`) verified the dispatcher and helper routing at that time. Synthetic
regressions cover renamed bindings/assets, original arguments with shadowed
target locals, concurrent call identity, guard rejection and dynamic module
availability. These checks alone do not establish real native sidebar registration
or first-provider inference.

On 2026-11-20, an isolated shared-data instance of Desktop `26.1103.60933`
(build `25894`) exercised the actual Agent tool and native `create_thread` path.
The new task appeared in the native sidebar, its original first message was
present, and its first turn completed with the expected response using Aiden
`gpt-6.1-terra`. The tested product code was candidate `c7fc8815`, included in
[#622](https://github.com/cordisx/cordisx/pull/622) and merged as `b0a3ea63`;
the subsequent candidate changes before merge affected tests only. This is
acceptance evidence for that build and provider, not a claim about every
supported configuration or a release or installation record.

An earlier isolated request returned `reconciliation-required` without a task
id. A later read-only check found its source not loaded in a separate app-server;
the original instance's processes were terminated, and no matching local task
was found. Its remote outcome remains unknown and is not resolved by the later
successful independent acceptance.

The [dated creation assessment](history/agent-provider-task-creation-2026-10-28.md)
retains the investigation and exact source provenance. Focused operation,
credential, transform, stdio and intermediary fixtures cover the integration
boundaries. Those fixtures do not by themselves establish native UI acceptance
or real model inference. The later live acceptance is limited to the build and
provider stated above; it does not imply a release or installation.

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
metadata flow. No real endpoint invocation was performed as part of that
earlier source inspection. The later isolated native execution and visible
registration are recorded above.
