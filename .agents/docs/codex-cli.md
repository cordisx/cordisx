# Supplemental Codex CLI and tools

Experimental Host implementation. These commands use the selected running
CordisX profile's management endpoint, except the local startup configuration
commands documented below. They do not launch an App or another
Codex app-server. Check `cordisx codex capabilities` before choosing an operation;
a command advertised in help may be unavailable in the selected runtime.

Prefer native Codex tools for ordinary chat creation, sending, reading and project
organization. CordisX supplements provider-aware creation/selection, execution
settings and shared model-service management. The CLI and MCP adapters dispatch
to the same Host services that own these operations. Channel retains its own
source-user authorization and consumes the common execution service.

## Session targets and defaults

```sh
cordisx codex providers list
cordisx codex chats provider set --session CHAT --provider PROVIDER --model MODEL
cordisx codex chats settings get --session CHAT
cordisx codex chats settings set --session CHAT --revision 0 --effort high --work-mode plan
cordisx codex chats settings reset --session CHAT --revision 1
cordisx codex defaults get
cordisx codex defaults set --revision 0 --execution workspace-write --approval on-request
```

All commands accept `--profile ID`; this selects a Codex profile even when the
home's default App is Claude. Only `--host local` is supported. Chat commands
accept an explicit `--session` or the current `CODEX_THREAD_ID`. If neither is
available, the request fails; it never changes defaults. `defaults` commands
explicitly address future chats in that profile and do not modify existing chats.

Read the revision before each write: an absent chat record uses revision `0`.
`settings set` replaces the saved override; preserve fields the user wants to
keep. `reset` clears that override. Settings support execution mode, approval,
reasoning effort, work mode and network access. Writes report `saved`; the next
native turn consumes the settings, and matching native observation confirms
application. Unsupported modes/models and named permission-profile conflicts
remain errors rather than silent substitutions.

Provider selection uses the existing admitted catalog and idle-thread native
resume path. It does not send a message or interrupt a running turn. A result of
`reconciliation-required` means the effect is uncertain; inspect the chat before
retrying. Fast and project switching use the supplemental configuration service:

```sh
cordisx codex defaults model get
cordisx codex defaults model set --revision 0 --provider PROVIDER --model MODEL --fast false
cordisx codex chats fast get --session CHAT
cordisx codex chats fast set --session CHAT --revision 0 --fast true
cordisx codex chats project get --session CHAT
cordisx codex chats project set --session CHAT --revision 0 --project NATIVE_PROJECT_ID
cordisx codex chats reviewer get --session CHAT
cordisx codex chats reviewer set --session CHAT --revision 0 --reviewer auto_review
```

Reviewer changes are local-management-only, require an idle chat and the current
configuration revision, and use native settings readback to distinguish applied
from pending or uncertain effects. `user` restores manual review. The setting
does not change the sandbox, network or approval policy, or answer pending
requests. Existing execution overrides are preserved. Availability depends on
native runtime support for reviewer settings; older runtimes may reject the
operation. A Channel-originated agent cannot change its own reviewer.

To select the automatic reviewer's model separately from the working model,
use [approval review model configuration](approval-review-models.md). It is an
operator-owned profile startup setting; it does not change the chat strategy
and does not provide live per-chat model overrides.

Model defaults are a separate profile-owned `chatCreation` layer in `config.json`.
They apply to future ordinary native/API chats. Explicit native selections take
precedence. Channel merges its own model rules over these defaults; changing
provider without a model selects the new provider's own default. An explicit
Fast `false` remains an intentional selection. Defaults never rewrite old chats.

Fast and project share each chat's configuration revision in the private profile
`codex-chat-configuration.json`. Writes require an idle loaded chat and never
interrupt one. Fast validates native model-catalog support. Project switching
uses native project tools on Desktop; an opt-in headless service uses the
operator-controlled workspace catalog described in the [Channel guide](channel-cli.md#provider-model-effort-fast-and-project).
Both canonicalize target directories and update cwd plus sandbox writable roots.
An old full-access chat narrows to workspace-write; read-only remains read-only.
Headless workspace-write also permits its private Channel transport directory,
without granting the rest of the temporary directory. On subsequent turns the
saved project binding wins over old cwd and sandbox payloads. A removed project
or changed roots fail explicitly. Native settings observation confirms `applied`;
`pending` and `reconciliation-required` require inspection. Headless projects
do not create Desktop sidebar membership. Channel callers may read their authenticated bound tasks and
request Fast/project changes through the same field-specific permissions and
approval workflow as Channel commands. Their existing `--context` identifies
the incoming actor; switching CLI entry points cannot bypass those rules.
Fast values and project IDs can be constrained independently. The common chat
configuration revision and Channel task revision are separate: read the matching
entry point's revision before requesting a change. Local user CLI can address
a bound chat explicitly.

## Provider-aware creation

```sh
cordisx codex chats create --provider PROVIDER --model MODEL \
  --message "Work on this task" --operation STABLE_ID --project NATIVE_PROJECT_ID
```

This uses [the existing native task creation path](native-agent-task-creation.md),
including native project resolution before the first message. Omit `--project`
for a projectless target. Source identity must identify an actual calling chat
and turn through `CODEX_THREAD_ID`/`CODEX_TURN_ID`, or explicit `--source-session`
and `--source-turn`. The command does not fabricate them or substitute a backend
thread for an App task. Keep the same operation ID after uncertain delivery;
changing it can create another task. Runtime `providerCreation` availability is
required. Provider/model/Fast flags can be omitted to use the profile creation
defaults. Stable operation replay keeps its original result even after defaults change. Native Codex creation tools remain preferred without a provider override.

## Shared model services

```sh
cordisx models services list
cordisx models services save --input-file /absolute/private/request.json
```

The save request is `{expectedRevision, services}` using the revision from `list`
and the existing [model-service store](shared-model-services.md). It replaces
declared model services; preserve unrelated service declarations. Gateway
providers are retained by the store. API keys and fixed header values are
write-only; reads expose credential status and header names. Supply secrets in a
private JSON file or pipe JSON with `--input-file -`. Saving applies after restart,
as reported by `applies: app-restart`, and does not rotate a running connection.

## MCP and Channel consumers

The launch-owned MCP catalog adds `codex_capabilities`, `codex_chat_settings`,
`codex_chat_settings_set`, `codex_chat_defaults`, `codex_chat_defaults_set`,
`model_services_read` and `model_services_save`. Existing provider tools are
retained. Additional tools are `codex_model_defaults`, `codex_model_defaults_set`,
`codex_chat_fast`, `codex_chat_fast_set`, `codex_chat_project` and
`codex_chat_project_set`. Omitting their chat target means the calling chat, never global defaults.

Channel-originated requests retain the real incoming source, context and field
permissions. Changing from a Channel command to a generic Codex command does not
grant profile or model-service administration. CLI callers pass their existing
`--context` token. Missing, mismatched or expired source context cannot fall through
to ordinary local-user mutation. Continue using Channel commands for its approval
workflow and source-scoped task configuration.

In [service mode](standalone-services.md), shared model-service commands and
creation defaults work without Channel or Desktop. Without a backend catalog,
model-default writes report `validation: deferred-until-creation`; actual creation
validates the selection before dispatch. Session operations require
an existing headless Codex backend, currently started by the enabled Channel
consumer. That backend supplies its actual catalog and existing-session settings;
Fast uses the same backend settings interface. Provider-aware App task creation
and sidebar project switching remain unavailable.
An idle loaded headless chat's model change is confirmed by a fresh native
settings event. Older backends without that event retain the existing resume
readback path; missing confirmation is reported as uncertain.

## Validation boundaries

Focused checks execute the compiled CLI through the authenticated management
socket, the real settings/model-service stores, the MCP stdio subprocess and the
production service owner. They cover session/default isolation, next-turn routing,
Channel context/permission guards, revision conflicts, stale/closed runtime state
and secret-free readback. Native Desktop project changes, first-provider inference
and live model execution require separate native evidence; these checks do not
establish those paths or imply publication/installation.
A temporary, isolated Codex CLI `0.149.1` app-server also confirmed creation of an
empty chat and a model change through the native settings notification, without
starting a model turn. This is headless protocol evidence, not Desktop UI evidence.
The supplemental defaults/Fast verification used the production headless authority:
provider/model creation defaults applied, Fast enable/disable both received native
confirmation, and cwd plus workspace-write roots were read back after settings
update. Native normalizes the cwd root out of `writableRoots` and reports a cleared
tier as `default`. Resume alone did not apply directory overrides to a loaded chat;
the project mutation uses settings update and confirms membership separately.
Channel-specific checks also exercise compiled CLI requests through the source
guard, persisted human approval and idle application of Fast/project settings.
A fixture app-server behind the production authenticated intermediary confirms
project resolution, native tool metadata, membership-before-turn ordering and
strict turn roots. The isolated real CLI confirmed Channel Fast enable/disable
and headless project unavailability without a configured workspace. The intermediary fixture does not
establish real Desktop sidebar behavior.
