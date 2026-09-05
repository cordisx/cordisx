# Extensible Manager settings navigation

Status: approved architecture and delivery contract. Protocol ownership is
formal at `cordisx-protocol#31` (`f350899`) plus the configuration-IA closure
in `cordisx-protocol#34` (`20053fb`). Host implementation must consume only
formal Protocol and Host merge commits.

## Product outcome and compatibility boundary

CordisX Manager no longer exposes a top-level **Settings / 配置** destination.
The empty Runtime and Launcher placeholder pages are removed with it. This is
an information-architecture change, not deletion of launcher capability:
executable discovery, CLI/profile/debug-port/environment parsing, process
startup snapshots, and redacted diagnostics remain in their owning launcher
modules.

Plugin configuration and permissions remain in the owning plugin detail.
Provider configuration belongs to the CLIProxy plugin detail; Marketplace
source management belongs to the Plugin Store. CordisX does not add global
Providers or general Settings categories.

The two existing extension contracts stay distinct:

| Capability                      | Stable surface                      | Outlet                     | Current Host projection                                                               |
| ------------------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| A: Settings content tabs        | `manager.settings.tabs`             | `manager.settings.content` | Compatibility-only; current context is `not-mounted` because no Settings page exists. |
| B: Settings-adjacent navigation | `manager.settings.navigation-items` | `manager.content`          | A real first-level Manager destination using the standard Host page shell.            |

The A identities, versions, point-policy tuples, registry diagnostics, and
body-only compatibility rules remain valid. The Host must not manufacture an
empty Settings page merely to mount A. New product examples use B when they
have real standalone content.

The names `before-settings` and `after-settings` remain closed Protocol group
identities for the two sides of a stable virtual insertion seam. They do not
imply a visible Host Settings row and are not renamed locally.

## Structured B contribution

B reuses the DSH-style registries; there is no `ctx.settings.*`, parallel
contribution facade, selector API, or Manager-specific mount callback:

```ts
ctx.slots.register({
  name: 'manager.settings.navigation-items',
  id: 'demo-tools',
  group: 'after-settings',
  order: 100,
  when: { key: 'plugin.ready', equals: true },
}, {
  route: { id: 'manager-tools' },
})

ctx.routes.register({
  id: 'manager-tools',
  path: '/manager/extensions/demo-tools',
  outlet: 'manager.content',
  page: 'manager-tools',
  title: { key: 'manager.tools.route.title', fallback: 'Demo tools' },
  description: {
    key: 'manager.tools.route.description',
    fallback: 'Open the demo plugin tools in Manager.',
  },
})

ctx.pages.register({
  id: 'manager-tools',
  title: { key: 'manager.tools.page.title', fallback: 'Demo tools' },
  description: {
    key: 'manager.tools.page.description',
    fallback: 'Inspect and configure the demo plugin.',
  },
  icon: 'host:layers',
  chrome: 'standard',
}, ({ container, signal }) => {
  // Mount only inside the Host-owned standard-page body.
})
```

The contribution envelope is the single source for local `id`, required
`group`, numeric `order`, `when`, and `disabled`. Its item contains exactly one
same-owner local route reference with optional scalar params. Route v2 owns the
navigation title/description; page v3 owns the standard header
title/description, required Host icon, breadcrumbs, and structured header
actions. Missing metadata is pending or invalid, never inferred from ids, DOM,
plugin metadata, or mounted content.

HTML, SVG, CSS, URLs, selectors, native nodes, components, arbitrary header
actions, badge renderers, layout values, and authorization origins are invalid.
The Host owns every row and header node, icon projection, selected/hover/focus/
disabled states, wide and constrained layouts, overflow, keyboard behavior,
accessibility, localization reprojection, diagnostics, and cleanup.

## Route, outlet, and page shell

An eligible B route is same-owner, strictly below
`/manager/extensions/`, targets exact outlet `manager.content`, and references
a same-owner page-v3 record with `chrome: 'standard'` and a known `host:*` icon.
Duplicate live Manager paths, cross-owner references, body-only pages, unknown
icons, stale generations, denied access, and incompatible outlets do not
produce clickable rows. Unresolved route/outlet/page dependencies remain
`pending` with attributed diagnostics.

`manager.content` belongs to presentation group `manager` and is isolated from
A's `manager.settings` body-only group and the Codex-facing `app`, `main`, and
`session.content` groups. Manager-local navigation never changes the outer
`app://` URL, browser history, or Codex router.

The Host renders breadcrumbs/back, icon, localized title and description,
structured Host-owned actions, focus, error/loading state, and the only
vertical content viewport. Trusted-local plugin code receives only a child of
the page body, immutable route/page state, bounded Manager navigation helpers,
locale context, and `AbortSignal`. It receives no row, header, breadcrumb root,
Manager root, Codex node, selector, or portal. This controlled seat is not a
process or iframe sandbox; Platform and Agent calls still pass their existing
permission brokers.

The Host opens a B page only after the eligible contribution still resolves to
the same owner-qualified route and page and passes surface, outlet-route, and
outlet-page policy checks. It aborts and disposes the prior B mount before a
route change, dialog close, owner removal, generation replacement, or policy
withdrawal. Snapshot `manager.content.mounted` and `activeRoute` describe that
controlled mount; they do not expose the child container as a general route
target or grant plugins Manager DOM authority.

## Deterministic navigation projection

The single fixed projection is:

1. Host core `host:plugins`, `host:extensions`, `host:routes`, and
   `host:marketplace`;
2. eligible `before-settings` contributions;
3. the virtual settings seam, with no rendered Host row;
4. eligible `after-settings` contributions; and
5. bottom-anchored `host:about`.

Host records have fixed positions rather than plugin numeric orders. Within
each external group the sole order is:

```text
numeric order -> owner by Unicode code unit -> qualified id by Unicode code unit
```

Registration time, localized title, DOM position, current activation, and the
other group are not tie-breakers. Reordering retains an active eligible route
by qualified identity. Owners `host` and `cordisx.*` are reserved; equal local
ids across plugins remain distinct and cannot override core destinations.
Exact live owner/point/id duplicates and duplicate canonical Manager paths are
invalid.

`when=false`, pending, denied, inactive-owner, and stale entries are hidden.
`disabled=true` remains visible with a Host-resolved reason and cannot
activate. Restore or a new eligible generation never steals activation.

Rows share the built-in vertical navigation pattern. Only the exact active
route has `aria-current="page"`. Tab enters/leaves the navigation normally;
Up/Down/Home/End and Enter/Space use the same Host behavior for built-ins and
plugins. Locale, order, width, block, and generation reprojection restore focus
to a surviving selected/nearby Host control instead of `document.body`.

## Selection, fallback, and lifecycle

Pointer, keyboard, structured deep-link requests, Back, breadcrumbs, refresh/
reprojection, close, and reopen select by owner-qualified route identity and
canonical Manager path, never selected CSS classes. Manager close creates no
outer history entry. It may retain an eligible selected plugin route and mount
it again on reopen after all current gates pass.

Activation creates and rechecks three launcher-bound, generation-fenced
`extension-point-access.v2` origins:

1. `surface.route.navigate` at `manager.settings.navigation-items`;
2. `outlet.route.navigate` at `manager.content`; and
3. `outlet.page.mount` at `manager.content` immediately before mount.

Surface/outlet point policy, plugin block/activation, availability, and
Platform/Agent capability policy are independent gates. Plugin data cannot
submit an access origin.

If the active B entry is hidden, disabled, removed, uninstalled, blocked,
permission- or point-denied, unavailable, stale, generation-replaced, or its
mount throws, the Host fences the old transition, aborts the page signal,
calls its disposer exactly once, clears the controlled body, discards stale
completion/errors, selects `host:plugins`, and restores focus. Back cannot
resurrect the invalid route. Restore makes it eligible without activating it.
Manager close performs abort then dispose; reopen uses a fresh signal.

The A compatibility path retains its historical `host:marketplace` fallback
semantics only for a Host that actually mounts Settings. In the current IA A
has no active mount to fall back from.

## Configuration planes

Configuration has two application planes:

- **Startup configuration** is frozen before the application process starts.
  Codex executable, debug port, profile, launch environment, and similar inputs
  remain CLI/launcher-owned and immutable for the current run. A future editor
  may only stage an explicit app-restart candidate.
- **Runtime plugin configuration** is shown in the owning plugin detail beside
  permissions and declares one canonical application mode: `live`,
  `plugin-restart`, `service-restart`, or `app-restart`. Closed v1 `restart`
  normalizes to `plugin-restart`; it is never used to collapse service/app
  restart semantics.

`app-restart` persists a next-start candidate without changing the current
fiber or watchers. `service-restart` requires an owning launcher service
handler; a renderer-only Host reports it read-only and must not substitute a
plugin restart. Removing Manager placeholders does not remove the underlying
parser, store, service, or diagnostics.

## Extension Points projection

The catalog keeps A and B as four distinct identities:

- `manager.settings.tabs`: compatible Settings content-tab surface; current
  context `not-mounted` in this Host IA;
- `manager.settings.content`: compatible body-only Settings outlet; current
  context `not-mounted`;
- `manager.settings.navigation-items`: real first-level Manager destination
  surface using the virtual settings seam; and
- `manager.content`: standard Manager page-shell body outlet.

Localized English and Chinese descriptions explain the different use cases.
Usage joins owner-qualified contribution, group/order, visibility/disabled/
pending state, route/page/icon/chrome, policy, generation, and mount state.
Routes and pages are associated resources, not extension-point rows.

## File overlap and delivery order

Before the Manager DOM slice, re-audit formal Host main and open PRs. The
navigation registry/contracts/sort/resolver/tests may be developed
independently. `packages/cli/src/renderer/manager.ts`, Manager route chrome,
form call sites, demo DOM assertions, and isolated renderer smoke must wait for
the Manager productization/TDesign work to merge formally, then rebase from
that merge SHA. Never consume a source head.

Preserve the latest formal behavior in `manager.ts`, `navigation.ts`,
`contracts.ts`, `runtime.ts`, catalog/localization, demos, and Manager tests:
TDesign forms, card/detail IA, route/page metadata, Host-owned icon-only glyph
tokens, toolbar spacing, bilingual copy gates, CLIProxy/Agent Trace product
README content, Marketplace trust/source workflows, Platform/Agent permission
behavior, and native console argument-array semantics.

Delivery remains:

1. architecture and overlap/validation matrix in `cordisx`;
2. versioned Protocol schemas/vectors/conformance in `cordisx-protocol`;
3. registry/runtime/contracts tests in `cordisx` from formal Protocol/Host
   baselines;
4. after formal TDesign merge, Manager DOM, real demo, focused/full gates, and
   isolated `app://` evidence;
5. normal Host PR/CI and head-fenced merge.

Mono is explicitly out of scope. No gitlink is updated by this delivery.

## Validation matrix

| Layer              | Required evidence                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol           | Closed-version rejection; no free DOM/header/CSS/selector; Host icons; deterministic groups/order/collisions; same-owner route/page; pending dependencies; exact origins; lifecycle/fallback; configuration v1-to-v2 normalization.                                            |
| Registry/runtime   | Immutable owner/point/id, stable sorting, duplicate path rejection, when/disabled/update, locale reprojection, availability/policy/generation fencing, pending diagnostics, no raw bridge.                                                                                     |
| IA                 | No top-level Settings, Runtime, or Launcher placeholder rows/pages; startup parsing and diagnostics remain; plugin detail retains configuration and permissions; CLIProxy owns Providers; Plugin Store owns sources.                                                           |
| Manager navigation | Built-ins plus B in fixed order; pointer/keyboard/roving focus/a11y; exact selected state; constrained and wide layouts; About anchoring; active identity retained across reorder.                                                                                             |
| Routing/page shell | Manager-local deep link, Back/breadcrumb, refresh/reopen, unchanged outer URL/history; Host icon/title/description/actions; plugin body child only; one scroll owner.                                                                                                          |
| Lifecycle          | hide/disable/remove/uninstall/block/restore/deny/generation replace/close/reopen/mount throw; Abort before one dispose; stale work fenced; fallback to `host:plugins`; restore does not steal activation.                                                                      |
| Configuration      | `live`, plugin restart rollback, app-restart stage without current apply/watch, unbound service-restart refusal, legacy `restart` normalization, CLI/startup parsing unchanged.                                                                                                |
| Extension Points   | Four distinct A/B rows in English/Chinese; A current context not-mounted; B real usage and policy/diagnostic attribution.                                                                                                                                                      |
| Isolated renderer  | Real `app://` wide/narrow and light/dark evidence for B order, pointer/keyboard/deep link/Back/selection, Host header/body, lifecycle/fallback, locale/generation; no placeholder Settings/Runtime/Launcher; no selector/raw bridge; native data flow and outer URL unchanged. |
| Release            | Focused tests, typecheck, build, full `npm run check`, `git diff --check`, screenshots and machine report, normal CI, formal head-fenced merge.                                                                                                                                |

Screenshots complement machine assertions; they do not prove lifecycle,
permission, generation fencing, or sandboxing.
