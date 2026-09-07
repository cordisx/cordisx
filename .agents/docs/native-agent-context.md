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
SessionId to a native thread. The current transport can reuse its in-memory thread
mapping or an explicit native thread reference. Durable native thread mapping is
a separate availability boundary.

Subsequent turns use the thread's developer instructions. Do not append the same
static definition to every user message or invent a `turn/start` instructions
field. The bundled `codex-cli 0.153.4` generated types inspected on 2026-09-07
support developer instructions on thread start/resume, but not on turn start.
[The app-server reference](https://learn.chatgpt.com/docs/app-server) describes
schema generation. A bundled CLI schema is evidence about that binary, not proof
that the current Desktop connection accepted a request or that a model read it.

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
explicit resume, unchanged user input, and invalid setup rejection. It proves
request construction and runtime handoff, not model consumption, native UI access,
Skill execution, or a real CLI-to-Room message.

For a native claim, retain the exact Desktop build and source head, observe
thread start/resume acceptance, then show the Agent using its supplied tools and
the real consumer receipt. Do not substitute a controlled transport response or
ordinary assistant text for those observations. UI access restrictions still
apply; context work does not authorize a CDP workaround.
