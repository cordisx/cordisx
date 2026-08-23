# Agent Trace Showcase plugin

Status: independent development and validation plugin stacked on the fixed UI
host head. The public event/UI protocol is merged and pinned, and the
fixture-backed Timeline plus structured session-header entry are integrated;
live Agent operations and live event data still wait for a merged Agent host.

## Product goal

Agent Trace Showcase is a session-scoped inspection and injection laboratory
for CordisX. It demonstrates the public DSH-aligned Agent extension contract
and makes every requested contribution visible in a Timeline before or while
the host processes it. It is not the event ledger, a Codex connection adapter,
the Permission Broker, an audit archive, or a replay engine.

The plugin is a separate workspace package under
`packages/agent-trace-showcase`. CordisX core never imports it. The default
CordisX home/setup configuration remains `plugins: []`; the package is enabled
only by an explicit development configuration or the isolated smoke fixture.

## Dependency and ownership boundary

The stacked dependency is the task **CordisX Agent events and Codex
compatibility foundation**, thread
`01a03038-8aa4-7441-83f9-05f88908a47e`. Its merged public protocol and host
head are the only acceptable live-contract source.

The plugin may consume only these public capabilities once they exist:

- Agent `send(message, target, wakeup)` plus the public `followup`, `steer`, and
  `inject` conveniences;
- `agent/pre-step` over complete source-bearing `UserMessage[]` values;
- `ctx.systemPrompt.section` and `ctx.systemPrompt.context`;
- a read-only Session/Agent event-ledger status, page/query, and subscription;
- the host-issued current session identity needed to open a session route;
- Permission Broker results associated with the manifest declarations above.

The plugin must not import a ledger implementation, platform adapter,
permission store, Codex `additionalContext` projection, or any private
renderer/AppHost object. It must not read `electronBridge`, a raw app-server or
CDP client, private adapter stores, DOM session selectors, or Codex router
state. Core source must not import this package.

The ledger `sessionId` is a provider-neutral Agent correlation key, not a
Platform-wide task identity. The Showcase neither relabels it as global task
identity nor constructs provider identity by concatenating raw ids. If a
future multi-provider host adds correlation, the page accepts only a
host-owned reference or an explicit public event field. It does not consume
the provider-session architecture merged through `cordisx#39` at
`4e1f06a605550c3786a7378be8d7bec6aed97a00`; that document remains context,
not a runtime or ledger dependency.

Until that dependency exposes its actual TypeScript declarations, the package
uses one local **consumer test port** implemented by a deterministic typed
fake. The port is not added to the Cordis context, exported as a CordisX public
API, or treated as protocol evidence. A single future adapter will map the
merged core services onto that port; if the real contract differs, the adapter
and fake change together rather than preserving a parallel facade.

The merged protocol baseline pinned by the fixture/provider is
`cordisx-protocol@2ec9ca15234e778853104d1667c7d1c4bffff1d9` from merged
PR #12. Its parent chain retains multi-provider merge `00113dc7` and the Agent
event contract from
`e6155723528a888d1b949a9c56483340874cff27`: `cordisx.agent-events/v1`, the
event/page schemas, optional turn/step/item/message/tool-call/context
projection keys, delivery stages, and the six Agent capabilities. The later
multi-provider protocol does not change this provider-neutral ledger model,
and the plugin consumes no Platform session scope or private provider fields.
Live integration still waits for merged compatible host exports.

The Timeline information architecture was reviewed against the current
upstream DeepSeek Harness Trajectory package at
`deepseek-ai/DeepSeek-Harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
(MIT). This package reuses only the high-level ideas of a compact Overview,
grouped trajectory, filtering, and record inspection. It copies no Trajectory
source, styles, icons, assets, or web runtime and introduces no DSH runtime
dependency.

The structured UI protocol shape is pinned at merged main
`cordisx-protocol@2ec9ca15234e778853104d1667c7d1c4bffff1d9`: catalog v2,
structured surface contribution v2, host-generated invocation context v1, and
generation-fenced `surface.route.navigate`. The package now supplies an exact
`session.header.actions` contribution containing localized label/aria label,
`host:history`, and the plugin command reference. It registers that data only
through the public `ctx.slots.register` service provided by stacked host head
`cordisx@2897c6c3bc230805009572f43e37e99d2ac4a4ee`; the host owns the unique
native seat, icon-only button, tooltip, focus, and no-drag behavior. This host
head is a temporary stack base until its ordinary PR merge commit is
available. The command accepts the immutable host-generated invocation
context from this service and ignores plugin arguments that resemble identity;
the plugin never creates or overrides that context. The Agent capability
identifiers are fixed as
`agent.events.read`, `agent.messages.append`, `agent.steps.reject`,
`agent.messages.transform`, `agent.prompt.section`, and
`agent.prompt.context`.

The host implementation architecture is recorded at unmerged CordisX commit
`23cc45c2118864fc46f1cc57ef5c70c56b5e2f6d` in
`.agents/docs/agent-events.md`. It confirms that append-only pre-step messages
use `agent.messages.append`; `agent.messages.transform` is needed only to
delete, replace, or reorder existing messages, which this Showcase never
does. This architecture head is not treated as a usable runtime dependency
until its implementation is merged and pinned.

The later stacked runtime checkpoint
`cordisx@4e3f7655766061ef51c54995bd3b4b8fd00389ba` confirms the public
TypeScript shape exported through `cordisx/contracts`: typed event envelopes,
status/query/subscribe, `agents.get(sessionId)` with send/followup/steer/inject,
append-only pre-step decisions, and system-prompt section/context disposables.
It is not a package dependency or release pin because it is unmerged and must
still rebase over the provider foundation. The existing store/provider seam
is compatible with that checkpoint, but the real provider is intentionally
not added until the merged host commit is available.

Fixture mode therefore declares no live Agent authority and labels every
operation and event `fixture`. Production/live mode reports `unavailable`
until both facts are supplied by the pinned core contract. It never falls back
to DOM discovery or the existing generic Platform task API.

## Entry and route

The main structured-UI task owns one general session action surface. The
Showcase consumes the merged protocol shape and the fixed stacked host API:

- `session.header.actions` provides an icon-only action in the current
  conversation header, using a host icon token plus command/route activation;
- one plugin-local entry adapter maps the frozen envelope to
  `ctx.slots.register`; it contains no selector, DOM, or renderer code;
- the host command invocation supplies an opaque, generation-fenced
  Agent `sessionKey`; it is distinct from Platform provider identity and is
  used to navigate a route owned by this plugin;
- `/sessions/:sessionId/agent-trace` targets `session.content` and is rejected
  when its parameter is not the active native session.

This consumer branch does not add `session.header.actions` to the catalog,
protocol, or Codex adapter and does not use `workspace.toolbar.items` as a
temporary parallel entry. In fixture mode, the explicit configuration pins
one provider-neutral fixture session id; the host-rendered entry supplies a
fresh immutable invocation context, the command rejects direct/plugin-spoofed
identity and mismatched fixture identity, and the session outlet rejects
navigation when that id is not the active native session.

The host records surface-command and outlet-route/page authorization as v2
access requests carrying its current generation. A pending or unavailable
surface renders no activatable entry and fails closed; block, restore, and
generation disposal invalidate the old button and command before any later
route/outlet policy check. The plugin does not retain or replay invocation
contexts across generations.

The plugin provides only structured action data and commands for native shell
chrome. It never supplies a toolbar DOM node, selector, SVG, tooltip, or event
listener. The host owns the icon-only button, Material/host icon rendering,
hover/focus/tooltip, keyboard semantics, `draggable=false`, and macOS
`no-drag`. The `session.content` outlet preserves the native conversation
title header, sidebar, and right/bottom panels and does not change the app URL
or native router.

## Explicit demo actions

The Timeline page owns six explicit controls:

1. queue `followup` for the next turn with wakeup;
2. queue `steer` for the next step with wakeup;
3. queue `inject` for the next step without wakeup;
4. enable or append a source-bearing `agent/pre-step` contribution;
5. enable or update a named `systemPrompt.section` contribution; and
6. enable or update a named `systemPrompt.context` contribution.

No action runs on plugin activation, page mount, session change, or event
subscription. Every payload visibly identifies the plugin id, version, and
generation. The page shows the Permission Broker result before queue state and
offers cancellation/clear for contributions that the core still reports as
queued or active. Forwarded or otherwise terminal operations are retained as
history and are never described as undoable.

Fixture controls operate only on fixture state. They cannot write to a real
conversation. Live controls remain disabled when the adapter status or
capability is unavailable, partial, ask-pending, or denied. Ask must go through
the host Permission Broker; the plugin does not implement its own grant UI or
persist permission choices.

## Timeline information architecture

The page is a flat session workspace, not a dashboard card inside another
card. Host page chrome provides one title, icon, close/back behavior, and
optional actions. The body begins with a compact integrity/capability strip,
then controls, filters, the event list, and one record-detail pane.

Four lanes follow DSH Trajectory while retaining CordisX-specific evidence:

- **Input** — user and source-bearing plugin messages;
- **Model** — model lifecycle and content observations;
- **Tools** — tool requests, approvals, progress, and results;
- **Injection / Prompt** — Agent send variants, pre-step contributions, and
  system-prompt section/context contributions.

Records group by turn and then step. Each row exposes sequence/time, lane,
type, source truth (`observed`, `cordisx`, or `inferred`), lifecycle phase, and
summary. Detail includes stable event id, session/turn/step/item identity,
causal parent, source, plugin id/version/generation, permission decision,
payload/ref metadata, and diagnostics.

The store view model keeps the normative `type` restricted to the eight
`cordisx.agent-events/v1` event types. A separate `semanticType` such as
`agent.followup` or `tool.result` is display/search projection metadata only;
it is never published as a ninth protocol event type or a Cordis service.

The lifecycle vocabulary includes `requested`, `permission`, `queued`,
`claimed`, `projected`, `forwarded`, `failed`, `expired`, and `cancelled`.
Presence in `projected` or a renderer-visible stream does not prove model
consumption. The UI may say the model consumed content only when the public
event contract provides an explicit proof event.

The minimum viable interaction supports:

- sequence and timestamp ordering;
- text search;
- source-truth, plugin source, lane, type, and phase filters;
- record selection with a detail pane;
- provider ledger pages of at most 500 records, matching the protocol bound,
  and explicit next-page loading (the deterministic fixture uses eight-record
  pages); and
- a rendered-row ceiling of 500 records, after which the oldest loaded page is
  discarded with a visible boundary notice.

High-volume chunks remain references or summaries according to the core
contract. The plugin does not duplicate an unbounded content log.

## Trace, audit, and replay boundary

Timeline is a trace projection for interactive diagnosis. Permission and
operation facts displayed in it remain sourced event data; the page is not a
tamper-proof audit log. Clear removes plugin-owned queued contributions and
fixture rows only where the public contract authorizes it; it does not erase
the core ledger. Replay is absent. Re-running a demo creates a new sourced
request rather than pretending to replay an old event.

The capability strip always states:

- adapter mode: `live`, `fixture`, `partial`, or `unavailable`;
- ledger completeness and retained range;
- whether high-volume payloads are summarized or referenced;
- supported Agent operations and manifest permission state; and
- the core contract version/head when live.

Empty states distinguish no events from unavailable data and partial history.

## Session and generation lifecycle

All registrations and subscriptions belong to the plugin Cordis fiber. Block,
unload, required-capability denial, or generation replacement disposes:

- the session-header contribution and command;
- route and page registration;
- ledger subscriptions and in-flight page queries;
- page event listeners and DOM owned inside the outlet;
- active pre-step and system-prompt contributions;
- queued demo contributions that the core still attributes to that plugin
  generation and permits it to cancel; and
- all fixture timers and state listeners.

The page reads exactly one session id: explicit fixture configuration in the
current stack, and a host-issued Agent key once dynamic invocation is
available. An A-to-B session switch changes the `session.content` context key,
aborts the old mount and query, and never carries selection, filters, queued
contributions, or fixture rows into the new session. Returning to A starts a
fresh page projection from the ledger.

## PR stack and landing rule

1. The UI protocol is merged at `2ec9ca15234e778853104d1667c7d1c4bffff1d9`;
   the fixed UI host stack base is
   `2897c6c3bc230805009572f43e37e99d2ac4a4ee` until its PR merges. That head
   is rebased over provider foundation merge
   `1f2c10df7909c0d4fe0d99189cffbd28f9c33207`, but this provider-neutral
   Agent fixture consumes no Platform session identity or private provider API.
2. This `cordisx` consumer branch lands documentation, the independent package,
   deterministic typed fake, component/model tests, structured header entry,
   and fixture renderer smoke. It must describe live Agent integration as
   unavailable.
3. The core task lands and merges its compatible `cordisx` Agent runtime.
4. Rebase this consumer onto the merged UI and Agent host heads, replace the single fake
   adapter seam with the actual public services, declare the exact manifest
   capabilities, and add core conformance/integration tests.
5. Run the complete host/package/security/renderer validation. Only then open
   or refresh the normal consumer PR.
6. Merge the owning `cordisx` PR after required review and CI. CordisXMono may
   pin the compatible merged host/protocol commits only afterward in its own
   PR; this task does not advance mono while still fixture-only.

## Validation matrix

Package and component coverage:

- manifest id, explicit development-only activation, and `plugins: []`
  default preservation;
- structured session-header contribution conformance, host icon, tooltip/a11y,
  `no-drag`, and no plugin DOM in native shell;
- route/current-session validation, page back/close, and unchanged app URL;
- four lanes, turn/step grouping, time/sequence order, every filter, selection,
  detail projection, pagination, and row ceiling;
- `observed`/`cordisx`/`inferred` distinction and honest
  unavailable/partial/fixture states;
- six explicit demo triggers, no activation-time writes, source/version/
  generation attribution, allow/ask/deny, queue ordering, cancellation, and
  clear;
- followup next-turn+wakeup, steer next-step+wakeup, inject
  next-step+non-wakeup, pre-step append-only source retention, and separate
  system-prompt section/context behavior;
- session A/B isolation, query abort, plugin block/restore, required denial,
  unload, and generation disposal.

Repository gates are `npm run check`, `npm audit --audit-level=high`, and
`git diff --check`. Live integration additionally requires an isolated real
`app://` renderer with the core public adapter available. It must exercise
sidebar collapse/expand and drag-resize, right/bottom panel geometry, session
switch, entry click, route open/back/close, permission allow/ask/deny, each
Agent operation, plugin block/restore, and generation replacement.

Acceptance screenshots include the real current-session header entry and the
Timeline page with native conversation header/sidebar/panel geometry retained.
Fixture screenshots are allowed during the stacked phase but must be labeled
fixture and cannot substitute for final live-injection evidence.
