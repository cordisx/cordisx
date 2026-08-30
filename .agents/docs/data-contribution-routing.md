# Structured contributions, routing, pages, and outlets

Status: approved architecture and implementation plan. This document does not,
by itself, claim that the described runtime is implemented or sandboxed.

## Outcome and invariants

CordisX will replace its experimental direct-DOM shell slots with a data-first
contribution system. Plugins declare intent; the CordisX host owns native-shell
DOM, rendering, styles, keyboard interaction, accessibility, sorting, overflow,
menus, asynchronous command state, and error presentation.

The invariants are:

1. A plugin never receives a native-shell container or Codex DOM node.
2. Every shell action references a command id. The executable handler exists in
   the command registry rather than in the contribution descriptor.
3. A primary activation executes its command when present; otherwise it opens
   its referenced route. A descriptor with neither is invalid and remains
   visible only as a manager diagnostic.
4. Icons are host token ids. Arbitrary HTML, SVG, URLs, and plugin CSS are not
   accepted by shell renderers.
5. Complex DOM or framework UI mounts only inside a CordisX-owned page outlet.
6. Route, page, and outlet are independent registries joined by validated ids.
7. No CordisX overlay replaces, reparents, removes, hides, or takes ownership of
   a Codex React node. The private Host adapter projects validated CordisX routes
   into Codex's existing React Router MemoryHistory; plugins never receive the
   navigator, history object, native controls, or DOM.
8. Every registration, observer, page mount, and command execution is fenced by
   the owning plugin fiber and renderer generation.
9. Host-rendered text is retained as `LocalizedText`/message references in the
   ledger and resolved only during host projection.

## Public runtime shape

The public runtime keeps the DSH-style service model and does not introduce a
parallel `ctx.cordisx.contribute()` facade:

- `ctx.commands.register()` registers executable command handlers and command
  metadata;
- `ctx.slots.inject()` waits for a host-declared structured surface and
  `ctx.slots.register()` contributes a typed data descriptor;
- `ctx.routes.register()` registers a serializable route descriptor and exposes
  id-based navigation, back, and close operations;
- `ctx.pages.register()` registers a controlled page mount callback for a page
  id.

Page mount props receive `localeNamespace`, a framework-injected typed `t` seat,
and reactive locale bindings from the i18n v1 kernel.

The runtime returns fiber-owned, idempotent handles. Structured contributions
whose values change at runtime receive an `update(snapshot)` handle. Updates
replace a validated immutable snapshot; they never expose the host renderer or
its DOM. Calling the disposer or unloading the plugin invalidates the update
handle.

Command, contribution, route, and page ids are globally unique after owner
qualification. A plugin may use a local id and the runtime qualifies it with
the owning plugin id. Cross-owner references require an already-qualified
public id; dangling and ownership-invalid references are diagnosed and do not
render or navigate.

## Protocol-owned and host-owned boundaries

`cordisx-protocol` owns implementation-independent, versioned material:

- command references and activation descriptors;
- host icon-token ids without icon payloads;
- structured surface descriptors and immutable update snapshots;
- route descriptors, path patterns, parameter references, page ids, and outlet
  ids;
- outlet declaration metadata and the rule that only a host/adapter may declare
  a DOM-touching outlet;
- extensible `LocalizedText`/message references for every host-rendered title,
  label, description, tab, menu, and configuration string;
- identifier, uniqueness, sorting, conflict, `when`, disabled, downgrade, and
  invalid-contribution behavior;
- route/path/outlet compatibility rules and deterministic conformance vectors;
- lifecycle language for owner disposal and semantic-context changes.

`cordisx` owns public trusted-local runtime bindings that cannot be serialized:

- command handler functions and execution context;
- page mount callbacks, `AbortSignal`, disposer, route params, and host
  navigation handles;
- TypeScript `CommandMap`, `SurfaceMap`, and extensible `OutletMap` module
  augmentation;
- the i18n v1 kernel, fiber-owned dictionary registration, ICU projection,
  typed translator seats, and page-prop reactive bindings;
- the update-handle implementation and manager snapshot types.

The `cordisx` private adapter/runtime owns all Codex-specific behavior:

- DOM probes, semantic anchors, native-session matching, and `contextKey`;
- outlet declaration and runtime schema validation;
- host icon-token implementation and structured DOM renderers;
- native-layout insertion seats for structured surfaces, plus route/page
  absolute overlays, body portal fallback, `ResizeObserver`, geometry, z-index,
  mutation signals, and anchor repair;
- command loading/error UI, overflow/menu mechanics, focus, keyboard, and
  accessibility behavior;
- projection of retained message references through the injected localization
  kernel and rerendering when its snapshot version changes.

Protocol schemas never contain a Codex selector, DOM class, React concept, or
renderer-version assumption.

## Localization kernel v1

Structured UI cannot freeze already translated strings without blocking the
i18n workstream. Version 1 therefore models every host-rendered text as a
`LocalizedText` message reference containing an optional namespace, key,
serializable params, and optional fallback. The contribution ledger stores the
reference unchanged. When `namespace` is absent, the registering owner id is
the default namespace.

The host runtime integrates a `LocalizationKernel` contract:

- `getSnapshot()` returns at least the current locale and a monotonically
  changing projection version;
- `resolve(owner, message)` returns rendered text plus missing-dictionary/key
  diagnostics;
- `subscribe(listener)` invalidates host projections when locale or dictionary
  state changes.

Host shell renderers resolve at render time and reproject every mounted label,
tab, menu, setting, and page-chrome field when the kernel version changes.
Manager diagnostics show the original namespace/key and any unresolved or
missing-dictionary result. Framework-agnostic page props reserve a typed `t`
seat and locale namespace; React and other adapters can supply their normal
reactive binding later.

The i18n v1 kernel/runtime service is a preceding stacked `cordisx` PR. It owns
the read-only `html[lang]/dir` adapter, canonical locale handling,
fiber-owned namespace-by-locale dictionary registration, ICU MessageFormat
compilation, exact/language/default fallback, typed `t` seats, reactive
`getSnapshot/subscribe/effect/bind` APIs, replacement/unload, and deterministic
missing namespace/key/params diagnostics. The structured runtime consumes that
real service and may inject a deterministic fake only in focused unit tests.

CordisX language preferences, remote dictionaries, extraction tooling,
pseudo-locales, and marketplace translation remain later i18n workstreams.

## Future platform compatibility constraints

A future platform abstraction must use an adapter-neutral service such as
`ctx.platform`, not lock the public API to `ctx.codex`. Locale/theme/viewport
snapshots belong to an environment service, while translation dictionaries and
typed translation seats belong to a separate i18n service.

No future platform adapter may treat a newly started app-server as the original
live connection or create a second AppHost that overwrites WebContents
registration. Shared persisted data does not imply shared requests, in-flight
turns, subscriptions, approvals, or current UI context. Controlled reuse of an
existing connection or an official bridge remains experimental future work.

## Registries and conflict rules

All registries record the qualified id, owning plugin, renderer generation,
registration sequence, active/invalid state, and the latest error.

- Commands: one live owner-qualified id. Duplicate live ids are rejected.
- Routes: one live owner-qualified id and one unambiguous path pattern per
  outlet. A conflicting route stays invalid; registration order never chooses a
  silent winner.
- Pages: one live owner-qualified id. A route whose page is missing stays
  diagnosed and cannot open.
- Outlets: declared by host/adapter only. Runtime declaration validates the id,
  schema version, supported placement, context policy, and resolver.
- Surface entries: an owner-qualified contribution id is unique within a
  surface and target. Ordering is deterministic by group, numeric order,
  qualified id, then registration sequence. Duplicate exact identities are
  rejected rather than shadowed by priority.

The old same-id priority shadowing model is removed with the free-DOM slots.
Replacement or user choice can be added later as an explicit protocol rather
than an accidental collision rule.

`when` is a serializable condition AST evaluated only against host-declared
context keys. Unknown keys make the contribution unavailable and produce a
diagnostic. Disabled state is structured as a boolean plus an optional
host-rendered reason. It prevents activation without discarding the entry.

Commands may be asynchronous. The host owns per-invocation loading state,
prevents accidental duplicate activation for the same rendered control,
respects `AbortSignal`, catches failures, presents a host-styled error, and
records the error for the manager. A plugin cannot substitute its own shell
loading or error DOM.

## Initial structured surfaces

Surfaces are extension points; their commands are associated executable
resources rather than additional points. The localized host descriptors,
manager catalog, per-plugin point policy, and enforcement plan are specified in
[`extension-point-management.md`](extension-point-management.md).

The initial surface registry includes at least:

| Surface | Structured contribution |
| --- | --- |
| `sidebar.footer.before-control` | compact action before the designated native control |
| `sidebar.footer.after-control` | compact action after the designated native control |
| `sidebar.footer.menu` | command menu item in the designated control menu |
| `sidebar.account.menu` | command menu item in the native account/profile menu |
| `sidebar.navigation.items` | main navigation row with primary activation and independent trailing actions |
| `workspace.toolbar.items` | action before, after, or in the menu of a declared semantic toolbar anchor |
| `environment.panel.header-actions` | panel-header command action |
| `environment.panel.sections` | section metadata |
| `environment.section.actions` | command action targeting a section id |
| `environment.section.rows` | structured label/value/status row targeting a section id |
| `environment.row.trailing-actions` | command action targeting a row id |

Navigation rows allow one or more trailing actions. The host renders separate
buttons, stops their pointer and keyboard events before row activation, and
gives every action an independent accessible label and command state.

Toolbar contributions name a semantic host anchor plus `before`, `after`, or
`menu`; plugins cannot submit selectors. An unavailable anchor keeps the entry
pending and diagnosed.

### Native surface insertion seats

Structured shell surfaces and route/page outlets deliberately use different
projection mechanisms:

- a **surface** is rendered into an adapter-owned insertion seat that
  participates in the native layout beside or inside the resolved semantic
  control; and
- an **outlet** remains a CordisX-owned overlay over a declared content region.

A surface seat may be an externally inserted DOM island, but it is not a visual
overlay. The Codex adapter inserts the smallest host-owned container at the
resolved native sibling/child position, lets normal flex/grid layout size it,
and removes or reattaches that container with the renderer generation. React
may detach an external island when it replaces or clears the native parent, so
the mutation observer repairs the same seat after re-resolving the semantic
anchor. Plugins never receive the parent, anchor, seat, or selector.

Interactive surface projection must satisfy all of these rules:

- no fixed-position fallback, broad covering card, or geometry clone is
  allowed for a shell button, navigation row, menu trigger, section, or row;
- if the adapter cannot resolve one unique insertion position, the affected
  contribution stays pending and native content remains untouched;
- the seat has no product-visible border, background, shadow, or width beyond
  its rendered content unless the native layout contract explicitly allocates
  a full row or section;
- every title-bar surface seat and interactive descendant is an Electron
  `no-drag` region, while noninteractive native title-bar space remains
  draggable;
- menu contributions mount inside the corresponding native menu after its
  native trigger opens; they never create a CordisX-owned fallback trigger or
  a parallel `CX` menu;
- toolbar and sidebar-footer actions are icon-only controls. Their localized
  label remains available through the accessible name and native tooltip, and
  their size, hover, focus, disabled, and pressed behavior follow the adjacent
  native control pattern; and
- icon-only surface glyph size is a host-owned component token, never plugin
  CSS. Standard native toolbar/footer glyphs are 16 pixels and compact shortcut
  glyphs are 12 pixels, a four-pixel visual reduction from their established
  20- and 16-pixel sizes. The host keeps the existing icon wrapper and native
  button hit box unchanged so both Material Symbols sources stay centered.
  Text-bearing navigation/menu icons keep their existing size, and the
  separately sized 20-pixel CordisX brand manager trigger is not part of this
  surface token. Composer toolbar actions also retain their separate established
  appearance and do not opt into this shell-glyph reduction; and
- an inserted action is a sibling of the complete native control/tooltip
  trigger, never a child of that trigger. Its hit box, accessible name, and
  tooltip belong only to the CordisX contribution; hovering it must not open a
  neighboring native control's tooltip. Host tooltips render through a
  body-level portal with the native Codex tooltip tokens and viewport-edge
  collision handling, never through a seat-local pseudo-element that can be
  clipped by sidebar or toolbar overflow; and
- insertion, reattachment, and disposal must preserve the identity, parent,
  visibility, event flow, and data updates of every native React node.

The first Codex adapter projects sidebar navigation into the native navigation
list, sidebar footer actions around the designated footer control, workspace
toolbar actions around the declared toolbar anchor, and environment
sections/actions/rows into the native environment panel layout. These probes
are private adapter details and may vary by verified Codex version.

Environment sections and rows use snapshot/update handles for dynamic values.
Rows contain text, host-token status, and command references only. Section and
row targeting is validated, so an orphan action or row is diagnosed rather
than appended to an arbitrary DOM parent.

## Direct-DOM slot migration

The five experimental direct-DOM slots—`header.actions`, `composer.before`,
`composer.after`, `sidebar.footer`, and `shell.overlay`—are retired together.
Their mount-component signature is removed rather than retained as a low-level
trusted surface. `ctx.slots.inject/register` remains, but accepts the new typed
structured surface descriptors only.

The showcase plugin migrates to structured sidebar, navigation, toolbar, and
environment contributions plus registered pages. There is no period where a
sidebar action can be contributed through both the old free-DOM slot and the
new structured surface. Dialogs and arbitrary overlays move to registered app
pages; lightweight host notifications remain commands/errors rendered by the
host, not plugin DOM.

Because CordisX is still experimental and has not promised a stable slot ABI,
this is an intentional compatibility break. An untyped plugin using an old
slot name is rejected with a migration diagnostic rather than mounted.

## Route, page, and outlet separation

A route is data: qualified id, path pattern, outlet id, page id, retained
localized product metadata, and an optional condition. A page is trusted-local
executable UI combined with versioned Host-owned chrome metadata. Its mount
callback receives a CordisX-owned container, immutable route state,
navigation helpers, `AbortSignal`, and an optional disposer. An outlet is host
infrastructure: a declared semantic region, resolver, context policy, and
overlay placement strategy.

Neither route nor page creates an outlet. A plugin may use only a currently
declared outlet. Ordinary plugins cannot define any outlet that touches Codex
DOM. The TypeScript outlet vocabulary is open through `OutletMap` module
augmentation, while runtime declarations and route descriptors are always
schema-validated. The initial built-ins are:

New first-party and generated registrations use closed route-v2/page-v3
documents. They include the matching protocol `$schema` URI and
`schemaVersion`, and both retain localized `title` and `description`
references. The owning plugin supplies real locale catalogs for every locale
it claims. Route copy names the user entry and explains when navigation is
useful; page copy names the destination and explains what the user can do after
it mounts. These are separate messages even when their short titles happen to
be similar. Page v3 uses owner-default localization and therefore does not
carry the legacy `localeNamespace` hint. Paths, outlet ids, page ids, route
ids, params, and chrome values remain untranslated. Missing metadata or an
older version tuple is accepted only for explicit third-party legacy
compatibility coverage; bundled plugins, official examples, generated
fixtures, and Host-owned plugins must not rely on the manager fallback
diagnostic.

- `app`: entire renderer application region;
- `main`: the region to the right of the sidebar;
- `session.content`: the current task body below its native title/header and
  excluding side and bottom panels.

Outlets are extension points. Routes and pages remain associated resources and
must not be counted as separate points in the manager. Point identity,
localized descriptors, usage details, and policy enforcement are specified in
[`extension-point-management.md`](extension-point-management.md).

Future host/adapter packages may add `panel.right`, `panel.bottom`, `sidebar`,
or other outlet ids without changing a closed union in core.

The manager-settings A delivery additionally declares
`manager.settings.content`. It is a host-neutral manager-local body outlet,
not a Codex adapter region. Compatible routes live below
`/manager/settings/`, keep `app://` and browser/Codex history unchanged, and
resolve only to a page owned by the contributing settings tab's owner. Its
`manager.settings` presentation group is isolated from the overlapping
`app`/`main`/`session.content` group. The host renders the settings header,
tablist, and panel; the page callback receives only the panel-body child. See
[`manager-settings-tabs.md`](manager-settings-tabs.md).

The distinct B delivery declares standard-chrome outlet `manager.content`.
Compatible routes use route v2, live strictly below `/manager/extensions/`,
and supply the left-navigation title/description. They resolve to same-owner
page v3 records whose title/description/required Host icon supply the standard
page header and navigation glyph. The B contribution item contains only its
same-owner route reference. `manager.content` belongs to presentation group
`manager`, never aliases the body-only A outlet, and remains independent of
Codex adapter selectors. See
[`manager-settings-navigation.md`](manager-settings-navigation.md).

## Paths and navigation

CordisX does not keep a parallel route-history stack. Navigation names a route
id and parameters; contributions never concatenate paths. The Host validates
ownership, policy, parameters, page, outlet, active session, and path before it
adds a namespaced projection to Codex's current React Router location.
Route matching supports static segments and declared `:parameter` segments
with strict encoding and no wildcard escape from the registered pattern.

The initial path/outlet rules are validated in both protocol conformance and
the runtime:

- `/xxxx` uses `app`, except reserved `/main` and `/sessions` prefixes;
- `/main/xxxx` uses `main`;
- `/sessions/:sessionId/...` uses `session.content`.
- `/manager/settings/xxxx` uses body-only `manager.settings.content`; and
- `/manager/extensions/xxxx` uses standard `manager.content` with route-v2/
  page-v3 metadata.

`history` is only an example session page. Plugins may register analytics,
files, review, or any other valid session page. For a session route, the
resolved `sessionId` must equal the currently active native session id. A
mismatch is rejected; CordisX never switches the native Codex session.

Executable inspection of Desktop 26.818.61809 shows that the actionable React
Router history is MemoryHistory: `window.history.length` remains 1 and
`window.history.state` remains null while the title-bar Back control is enabled.
The private adapter discovers the live Context navigator from React's root and
requires a non-negative `index`, non-empty `location.key`, and callable
`push`/`replace`/`go`/`listen`. It wraps only the three mutation methods and
leaves the navigator's single React Router listener intact. CordisX neither
retains nor synchronizes a second navigator. When the executable probe passes,
a valid `ctx.routes.navigate()` preserves the native pathname/search/hash and
opaque state, advances the existing navigator, creates a new location `key`,
and writes one closed `__cordisxRouteV1` projection. When the probe fails,
routes remain unavailable with a diagnostic; there is no in-memory history
fallback.

Codex's current MemoryHistory location is the source of truth. Native React
Router PUSH/REPLACE/POP, title-bar back/forward, system shortcuts, and trackpad
gestures all reproject that location into the current CordisX page. CordisX
does not change the visible `app://` URL. A new Codex route entry normally omits
the CordisX projection and therefore closes the overlay. A CordisX entry stores
owner-qualified route id, outlet, validated path, and scalar params; two entries
with the same route id and different params remain distinct and restore
independently.

Only the current session-history entry is mounted. Navigating from one outlet
to another aborts/unmounts the former page; native Back remounts the former
entry from its serialized route projection, and Forward remounts the latter.
Presentation groups still prevent overlapping current projections during
adapter reconciliation, but they are not history or suspended-page stacks.

The built-in `app`, `main`, and `session.content` outlets share the primary
presentation group because their rectangles overlap. Runtime and manager
snapshots retain `inactive`, `presented`, and `suspended` for general adapter
coordination, but ordinary CordisX history projection has only one mounted
current entry. Shell navigation selection follows `presented`, not merely a
serialized historical entry.

Host page chrome owns title, icon, close/back controls, breadcrumb rendering,
declared tabs, and declared header actions. This rule is identical for `app`,
`main`, and every future outlet: covering a native header does not give the
plugin a header DOM seat. Page metadata is a closed, schema-validated data
record. A header action may name only a local id, localized label and accessible
name, a host icon token, a command reference, and optional host-evaluated
visibility/disabled state. Arbitrary `Node`, component, render callback, raw
HTML, `children`, or header mount container values are rejected.

Page metadata v2 adds only `chrome: standard | body-only`. `standard` preserves
the complete host chrome projection. `body-only` mounts the page body directly,
without creating the chrome, breadcrumb, tab, or header-action rows; the host
still uses the localized title for accessible naming and diagnostics. This is
a general contract gated by outlet policy: the current host accepts it only in
`session.content`, where the native session header remains present and provides
an external control seat. `app` and `main` reject it instead of leaving an
unclosable page. Plugins cannot provide substitute DOM/CSS/selectors.

Surface contribution v3 route actions may declare
`routeBehavior: navigate | toggle`. Toggle state is derived from the exact
owner-qualified active route plus resolved parameters and presented outlet
state, then projected through the host control as `aria-pressed`. Contextual
`session.header.actions` binds `:sessionId` from the current host session, not
plugin arguments. Re-activation closes the route; Escape uses the same close
path and focus returns to the connected trigger when practical. A session
change, route close, policy block, plugin disposal, or generation replacement
is resolved from the same Codex history location without a plugin boolean.

The host renders those values through one chrome component and owns layout,
macOS safe insets, drag/no-drag regions, native button interaction, i18n,
keyboard/a11y behavior, command dispatch, and current outlet-policy checks.
The chrome reserves one fixed-width leading position before the title. At the
session-history root it renders the declared host icon token; when Codex's
current `idx` can return to an earlier entry, the same position changes to the
host-rendered back button. That button calls the same Codex history authority
as the native title-bar control. Plugins never render or resize that position,
so title and breadcrumb text do not jump horizontally across navigation.

Page chrome, page surfaces, and bundled examples use the current host semantic
background, border, and text tokens. They must not introduce an independent
purple/accent palette merely to identify CordisX content.
The page mount receives only the scrollable body container after that chrome;
it cannot replace or append to the host header through the page API. A
framework-agnostic mount may use DOM or attach its own framework root inside
the body container. This trusted-local mount is controlled lifecycle
composition, not a permission sandbox: trusted renderer code can still query
the document on its own, while an isolated realm or MCP UI bridge remains a
later migration path.

## Overlay insertion and native-DOM safety

Routes are insertion overlays over native content, never replacements. This
section applies to outlets only; structured shell surfaces use the native
insertion seats defined above.

- `app` appends one fixed CordisX host layer under `body` and covers the
  renderer application rectangle.
- `session.content` prefers a stable, already-positioned native host region and
  appends exactly one CordisX absolute/inset overlay.
- `main` uses a fixed body portal projected from the complete native main-region
  rectangle. Keeping it outside the native main stacking context is required:
  otherwise the native title toolbar can paint above CordisX even when both
  rectangles begin at `y=0`.
- A body portal tracks the resolved rectangle with `ResizeObserver`,
  scroll/resize signals, and bounded geometry updates. This includes sidebar
  collapse/expand and user-driven sidebar-width changes.

The `app` outlet paints from the window origin and therefore covers the native
title-bar background. Its host-owned page chrome becomes the drag region while
back, close, tabs, and every other interactive descendant remain explicit
`no-drag` regions. On macOS, the chrome derives a horizontal traffic-light safe
inset from the resolved native title-bar controls, so page controls never sit
under the red/yellow/green window buttons.

The `main` outlet covers the complete native main-region rectangle from `y=0`.
With the sidebar expanded, the sidebar keeps the macOS traffic lights and the
main page chrome supplies the draggable region on the right. When the sidebar
collapses and the main rectangle reaches into the traffic-light zone, the same
host-derived safe inset is applied relative to the main rectangle's current
left edge. Collapse, expansion, and drag-resize must update that inset together
with portal geometry. `session.content` alone derives its top boundary from the
native session-content anchor below the session header.

The adapter must not call `replaceWith`, `remove`, `append` on a native child for
reparenting, set `display:none` on native content, clear native children, or
interfere with React event/data subscriptions. Overlay styles must not change
native layout dimensions. Pointer interception is limited to the active
CordisX overlay rectangle.

React reconciliation normally compares Fiber, not arbitrary external DOM, but
a native parent replacement, child clear, or hydration commit can still detach
an external outlet. `MutationObserver` therefore treats disconnection only as
a repair signal; incidental DOM survival is not a contract.

## Context lifecycle and state

Every successful outlet resolution returns `{ anchor or rectangle,
contextKey }`.

- The `app` key is stable for the renderer generation and survives native
  internal navigation.
- The `main` key represents the current native workspace/main semantic context.
- The `session.content` key includes the current native session id.

If a resolver returns the same `contextKey` after a React rebuild, the adapter
re-inserts or migrates the same CordisX outlet element. The active page mount is
not aborted or recreated, preserving DOM/framework state.

If the key changes, the outlet aborts and disposes the old page and all
context-scoped contribution state before accepting a route in the new context.
Version 1 does not retain per-context page stacks. Returning to a prior Codex
history entry creates a fresh page mount from its validated projection.

Reload cannot preserve an in-memory navigator, so the adapter mirrors only the
current validated projection into one namespaced browser-history reload
checkpoint. That checkpoint is bound to the current native
pathname/search/hash, replaced after each Codex transition, and cleared when
the current Codex location has no CordisX projection. It never stores an index,
back entry, or forward entry and is not consulted by Back/Forward. Initial
injection restores the checkpoint into the fresh current Codex location only
when the native location matches; Host outlets and plugin registrations then
perform the usual validation. A same-owner/same-id plugin generation
replacement keeps the location key and entry, aborts the old page, and remounts
the new registered implementation. Blocking, uninstalling, or otherwise
invalidating the current route replaces that one history entry with the native
location at the same navigator index; it does not push another entry or walk
the user backward. Historical entries cannot be mutated while they are not
current; if native Back/Forward later reaches one whose route is still absent,
the Host validates it, clears that current projection with REPLACE, and mounts
nothing. Renderer shutdown aborts mounts but leaves only that single current
checkpoint available for a later compatible reload.

## Manager diagnostics

The extension-point primary list and its second-level `Usage`, `Point
information`, and `Diagnostics` tabs follow
[`extension-point-management.md`](extension-point-management.md). In
particular, user-facing point identity comes from localized host descriptors;
stable English ids remain searchable secondary data rather than the only
visible name.

The manager joins immutable registry snapshots and groups them by owning
plugin. It reports:

- commands and their current execution/error state;
- structured surface entries, targets, `when`/disabled state, order, and mount
  status;
- routes, resolved parameters, path/outlet validation, and navigation errors;
- pages and current mount/abort/error state;
- host-declared outlets, current `contextKey`, direct/portal placement,
  geometry, and coverage state.

For Manager points the projection keeps A and B separate: A usage reports
content-tab order/body-only mount, while B usage reports before/after Settings
group, route-v2 navigation metadata, page-v3 Host icon/standard header, and the
`manager.content` mount. Associated routes/pages never inflate point counts.

Invalid and pending entries remain inspectable. The manager must distinguish
implemented runtime behavior from future capability enforcement, signing,
installation, marketplace activation, isolation, and rollback; none of those
future controls may be presented as active security.

## Delivery and validation boundaries

The compatibility unit is delivered in this order:

1. this architecture and development plan in `cordisx`;
2. `LocalizedText`/`MessageRef` and UI schemas/specification/conformance in
   `cordisx-protocol`;
3. the usable i18n v1 kernel, adapter, dictionary registry, typed seats, and
   reactive bindings in a `cordisx` PR;
4. compatible command/surface/route/page/outlet registries and TypeScript
   contracts together with private adapter outlets, structured host renderers,
   manager diagnostics, demo, simulated tests, and isolated real-renderer
   validation in one `cordisx` runtime/adapter delivery PR;
5. exact `cordisxmono` gitlink update.

The later Manager B slice follows the narrower dependency order frozen in
`manager-settings-navigation.md`: formal Protocol `f350899` first, then one
Host implementation/demo PR from the latest formal main with head-fenced CI
merge. It does not update mono. Route v2/page v3 are consumed directly rather
than forked in Host code.

Required automated coverage includes:

- schema acceptance/rejection and downgrade behavior;
- preservation of namespace/key/params in registry snapshots, render-time
  projection, locale-version reprojection without re-registration, missing-key
  and params diagnostics, canonical exact/language/default fallback,
  dictionary replacement/unload, typed page-seat shape, and subscription and
  generation cleanup through the real kernel integration; focused unit tests
  may inject a fake;
- registry ownership, unique ids, conflicts, deterministic sorting, unknown
  icons/context keys/targets, `when`, disabled state, and update-after-dispose;
- primary command precedence over route and invalid no-activation entries;
- independent trailing actions that never activate their navigation row;
- route path matching, parameter encoding, outlet/path mismatch, missing page,
  current-session enforcement, exact-param identity, Codex PUSH/REPLACE/POP,
  native back/forward, close, reload restore, and no parallel history fallback;
- same-key anchor replacement without page remount, different-key abort, no
  per-context stack, plugin block/uninstall replacement, and generation rebind;
- direct absolute overlays, portal geometry tracking, sidebar resize/collapse,
  side/bottom panels, no layout shift, and bounded pointer coverage;
- assertions that native nodes retain identity/parentage, are never hidden or
  removed, and continue receiving synthetic native data updates while a page is
  open.

For Manager B, focused coverage additionally proves route-only surface data,
route-v2/page-v3 single-source localization, required page Host icon, fixed
before/after Settings ordering, standard page chrome, Manager-local
deep-link/Back/close-reopen behavior, all three point origins, active fallback
to Host Settings, and Abort-before-dispose cleanup. The isolated renderer must
cover wide/narrow plus light/dark presentation while A remains usable.

The demo must contribute a sidebar navigation row with multiple independent
shortcuts, footer actions/menu, toolbar action/menu, environment section/rows
with live snapshot updates, and arbitrary pages in `app`, `main`, and
`session.content`.

The isolated `app://` renderer smoke must exercise sidebar collapse/expand and
drag resize, native session switching, side and bottom panels, simulated React
anchor replacement, page open/back/close, localization projection invalidation,
native data updates during overlay, plugin block/restore, and
renderer-generation disposal. Screenshots and the
machine-readable smoke report are delivery artifacts, not substitutes for
automated lifecycle tests.

## Explicitly not implemented by this slice

The current plugins remain trusted renderer code. Controlled page containers,
schema validation, host-rendered shell DOM, and private adapters reduce
accidental coupling but do not isolate a malicious plugin. Capability grants,
signatures, package installation/update, marketplace activation, atomic
generation publication, rollback, isolated realms, and MCP UI transport remain
planned work. CordisX language preferences, remote dictionaries, extraction,
pseudo-locales, marketplace translation, and every platform/app-server bridge
also remain outside this slice.
