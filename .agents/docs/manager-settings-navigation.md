# Extensible Manager settings navigation

Status: approved architecture and delivery contract. This document freezes the
Host implementation model for plugin-owned top-level destinations adjacent to
Manager Settings. It is based on formal `cordisx` main
`1eb9e421964a42afd5538fe1b5a2f83ad71299ce` and the merged Protocol contract
`f350899`. It does not by itself claim that the Host runtime or demo is
implemented.

## Outcome and the A/B boundary

CordisX exposes two intentionally different Manager extension models:

| Capability | Stable surface | Outlet | User-visible seat |
| --- | --- | --- | --- |
| A: Settings content tabs | `manager.settings.tabs` | `manager.settings.content` | Horizontal tabs inside the Host `配置` page |
| B: Settings-adjacent navigation | `manager.settings.navigation-items` | `manager.content` | Independent first-level entries in the Manager left navigation near `配置` |

A remains useful and compatible. Its stable point id and point-policy tuple do
not change. Surface v4/catalog v3 records retain their existing
`manager-settings-tab` meaning; surface v5/catalog v4 describe that same point
more precisely as `manager-settings-content-tab`. The Host normalizes both to
one internal content-tab projection. No migration renames
`manager.settings.tabs` or treats an A registration as B.

B opens a normal Host-owned Manager page shell. A plugin contributes only a
same-owner route reference and envelope placement state. Route v2 supplies the
left-navigation title and description. Page v3 supplies the standard header
title, description, required `host:*` icon, breadcrumbs, and structured header
actions. The page callback mounts trusted-local code only in the Host-owned
content body. The contribution never renders navigation or header DOM.

Both capabilities reuse the existing DSH-style services:

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
  breadcrumbs: [{ key: 'manager.plugins', fallback: 'Plugins' }],
}, ({ container, signal }) => {
  // Mount only in the Host-owned standard page body.
})
```

There is no `ctx.settings.*`, parallel contribution facade, selector field,
navigation renderer, header callback, CSS seat, or B-specific page mount API.

## Versioned contract and single-source metadata

Protocol surface v5 and catalog v4 are new closed versions. Older validators
reject them instead of dropping unknown points or payload families. Catalog v4
keeps A's point identity, adds payload family
`manager-settings-navigation-item`, declares outlet `manager.content`, and
adds route-path family `manager`. Route v2 and page v3 are consumed exactly as
merged; the Host does not create local variants or modify their schemas.

The B contribution envelope owns:

- local contribution `id`;
- required group `before-settings` or `after-settings`;
- numeric `order`;
- `when`; and
- `disabled` plus localized reason.

Its item contains exactly one same-owner local route reference with optional
scalar params. It contains no title, description, icon, order, group,
condition, disabled state, badge, action, DOM, selector, CSS, or callback.

Display data has one source at each layer:

- route-v2 `title` and `description` name and explain the left-navigation
  destination;
- page-v3 `title`, `description`, and required `host:*` icon render the
  standard page header; the same page icon is the sole glyph source for the
  corresponding navigation row; and
- page-v3 breadcrumbs and structured header actions are Host-rendered page
  chrome. Any accepted action icon is also a Host token.

The Host resolves retained messages through the shared localization kernel on
every locale/dictionary revision. It never infers product text from ids, path,
mounted DOM, plugin metadata, or implementation. Missing route-v2/page-v3
metadata or a missing/non-Host page icon makes B pending or invalid; it is not
silently filled from the contribution.

## Route, outlet, and standard page shell

The referenced route must:

- be owned by the contribution owner;
- have a path strictly below `/manager/extensions/`;
- target exact outlet `manager.content`;
- reference a page-v3 record owned by the same plugin; and
- resolve a page with `chrome: 'standard'` and a required known `host:*` icon.

Qualified cross-owner route/page references, exact duplicate live Manager
paths, `/manager/extensions` itself, settings-content paths, body-only pages,
unknown icons, unresolved dependencies, inactive owners, stale generations,
and denied point access do not produce clickable rows. Pending dependencies
remain attributed diagnostics in Extension Points.

`manager.content` has presentation group `manager` and route-path family
`manager`. It is distinct from A's body-only `manager.settings.content` /
`manager.settings` group and from the Codex-facing `app`, `main`, and
`session.content` groups. No B route suspends a native Codex page, mutates the
outer `app://` URL, calls browser history, or invokes the Codex router.

The Host maps a resolved B route to structured `ManagerRouteState`. Pointer,
keyboard, internal Back, breadcrumb activation, refresh/reprojection, and a
manager-local deep-link request all select by owner-qualified route identity
and canonical Manager path rather than by DOM state. Close records no browser
history entry. The selected B route identity may survive Manager close; reopen
remounts it only if the contribution, route, outlet, page, owner generation,
and policies are still eligible. Otherwise normalization falls back to
Host Settings without first exposing an empty plugin shell.

The Host owns the complete standard page structure:

```text
Manager dialog
  Host left navigation
    Host-rendered B row
  Host main content viewport
    Host breadcrumbs / Back
    Host icon + localized page title
    Host localized page description
    optional Host-rendered structured actions
    Host page body
      plugin mount container
```

The page mount receives only the final body container, immutable route/page
state, bounded Manager navigation helpers, locale context, and `AbortSignal`.
It receives no navigation row, page header, breadcrumb root, Manager root,
Codex node, selector, or portal. The content viewport remains the only vertical
scroll owner.

## One deterministic left-navigation projection

Host core and eligible B entries form one projection:

1. `host:plugins` (`plugins`);
2. `host:extensions` (`extension-points`);
3. `host:routes` (`routes`);
4. `host:marketplace` (`marketplace`);
5. eligible `before-settings` plugin entries;
6. `host:settings` (`settings`);
7. eligible `after-settings` plugin entries; and
8. bottom-anchored `host:about` (`about`).

Host positions are fixed and are not values in the plugin order range. Within
each external group the only order is:

```text
numeric order -> owner by Unicode code unit -> qualified id by Unicode code unit
```

Group comparison never moves an `after-settings` entry before Settings or a
`before-settings` entry into the Host core block. Registration time, localized
title, DOM position, active route, and locale are not tie-breakers. Reordering
retains an active eligible route by qualified identity.

Owners `host` and `cordisx.*` are reserved. Equal plugin local ids remain
separate qualified identities and cannot replace Host core rows. Exact live
owner/point/id duplicates and duplicate canonical Manager paths are invalid.

`when=false` removes the row. `disabled=true` retains a Host-rendered,
non-activatable row with a localized reason. Restore or a newly eligible
generation re-adds the row but never steals activation from Settings or the
currently selected route.

The Host owns row DOM, icons, selected/hover/focus/disabled/error states,
accessible name and description, keyboard navigation, compact/wide behavior,
truncation, sidebar scroll, and About anchoring. Wide layout uses the same
Manager row component as built-ins. At constrained widths text may truncate
visually while the full localized accessible name remains; the plugin cannot
request an icon-only mode, width, wrapping, overflow menu, group separator, or
custom hover/selection style.

## Selection, accessibility, and history

Only the exact active route is selected and receives `aria-current="page"`.
Rows are real Host controls in the existing vertical navigation pattern. Tab
enters/leaves the navigation normally; Up/Down and Home/End behavior, if
enabled for the built-in list, is shared by B rows without a plugin-specific
keyboard branch. Disabled rows are skipped by activation. Reprojection after
locale, order, width, block, or generation changes restores focus to the
surviving selected/next Host control rather than document body.

The standard page header follows the fixed leading-seat and breadcrumb rules
in `manager-content-design.md`. Back follows Manager internal history; a page
breadcrumb targets a structured Manager ancestor. Current crumbs are text with
`aria-current="page"`; ancestors are Host buttons. Refresh/reopen reconstructs
selection from structured route identity, never from selected CSS classes.

When an active B entry disappears, normalization replaces the current route
with `host:settings` without adding an invalid history entry. Back cannot
resurrect a denied/stale route. Restoring the entry leaves Settings selected
until the user explicitly activates it again.

## Authorization and lifecycle

Activation creates and rechecks three launcher-bound, generation-fenced
`extension-point-access.v2` origins:

1. `surface.route.navigate` at `manager.settings.navigation-items`;
2. `outlet.route.navigate` at `manager.content`; and
3. `outlet.page.mount` at `manager.content` immediately before mount.

The origin binds canonical source, plugin owner, point, contribution, route,
page, and generation. Plugins cannot submit it through contribution data,
route params, page props, commands, DOM, or mounted content. Surface policy,
outlet policy, whole-plugin activation/block state, declared capability
availability, and Platform/Agent permission brokers remain independent gates.
This outlet grants no Platform or Agent capability.

If the active B entry becomes hidden, disabled, removed, uninstalled, blocked,
permission-denied, point-denied, unavailable, stale, or generation-replaced,
the Host performs this ordered transition:

1. fence the old transition/generation;
2. abort the active page signal;
3. call its disposer exactly once;
4. clear the body and discard stale completion/errors;
5. select and render `host:settings`; and
6. restore focus to the surviving Host navigation/page target.

Manager close aborts then disposes the B mount but may retain its structured
selected route. Reopen creates a new signal and mount only after all current
gates pass. Mount throw performs the same cleanup and falls back to Settings
with a Host-owned attributed error. Restore never auto-activates. A stale
click, route request, page completion, update, or disposer cannot affect the
new generation.

A keeps its existing lifecycle: closing Settings content resets A to
`host:marketplace`. B close/reopen selection retention is not applied to A.

The page body still executes as trusted local renderer code. A controlled body
seat and origin checks are not a process, iframe, or hostile-code sandbox.

## Extension Points product projection

Manager `扩展点位` must show A and B separately:

- `manager.settings.tabs`: **Manager settings content tabs** — switches
  Marketplace, plugin settings, runtime, and launcher content inside Settings;
- `manager.settings.content`: body-only outlet for the selected A tab;
- `manager.settings.navigation-items`: **Manager settings navigation items** —
  adds independent top-level plugin destinations near Settings; and
- `manager.content`: standard Manager page shell/body outlet for B routes.

Descriptions and examples exist in both `en` and `zh-CN`. Surface usage lists
owner-qualified contribution id, group/order, visibility/disabled/pending
state, route metadata and policy. Outlet usage joins same-owner route/page,
page chrome/icon, active mount, generation, and policy. Routes and pages remain
associated resources, not extra point counts.

## File-level overlap audit

The future Host implementation must rebase on the latest formal main and
preserve these already merged slices:

| Concurrent/merged slice | Overlapping files | This delivery boundary |
| --- | --- | --- |
| Manager productization (`8e3e7ab`, current main descendants) | `packages/cli/src/renderer/manager.ts`, `runtime.ts`, Manager tests | Extend existing `ManagerRouteState`, navigation renderer, snapshots, history, focus and list/detail behavior. Do not replace productized plugin actions, permission pages, marketplace trust, About, or Manager layout. |
| Host form / TDesign-aligned forms (`018f5a7`) | `renderer/host-form.ts`, `tests/host-form.test.ts`, Manager form call sites | B page shell does not create a second form system. Demo body may consume existing Host form primitives, but navigation/header contracts do not change Schemastery, form theme, validation, or field renderer ownership. |
| UI catalog and Extension Points | `contracts.ts`, `renderer/surfaces.ts`, `extension-points.ts`, `runtime.ts`, `tests/surfaces.test.ts`, `tests/extension-points.test.ts` | Append v5/catalog-v4 normalization, B descriptor/usage, and `manager.content`; retain all existing point ids, locale keys, policies and A v4/catalog-v3 behavior. Do not rebuild or shrink the complete catalog. |
| A settings content tabs | `renderer/manager.ts`, `navigation.ts`, `runtime.ts`, `surfaces.ts`, `tests/manager-settings-tabs.test.ts`, demo | Reuse the registries and access broker. Keep `manager.settings.tabs` and `manager.settings.content`, built-in orders, A keyboard/a11y, body-only mount, and marketplace fallback unchanged. |
| Route/page localized metadata (`cordisx-protocol` `f350899`) | Host `contracts.ts`, `renderer/navigation.ts`, runtime normalization | Consume route v2/page v3 directly. Do not add Manager-only title/description fields or modify the owning protocol schemas. |

The architecture documentation is edited first. Runtime/tests/demo changes
must not begin from an old source head or overwrite unmerged work. Before the
Host PR is opened, repeat the overlap audit against open PR heads and resolve
only real conflicts by preserving both owning behaviors.

## Dependency order and PR boundaries

1. **Architecture (`cordisx`)**: this document and the linked architecture,
   Manager, routing, catalog, and Extension Points documents. No runtime code
   precedes the frozen model.
2. **Protocol (`cordisx-protocol`)**: already merged at `f350899`; owns surface
   v5, catalog v4, route-v2/page-v3 reuse, valid/invalid vectors, conformance,
   lifecycle and origin semantics. Host consumes only this formal merge.
3. **Host and demo (`cordisx`)**: from the latest formal main, add public
   types/normalization, registry validation, catalog descriptors, route/outlet
   enforcement, Manager projection, standard shell/body mount, diagnostics,
   lifecycle fencing, and make `settings-tab-demo` visibly demonstrate both A
   and B with unambiguous copy.
4. **Owning verification and merge**: focused and full gates plus isolated real
   renderer evidence; rebase any new formal main and use normal CI plus a
   head-fenced merge. Never consume another PR's source head.
5. **Mono**: explicitly out of scope for this delivery. Do not update any mono
   gitlink after the Protocol or Host merge.

Protocol and Host remain independently reviewable. The Host PR must name the
formal Protocol merge in its dependency/evidence, and its merge SHA—not its
source head—is the only valid downstream compatibility reference.

## Validation matrix

| Layer | Required evidence |
| --- | --- |
| Protocol compatibility | v1-v4 validators reject v5/catalog v4; A surface v4/catalog v3 keeps its meaning; v5 A normalizes to the same runtime point; B item accepts route only and rejects title/description/icon/DOM/CSS/selector/callback fields. |
| Route/page boundary | Require route v2 title/description, same owner, strict `/manager/extensions/...`, `manager.content`, page v3 standard chrome/title/description/known Host icon; reject route v1/page v1-v2, cross-owner reference, duplicate path, body-only page, missing/non-Host icon; unresolved route/outlet/page is pending. |
| Projection | Exact Host core order; separate before/after groups; deterministic `order -> owner -> qualified id`; reserved owners/core collisions; when/disabled; reorder retains active identity; locale never changes order. |
| Registry/runtime | v4/v5 A normalization; immutable point/owner/id; update and generation fences; source attribution; point/capability/owner availability; pending and diagnostic reprojection; no raw bridge, selector, header seat or arbitrary icon path. |
| Manager navigation | B visible in wide and constrained navigation; pointer and keyboard activation; exact selected/hover/focus/disabled states; accessible title/description; truncation/overflow; About remains bottom; no Host core replacement. |
| Routing/history | Manager-local deep link, refresh/reprojection, breadcrumb ancestor, Back, close/reopen remount, unchanged outer `app://` URL/browser/Codex history, selected state derived from structured route rather than DOM. |
| Page shell/content | Host renders page-v3 icon/title/description/breadcrumb/actions and error/loading states; plugin mounts only in body; single scroll owner; no plugin header/nav DOM; A body-only content tab still works. |
| Lifecycle | when-hide, disable, remove/uninstall, block/restore, permission and both point-policy deny/allow, stale click/route/page completion, generation replacement, active fallback to Settings, restore without activation theft, close/reopen, mount throw, Abort-before-dispose, idempotent cleanup. |
| Extension Points | Four distinct A/B descriptors searchable in English and Chinese; detailed real-use copy; attributed surface/outlet usage, group/order, route/page/icon/chrome, policy, pending, generation and mount state; resources do not inflate point count. |
| Isolated renderer | Real `app://` evidence for B visibility/order, pointer/keyboard, manager-local deep link, Back, selected state, standard header/body, constrained width, light/dark, conflicts, block/restore, disable/uninstall, generation disposal and fallback; A remains usable; no raw bridge/selector; native node identity/data flow and outer URL unchanged. |
| Release | Focused tests, typecheck, build, full `npm run check`, `git diff --check`, screenshots plus machine report with exact formal Protocol/Host revisions, normal PR checks and head-fenced Host merge; no mono update. |

Screenshots complement machine assertions; they do not prove lifecycle, policy,
generation fencing, or the absence of a raw bridge. Trusted-local code remains
trusted-local even when it receives only a controlled page body.
