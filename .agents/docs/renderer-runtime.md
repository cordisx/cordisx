# Renderer runtime composition

Type: implementation reference for renderer, adapter, and Manager composition.
This page owns the detailed integration constraints moved from the
[architecture overview](architecture.md#renderer-plane). Feature-specific
references linked below own their detailed design; versioned public plugin
contracts remain in `cordisx-protocol`. Scope and availability statements do
not establish release, live verification, or acceptance.

## Renderer plane

The injected bundle creates a new Cordis `Context`, mounts `SlotService` at `ctx.slots`, then mounts each configured plugin as a child fiber. A second injection first disposes the previous host. Plugin startup is fail-loud; already-started fibers unwind in reverse order if a later plugin fails.

The renderer generation also installs one Host-owned React 19 singleton before
plugin factories run. Plugin builds resolve `cordisx/react`, its automatic JSX
runtime subpaths, and `cordisx/ui` to this singleton; a plugin artifact that
contains React, React DOM, or a private React component library is rejected.
`defineReactPage` mounts a React component only in the existing page-v3 body
seat and unmounts it on abort or generation disposal. Manager chrome and
Schemastery configuration remain Host-owned. The public authoring and lifecycle
contract is specified in
[`plugin-react-runtime.md`](plugin-react-runtime.md).

### Bounded plugin visuals

The renderer also mounts one generation-aware `ctx.visuals` registry for
bounded Host visual seats. An exact source owner and local provider id select a
trusted React renderer. The Host passes only detached, deeply frozen opaque
JSON data and its current light/dark theme; it never passes a Context, node,
selector, or action authority. Registrations belong to the calling Cordis
fiber, candidate generations stay hidden until the shared publication flip,
rollback restores last-good visibility, and render errors are contained to an
empty decorative seat. The complete runtime boundary is specified in
[`plugin-visuals.md`](plugin-visuals.md).

### Conversation shell

The production Agent conversation shell is a separate Host-owned renderer
kernel under `renderer/host-ui/conversation`. Its immutable render model is a
private, already-localized projection: it contains only bounded room,
participant, entry, status, action and composer data. The renderer owns the
single top chrome, the only timeline scroll container, message grouping,
exact participant AvatarRef rendering, conditional Host-generated initials,
status announcement, ephemeral draft, fixed composer geometry, focus and
responsive behavior. An explicit participant AvatarRef is rendered on every
incoming Agent message. The legacy `host-initials` presentation controls only
descriptor-less initials in a multi-participant projection. Identity actions
remain gated by an exact AgentDefinition identity presentation rather than a
display-name guess.

The associated command controller preserves the exact owner id,
`agent-desktop` shell, binding id, owner generation, separate snapshot
generation, and a Host-private snapshot-sequence freshness fence. It creates
scope-discriminated Host command contexts; only message scope carries canonical
`itemId`, while composer submit
carries a bounded primitive string. Before execution, the complete request and
all nested binding, reference, command arguments and context data are cloned
and deeply frozen, so caller mutation cannot change the observed command. The
`new-room` selection discriminator directly contains exactly one enabled
`newRoomAction`; its projection contains
no timeline and forbids the separate header-action list. Models contain no callback,
DOM, CSS, media URL, Connector handle or renderer component.

The production adapter preserves the formal v1 compatibility path and consumes
the exact formal `@cordisx/protocol/agent-conversation-shell/v2` export for
Agent identity, active runs, presence, acknowledgement sources and reactions. A plugin injects
`agentConversationShell`, calls `registerSource(factory)`, and gives the
returned Host-owned `mount` to its normal `pages.register` declaration. The
Host invokes the factory only after it has issued an immutable binding for the
current page route; the plugin then supplies only the formal
`snapshot/subscribe/dispose` source. The adapter validates and clones the
complete snapshot, exact binding and generation, accepted subscription
descriptor, replay watermark, serialized cursor, monotonic updates and
terminal disposal before projecting any data. Registration, page unmount,
generation replacement and terminal source updates all release the runtime
handle and source.

For Session-compatible Shell v4 identity actions, the same Host Agent/Session
authority resolves each accepted or recovered `AgentSetup` catalog with the
established AgentDefinition inheritance, prompt, and avatar rules, then retains
the complete exact effective catalog on the owned Session and its current Agent
generation. Shell identity resolution consults this authority alongside the
byte-preserved AgentLoop v4 catalog, so recovered member and message-avatar
actions still open the exact identity detail and Recent tasks retains its agent
label. Owner, Session, connection, or Agent generation replacement removes the
stale live presentation; unresolved identities continue to use the members
search fallback. Active Session navigation consumes only the Host-issued
`AgentDetailReference` carried by the Shell v4 run.

Conversation commands remain normal owner commands registered through
`ctx.commands`. The Host verifies the renderer freshness fence and injects the
formal, deeply frozen `AgentConversationShellCommandContext` as
`CordisXCommandContext.hostContext`; plugins never create that context. This
data-provider service does not add a manifest permission capability: its
Cordis injection name is `agentConversationShell`. The UI Playground may
construct a package-local, debug-only private projection and mount this
production renderer; production renderer and adapter modules never import
Playground fixtures or selectors.

Shell v9 extends that command boundary with three disjoint Host-owned
admission paths. A mounted Room with an exact Session-backed active run receives
the normal immutable v1 `AgentCommandOrigin`; the plugin uses v3 to issue one
opaque target capability per known delivery, reserve its exact Agent handle, and
capture before private driver submission. A mounted Room with no such known
Session-backed target receives a bootstrap origin, but may use v5 only to
declare `{roomId, participantId, memberId, runId}` through
`agentAdmissionBootstrapRoomTargets.issue`. The clone-safe v5 receipt is
retained with the same live binding and its paired reservation captures the
newly acquired exact Agent handle before driver submission; it cannot transfer
across a route or binding replacement. A fresh/no-Room composer, whose handler
creates a Room and then navigates to it, uses v6 only: the plugin declares each
exact `{roomId, participantId, memberId, runId, route:{routeId, param:'roomId',
roomId}}` through `agentAdmissionBootstrapRouteDeclarations.declare`. The Host
returns one opaque continuation per declaration; an accepted submission records
the exact `{sessionId, messageId}` under it. When the matching same-owner Room
route obtains its new Host binding, the Host-only claim atomically moves—not
copies—that source capture to the new binding before navigation resolves or
deferred scenario work can run. Every path binds the full
`PluginOwnerIdentity`, command, binding, connection, execution, Room and exact
target; a plugin-id match alone never spans generations. The old binding is
never retained as live authority. Capabilities, receipts, reservations and
claims are one-shot and fail closed on command completion, target/Room/owner
substitution, unmatched route activation, binding/generation/connection
replacement, revocation, or disposal. The frozen Shell v8 target-origin path
is unchanged and has no bootstrap fallback.

The renderer also owns one fixed-height Room header and one reusable
`HostConversationRightInspector`. The header projects the Room title and
description, members/settings/more actions, and a raw composite of the exact
ordered participant AvatarRefs; it does not infer membership from names or
decorate the composite with another badge surface. Members, settings, more,
and Agent identity content all share the same inspector. At sufficient
container width it is a split pane which compresses the conversation; below
the container breakpoint it is a drawer with a scrim, focus trap, Escape and
outside-close behavior, and exact focus return. Resize and snapshot
replacement preserve the active inspector and focused control. Inspector state
is local presentation state and does not add native-history entries.

The public plugin surface follows DeepSeek Harness: plugins declare injected
services and use `ctx.slots.inject/register` for structured shell data. Both
methods install Cordis effects through the service proxy, so the caller's fiber
owns every registration and update handle. There is no parallel
`ctx.cordisx.contribute()` facade.

## Slot plane

The five feasibility-era direct-DOM slots were removed together. Registrations
now contain only validated actions, navigation items, menu entries, sections,
rows, and update handles. The host owns DOM, styles, keyboard/a11y behavior,
loading/error projection, ordering, overflow, and cleanup.

Complex UI registers a page and route, then mounts only inside a declared
CordisX outlet. `app`, `main`, and `session.content` are initial host adapter
declarations, not a closed union. React anchor disconnection is only a
reconciliation signal: the same `contextKey` migrates the same outlet and page
state, while a changed key aborts/disposes the page. Native React nodes remain
in place, visible, and subscribed. The complete contract and test matrix live
in [`data-contribution-routing.md`](data-contribution-routing.md).

The current Codex session tree may retain a legacy thread drop-target around
the newer main-thread timeline seat. `session.content` treats that nesting as
one semantic region: one identity-matched current timeline seat wins, and the
legacy drop-target is considered only when no current seat exists. Multiple
matching seats at the same priority remain unavailable. This ordering is an
adapter compatibility rule, never a geometry or application-body fallback.

Structured shell surfaces are not page overlays. The private Codex adapter
projects them through minimal host-owned insertion seats in the resolved native
layout. Buttons sit before or after their semantic control, navigation rows
join the native list, and environment rows and sections join the native panel.
If a precise seat is unavailable the contribution remains pending; the adapter
does not fall back to a fixed covering card. Mutation repair may reinsert a
detached seat after React replaces its parent, but plugins never receive that
DOM.

The bounded `composer.reasoning-intensity` and `session.backdrop` surfaces are
the same ownership rule applied to presentation data. The Host alone observes
the native range and renders the control, ambient geometry, transitions,
pointer policy, and cleanup. A plugin may supply ordered semantic materials and
one embedded transparent PNG portrait per backdrop stage; it cannot supply a
selector, network URL, CSS, HTML, or executable renderer. The backdrop retains
the last observed stage only for the same active session and is removed on
session change, contribution withdrawal, or adapter disposal.

### Structured control ownership

`extension-point-control` v1 adds a Host-owned control plane to the existing
`slots.register()` path; it does not add a second full-declaration API. A
plugin may add only a local claim id, mode, priority, and requested safe
bindings. The Host stamps the canonical source/plugin/point/contribution,
launcher principal, legacy order, and generation. Legacy registrations remain
`compose` with `priority = -order`; `replace`, `overlay`, `proxy`, and
`hide-native` default to denied. Exclusive decisions and partial claim grants
are resolved by the Host policy broker before ordered claims, and every command
invocation is rechecked against the current principal, generation, grant,
selection, point state, and allowlisted scalar arguments.

The returned controlled contribution handle exposes only a claim-scoped lease:
a scalar snapshot, invalidation subscription, and Host-brokered command
request. It never contains selectors, nodes, CSS, native callbacks, native
events, or business command results. Claim denial, point-local access denial,
switching, ancestor suppression, generation replacement, and disposal remove
its projected properties and commands and reject invocation. Lifecycle
subscriptions remain attached with a scrubbed state-only snapshot so recovery
is observable; unloading revokes the lease. Adapter effects are separate from
this state machine. For `composer.reasoning-intensity`, replace/legacy rendering
hides and restores the native presentation, overlay retains it, proxy performs
no DOM effect, and hide-native uses a reversible Host visibility lease.

Manager receives a separate read-only diagnostic projection with candidates,
exact claim policy, durable user group choices, current group decisions, and
suppression reason chains. The durable choice drives the selector even while
the point is not mounted; the current decision separately reports runtime
effect. Manager writes call the Host policy broker; plugins cannot submit a
selected winner.
The projection, opaque principal handles, stored policy, and diagnostics are
removed from the public runtime snapshot. Policy storage contains only
principal bindings, exact authorization records, and group choices under a
profile-qualified local-storage key inside the CordisX Chromium profile; it
contains no presenter, selector, native value, or generation metadata. A
missing plugin leaves a dormant policy with no runtime effect, and a later
generation of the same canonical source/plugin/origin reuses its Host principal.

The generic resolver implements and tests transitive parent/subtree
suppression and same-generation restoration. The current production Codex
control catalog binds `composer.reasoning-intensity` and
`composer.toolbar.items`. The toolbar point exposes the exact
`cordisx.composer-submit-celebration/v1` profile through one host-priority,
exclusive `proxy` claim: property `celebrationProfile`, event
`submitActivated`, and commands `presentCelebration` / `dismissCelebration`.
The Host emits a five-second, opaque, single-use activation only for an enabled
native submit activation. It alone owns the pointer-inert full-window confetti
DOM, styles, timer, idempotency, and removal on timeout, unload, replacement,
candidate abort, rollback, or adapter disposal. The plugin receives no native
event, selector, node, stylesheet, timer, or presentation handle. Real-App
evidence for a parent control point still must not be claimed until such a
semantic parent is cataloged and adapted.

The host-neutral surface/outlet vocabulary, current Codex adapter availability,
DeepSeek Harness intent mapping, explicit replacement refusals, contextual
identity boundary, PR order, and validation matrix are maintained in
[`ui-extension-catalog-codex-adapter.md`](ui-extension-catalog-codex-adapter.md).
The catalog distinguishes implemented, experimental, and reserved points;
protocol reservation is never evidence that the current Codex adapter can
project a point.

### Manager extension points and collections

The manager-settings A compatibility pair remains host-neutral:
`manager.settings.tabs` accepts structured tab records and
`manager.settings.content` accepts same-owner routes/pages for controlled body
mounts. These are Manager extension points, not Codex adapter surfaces, and
require no selector or native anchor. The current product IA has no top-level
Settings destination, so both points remain registered and diagnosable but
report current context `not-mounted`; CordisX must not manufacture an empty
Settings page to project them. Their closed versions, point-policy identities,
Host-owned header boundary, and fallback semantics for a Host that does expose
Settings remain specified in
[`manager-settings-tabs.md`](manager-settings-tabs.md).

Catalog v4 adds the distinct B pair
`manager.settings.navigation-items` / `manager.content`. B inserts a
Host-rendered first-level Manager destination across the stable virtual
settings seam and opens a standard Manager page; no visible Host Settings row
is required. Its item contains only a same-owner route. Route v2 supplies
navigation title and description, while page v3 supplies the required Host
icon and standard header title/description/actions. The active destination
falls back to `host:plugins` when it becomes ineligible. A's stable id and
body-only outlet remain unchanged. The Host merge model, routing, lifecycle, configuration planes, file-overlap
audit, delivery order, and validation matrix are described in
[`manager-settings-navigation.md`](manager-settings-navigation.md).

An active authorized `manager.content` page also receives the optional,
page-scoped `managerCollection` registry in its mount context (and therefore
in shared-React page props). The Host creates the collection root as a sibling
of the contributed page body and never exposes that root to the plugin. One
registration supplies only immutable registration/source data; the Host owns
view selection, exact Unicode search and final filtering, rows and visuals,
route activation, menus, text-input and confirmation dialogs, clipboard,
feedback, focus, keyboard, accessibility, and theme. A route change, page
close, owner disposal, or generation replacement aborts pending queries,
unsubscribes, disposes the source exactly once, and removes all Host UI. The
registry is absent from `manager.settings.content`; separate first-level
Manager routes register separate collections rather than sharing private view
state across routes.

Manager content navigation v1 and v2 share one owner-qualified declaration and
route collision domain. V2 alone accepts an optional localized tab label; the
Host projects it into the unchanged projection-v1 tab text, otherwise derives
that text from the target route title. An owner may atomically replace one
mixed-v1/v2 declaration catalog together with its record-title catalog; every
declaration still passes its own exact version validator before the transaction
becomes visible. V1 remains closed and keeps its existing target-page-title
behavior. Tab labels never alter headers, breadcrumbs,
record titles, routing, history, selection, or lifecycle, and do not introduce
a redirect or default-child route.

### Native controls and route history

Native menu contributions use the same boundary: CordisX inserts host-rendered
rows into the opened Codex Help or account menu and never adds an independent
fallback menu trigger. Compact shell actions are icon-only and inherit the
interaction pattern of adjacent native Codex controls. Their host-owned glyph
token reduces only the decorative SVG by four pixels while preserving the
existing wrapper, native button hit box, alignment, tooltip, focus, and
accessible name; the separately sized brand manager trigger and composer
toolbar appearance are excluded.

For `session.header.actions`, the host renders a new button inside its own
`no-drag` seat before the complete adjacent native control wrapper. A native
TooltipTrigger may use a `display: contents` wrapper; CordisX anchors beside
that wrapper and never inserts into it, delegates activation to it, or reuses
its tooltip. The CordisX tooltip is a body portal owned and disposed by the
current renderer generation. The same public host control boundary marks the
seat, icon button, and every rendered descendant as Electron `no-drag`; this is
shared by title-bar/header structured controls rather than implemented by an
Agent Trace selector or plugin listener. Native drag space stays outside the
seat, and the host verifies the button remains the pointer hit-test target.

Toolbar button state and spacing are also Host-owned. The renderer does not
copy a native reference button's `className`: Codex may add unconditional
pressed background/foreground utilities to that node, and copying the class
would project one native toggle's state onto every CordisX sibling. CordisX
uses a stable 28-pixel toolbar variant and projects idle, hover, focus-visible,
open, disabled, and route-toggle pressed states on each generated button. Only
an exact presented route produces `aria-pressed="true"` and the pressed style.
The Host-owned pressed semantic token uses the current theme text color at five
percent, with a ten-percent hover/open layer, primary foreground, the existing
focus ring, and 40-percent disabled opacity. It is scoped to the exact
generated button state rather than its toolbar seat, so no sibling or native
control is activated with it.
The independent `--cordisx-toolbar-action-gap` and
`--cordisx-toolbar-outer-group-gap` tokens are both verified as six pixels for
the current host: the first separates actions inside the CordisX seat and the
second separates the seat from the adjacent native summary toggle. Workspace
slot sizing continues to add only measured contribution widths to the native
minimum; it must not add `roots.length * gap`, so the verified two-root slot
remains 126 pixels and retains the native `ms-auto` alignment.

Route-backed controls may opt into protocol-v3 `toggle` behavior. The host
binds contextual session parameters, compares the exact owner-qualified route
and parameters with current outlet state, and projects `aria-pressed`; plugins
do not keep a parallel open boolean. Re-activation, Escape, policy close,
session change, plugin block, and generation disposal all converge on the same
outlet lifecycle. An explicit close restores focus to the still-connected
host-rendered trigger when practical.

Plugin routes use Codex's current React Router MemoryHistory as their only
back/forward authority. Executable inspection of Desktop 26.818.61809 shows
that `window.history` remains length 1 with null state while the native title
bar can still go back. The private adapter therefore discovers the existing
React Router Context navigator from the live React root and requires its
`index`, `location.key`, `push`, `replace`, and `go` seam. It wraps those three
mutation methods reversibly so native PUSH/REPLACE/POP can be
reverse-projected, but never calls the navigator's single-listener `listen`
method or replaces React Router's listener. A failed probe makes route
navigation unavailable; it never activates a CordisX memory-history fallback.
A successful `ctx.routes.navigate()` validates the complete
owner/permission/params/page/outlet/session tuple, preserves Codex's native
pathname and state, then adds a closed namespaced route projection while
advancing that same MemoryHistory. Consequently native title-bar buttons,
keyboard shortcuts, trackpad gestures, page-chrome Back/close, and plugin jumps
all traverse one history. Same route ids with different params are distinct
entries.

Initial injection and reload restore only the current validated projection. A
single browser-history record stores that current reload checkpoint, bound to
the native pathname/search/hash; it is replaced or cleared after every Codex
navigator transition and is never a back/forward stack.
Same-id plugin generation replacement rebinds that entry without adding or
replacing history; an invalidated, blocked, or uninstalled current route is
removed with REPLACE at the same index. A non-current stale entry cannot be
rewritten until native navigation reaches it, at which point validation either
mounts it or replaces its invalid projection. CordisX never queries or clicks
the native controls and never patches an installed application file.

### Sidebar and recovered task projections

Sidebar Room history uses the Host public structured-collection lifecycle, not
plugin DOM and not Playground task fixtures. A plugin registers one
`sidebar.navigation.items` collection source with a localized group label and
an atomically replaced, monotonically revised list of route-only descriptors.
The source orders its Room descriptors latest-first; the Host clones and
freezes each replacement, validates bounded ids/text/icons/routes, renders the
group heading and rows with the shared SidebarItem primitive, and derives the
single selected row from the exact owner-qualified route plus parameters.

The Playground unified Recent tasks list uses the same Host SidebarItem
primitive and keeps a task/history semantic icon. Agent identity Avatars belong
to conversation participant surfaces, not to generic task navigation. A future
per-Room composite leading visual must come from an exact row-scoped collection
contract; the Host must not infer it from the current Room selection or title.

Playground Agent/Session runs enter that same Recent tasks and Simulator detail
surface through a Host-private read projection of the single Agent/Session
authority. The task key and details route are the exact `SessionId`; every
conversation, tool, approval, and lifecycle row retains its originating
`SessionEvent` and sequence. Live status comes from the current Agent generation,
while recovered status is derived only from the persisted event terminal. The
projection is merged additively beside the byte-preserved AgentLoop Simulator,
but is never written to the browser task-snapshot registry: restart recovery
comes exclusively from the launcher-owned Playground SessionEvent store. This
prevents Recent tasks from becoming a second execution or causation ledger.

AgentLoop v2 commands are accepted only when the Host can provide the formal
owner/provider durable-ledger semantics. The explicit Playground mock uses
session-scoped persistence for disposable simulator state. A real/local-cli
renderer without the launcher-owned durable RPC fails v2 create/send closed as
`reconciliation-required`; it must not advertise an accepted operation backed
only by renderer memory or localStorage. Real provider task recovery across a
Host restart remains unavailable until the launcher-owned, generation-fenced
ledger and provider reconciliation service is delivered.

Collection subscriptions are owned by the calling Cordis fiber. Plugin block,
generation replacement, registration disposal, or runtime teardown
unsubscribes the source, removes the whole group in one published surface
epoch, and rejects late or same-revision mutation. The collection is a
projection rather than a Host Room database: after reload, the plugin or its
provider must restore the complete source snapshot before registration. This
Host-specific navigation lifecycle does not extend the room-neutral
Conversation Shell Protocol.

### Outlet geometry

Page-v2 `body-only` is a general structured chrome policy with a host outlet
gate. The current adapter accepts it only for `session.content`, whose overlay
begins below the retained native session header. The host does not create a
CordisX header/title/close row in that mode; `app` and `main` reject it because
they cover native chrome. No plugin can supply substitute header DOM, CSS, or a
selector.

Route and page outlets remain independent overlays. `app` paints through the
native title-bar and supplies its own draggable chrome with a macOS
traffic-light safe inset; `main` paints the entire region to the right of the
sidebar from `y=0` through a body-level portal and supplies draggable chrome
there. The portal avoids being trapped below the native main-toolbar stacking
context while its geometry still follows sidebar collapse and width changes.
Interactive controls are always explicit `no-drag` regions. This keeps native
window dragging and ordinary page controls from competing for the same
hit-test region.

Both chrome variants are the same host-owned structured projection. Plugins
declare only validated title/icon/breadcrumb/tab/action data, and header
actions reference commands that the host dispatches after checking the active
outlet policy. Plugins receive a body mount container, never a header seat,
node, component, or render callback. Covering the native header therefore
changes geometry only; it does not transfer shell rendering authority to the
plugin.

The host may improve selectors without requiring plugin changes. Plugins that query Codex DOM directly opt out of that compatibility boundary.

## Host-owned form plane

Host-owned configuration, import, Marketplace, permission, Provider, and
Channel forms share the scoped primitive, theme, validation, and state model in
[`host-form-system.md`](host-form-system.md). Plugins still provide structured
schema data and bounded custom field content only; they never receive a UI
library instance, form root, selector, CSS, or portal authority.

The Host bundles a reproducible subset of the official
`tdesign-web-components@1.2.10` Web Components implementation. It imports only
the supported controls, keeps component CSS in their open Shadow roots, scopes
base tokens to `.cxf-scope`, and attaches dropdowns to a CordisX-owned Shadow
portal. The full npm graph and global stylesheet are not installed. A thin
Host adapter supplies the missing accessibility/theme seams without a React
root or second schema registry. This is an implementation boundary, not a new
plugin contract.

## Built-in manager plane

The built-in Manager implementation uses a Host-owned React 19 component tree.
React owns rendering and local interaction state only; Cordis remains the
runtime and plugin lifecycle authority. Manager components consume immutable
Host snapshots and brokered Host actions through an external store. They do
not expose React, DOM nodes, portals, CSS, or UI-library instances to plugins.

The implementation is split by responsibility:

- `renderer/host-ui` contains reusable Host primitives and interaction hooks;
- `renderer/manager/model` adapts runtime snapshots and actions into a React
  external store;
- `renderer/manager/components` contains Manager shell and feature panels;
- `renderer/manager/hooks` contains Host lifecycle, theme, focus, and scrolling
  policies; and
- `playground` composes the development host but owns no Manager behavior.

The previous imperative Manager is a migration seam only. New behavior must be
implemented in the component/store layers rather than appended to that file,
and each migrated feature removes the corresponding imperative ownership.
There is one React root per renderer generation and it is unmounted before the
generation's Cordis resources are disposed.

The local plugin manager is host chrome, not a plugin contribution and not a
new public slot. Its trigger is mounted beside Codex's workspace switcher by a
private adapter probe, and a mutation observer remounts it when the host React
tree replaces that row. The manager and every listener, observer, and DOM node
it creates are disposed with the CordisX renderer generation.

The manager reads a runtime-owned snapshot rather than scraping plugin UI. The
snapshot joins three internal sources:

- build metadata supplies the CordisX package version;
- the runtime tracks each bundled plugin module, Cordis fiber, configuration,
  and active or blocked state;
- the structured registries attribute commands, surfaces, routes, pages, and
  outlets to the calling plugin fiber and report validation, context, and mount
  state.

For already-bundled trusted modules, blocking a plugin disposes only that
plugin's Cordis fiber, which reverses its
slot registrations and effects. Restoring it creates a fresh fiber from the
already bundled trusted module. The blocked-id set may be retained in renderer
storage for the current Chromium profile, but this is activation state rather
than package removal: module top-level code is already in the trusted bundle,
and the manager does not edit `cordisx.config.json`, install packages, enforce
permissions, or create a security boundary.

Installed dynamic packages use the distinct launcher-owned profile activation
record described in [dynamic plugin lifecycle](dynamic-plugin-lifecycle.md),
rather than treating renderer-local block state as package enable/disable. It keeps
explicit reload as an owning-fiber operation and uses plugin generations only
for code, entry, version, or dependency changes. The manager remains a brokered
projection and never receives filesystem or arbitrary module-loading authority.

The manager has five non-spoofable Host primary navigation views:

1. searchable installed-plugin inventory and local runtime controls;
2. semantic extension points with attributed plugin use and enforced policy;
3. routes/pages as a separate associated-resource inventory;
4. marketplace discovery from validated feeds; and
5. product identity, version, and verified external support links on About.

Eligible `manager.settings.navigation-items` records may join only on the two
sides of the virtual settings seam. They are independent plugin pages rather
than fixed Host views. Host core order and bottom-anchored About cannot be
overridden.

Manager-owned content follows one semantic context at a time: a title,
breadcrumb, or selected tab is not restated by body headings or redundant
cards. The reusable hierarchy, flat-list/card, exceptional-state,
accessibility, and visual-regression rules are normative in
[`manager-content-design.md`](manager-content-design.md).

Plugin inventory is a list page rather than a permanent list/detail split.
Selecting a plugin opens a second-level detail page inside the manager; its
header provides an icon-only back action and the breadcrumb `插件 / <name>`.
Every manager header reserves one fixed-size leading slot: a primary page puts
its page glyph in that slot, while a second- or third-level page replaces the
glyph with the back action. Both controls share the same geometry, so changing
levels never moves the title horizontally. The back action has an accessible
name without visible text. Returning preserves the list search query. The same
list-to-detail navigation pattern is used by marketplace discovery so dense
details do not crowd catalog results.

Installed plugin detail is local tab navigation inside that second-level page,
not another semantic extension point. Its default `README` tab renders the
plugin's adjacent `README.md`; `配置管理` shows the configuration available to
the current bundle; `运行状态` owns activation state, injected services,
failures and block/restore actions; `扩展点位` lists only attributed surface or
outlet use; and `路由` separately owns routes, pages, and their outlet
associations. Runtime status does not repeat route/page inventory. The launcher
reads the adjacent README while
composing the browser bundle so the renderer does not gain filesystem access.
The manager renders a deliberately limited Markdown subset by creating DOM
nodes and text nodes only: raw HTML is never interpreted, and remote media or
script execution is not supported. A missing README produces an explicit empty
state rather than synthesized package documentation.

Marketplace discovery adds a searchable catalog assembled from validated
feeds with a two-tab `概览` / `作者与来源` detail. Source management belongs to
the Plugin Store workflow rather than a general Manager Settings category.
The current IA removes the top-level `配置` destination and its empty
`运行状态` / `启动器` placeholders. The former settings-content extension
points remain registered compatibility identities with current context
`not-mounted`; the Host does not render a shell solely for them. Feed
aggregation keys
plugins by canonical `(source, id)` identity; the first configured feed wins a
duplicate. Source settings and blocked plugin ids are separate profile-local
state. Catalog entries can link to authors, their public source, optional
homepage, manifest/icon, and feed provenance, but cannot install or activate
code in this stage. External navigation first hides the manager modal and then
uses the browser's uncancelled `_blank` navigation with `noopener noreferrer`.

The primary manager navigation keeps Host `插件`, `扩展点`, `路由`, and
`插件商店` as separate top-level contexts. Eligible B entries are grouped on
the two sides of the stable virtual settings seam; there is no rendered
`配置` row. About remains anchored last. Searchable browse pages omit aggregate
result and usage counts. The content viewport is the single vertical scroll
owner and restores query/scroll state after a detail back action.

Configuration has two distinct application planes. CLI-resolved executable,
debug port, profile, launch environment, and other process-start values are
frozen for the current process and are not Manager global settings. Runtime
configuration stays in the owning plugin detail beside permissions and
declares `live`, `plugin-restart`, `service-restart`, or `app-restart`.
CLIProxy owns Provider configuration. A staged app-restart value does not
mutate the current fiber or watchers; service-restart requires an owning
launcher handler and is not downgraded to a plugin restart. Removing Manager
placeholders does not remove CLI parsing, launcher stores, or diagnostics.

The normal CordisX Home document and an explicit Playground launcher
composition are also separate storage envelopes. They share the same
owner/profile/generation-scoped plugin candidate ledger and revision CAS, but
each read-modify-write uses its own parser. A Playground Manager save replaces
only the selected plugin profile state inside the validated launcher document;
launcher fields such as `codex` and unconsumed forward-compatible fields remain
unchanged. The Host never normalizes that launcher document through the Home
schema, and both stores retain the same lock, no-follow read, atomic rename,
file-mode, candidate ownership, commit, and abort fences. A disposable
Playground home continues to receive a fresh fixture, while an explicitly
selected stable home materializes each launcher and Home document only when it
is absent. Existing documents are adopted only after their respective formal
parsers accept them and are never replaced from a changed source fixture;
malformed or incompatible documents fail startup without rewriting either
file. This startup path is distinct from the explicit preview-reset authority,
which remains the only operation that intentionally restores the fixture.
After a successful Playground commit, the owning session publishes one
effective-composition change for each advancing plugin revision. The Vite
server invalidates only its cached virtual composition, so a reload rebuilds
from that committed ledger; commit publication, composition rebuild, reset,
and disposal are serialized so the next generation cannot hydrate an
intermediate document. Abort, conflict, rejected, and stale-generation requests
never publish a change.

Codex's `app://` renderer rejects direct arbitrary network reads, including the
official raw GitHub feed. The launcher therefore owns a narrow, private CDP
binding for marketplace JSON retrieval. It accepts only configured public
HTTPS URLs, resolves and rejects non-public network addresses, follows a small
number of individually revalidated HTTPS redirects, applies timeout/response
size/concurrency limits, and returns text to the manager for protocol
validation. The binding is reserved host infrastructure rather than a plugin
API and catalog code is never evaluated. This reserved name is not capability
enforcement: plugins are still trusted renderer code and can inspect globals,
so the public-HTTPS, address, redirect, concurrency, timeout, and size limits
are damage-reduction boundaries rather than isolation from a malicious bundled
plugin.

### Marketplace trust and Host DOM isolation

That renderer bridge and the renderer Marketplace model are display-only trust
projections. They are not permission or lifecycle authorities because a bundled
plugin shares the renderer realm and may mutate `localStorage`, bridge/global
objects, or primordials before Manager initialization. Exact Certified
eligibility is instead evaluated by
`launcher/marketplace-certified-authority.ts`. It loads at most eight enabled
roots from Host-owned home config, fetches and parses feeds in the Launcher
realm with bounded public-HTTPS requests, and exposes only strict
`source + pluginId + version + sha256 integrity` lookup plus revision-only
subscription. Official identity never enters this API.

The authority persists the last valid feed body/digest, a non-decreasing
`generatedAt` fence, equal-revision divergence state, projection revision, and
local expiry under the selected profile in
`CORDISX_HOME/state/marketplace-certified`. State is private, bounded,
symlink-rejecting, and atomically replaced. A source disable/removal clears its
projection while retaining the rollback fence; a newer revocation replaces an
older active feed; an older replay cannot restore it; and an active
certification disappears at `expiresAt` even without network activity. A
successful malformed or identity-mismatched feed fails closed. Transport
failure may retain only a still-unexpired last-good projection. No renderer RPC
can submit roots, feed bodies, Official/Certified assertions, projections, or
attestations to this authority. PermissionBroker and PackageLifecycleAuthority
must re-read the private exact lookup at plan/apply and treat absence or any
fingerprint/revision change as revocation.

The production Launcher-to-Broker handoff does not reuse the display-side
Marketplace model. A random future-document take key is emitted only in the
new-document bootstrap. CDP atomically takes one endpoint and keeps its
RemoteObject in the debugger; the renderer receives no projection-setting
global or reusable credential. Every authority notification and bounded
heartbeat performs a fresh Launcher snapshot read, then delivers an exact
profile/runtime/document-epoch envelope with monotonic sequence and revision.
Context destruction, target replacement, timeout, replay, equivocation,
delivery failure, or endpoint close clears Certified eligibility in the same
PermissionBroker. The current already-running document remains fail-closed.

Manifest-v5 artifacts declaring `ui.host-dom.read` or
`ui.host-dom.modify` use a separate production execution path. Bundle and CDP
carry their source only as data; the renderer creates an opaque-origin sandbox
iframe which owns a locked-down classic Blob worker. The worker receives a
frozen serialized `{ hostDom, onDispose }` facade and JSON configuration, not
Cordis context, DOM objects, selectors, raw bridges, or ambient renderer
globals. The Host captures native DOM/MessagePort primitives before plugin
activation, binds every RPC envelope to a per-boundary random token, and keeps
the real `BoundHostDomClient` in the Host renderer. Worker readiness is the
availability signal; dispose, disable, uninstall, generation replacement, or
Broker invalidation terminates the transport and rolls back owned DOM effects.
This narrow boundary does not relabel legacy structured/local-development
plugins as sandboxed code.

Manifest metadata, dependency graphs, compatibility declarations, immutable
local packages, and activation transactions are described in
[`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md). General-purpose
untrusted execution isolation for legacy structured plugins remains a later
stage; the Host DOM worker is deliberately capability-specific.
