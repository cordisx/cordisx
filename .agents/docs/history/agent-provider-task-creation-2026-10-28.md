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

## Follow-up: protocol capability versus the missing adapter

The initial exposed-tool assessment is insufficient to conclude that the
underlying protocol cannot create a provider-bound thread. A second bounded
read-only investigation checked existing generated protocol snapshots and the
adopted Host seams. A subsequent read-only inspection of the installed archive
then identified the actual creation dispatcher below. No live transport was
called. The conclusions are distinct:

| Layer                        | Evidence                                                                             | Conclusion                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Exposed app-tools input      | Available `create_thread`/`send_message_to_thread` schemas                           | Provider/config/deferred-submit inputs are absent from these tools                               |
| Underlying app-server        | Existing generated `ThreadStartParams` snapshots                                     | `modelProvider` and private `config` are supported; provider-bound backend creation is possible  |
| CordisX adapter              | Production marker/controller/CDP/renderer composition                                | Composer routing is implemented; app-tools creation correlation is not implemented               |
| Native user-task transaction | No adopted create dispatcher or correlated app-tool-to-creation hook in Host sources | One supported transaction seam is still needed to preserve task registration before first submit |

The offline snapshot retained from the 2026-10-27 diagnosis identifies
`codex-cli 0.164.0-alpha.11.1`, App `26.1021.31345` build `21828`:

- `ThreadStartParams` SHA-256
  `e9c6d3cc18d049bfbc0249add3808fb8e5a27e1a0b5a423767aafbc3859a9428`
  has `modelProvider`, `model`, `config`, `cwd`, `approvalPolicy` and `sandbox`.
- `McpServerToolCallParams` SHA-256
  `7039a7583a1cbf38e9e0f5fe6398ff3711acd4d654b81b0be562514087fce6ba`
  accepts `server`, existing `threadId`, `tool`, `arguments` and `_meta`.
- A retained `codex-cli 0.153.4` complete snapshot also has `projectId` on
  `ThreadStartParams`, with an explicit durable-assignment description, and
  `thread/metadata/update.projectId`. Its ThreadStartParams SHA-256 is
  `25f490368ec6df52a2a3b82a5469d2413307eb93439121b309f415b5648eee7a`.
  This older complete schema is not a current Desktop compatibility pin. The
  newer snapshot's omission of project fields does not prove experimental
  project support was removed or that native projectless registration works.

The promising reusable path is a CordisX supplementary MCP tool forwarding a
normal native `create_thread` via `mcpServer/tool/call`, retaining native context
and registration. This alone still lacks provider binding:

1. `NativeMcpRequestClient.request` already sends a correlated `mcp-request`
   envelope through the existing renderer preload bridge. A native MCP tool
   call can carry caller metadata without inventing another backend process.
2. The bundled app-tools proxy extracts only known caller/thread/turn/call
   identity keys from `_meta` into its `tools/call` envelope. It does not forward
   arbitrary `_meta` as tool arguments or creation config. Adding a custom
   provider token to `_meta` therefore does not reach native creation through
   this proxy. Calling with an unsupported provider/config argument is not a
   supported extension of `create_thread`.
3. `ThreadStartParams` has no parent app-tool call id or parent turn id. Its
   `serviceName` and `threadSource` are service/analytics classifications, not
   contracts linking an app-tool request to a creation transaction. The first
   input's `clientUserMessageId` is on `turn/start`, after thread/provider
   creation. No evidence establishes that native app-tools carries a caller
   id into one of these creation fields. Reusing them as a hidden channel would
   require an unproved native change.
4. Existing `draftConfigForward` discovery in `native-submission-structure.ts`
   verifies that a renderer's `configOverrides` reaches creation `config`.
   The `firstTurn` transform carries that same token forward. These are useful
   existing seams **after** a token reaches the renderer operation. They do not
   expose or call the native app-tool dispatcher that constructs that operation.
5. `native-submission-cdp-channel.ts` revalidates a composer operation against
   the exact live renderer/navigation scope. `native-submission-control-server.ts`
   exposes existing-thread switch/read, not native user-task creation or adoption.
   A new Agent tool cannot manufacture a draft scope or attach its lease to
   whichever unrelated `thread/start` happens to arrive next.

Direct `thread/start` could bind provider credentials and, on a compatible
schema, persist project metadata. The current sources do not prove that this
also performs Desktop projectless/worktree provisioning, saved-project lookup,
caller task attachment, task status/notifications or sidebar registration.
`thread/metadata/update`, a Host Session binding, and navigation each cover
only their own part. A lower-level backend thread plus any one of those is
insufficient evidence for the requested native user task.

The concrete missing step is between **native `tools/call(create_thread)` and
the renderer creation operation's `configOverrides`**, before `thread/start`.
The smallest candidate interface is a native creation adapter hook that receives
the authenticated caller/call identity and exact resolved target, accepts one
opaque Host-private routing handle, and puts its verified config into that same
creation operation. Existing CordisX marker/credential/first-turn logic can then
do the rest while native code retains registration. The hook must return the
native creation/registration receipt, including pending client task identity,
and be fenced to that operation rather than a global pending preference.

No such dispatcher/hook is currently adopted in CordisX sources. The next audit
identifies its actual native shape and the required contract extension. This
assessment does **not** claim that Codex's entire private implementation has no
usable seam.

## Installed dispatcher audit

After clarification that a bounded read-only installed-source inspection was
permitted, the archive was read without extraction into the installation,
execution, pipe calls, mutation or access to user conversations/configuration.
The first inspected installation was the older `/Applications/Codex.app`,
version `26.820.60940`, build `7119`; it is not evidence for current build 21828.
Its resource is `webview/assets/app-initial-CmWKLN1D.js`, SHA-256
`919f74f8443047cf6fda745a2e3bf1736cae3bcd9fed3fc261304894622cf9f5`.
The native pipe resource is `.vite/build/main-BA_G1ClR.js`, SHA-256
`51398c07cba29dc2d71d2505ef64ce13fd1ef84653338832058361a2d727ff27`.
Names and zero-based character offsets below are observations of these exact
bytes, not stable exports or instructions to invoke private functions:

1. The native pipe `tools/call` parser retains arguments, namespace and
   caller/call/thread/turn identity. Its dispatcher routes to renderer execution;
   arbitrary `_meta` does not become creation options.
2. Renderer `W9o` (offset 9028141) is the `create_thread` handler. Its closed
   argument schema contains title/prompt/target/model/thinking. It resolves the
   real native project, validates a requested model, and calls `yli` with the
   actual source thread, prompt, resolved target and native delegation source.
   The handler does not pass call identity, config, a routing handle or a
   deferred-first-turn option into `yli`.
3. `yli` (5073597) rejects a non-null config together with a delegated source
   thread before any creation. It resolves native saved-project/worktree roots
   and passes worktree targets to `xli`; other targets go to `bli`.
4. `bli` (5075246) resolves native project/projectless cwd and output directories,
   inherits permission selection from the source conversation, constructs the
   actual first user input, then calls `GN`. It accepts `startWithoutFirstTurn`
   internally, but `W9o`/`yli` never forward it. With a delegated source, its
   first input is always the native delegation input. Calling that private helper
   without a source would discard required caller/permission semantics.
5. `xli` (5077077) resolves the native Git starting state, obtains permission and
   creation options from `Tli` (5081408), and creates the native pending worktree
   operation with a `clientThreadId`. This branch does not forward arbitrary
   config from `yli`. `Tli` constructs config from native settings and optional
   reasoning overrides, not from an app-tool routing handle.
6. `GN` (5053313) calls the existing manager `startConversation` with native
   config and runtime options. `startConversation` (1479382) defers the started
   notification while saving project assignment and binding a client task id,
   notifies conversation callbacks, sets the owner stream and broadcasts the
   snapshot. It then executes the first turn. `beforeFirstTurn` is an internal
   callback option on this manager path, but is not forwarded by `W9o`/`yli`/`bli`.
   Native sidebar manual order is retained through the final `vLn` call.

This confirms an explicit delegated-config restriction, not merely an omitted
tool parameter. It also confirms that the full native manager path, rather than
`thread/start` alone, owns the registration work required by the user.

A reliable implementation can reuse that native path **if** a new bounded
creation adapter contract is admitted. It must extend the authenticated
app-tool handler to resolve one operation routing handle by the real call
identity, carry it through both local/projectless and pending-worktree branches,
merge verified provider config at the existing native create operation, and
retain registration plus first-turn acknowledgement/uncertainty callbacks.
The provider handle must be separated from arbitrary caller config so the
delegated-config restriction continues to reject untrusted overrides. It must
also retain source-thread permissions and native delegation input.

That requires an additive, exact-source-verified renderer resource adapter for
these private functions, or an upstream native hook supplying the same contract.
The existing CordisX resource interception architecture can host such an adapter
without editing installed bytes, but it does not currently expose this contract.
Bypassing the guard, invoking `bli` with a fabricated source, attaching a handle
to the next global create, or intercepting arbitrary app-tool arguments would
cross the stated boundary. The minimum user decision is whether to authorize
and admit this specific new native creation adapter; the feature cannot be
honestly completed using only the already adopted seams.

### Current build 21828 readback

The current `/Applications/ChatGPT.app` identifies version `26.1021.31345`, build
`21828`. The same bounded read-only audit checked its actual dispatcher rather
than extrapolating the old installation:

- `webview/assets/execution-94a643044336.js`: SHA-256
  `f1a35f5a2b7397024aae8fdfc154bbb86cc6fd17c08c78811f8c41d54cc28a9b`.
- `webview/assets/app-initial-feb30b196d11.js`: SHA-256
  `8f4e5fe65617413cabf689afbfc04bc6c24f73a5c0b57d7d0de443942343bd55`.
- `.vite/build/main-0FVbxCQU.js`: SHA-256
  `fad45aa7d81de6fe166704e8879e3b7cbfc85151e72df7946853336c7cbc5a3c`.

Its `create_thread` handler `wp` (execution offset 88600) calls the native
creation helper with source thread, target, actual input, `parentTurnId` and
`rootTurnId`. It maps a native queued worktree to `clientThreadId`; ordinary
creation returns the real thread only after both creation and first turn are
accepted, preserving partial/unknown runtime results otherwise.

The native helper `ius` (initial offset 8966177) still rejects config on
delegated creation before resolving the target. Its service-name override is
also restricted to local root tasks outside worktrees, so it cannot act as a
delegated provider handle. The local/projectless helper `aus` (8968873) retains
native output-directory provisioning and source permission selection, then
calls `hpo`/`ous`. `ous` (8971470) uses the native manager's real creation inputs,
client-thread attachment and settlement callbacks. The worktree helper `sus`
(8972242) prepares the native pending worktree and its creation options. Both
branches retain native delegation input; neither receives provider config from
the app-tool handler. Native title/project/sidebar updates run after an actual
created receipt, including the settlement path.

The current manager's `Kdn` transaction (3207447) already has creation,
first-turn preparation, current-operation checks, dispatch and settlement
callbacks. The missing adapter should retain those real outcomes rather than
introduce a second optimistic task ledger or infer success from a backend id.
The native pipe also contains signed `taskWorkspace/prepare`, `taskProject/list`
and `taskProject/assign` operations. They establish scoped context/assignment,
not a new task-plus-first-turn endpoint, and are not adopted CordisX APIs. A
signature and project assignment alone do not establish all creation callbacks
or sidebar/task ownership.

The newer parent/root turn fields improve provenance but do not identify one
creation call: one turn can request several tasks. The `wp` handler does not
pass the unique native app-tool `callId` into `ius`; a parent-turn-based pending
provider slot would therefore race. The specific extension required on this
build is authenticated **callId + routing handle** forwarding through the native
handler and both creation branches into the existing create config and first
turn, with the native transaction's actual settlement callbacks. CordisX's
credential broker and intermediary can consume the handle, but its current
adapters cannot insert it at that boundary. This is a concrete new native
adapter contract/admission requirement, not an inference from a missing tool
schema. No installed bytes were modified and none of these functions was run.

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
