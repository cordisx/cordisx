# Agent Trace Showcase plugin

Status: independent development and validation plugin based on merged CordisX
host `90e1fcc14984e24f64464d9c8777fa364b886787`, current protocol main
`f25e870ecb0bac285aeb69ddd061815d64511ee3`, Agent protocol
`08dcdc11aae38ea9c0e91e4ad17cf31b8c756747`, and history protocol
`e4c1fea227cb53e3a0833a0c84c5f9f487f107c5`. The fixture Timeline,
structured session-header entry, session outlet, public live ledger projection,
owner/generation-fenced delivery controls, and contribution disposables are
integrated. The Host owns a brokered read-only Codex JSONL importer. Current
Codex connection availability remains an honest runtime fact rather than a
claimed live-forwarding success.

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

The page reads one local **consumer store port**. A deterministic typed fake,
the public `ctx.agentEvents` query/subscription adapter, and the public
`ctx.agentHistory` query/tail adapter implement that
port; it is not added to the Cordis context or exported as a parallel CordisX
API. The live provider projects only public envelopes and never imports the
host ledger, broker, adapter, or private connection implementation.

## Historical Codex session projection

Historical mode consumes `cordisx.agent-history/v1` through the exact
`agent.history.read` capability. JSONL discovery, selected profile resolution,
realpath containment, parsing, sparse indexing, pagination, tailing, rotation,
truncation detection, stable fingerprinting, and redaction all remain in the
Node/Host service. The renderer sends only `sessionId`, opaque cursor, page
limit, and payload policy; it receives no HOME/CODEX_HOME path or arbitrary
file handle.

Imported records use the same `TraceShowcaseStore` and Timeline as fixture and
live records. Each projected event carries one explicit origin:
`live/observed`, `historical/imported`, or `fixture`. Native event/item/message/
tool ids are the first dedupe keys. When those are absent, the Host event id is
a stable opaque fingerprint of profile, source identity, byte offset, and
schema version. The consumer merges by factual identity, prefers a public live
observation over an overlapping imported projection, and orders by recorded
time, origin priority, sequence, and event id. Re-query, restart, tail, and
active-to-archive rotation therefore do not duplicate a row.

Historical projection is deliberately narrower than the live Agent ledger. It
may emit only source-supported session/turn/step/item/message/content/tool/
timing/compaction facts. It cannot emit `message.delivery` or
`input.contribution`, permission decisions, forwarding success, or
model-consumption proof. Unsupported JSONL fields stay absent. Corrupt lines,
oversized lines, partial tails, truncation, source replacement, indexing time
limits, and privacy clamping appear only as structured coverage diagnostics.

The plugin configuration defaults historical pages to 100 records and permits
25–500 in steps of 25; the Host protocol ceiling remains 500. The merged view
defaults to a 500-row window and permits 50–500 in steps of 50. “Load earlier” moves
the historical window using the opaque Host cursor. Incremental tail requests
advance from an opaque snapshot and never rescan already imported rows. A
session or profile switch creates a new provider and disposes the old cursor,
timer, and subscriptions; block, unload, and generation replacement make the
Host caller stale and fail closed.

The Host defaults history payloads to `summarized`. `referenced` shows only
bounded metadata; `inline` is still bounded and redacted. Secret-like values,
raw local paths, tool arguments/results, diffs, instructions, encrypted data,
replacement histories, and unrequested bodies never enter the renderer or
diagnostics. Provider and profile identity remain Host-owned opaque references,
separate from the provider-neutral Agent `sessionId`.

The Agent baseline pinned by the fixture/provider is merged
`cordisx-protocol@08dcdc11aae38ea9c0e91e4ad17cf31b8c756747` from PR #13:
`cordisx.agent-events/v2`, `cordisx.agent-delivery/v1`, stable delivery and
contribution identities, owner/generation-fenced cancellation, and
host-committed `input.contribution` lifecycle. The deterministic UI fixture is
mapped against
`test-vectors/agent-events-v2/valid/control-and-contributions.json`; it does
not copy the mounted protocol repository or publish a substitute schema. The
parent chain retains provider-aware Platform protocol `00113dc7` and Agent v1
`e615572`, while Agent session ids remain provider-neutral. The plugin consumes
no Platform session scope or private provider fields.

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
through the public `ctx.slots.register` service provided by merged host
`cordisx@118fc26269fa04d368fa6bfb4129014b5b011d37`; the host owns the unique
native seat, icon-only button, tooltip, focus, and no-drag behavior. The
command accepts the immutable host-generated invocation
context from this service and ignores plugin arguments that resemble identity;
the plugin never creates or overrides that context. The Agent capability
identifiers are fixed as
`agent.events.read`, `agent.history.read`, `agent.messages.append`, `agent.steps.reject`,
`agent.messages.transform`, `agent.prompt.section`, and
`agent.prompt.context`.

Merged current host `90e1fcc14984e24f64464d9c8777fa364b886787`
exports v2 event envelopes, query/subscription, immutable delivery snapshots,
fenced handles, `clearPending`, pre-step decisions, and prompt disposables
through `cordisx/contracts`; it also exports the read-only history page/tail
service. Live/historical mode declares optional
`agent.events.read`, `agent.history.read`, `agent.messages.append`, `agent.prompt.section`, and
`agent.prompt.context`; it deliberately does not request step rejection or
message transformation. The adapter can honestly remain `unavailable` while
the CordisX-owned ledger and control plane are available, so the page reports
`partial`, records the actual failed terminal path, and never invents Codex
observations. It never falls back to DOM discovery or the generic Platform
task API.

## Entry and route

The main structured-UI task owns one general session action surface. The
Showcase consumes the merged protocol shape and the fixed stacked host API:

- `session.header.actions` provides an icon-only route toggle in the current
  conversation header, using a host icon token plus protocol-v3 toggle data;
- one plugin-local entry adapter maps the frozen envelope to
  `ctx.slots.register`; it contains no selector, DOM, or renderer code;
- the host binds the current, host-issued Agent `sessionKey` to the route's
  `:sessionId`, projects exact route/outlet state as `aria-pressed`, and closes
  the same route on re-activation;
- `/sessions/:sessionId/agent-trace` targets `session.content` and is rejected
  when its parameter is not the active native session.

The package-root `packages/agent-trace-showcase/README.md` is the canonical
product description. The package build copies that exact file to
`dist/README.md`, beside the compiled plugin entry files consumed by the
launcher. The launcher captures the adjacent README in the bundle and the
manager renders that captured value; neither layer synthesizes Agent Trace
product copy or maintains a second README source.

This consumer branch does not add `session.header.actions` to the catalog,
protocol, or Codex adapter and does not use `workspace.toolbar.items` as a
temporary parallel entry. Every mode, including fixture, receives only the
Host-issued active Agent session identity. Configuration cannot override that
identity, and the session outlet rejects navigation when the resolved id is not
the active native session.

The host records surface-route and outlet-route/page authorization as v2
access requests carrying its current generation. A pending or unavailable
surface renders no activatable entry and fails closed; block, restore, and
generation disposal invalidate the old button and route projection before any later
route/outlet policy check. The plugin does not retain or replay invocation
contexts across generations.

The plugin provides only structured route-toggle data for native shell
chrome. It never supplies a toolbar DOM node, selector, SVG, tooltip, or event
listener. The host owns the icon-only button, Material/host icon rendering,
hover/focus/tooltip, keyboard semantics, `draggable=false`, and macOS
`no-drag`. The `session.content` outlet preserves the native conversation
title header, sidebar, and right/bottom panels and does not change the app URL
or native router. Its page-v2 `body-only` policy means the Timeline begins
directly below that native header; CordisX creates no second header, title, or X
row. The same top toggle and Escape remain keyboard-reachable close paths, and
explicit close restores focus to the toggle.

## Explicit demo actions

The Timeline page owns six explicit controls:

1. queue `followup` for the next turn with wakeup;
2. queue `steer` for the next step with wakeup;
3. queue `inject` for the next step without wakeup;
4. enable or append a source-bearing `agent/pre-step` contribution;
5. enable or update a named `systemPrompt.section` contribution; and
6. enable or update a named `systemPrompt.context` contribution.

No action runs on plugin activation, page mount, session change, or event
subscription. The Host stamps every accepted delivery/contribution event with
plugin source, id, version, and generation. The page projects explicit
delivery permission stages and contribution capability/failure facts, and
offers cancellation/clear only for state the public controls still permit.
Forwarded or otherwise terminal operations are retained as history and are
never described as undoable.

Fixture controls operate only on fixture state. They cannot write to a real
conversation. Live controls call only the public Agent APIs after a user
click. Permission allow/ask/deny is resolved by the host Permission Broker;
the plugin implements no grant UI and persists no permission choice. An
unavailable Codex connection does not disable the public control plane: the
Host ledger records the actual `failed` terminal result and the page remains
`partial`. A denied or failed ledger query disables the controls because the
resulting action could not be audited in the page. Prompt and one-shot pre-step
registrations are cleared only through their public disposables; delivery
cancellation and clear use only the fenced handle and `clearPending` result.

## Timeline information architecture

The page is a flat session workspace, not a dashboard card inside another
card. The preserved native session header and its Agent Trace toggle provide
the only top chrome. The body begins with a compact integrity/capability strip,
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

The store view model keeps the normative `type` restricted to the nine
`cordisx.agent-events/v2` event types, including `input.contribution`. A
separate `semanticType` such as
`agent.followup` or `tool.result` is display/search projection metadata only;
it is never published as a ninth protocol event type or a Cordis service.

The lifecycle vocabulary includes delivery stages `requested`, `permission`,
`queued`, `claimed`, `projected`, `forwarded`, `failed`, `expired`, and
`cancelled`, plus contribution stages `registered`, `evaluated`, `projected`,
`forwarded`, `released`, and `failed`.
Presence in `projected` or a renderer-visible stream does not prove model
consumption. The UI may say the model consumed content only when the public
event contract provides an explicit proof event.

The minimum viable interaction supports:

- sequence and timestamp ordering;
- text search;
- source-truth, plugin source, lane, type, and phase filters;
- record selection with a detail pane;
- configurable historical pages of 25–500 records, defaulting to 100 and never
  exceeding the protocol bound, plus explicit next-page loading; and
- a configurable rendered window of 50–500 records, defaulting to 500, after
  which the oldest loaded rows are discarded with a visible boundary notice.

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

## Plugin configuration

The package exports one `@deepseek-ai/schemastery` `Config` and
`configApplies = 'restart'`, using the configuration protocol introduced in
protocol PR #19 and the Host lifecycle merged through Host PR #60 and retained
by the current main. Restart application is required because a mode change
replaces the provider, query/subscription ownership, history cursor/tail timer,
and pending demo ownership; a fresh Cordis fiber disposes the old tuple before
publishing the new one.

The public configuration contains only:

- `mode`: `live` (default), `historical`, or `fixture`;
- `historyPageSize`: default 100, minimum 25, maximum 500, step 25; and
- `timelineWindowSize`: default 500, minimum 50, maximum 500, step 50.

`live` consumes only the public ledger. `historical` selects the brokered
history provider and merges it with live observations. `fixture` selects the
deterministic provider. Session/provider/profile identity, paths, permission
policy, payload/redaction policy, tail cadence, contract heads, diagnostics,
secrets, and internal adapter switches are deliberately absent. They remain
Host decisions and capability-gated runtime facts. The schema carries English
and Simplified Chinese descriptions for the Manager form.

## Session and generation lifecycle

All registrations and subscriptions belong to the plugin Cordis fiber. Block,
unload, required-capability denial, or generation replacement disposes:

- the session-header route-toggle contribution;
- route and page registration;
- ledger subscriptions and in-flight page queries;
- page event listeners and DOM owned inside the outlet;
- active pre-step and system-prompt contributions;
- queued demo contributions that the core still attributes to that plugin
  generation and permits it to cancel; and
- all fixture timers and state listeners.

The page reads exactly one session id: the host-issued Agent key bound to the
route by the Host in every mode. An A-to-B
session switch changes the `session.content` context key,
aborts the old mount and query, and never carries selection, filters, queued
contributions, or fixture rows into the new session. Returning to A starts a
fresh page projection from the ledger.

## PR stack and landing rule

1. Page-v2 body-only chrome and surface-v3 route toggles are merged in protocol
   `8036d7228fdc6ebdba41734c5cc7aa6fc850fc58`; Agent v2 remains its
   orthogonal predecessor `08dcdc11aae38ea9c0e91e4ad17cf31b8c756747`.
2. Merged current host `90e1fcc14984e24f64464d9c8777fa364b886787` supplies the
   structured UI host, v2 Agent delivery/contribution lifecycle, and brokered
   history service. The
   provider-neutral Agent projection consumes no Platform session identity or
   private provider API.
3. This `cordisx` consumer PR lands the independent package, fixture/live/history
   providers, component/integration coverage, structured entry, and
   current-build renderer evidence after complete gates and normal CI.
4. Merge the owning `cordisx` PR after required review and CI. CordisXMono may
   pin the compatible merged host/protocol commits only afterward in its own
   PR; this consumer branch does not advance mono.

## Validation matrix

Package and component coverage:

- manifest id, explicit development-only activation, and `plugins: []`
  default preservation;
- exported Schemastery schema, localized Manager descriptors, bounded defaults
  and ranges, restart application, and absence of identities, paths, policy,
  diagnostics, and secrets from ordinary configuration;
- byte-identical package/build README projection, launcher bundle capture, and
  manager README-tab rendering from the compiled plugin entry;
- structured session-header contribution conformance, host icon, tooltip/a11y,
  `no-drag`, and no plugin DOM in native shell;
- route/current-session validation, page back/close, and unchanged app URL;
- four lanes, turn/step grouping, time/sequence order, every filter, selection,
  detail projection, pagination, and row ceiling;
- `observed`/`cordisx`/`inferred` distinction and honest
  unavailable/partial/fixture states plus explicit live/historical/fixture
  origin;
- real Codex JSONL message/tool/timing/compaction projection, summarized and
  referenced payload policies, corrupt/partial/oversized lines, 500-row page
  bound, opaque earlier cursor, incremental tail, truncation/rotation, stable
  restart identity, and history/live dedupe;
- exact session/profile isolation, permission ask/allow/deny, raw-path/secret
  absence, block/restore, generation disposal, and current-connection
  unavailable with historical/partial coverage;
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
`app://` renderer with the public Agent runtime present; adapter availability
is reported as a tested fact rather than a precondition. It must exercise
sidebar collapse/expand and drag-resize, right/bottom panel geometry, session
switch, entry click, route open/back/close, permission allow/ask/deny, each
Agent operation, plugin block/restore, and generation replacement.

Acceptance screenshots include the real current-session header entry and the
Timeline page with native conversation header/sidebar/panel geometry retained.
Fixture and live/partial captures are labeled separately. An unavailable
adapter capture proves only brokered control plus honest failure/empty state;
it is never presented as successful live forwarding or model consumption.
