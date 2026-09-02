# Host-bound AgentLoop

## Status and boundary

The renderer Host implements an experimental, plugin-facing `ctx.agentLoop`
service against the formal `@cordisx/protocol/agent-loop/v1` contract. The
Protocol remains room-neutral and data-only. Chatroom owns its room data and
structured state/commands; the Host owns the conversation UI, Agent task
identity, provider routing, permission decisions, prompt projection, proactive
event delivery, and cleanup.

This slice targets the internal text path only. It does not add an external
channel, a general security system, a Chatroom store, or plugin-owned Host UI.
An `image-ref` remains opaque. Until a controlled Host resolver exists, sending
one returns typed `unsupported`; it is never converted to a URL, path, base64
payload, or raw provider value.

## Runtime flow

Each live plugin fiber receives one principal-bound `BoundAgentLoopClient` at
`ctx.agentLoop`. The client exposes only `createOrBind`, `send`, `subscribe`,
and `dispose`.

`createOrBind` validates the self-contained AgentDefinition catalog, rejects
missing, cyclic, duplicate, self-referential, or unreachable definitions, and
resolves ordered parents before applying the leaf's field inheritance modes.
Prompt sections include introduction, personality, and memory. The effective
definition is projected into provider task creation and its prompt sections are
registered through the same Host prompt runtime behind `ctx.systemPrompt`.
Avatar resolution follows the formal Agent Avatar v1 contract: an explicit
child ref wins, `inherit.avatar=inherit` may select the last non-generated
parent ref, and generated parent identities never leak into a child. All other
definitions receive the stable canonical child-identity generated ref.

Every `target.mode=create` call creates a new task and binding, even when the
same plugin owner and immutable AgentDefinition identity are used repeatedly.
Here, "call" means a new `commandId`: retries of the same canonical command are
single-flight and return the cached result without repeating task creation or
turn submission. Reusing a `commandId` with a different command is rejected as
`unsupported`.
One bound client may concurrently manage multiple definitions, tasks, bindings,
and subscriptions. Only `target.mode=bind` may reuse an active binding for its
explicit opaque task. Host task handles are random opaque values backed by a
private generation-local session map; serialized bindings are correlation data
and never authorize access.

`send` reuses `turns.submit`, so accepted text wakes the bound task. The Host
then projects the existing Provider Fleet lifecycle ledger into ordered
AgentLoop pages:

- user and assistant text messages;
- observed approval pending and resolved states;
- binding created/bound/closed and turn started/completed/failed lifecycle.

Each subscription installs its live listener after a fixed replay snapshot and
maintains its own cursor. Event delivery is pull-based and limited to 64 events
per page, so a slow consumer does not accumulate a separate unbounded page
queue; `hasMore` directs immediate draining. Subscription descriptors, pages,
and every projected message, approval, and lifecycle event carry the exact
binding identity. They are fenced by binding generation, plugin owner,
unsubscribe, fiber disposal, and runtime disposal.

The Host does not define or retain Room, member, leader, or consumer run-list
state, and it does not aggregate a Room timeline. A consumer may map one opaque
task binding to its own run record and use an event's optional `turn` only to
correlate one submitted turn. That mapping remains consumer-owned.

## Existing authority reused

The client never accepts caller identity, grants, policy, provider adapters, or
native handles. Calls are authorized by the existing `PermissionBroker` using
`tasks.create`, `tasks.content.read`, and `turns.submit`. Existing denied,
undeclared, out-of-scope, timeout, adapter-unavailable, and task-unavailable
outcomes are mapped to the Protocol's typed denied/unavailable states. Approval
events are observations only and never grant authority.

Provider task creation and lifecycle reads use a token-bound launcher-private
RPC. Public `ctx.platform` remains unchanged and does not accept effective
prompt instructions or expose the lifecycle transport.

An internal local runtime is opt-in through
`codex.agentLoopBackend: "local-cli"`. The Host launches `codex app-server
--stdio` against the existing authenticated `CODEX_HOME`, registers the public
provider identity `codex-local`, and keeps the App Server's `openai` source
provider id private. Real agent-message delta notifications are accumulated per
exact task/turn/item and emitted only as sanitized assistant text on the
matching completed turn. Server-side command/file approval requests are
observed as pending then resolved-denied and answered `decline`; the local task
default itself is `approvalPolicy=never` with a read-only sandbox. No raw frame,
credential, process handle, or approval callback crosses into the renderer.

The UI Playground also accepts the explicit debug-only
`codex.agentLoopBackend: "mock"` value. It selects a deterministic in-memory
Host behind the same `ctx.agentLoop` broker; it does not register a provider,
start a model, App Server, Codex task, external process, network request, or
login flow. Create/bind/send/subscribe/dispose, command idempotency, binding
fences, cursors, assistant/approval/lifecycle projection, and `image-ref`
unsupported behavior remain the normal AgentLoop implementation. Only the
Host-private backend changes.

The Simulator records a redacted, debug-only trace of the exact create input,
ordered definition catalog, resolved inheritance layers, effective prompt,
structured deterministic CLI invocation, result, and lifecycle. A distinct
Playground Host task list opens those traces. It never places prompt or trace
data in Chatroom, a plugin snapshot, the public runtime snapshot, the native
Agent ledger, or `agent-trace-showcase`. The debug namespace is
`debug:agent-loop/mock/v1`; it is not a Protocol or durable CLI contract.
Each Simulator task receives its canonical
`detailsUrl: { url: "app:…", target: "host" }` when it is created. Rebinding
the same private task preserves that URL; closed trace history keeps it while
the active list drops the run. Playground navigation consumes the snapshotted
URL through Host browser history. The plugin does not resolve, cache, or build
task URLs.

## Consumer sequence

An internal Chatroom plugin:

1. declares the existing task create/read/turn submit capabilities;
2. injects `agentLoop` and submits a complete AgentDefinition catalog;
3. retains every returned active `AgentLoopTaskBinding` as opaque correlation
   state in its own domain model;
4. subscribes to each binding from `-1` (or that binding's last processed
   sequence), then fans one consumer-selected message out as separate sends
   with stable per-command IDs and each exact saved binding;
5. maps each exact-binding message, approval, and lifecycle event into its own
   data/UI;
6. unsubscribes and disposes with its fiber.

Chatroom must not infer provider sessions from `binding.task`, move room,
member, run-list, leader, recipient selection, mention, organization tree, or
Channel scope into AgentLoop, or provide conversation DOM.

## Host-owned Agent avatar rendering

Conversation participants may carry only the closed Protocol `AgentAvatarRef`
union. The shell validates and clones it before it enters the immutable Host
model. URL, path, `data:`, `blob:`, `file:`, and base64-shaped values are
rejected at this boundary; no ref value is written into DOM attributes.

The Host resolves generated refs into validated, deeply frozen deterministic
OneWorks Avatar definitions and stores only those successful results in a
256-entry LRU keyed by algorithm, version, canonical seed, and the generated
ref's explicit no-revision sentinel (generated v1 has no revision field). Asset,
definition, and platform refs are not cached; they remain opaque until the
matching Host-owned broker exists and therefore render typed deterministic
initials fallback. A missing ref, resolver failure, component exception, or
renderer error uses the same fallback without changing the conversation model.

The renderer is decorative (`aria-hidden` and inert) because the adjacent Host
author label already provides the accessible identity. Server rendering and
the first client render use initials; an effect reads the explicit projected
Host light/dark theme before mounting the non-interactive, non-autoplay vendor
renderer. The Host consumes the pinned vendor CSS text and injects its scoped
Avatar rules once per document under a versioned style marker. Host layout uses
Host tokens, and reduced-motion disables descendant animation and transition.
Plugins do not supply components, raw assets, CSS, URLs, paths, or base64
payloads.
