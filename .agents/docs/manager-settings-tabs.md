# Extensible manager settings tabs

Status: implemented A/content-tab compatibility contract. The current CordisX
Manager IA has no top-level Settings page, so the Host retains these point
identities and diagnostics with current context `not-mounted` rather than
manufacturing an empty shell.

This point switches content **inside** Manager Settings only for a Host that
exposes that page; it is not the first-level left-navigation contribution.
The current product uses the separate B capability specified in
[`manager-settings-navigation.md`](manager-settings-navigation.md).

## Outcome

The closed A contract lets a compatible Host expose an extensible,
host-rendered Settings tab surface. A plugin contributes structured tab data,
associates it with one of its own routes and pages, and mounts trusted-local
content only inside the selected panel body. Such a Host owns the settings
page header, tab DOM, icons, localization, ordering, selection, overflow,
keyboard behavior, accessibility, focus restoration, error projection, scroll
ownership, and cleanup. CordisX's current IA projects none of that DOM because
the containing page is absent.

The versioned host-neutral extension points are frozen as:

- surface `manager.settings.tabs`; and
- outlet `manager.settings.content`.

They are CordisX manager extension points, not Codex shell surfaces. The Codex
adapter declares no selector, native anchor, or fallback overlay for either
point. A future non-Codex CordisX host may expose the same pair.

The public runtime remains the existing DSH-style service model:

```ts
ctx.slots.register({
  name: 'manager.settings.tabs',
  id: 'preferences',
  order: 220,
  when: { key: 'plugin.ready', equals: true },
}, {
  title: { key: 'settings.title', fallback: 'Preferences' },
  icon: 'host:settings',
  route: { id: 'settings.preferences' },
})

ctx.routes.register({
  id: 'settings.preferences',
  path: '/manager/settings/preferences',
  outlet: 'manager.settings.content',
  page: 'settings.preferences',
})

ctx.pages.register({
  id: 'settings.preferences',
  title: { key: 'settings.title', fallback: 'Preferences' },
  chrome: 'body-only',
}, ({ container, signal }) => {
  // Mount only in the CordisX-owned panel-body child.
})
```

There is no `ctx.settings.*`, `ctx.cordisx.contribute()`, header render callback,
or settings-specific page API.

## Contract shape and versioning

`surface-contribution.v1`, `.v2`, and `.v3` contain closed surface enums.
Version 3 already owns route-toggle behavior, and old
validators must be able to reject a newer document without guessing whether an
unknown surface is safe. The protocol delivery therefore adds
`surface-contribution.v4` and `host-extension-point-catalog.v3`. It does not
append these ids to a stable v1/v2/v3 surface enum or the v1/v2 catalog maps.

Version 4 is an explicit additive surface superset. A v1/v2/v3 host rejects
v4. A v4 host may normalize conforming v1/v2/v3 contributions, while retaining
their original version in diagnostics. There is no downgrade to a retired
free-DOM slot. Page bodies use the already versioned `page.v2`
`chrome: 'body-only'` contract; catalog v3 adds
`manager.settings.content` to the outlet policies that allow it rather than
changing the frozen page schema.

Surface v5/catalog v4 retain the stable `manager.settings.tabs` id and its
point-policy tuple while naming the payload family more precisely as
`manager-settings-content-tab`. The Host accepts both the existing v4/catalog
v3 shape and the compatible v5 shape as one A projection. It does not rename
the point, move it into first-level navigation, or infer B from an A record.

The Settings Tab contribution has one source of truth:

```ts
interface CordisXManagerSettingsTabItem {
  readonly title: CordisXLocalizedText
  readonly icon: CordisXHostIconToken
  readonly route: CordisXSameOwnerRouteReference
}
```

The contribution envelope supplies the local `id`, numeric `order`, `when`, and
`disabled` state. The item does not repeat `id`, `order`, `when`, or `disabled`.
The point rejects `group`; settings has one ordered tab sequence rather than
multiple independently sorted groups. A fiber-owned update handle may replace
the item and may update envelope `order`, `when`, and `disabled`, but it cannot
change owner, point id, contribution id, or route ownership.

`icon` is required and must be a known `host:*` token. Arbitrary SVG, HTML,
CSS, URLs, selector strings, nodes, components, render callbacks, `children`,
and header mount containers are invalid. Version 1 of this settings point has
no badge. A badge can be added only after one bounded, localized, accessible
badge contract applies consistently to all host-controlled tab surfaces.

The route reference is local to the contribution owner. It must resolve to a
live route owned by that same plugin; that route must use
`manager.settings.content`, have a path below `/manager/settings/`, and resolve
to a live page owned by the same plugin. Cross-owner route or page reuse is
invalid even when a qualified id is otherwise public. Missing route, page, or
outlet dependencies remain pending with a diagnostic and never produce a
clickable empty tab.

Manager-local paths remain inside CordisX's in-memory routing. They do not
change the `app://` URL, call browser history, invoke the Codex router, or
switch a native workspace/session.

## One projection and deterministic order

When a Host exposes Settings, the historical three built-in tabs and external
contributions enter one `ManagerSettingsTabProjection`. Built-ins are host
records, not spoofable plugin registrations:

| Qualified id | Stable order | Content owner |
| --- | ---: | --- |
| `host:marketplace` | 100 | CordisX marketplace settings |
| `host:runtime` | 200 | Historical runtime placeholder |
| `host:launcher` | 300 | Historical launcher placeholder |

The current CordisX Host does not expose this projection. In particular it
does not render the historical Runtime or Launcher placeholders. Their removal
does not delete plugin runtime status, CLI parsing, launcher validation, or
redacted diagnostics from their owning product areas.

Plugin ids cannot be `host` or start with `cordisx.`, so a local id such as
`marketplace` cannot replace a built-in record. It remains a distinct qualified
identity. Exact live `(owner, point, local id)` duplication is rejected.

The only projection order is:

```text
numeric order -> owner by Unicode code unit -> qualified id by Unicode code unit
```

Registration sequence, locale, label, current activation, and DOM order are
not tie-breakers. Updating order reprojects the sequence but never changes the
active tab, which is retained by qualified id. `host:marketplace` is the stable
default and fallback; the first sorted third-party tab is never an implicit
default.

`when=false` removes a tab from the projected tablist. `disabled=true` keeps it
visible and non-activatable with a host-rendered reason. Unknown context keys,
invalid icons, unresolved dependencies, stale generation, and point-policy
denial remain attributed manager diagnostics. Pending and invalid records are
inspectable in Extension Points but are not clickable settings tabs.

## Header and content ownership

For every projected item CordisX creates the `role=tab` button from structured
data. Plugins never receive the tab, tablist, settings header, manager root, or
any Codex node. CordisX owns:

- localized title reprojection and the required host icon token;
- active underline, neutral silver-grey styling, disabled/error states, and
  horizontal overflow/scroll;
- roving tabindex, Left/Right wrap, Home/End, activation, accessible names,
  focus restoration after rerender, and `aria-selected`;
- `role=tabpanel`, stable tab/panel ids, `aria-controls`, and
  `aria-labelledby`; and
- the manager content viewport as the single vertical scroll owner.

Only the active panel exists. Its structure is:

```text
CordisX settings page
  CordisX-owned tablist
  CordisX-owned role=tabpanel
    CordisX-owned panel body
      plugin page mount container
```

The page mount receives the final body container, route params, locale seat,
navigation helpers limited to CordisX routes, and an `AbortSignal`. It does not
receive or render page chrome for this outlet. `manager.settings.content`
belongs to its own `manager.settings` presentation group and never suspends or
is suspended by the primary `app`, `main`, or `session.content` group.

This is controlled lifecycle composition, not process or iframe isolation.
Plugins still execute as trusted local renderer code. Platform and Agent calls
made by settings content continue through their existing identity-bound
permission brokers; the settings outlet grants no additional service access.

## Activation and lifecycle state machine

Activation rechecks both extension-point gates with host-generated,
generation-fenced origin:

1. `surface.route.navigate` for `manager.settings.tabs`;
2. `outlet.route.navigate` for `manager.settings.content`; and
3. `outlet.page.mount` immediately before the page callback.

The originating source/plugin/point/contribution tuple is launcher-bound. A
plugin cannot supply it through route params, page props, or mount content.

For a Host that mounts Settings, the active qualified id survives title,
locale, icon, disabled state of other tabs, and order changes. The host aborts
and disposes the active plugin mount,
clears its body, and falls back to `host:marketplace` when the active tab:

- becomes hidden or is removed;
- belongs to a blocked, permission-blocked, failed, or disposed plugin fiber;
- loses either point-policy authorization;
- is replaced by a newer renderer generation; or
- is active when the manager closes.

Abort happens before the plugin disposer. Cleanup is idempotent. Restoring a
plugin or policy makes its tab eligible again but does not steal activation
from the current built-in tab. Reopening that Settings context starts on the
stable built-in fallback and mounts plugin content only after a new explicit
activation. The current Host has no active A mount and therefore no A
activation to normalize.

If a page mount throws, the host aborts and disposes any partial mount, clears
the body, retains the attributed diagnostic, and renders a CordisX-owned error
state instead of an empty shell. A later explicit activation may retry. A
stale update or disposer from an earlier generation cannot mutate the current
projection or body.

## Extension Points projection

The Extension Points manager page lists both
`manager.settings.tabs` and `manager.settings.content` with localized host
descriptors, payload/context policy, and current-context `not-mounted`
diagnostics.

Usage for the surface attributes every external tab, order, visibility,
disabled/pending state, and route reference to its plugin identity. Usage for
the outlet joins only same-owner routes/pages and reports the active mount and
point-policy outcome. Commands, routes, and pages remain associated resources,
not extra extension points.

## Delivery order and PR boundaries

A was delivered architecture first, then surface v4/catalog v3 Protocol,
Host/demo, real-renderer verification, and its historical mono pin. Its owning
contracts and tests remain the compatibility baseline.

The current B/IA delivery does not reopen that history. Architecture is frozen in
[`manager-settings-navigation.md`](manager-settings-navigation.md); formal
Protocol `f350899` adds surface v5/catalog v4 while retaining A's stable id,
and Protocol `20053fb` makes the no-Settings IA explicit. One Host PR from
latest formal main appends B, keeps A as not-mounted compatibility state, and
uses the demo for a real B page. Normal CI and a head-fenced Host merge are required.
No mono update belongs to the B delivery, and no source branch head is a
dependency.

## Validation matrix

| Layer | Required evidence |
| --- | --- |
| Protocol versions | v1/v2/v3 surface validators reject v4; v4 keeps its original meaning; older validators reject v5/catalog v4; v5 A and v4 A normalize to one stable `manager.settings.tabs` runtime point; unknown fields/versions fail closed. |
| Protocol boundary | Accept localized title, required known host icon, same-owner route, envelope order/when/disabled; reject HTML, SVG, CSS, selector, node/component/render callback, `children`, header seat, arbitrary icon, badge, group, cross-owner route/page, wrong path/outlet, and plugin-supplied access origin. |
| Protocol projection | Built-in and plugin same-local-id records coexist; exact identity conflicts fail; deterministic `order -> owner -> qualified id`; unresolved route/page/outlet is pending; stale generation is rejected. |
| Registry/runtime | Registration and immutable item/options updates; unknown context; disabled and visibility transitions; locale reprojection without re-registration; policy and route/page dependency reconciliation; update-after-dispose and stale generation rejection. |
| Manager DOM | One host-rendered tablist and active panel; no plugin header DOM; host icon only; exact order; stable active id across reorder/locale; horizontal overflow; roving tabindex; Arrow/Home/End; disabled skipping; focus restoration; `aria-controls`/`aria-labelledby`; one vertical scroll owner. |
| Lifecycle | Block/restore, required-permission deny/recovery, active removal fallback, point deny/allow, stale generation, close/reopen, mount throw/retry, Abort-before-dispose, idempotent cleanup, and no activation theft after restore. |
| Native data flow | Opening and switching settings content does not change `app://`, browser/Codex history, primary outlet presentation, native node identity, visibility, subscriptions, or simulated data updates. |
| Extension Points | Both descriptors are searchable; surface/outlet usage is attributed to the plugin and exposes policy, pending, route/page, mount, and diagnostic state without counting resources as points. |
| Demo | Compatibility fixtures still prove A validation, controlled body mount, no selector/header DOM, and fiber cleanup; the shipped demo uses B for its real first-level page. |
| Isolated renderer | Real `app://` evidence proves A is not mounted and no empty Settings/Runtime/Launcher shell appears; B evidence belongs to the navigation architecture. |
| Release | Preserve all A tests/evidence while adding B; focused tests, typecheck, build, full `npm run check`, `git diff --check`, normal Protocol/Host PR checks and head-fenced merges, exact merged revision evidence, and no mono update. |

Screenshots complement machine assertions; they do not prove lifecycle or
policy enforcement. A controlled body container is not evidence of a sandbox.
