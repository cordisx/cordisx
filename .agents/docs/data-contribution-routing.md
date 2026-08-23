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
   a Codex React node. CordisX never calls the Codex router or browser history.
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

A route is data: qualified id, path pattern, outlet id, page id, optional title
and host-owned chrome metadata. A page is trusted-local executable UI: a mount
callback receiving a CordisX-owned container, immutable route state,
navigation helpers, `AbortSignal`, and an optional disposer. An outlet is host
infrastructure: a declared semantic region, resolver, context policy, and
overlay placement strategy.

Neither route nor page creates an outlet. A plugin may use only a currently
declared outlet. Ordinary plugins cannot define any outlet that touches Codex
DOM. The TypeScript outlet vocabulary is open through `OutletMap` module
augmentation, while runtime declarations and route descriptors are always
schema-validated. The initial built-ins are:

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

## Paths and navigation

CordisX keeps its own in-memory route state. Navigation names a route id and
parameters; contributions never concatenate paths. Route matching supports
static segments and declared `:parameter` segments with strict encoding and no
wildcard escape from the registered pattern.

The initial path/outlet rules are validated in both protocol conformance and
the runtime:

- `/xxxx` uses `app`, except reserved `/main` and `/sessions` prefixes;
- `/main/xxxx` uses `main`;
- `/sessions/:sessionId/...` uses `session.content`.

`history` is only an example session page. Plugins may register analytics,
files, review, or any other valid session page. For a session route, the
resolved `sessionId` must equal the currently active native session id. A
mismatch is rejected; CordisX never switches the native Codex session.

Every outlet owns an internal stack. Open pushes a validated route, back
returns within that CordisX stack, and close clears the current CordisX page to
reveal the untouched native content. These operations do not call
`history.pushState`, change the browser URL, or invoke Codex routing APIs.

Host page chrome owns title, close/back controls, breadcrumb rendering, and
declared tabs where possible. The page mount receives the body container. A
framework-agnostic mount may use DOM or attach its own framework root inside
that container. This trusted-local mount is controlled lifecycle composition,
not a permission sandbox; an isolated realm or MCP UI bridge remains a later
migration path.

## Overlay insertion and native-DOM safety

Routes are insertion overlays over native content, never replacements. This
section applies to outlets only; structured shell surfaces use the native
insertion seats defined above.

- `app` appends one fixed CordisX host layer under `body` and covers the
  renderer application rectangle.
- `main` and `session.content` prefer a stable, already-positioned native host
  region and append exactly one CordisX absolute/inset overlay.
- If no reliable positioned anchor exists, the adapter appends a fixed body
  portal and tracks the resolved rectangle with `ResizeObserver`, scroll/resize
  signals, and bounded geometry updates.

The Codex adapter preserves the native Electron title-bar safe area for `app`
and `main` outlets. It derives the inset from the currently resolved native
application-menu/title-bar rectangle instead of publishing or assuming a
cross-host constant. The overlay starts below that rectangle, so native window
dragging remains available. CordisX page chrome and all of its controls are
explicit `no-drag` regions as defense in depth. `session.content` continues to
derive its top boundary from the native session-content anchor below the
session header.

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
Version 1 does not retain or restore per-context page stacks. Returning to an
earlier workspace or session starts a fresh page mount. Plugin blocking,
generation replacement, or renderer shutdown aborts all active pages and
commands regardless of context.

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
  current-session enforcement, history/back/close, and no browser-history use;
- same-key anchor replacement without page remount, different-key abort, no
  per-context restore, plugin block/restore, and generation disposal;
- direct absolute overlays, portal geometry tracking, sidebar resize/collapse,
  side/bottom panels, no layout shift, and bounded pointer coverage;
- assertions that native nodes retain identity/parentage, are never hidden or
  removed, and continue receiving synthetic native data updates while a page is
  open.

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
