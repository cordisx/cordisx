# Supplemental Codex CLI and tools

Experimental Host implementation. These commands use the selected running
CordisX profile's management endpoint. They do not launch an App or another
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
retrying. Fast and project switching are not supplied by these commands. Native
project membership changes do not alone prove a new cwd or writable boundary.

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
required. Native Codex creation tools remain preferred without a provider override.

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
retained. Omitting their chat target means the calling chat, never global defaults.

Channel-originated requests retain the real incoming source, context and field
permissions. Changing from a Channel command to a generic Codex command does not
grant profile or model-service administration. CLI callers pass their existing
`--context` token. Missing, mismatched or expired source context cannot fall through
to ordinary local-user mutation. Continue using Channel commands for its approval
workflow and source-scoped task configuration.

In [service mode](standalone-services.md), shared model-service commands and
creation defaults work without Channel or Desktop. Session operations require
an existing headless Codex backend, currently started by the enabled Channel
consumer. That backend supplies its actual catalog and existing-session settings;
provider-aware App task creation, Fast and project switching remain unavailable.
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
