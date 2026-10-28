# Provider-aware native task creation assessment, 2026-10-28

This is a dated implementation assessment against Host main
`45c22b696c712c749ee94c2446d5543ee8ff7508` (including #519, #521, #522 and beta.31 release preparation).
The current reference is [native model providers](../native-model-providers.md).
This change reports an unavailable capability; it does not implement task creation.

## Requirements and retained gates

| Requirement                                                  | Implementation/evidence                                                                                                                    | Remaining gate                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Agent selects an admitted provider/model for a new user task | Existing catalog and idle-thread selection available; provider-aware creation unavailable                                                  | Supported native creation/registration seam                         |
| The actual first user message uses that pair                 | Existing marked native `thread/start` sets provider/model before creation; this is the composer path, not an app-tool creation transaction | Exact new-task transaction and provider readback                    |
| Native project, cwd, sidebar and task identity are preserved | Native `create_thread` remains the authoritative entry; no background-thread substitute added                                              | Native registration receipt and visible task evidence               |
| No repeated create/send after an uncertain result            | Existing selection reports reconciliation required; no creation operation exposed                                                          | Durable transaction identity and phase readback for future creation |
| Agent can discover the limitation                            | `list_model_providers` includes `threadCreation.status=unavailable`; MCP description explains the first-turn limit                         | Focused handler/stdio tests and PR CI                               |
| No installation, launch, reload or cross-chat mutation       | Only isolated source checkout and synthetic tests used                                                                                     | User performs later native acceptance                               |

Merge, publication, installation and user acceptance are separate states. This
record does not establish any of them, and passing fixtures cannot close the
native registration or first-inference gates.

## Confirmed boundaries

The native app-tools `create_thread` schema exposed to this task accepts the
initial prompt, target, optional model/thinking and title. Targets retain native
project/local/worktree or projectless semantics. A ready result identifies the
task and host; asynchronous worktree setup may instead identify a pending client
task. The schema has no provider, arbitrary config, deferred-first-turn or
existing-thread adoption input. `send_message_to_thread` likewise has model and
thinking inputs without a provider. No separate adoption/registration tool was
exposed in the available app-tools inventory.

A read-only inspection of the bundled app-tools MCP server snapshot
`26.1021.31345` (SHA-256
`c1209959d8c3b8f532e2d9e7e2bc72e50ad37f622b0d5ff0d0d062a00a64142f`)
confirmed that it obtains tools through `tools/list` and forwards `tools/call`
over its native pipe. The call preserves the executor's caller/thread/turn/call
metadata and host identity. That proxy supplies no separate task registration
API or provider adapter. This is evidence about that proxy and exposed schemas,
not a claim that all private Desktop implementation has been audited. No live
pipe call, installed-app modification or native process launch was performed.

CordisX's production `native-submission-composition.ts` binds the admitted
catalog, credential controller and existing-thread authority to
`native-agent-models.ts`. Its control server communicates with the already
launched intermediary. `native-app-server-intermediary.mjs` injects the stdio
`cordisx_models` configuration and handles marked composer creation:

1. The submission controller prepares a scoped credential lease and operation.
2. The intermediary consumes and authorizes its marker before forwarding
   `thread/start`, setting `modelProvider`, `model` and private provider config.
3. The native creation response binds the operation to the returned thread id.
4. The first `turn/start` must carry that association; it retains native user
   input, permissions, cwd and other controls.

That operation is bound to a renderer document/selection scope. The Agent MCP
does not create such a scope or join a native app-tools creation transaction.
`prepareThreadResume` requires an existing thread id, so it cannot serve as a
pre-create credential commit by inventing an id.

The renderer `codex-desktop-agent-session-transport.ts` does use native
`thread/start`/`turn/start` and persists a plugin-owned Session binding. Its
project transport has an exact Desktop-build fence. Session binding persistence
and native task navigation are not evidence of the app-tools project/worktree,
sidebar or task registration contract. See [Agent task creation](../agent-task-creation.md)
and [execution contexts](../entity-execution-contexts.md).

The [official app-server reference](https://learn.chatgpt.com/docs/app-server)
documents thread creation and separate turn submission. It does not establish
the Desktop app-tools registration behavior required here. A `thread/started`
notification or `thread/list` entry alone cannot close that evidence gap.

## Smallest missing seam and future operation order

The missing seam is a supported, correlated provider binding **inside the
native user-task creation transaction, before its first turn**. It must preserve
native context resolution, task registration and permission policy. Either a
native creation hook accepting a Host-private admitted binding, or a supported
create-without-submit entry followed by registration readback and existing send,
could supply it. Neither is currently adopted or confirmed available.

A future `create_thread_with_provider` must follow this order:

1. Validate explicit user intent, exact admitted provider/model and the native
   target/context. Reject unavailable targets before any creation or inference.
2. Claim one retained operation identity for the exact caller, target and input.
   Equal requests join/read that operation; mismatched reuse is rejected.
3. Prepare credentials privately. Carry only an opaque correlated binding into
   the supported native create transaction; never accept endpoint/secret/config
   injection or alter global defaults.
4. Let native creation resolve the real project/worktree/cwd and apply provider
   config to `thread/start`. Bind the lease only to its acknowledged real id.
   Retain pending client ids without pretending they are ready thread ids.
5. Verify native task registration and returned context/provider/model before
   submitting the original user input once through the native send path.
   Registration may occur during native creation; it must be acknowledged before
   first submission, not reconstructed from a backend thread response.
6. Record the actual send acknowledgement and return the registered native task
   identity and status. Inference completion is later evidence, not the create
   acknowledgement.

Known pre-dispatch failures can release an unused lease. Any timeout,
disconnect, cancellation or missing acknowledgement after dispatch leaves the
operation uncertain. Retain its phase and any known task ids; never retry create
or send automatically. A duplicate invocation reads/joins the same operation,
including after runtime restart. A lost acknowledgement is not proof that
nothing happened. Registration failure after backend creation must report a
partial/unavailable result and must not create a replacement task. No automatic
archive, deletion, fabricated successful first turn or bootstrap prompt is
permitted as reconciliation.

## Validation scope

The following local checks passed with reused existing workspace dependencies:

- `native-agent-models.test.ts`: 8 tests, including the actual stdio MCP subprocess.
- The controller, intermediary, submission-composition and Agent-model suites:
  137 tests total, using synthetic fixtures (8.82 seconds).
- Changed-source ESLint, changed-file dprint, Node syntax check, relative
  document links and `git diff --check`.
- `tsc -p packages/cli/tsconfig.json --noEmit`, after including the CLI workspace's
  existing Vite dependency directory; root dependencies alone lacked its types.

Focused handler and actual stdio MCP tests exercise capability projection,
description discovery, authenticated transport and rejection of unsupported
creation before credential or native mutation. Existing intermediary/controller
and submission-composition regressions cover retained routing behavior using
synthetic fixtures. They do not prove real native UI registration, provider
inference or production usability of a creation capability. No creation tool is
advertised until the missing seam and its real native acceptance can be supplied.
