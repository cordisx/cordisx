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
does not depend on an old renderer's prompt cache. This preserves definition
context; it does not establish that a cold restart can resolve an arbitrary Host
SessionId to a native thread. The transport currently requires its in-memory thread mapping; neither an
unknown Host SessionId nor a caller-spelled native reference establishes that
binding. Durable native thread mapping is a separate availability boundary.

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

The first collaboration milestone supports a newly created Session, followed by
its persisted domain run association, tool binding, and first submission. A
revoked CLI-bound Session cannot currently resume: resume validates before the
consumer can establish a replacement binding. This intentionally fails closed;
a controlled owner-recovery and rebind phase remains unfinished. Ordinary
never-bound Agent resume does not prove bound collaboration recovery.

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
revocation refusal. The context lifecycle cases substitute the broker getter;
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
