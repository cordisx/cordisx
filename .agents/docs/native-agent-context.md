# Native Agent context

The Host-private Desktop Agent/Session transport consumes the existing local
Desktop connection. It accepts only the version/build/flavor pins in
`codex-desktop-agent-session-transport.ts`; adding context does not widen that
fence or create another provider, process, or connection.

## Definition delivery

`agent-session-runtime-agent-operations.ts` validates AgentSetup with the
existing definition catalog resolver. The native transport resolves the selected
leaf with the same inheritance rules, then composes its identity and existing
`renderAgentDeveloperInstructions` output into `thread/start.developerInstructions`.
The native base instructions and original user message are not replaced.
Malformed or incomplete definition catalogs fail before a native request.

Explicit resume setup replaces the supplied definition context. Resume without
setup passes the Session's saved setup back through the driver, so a fresh driver
does not depend on an old renderer's prompt cache. Unknown Host SessionIds and
caller-spelled native references never establish a native thread binding. Only
the Host recovery store can supply a missing binding after checking the current
owner and the exact supplied definition context.

Subsequent turns use the thread's developer instructions. Do not append the same
static definition to every user message or invent a `turn/start` instructions
field. The bundled `codex-cli 0.153.4` generated types inspected on 2026-09-07
support developer instructions on thread start/resume, but not on turn start.
[The app-server reference](https://learn.chatgpt.com/docs/app-server) describes
schema generation. A bundled CLI schema is evidence about that binary, not proof
that the current Desktop connection accepted a request or that a model read it.

## Dynamic tool context

The transport calls the real `getAgentToolSetup(sessionId)` broker before create,
resume, each actual turn start (including dequeued turns), steer, and item
injection. Enqueueing does not cache a setup. A never-bound ordinary Agent may
receive an empty setup; a revoked, expired, unavailable, or mismatched binding
fails closed. The consumer must persist its real run/Session association and
successfully bind tools before submitting its first task.

The broker supplies verified Skill IDs, paths, and actual content, plus exact
CLI argv prefixes and non-secret descriptor references. The native transport
never discovers resource paths or reads credential files. Tool instructions are
an independent user-input block; they do not replace the original user content
or become base instructions. Turn start and steer also attach the native
`skill` input shape. Item injection uses the verified content because that
operation accepts conversation items, not Skill input attachments. A textual
Skill reference alone is not evidence that a model loaded or executed it.

Dynamic context is not saved in AgentDefinition and is obtained again for each
execution. Native conversation history can retain an older descriptor path;
authority is always decided by the Host at actual CLI execution. Revocation must
remain effective even if a model repeats an old command.

## Native Session recovery

`NativeSessionRecoveryStore` owns persistence and authorization. The transport
passes the current runtime owner to that store; it does not construct a plugin
source, profile, principal, or thread ID from user input. A new native thread is
acknowledged to the runtime only after its binding is saved. Each observed
terminal turn saves its completed-turn checkpoint before a queued turn may run.
Failed persistence blocks further execution; it does not silently advance the
queue past an unavailable checkpoint.

When the local Session ledger is absent, `resumeEntity` returns the existing
`session-unavailable` result. A Session that exists without an
`entity/definition-bound` event remains `unsupported` for entity-backed resume.
An explicit inline AgentSetup resume may call the optional private driver
`recover` method. Drivers without it retain the missing-Session refusal. A valid
setup alone grants no recovery authority: the Host must resolve the exact
persisted native binding and validate the supplied setup digest before the
transport sends `thread/resume`. Returned thread identity must match, and a
thread already mapped to another Host Session is refused.

Successful missing-ledger recovery creates an `isSeeded: true` observation
ledger with no initial events. Its observations begin at recovery time. It does
not invent entity-binding, user, assistant, tool, or turn history that the Host
did not persist. Existing native history and Room records retain their original
identities. This inline recovery is not a claim that old entity-backed Session
history has been reconstructed.

The recovery store establishes the tool broker's `needs-rebind` fence as part of
authorized resolution. Resume itself starts no task and bypasses the invalid old
tool setup only through that controlled resolution. The consumer must establish
a new binding for its same persisted Room run and Session before sending. Every
actual turn, steer, or injection still obtains fresh tool setup and refuses the
unbound recovery stage. Restored turns continue after the saved terminal-turn
watermark; a native resume response's observed terminal count can raise but never
lower it. Controlled recovery requires the native `turns` array and rejects any
nonterminal turn. Missing turn state cannot establish an idle Session from a
historical checkpoint alone. Known hot resume retains its existing behavior.

## Event and Room correlation

The private `byThread` map correlates native thread IDs with the Host SessionId.
Native turn IDs are checked against the active turn and mapped to Host ordinals.
Assistant chunks/messages, command/tool observations, and terminal turn events
are emitted under that SessionId through the Host Session authority. Unrelated
native threads and mismatched active turns are ignored. Connection replacement
clears the map and invalidates the runtime generation.

A Room consumer correlates its own member/run records with that SessionId. An
assistant event remains an observed model reply; it is not proof that a CLI sent
a Room message. A CLI collaboration consumer must use its authenticated command
handler and real Room write as the message source, while retaining Session events
for execution status. Host native context code does not own a Room ledger or
infer Room authority from prompt text.

## Validation boundary

`tests/codex-desktop-agent-session-transport.test.ts` exercises real runtime
composition against a controlled Desktop bridge: inherited context, implicit and
explicit resume, unchanged user input, invalid setup rejection, fresh queued/steered/injected tool context, and
revocation refusal, authorized missing-ledger recovery, preserved turn numbering,
and checkpoint ordering. The context lifecycle cases substitute the broker getter;
`plugin-agent-tools.test.ts` separately exercises the real authority, resources,
renderer service, and subprocess with a substituted CDP transfer. Together these
are scoped component evidence. The transport suite proves
request construction and runtime handoff, not model consumption, native UI access,
Skill execution, or a real CLI-to-Room message.

For a native claim, retain the exact Desktop build and source head, observe
thread start/resume acceptance, then show the Agent using its supplied tools and
the real consumer receipt. Do not substitute a controlled transport response or
ordinary assistant text for those observations. UI access restrictions still
apply; context work does not authorize a CDP workaround.

## Native task navigation

An Agent detail reference is resolved by `HostAgentTaskDetailsNavigator`; the
existing `codex-thread:` mapping supplies its Host-owned task address. Native
runtime composition must route that address through the already installed
`CodexRouterHistoryAdapter`. Its existing React Router navigator owns actual
navigation and Back/Forward. A `window.history.pushState` call plus the
`cordisx:host-task-details-navigation` event only reaches the browser Playground
listener; it does not navigate Codex's native MemoryHistory router.

The native adapter pushes the resolved target, removes only the CordisX route
projection from that new native location, updates its current reload checkpoint,
and notifies its existing subscribers. The previous Room location remains in
native history, so Back restores its original route entry. Do not create another
navigator, replace React Router's single listener, infer a different task path,
or reload the page when this seam is unavailable. Disposal or a missing router
fails closed without a browser-history fallback.

The focused router test drives the actual Host adapter and detail-navigation
factory with a controlled native navigator, verifying native push, the original
React listener, one transition notification, no browser push, and native Back.
This is adapter evidence, not direct native UI verification. Keep an accepted
CLI/Room window unchanged while preparing a separate navigation candidate;
Host runtime HMR can revoke its live bindings.

## Native persistence and explicit legacy recovery

Native Host Sessions now use the existing authenticated owner-document CDP
transport and locked CAS store. Each source/profile/plugin scope stores one
native binding record per Session plus its recovery-afterward Session ledger.
Creation saves the exact native thread id and setup digest before reporting
success. Completed native turn counts are checkpointed before further work.
A native resume never guesses a thread id from an unknown Host Session id.

A source from before this persistence change has no old Host SessionEvent ledger
to restore. The explicit local
[receipt recovery script](../../packages/cli/scripts/recover-native-session-from-cli-receipt.mjs)
validates one original Room run/Session, an actual native tool-call receipt,
current authenticated local-thread evidence, terminal turn evidence, and exact
Entity revision/catalog-to-native developer instruction bytes. It imports only
the proved mapping. It must first run against a restoration-only copy and must
recheck the original Room hash/revision before an authorized original-home write.
It never merges same-named Rooms from different homes or overwrites a binding.

The consumer may use the existing inline AgentSetup resume overload only after
an exact missing Session result or for a marked seeded recovery Session. The
Host's optional recovery driver resolves the scoped mapping and resumes that
same native thread. A seeded empty ledger explicitly represents observations
starting after recovery; it does not claim that unknown historical events were
reconstructed. Native resume must return the same id and an explicit turns
array containing only terminal turns. Unknown/running turn state fails closed.

Successful resolution marks the single Agent tool state as requiring rebind.
The recovered owner cannot execute a turn until the Room consumer validates its
unchanged member/run/Session and issues a fresh bound CLI credential. Old tokens
are never revived. Same-Session recovery does not rewrite the Room association
or erase its outbox/history. History remains in the original Room and native
thread; no old user task is replayed by recovery.

Native Session RPC additionally requires a domain-separated Host-runtime HMAC
credential and the current plugin owner principal. The Host credential remains
in runtime-private composition, never plugin Context/setup, logs, or CLI binding
files. Storage uses a reserved Host scope derived from the authenticated original
source/profile/plugin tuple; the plugin's public document scope cannot read or
replace the native records. Caller-supplied source/id fields never select a scope.

## Entity details without a live Session

Entity names, avatar references, exact revisions and definitions already live in
`profiles/<profileId>/entities` with their prompt files and owner index. Room
members retain their exact AgentDefinition reference. A cold Room can therefore
have complete identity data while having no live or recovered Session ledger.

The Shell's display resolver first retains its existing Session/AgentLoop
presentation behavior, then reads the calling owner's authenticated Entity
snapshot view. The Entity service refreshes that view on its normal snapshot
read; binding, owner and module-generation fences prevent a stale or foreign
view from being used. The snapshot is cloned before returning it to plugin code.
This is a read-only view of existing persistence, not a new ledger or a claim
that an Agent is online. Exact revision/parent resolution is still required.

A missing live Session must not turn a valid persisted Entity's message avatar
into the decorative-only avatar renderer. The cold identity regression creates
an Entity on disk, recreates the directory authority, reads it back without
creating any Agent or Session, and clicks the actual avatar button to open its
identity panel. Unknown revisions and foreign owner snapshots remain unavailable.

## Associated Sessions before runtime loading

Shell v12 renders a source's existing Room association independently from live
`activeRuns`. The Host identity panel merges both sources into one “会话” list,
keyed by exact Session identity, and displays Room and Agent names. Internal
Session IDs and unknown/loading diagnostics do not appear in the card. Only a
reliable live working/waiting/attention state is shown; absence of a Room
projector does not assert native idleness or resumability. An empty state appears
only when the merged list is empty. The panel keeps a row without a link when the
authenticated mapping is unavailable.

`NativeAgentSessionPersistence.getDetail` issues a generation-scoped ephemeral
reference through `native-session-detail`; it neither calls recovery nor creates
a Session ledger. `resolveDetail` checks the current owner client and rereads the
same protected mapping before the existing Host navigator opens the native task.
Plugin disposal clears these references. They contain no native task ID and are
not a second persistent ledger. The Shell callback uses the mounted plugin's
existing detail navigation authority, so a renderer row cannot bypass owner or
generation checks by calling the raw navigator.

The [Protocol v12 association contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/agent-conversation-shell/README.md#v12-persisted-session-associations)
owns correlation semantics and downgrade behavior. Display and navigation do
not start an Agent, bind tools, send input, or import historical SessionEvents.
