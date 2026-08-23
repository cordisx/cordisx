# Extension-point catalog and policy

Status: approved CordisX product and architecture contract. The structured
surface/outlet registries, localized host catalog, identity-bound point-policy
broker, surface command-origin checks, and outlet navigation/mount enforcement
are implemented in the runtime slice. This manager delivery adds the searchable
catalog and point-detail experience described below.

Normative, plugin-visible schemas belong in `cordisx-protocol`. This document
owns the CordisX host model, manager projection, enforcement boundary, and
validation plan.

## Meaning of an extension point

An extension point is a host-declared place where plugin-owned behavior can be
projected. CordisX has exactly two extension-point families:

- a **surface** accepts structured contribution data and lets the host render
  native-shell controls in an adapter-resolved insertion seat; and
- an **outlet** accepts a compatible route and mounts its page inside a
  CordisX-owned overlay.

Commands, routes, and pages are associated resources, not extension points.
A command supplies behavior for a surface contribution. A route selects an
outlet and a page. A page supplies trusted-local content for that outlet. The
manager may join these resources into a point's usage view, but it must not
inflate the point count or describe a command, route, or page as a point.

The distinction is stable even when adapters add new points. The catalog count
is the number of currently declared surface and outlet descriptors, not the
number of plugin contributions or registered resources.

## Host descriptor contract

Every declared point has a host-owned descriptor:

```ts
interface HostExtensionPointDescriptor {
  readonly id: string
  readonly kind: 'surface' | 'outlet'
  readonly title: LocalizedText
  readonly description: LocalizedText
  readonly icon: HostIconToken
}
```

`title` and `description` are retained `LocalizedText`/`MessageRef` values.
They are resolved through the LocalizationKernel at projection time and
reproject when locale or dictionary version changes. A manager list must never
promote the stable id to the visible title merely because a translation is
missing. It uses the message fallback and records the missing key in
diagnostics. `icon` is a host token; plugins cannot replace point identity with
arbitrary SVG, HTML, URLs, or CSS.

Adapters may augment the descriptor catalog, but a runtime declaration without
all five validated fields is invalid. Descriptor ids are unique across both
families. A changed kind for an existing id is an incompatible protocol
change.

The initial catalog contains ten surfaces and three outlets. The message
namespace is `cordisx.manager.extension-points`; the table freezes the message
keys and English fallbacks. Host dictionaries provide localized projections.

| Kind | Stable id | Title message (`key`; fallback) | Description message (`key`; fallback) | Icon |
| --- | --- | --- | --- | --- |
| surface | `sidebar.footer.before-control` | `sidebar.footer.before-control.title`; Sidebar footer before control | `sidebar.footer.before-control.description`; Adds a compact action before the designated sidebar footer control. | `host:open` |
| surface | `sidebar.footer.after-control` | `sidebar.footer.after-control.title`; Sidebar footer after control | `sidebar.footer.after-control.description`; Adds a compact action after the designated sidebar footer control. | `host:open` |
| surface | `sidebar.footer.menu` | `sidebar.footer.menu.title`; Sidebar footer menu | `sidebar.footer.menu.description`; Adds a host-rendered command to the designated footer control menu. | `host:more` |
| surface | `sidebar.navigation.items` | `sidebar.navigation.items.title`; Sidebar navigation | `sidebar.navigation.items.description`; Adds a navigation row with a primary action and optional independent shortcuts. | `host:layers` |
| surface | `workspace.toolbar.items` | `workspace.toolbar.items.title`; Workspace toolbar | `workspace.toolbar.items.description`; Adds an action before, after, or inside the menu of a semantic workspace toolbar anchor. | `host:more` |
| surface | `environment.panel.header-actions` | `environment.panel.header-actions.title`; Environment panel header | `environment.panel.header-actions.description`; Adds a command action to the environment panel header. | `host:settings` |
| surface | `environment.panel.sections` | `environment.panel.sections.title`; Environment panel sections | `environment.panel.sections.description`; Adds a host-rendered section to the environment panel. | `host:layers` |
| surface | `environment.section.actions` | `environment.section.actions.title`; Environment section actions | `environment.section.actions.description`; Adds a command action to a declared environment section. | `host:settings` |
| surface | `environment.section.rows` | `environment.section.rows.title`; Environment section rows | `environment.section.rows.description`; Adds a structured label, value, description, and status row to a declared section. | `host:info` |
| surface | `environment.row.trailing-actions` | `environment.row.trailing-actions.title`; Environment row actions | `environment.row.trailing-actions.description`; Adds an independent command action to the end of a declared environment row. | `host:more` |
| outlet | `app` | `outlet.app.title`; Application page | `outlet.app.description`; Opens a CordisX page over the renderer application region without replacing native content. | `host:open` |
| outlet | `main` | `outlet.main.title`; Main workspace page | `outlet.main.description`; Opens a CordisX page over the region to the right of the sidebar and follows the current main context. | `host:layers` |
| outlet | `session.content` | `outlet.session.content.title`; Session content page | `outlet.session.content.description`; Opens a CordisX page below the active session header while preserving side and bottom panels. | `host:history` |

The catalog owns point identity only. Plugin-provided contribution labels,
command titles, route titles, and page content keep their own owner-qualified
message references.

Surface placement is a host-adapter contract, not plugin metadata. A surface
must resolve to a real native layout seat and must not degrade to a broad fixed
overlay. Failure to resolve a unique seat leaves attributed uses pending and
diagnosable. Outlet placement remains overlay-based and follows the safe-area,
geometry, and context rules in `data-contribution-routing.md`.

## Primary catalog page

The primary manager page lists extension points directly. It does not combine
commands, routes, and pages into a generic engineering inventory. Each row
contains, in order:

1. the descriptor icon;
2. localized title and one concise localized description;
3. the stable id as secondary technical text;
4. a localized `Surface` or `Outlet` kind label; and
5. unavailable or diagnostic state only when it changes the row's meaning.

Selecting a row opens that point's second-level page. Point policy is not
edited inline in the catalog, because an isolated selector without plugin
source identity is ambiguous.

The page has a search field before the list. Matching is case-insensitive over
the current localized title and description, stable point id, kind, host-owned
search keywords, and attributed plugin display names, ids, and canonical
sources. It does not search arbitrary page or README content. Locale changes
recompute the searchable localized fields without losing the query.

Search does not display a result summary, catalog total, in-use count, or row
usage count. The runtime may retain usage cardinality for diagnostics and
compatibility, but the browse UI presents identity, description, kind, and
state instead of aggregate telemetry. A point with only invalid, denied,
blocked, or pending use remains inspectable.

There are two distinct empty states:

- the no-host-descriptors state declares that the current adapter exposed no
  extension points and links the user to diagnostics; and
- no search matches preserves the query, says that no points matched it, and
  offers a clear-search action.

### Scroll ownership

The modal shell, sidebar, page header, and search field remain stable.
The manager content viewport below the header owns vertical scrolling for the
entire catalog and for every point detail page. The list must not grow the
modal beyond the viewport or depend on document/body scrolling. Rows do not
create nested scroll containers. Wheel, trackpad, touch, Page Up/Down, Home/End,
and keyboard focus movement must reach every result, and returning from a point
detail restores the query and prior scroll position.

## Point detail page

The second-level header replaces the primary icon with the standard frameless
back control and names the selected localized point. Its local tabs are:

### Usage

`Usage` is the default tab. It groups records by canonical plugin identity and
shows the plugin mark, display name, source, id, active/blocked state, effective
point policy, and only the resources attributable to this point. It does not
display an aggregate plugin or contribution count:

- for a surface, contribution ids, commands reached from those contributions,
  visibility, target, and render state; and
- for an outlet, routes targeting that outlet, their pages, active mount, and
  current context state.

Multiple contributions by one plugin remain separate rows inside that plugin's
group, but policy is edited once per plugin/point identity. Selecting a plugin
may navigate to its existing detail page; it must not duplicate the entire
plugin manager inside the point page.

### Point information

`Point information` explains the host contract: localized descriptor, stable
id, kind, schema version, supported structured shape or outlet context policy,
current adapter declaration, and availability. Surface information includes
target and placement rules. Outlet information includes compatible path
family, overlay placement, and `contextKey` behavior. It does not list plugin
configuration or Platform capabilities.

### Diagnostics

`Diagnostics` owns information that helps explain invalid, pending, or failed
use: descriptor validation, adapter anchor/outlet availability, unresolved
targets, unknown icons/context keys, missing localized messages, route/path/
page mismatch, policy rejection, mount state, and the latest relevant error.
Diagnostics retain stable ids and machine codes; ordinary titles and
descriptions do not expose those codes as primary content.

## Point policy

The point-policy ledger key is the canonical tuple `(source, pluginId,
pointId)`. It cannot be keyed only by a plugin id, display name, contribution
id, route id, or page id. Source identity is launcher-derived and cannot be
supplied by the plugin.

The stored user choice is:

- `inherit`: use the current host default;
- `allow`: let this plugin use this point; or
- `deny`: reject this plugin's use of this point.

The compatibility default is `inherit`, and the version-1 host default resolves
to `allow`. Existing bundles therefore keep working until the user makes an
explicit narrower choice. A later distribution/activation workflow may add
`ask on activation`; it is an unresolved activation decision, not a per-click
command prompt, and it must not be shown before that workflow can persist and
enforce the answer.

Policy changes reconcile the affected records immediately:

- For a **surface**, `deny` removes the plugin's rendered contributions for
  that point and prevents subsequent projection. Command invocations carry the
  originating surface point and plugin identity; the command dispatcher checks
  the same effective policy as defense in depth. The command registration is
  not deleted and the same command may remain usable through another allowed
  origin.
- For an **outlet**, `deny` rejects matching route navigation and page mount for
  that plugin and point. An already mounted page in that outlet is aborted and
  disposed, revealing the untouched native content. Route and page
  registrations remain available for another allowed outlet where their
  contracts permit it.

Registry snapshots retain denied records and their reason for manager
inspection. Owner disposal,
generation replacement, and context changes continue to apply independently.

Point policy, whole-plugin blocking, and Platform capability policy are
orthogonal gates:

- plugin blocking controls whether the plugin fiber runs at all;
- point policy controls projection or navigation through one host point; and
- Platform capability policy controls calls through `ctx.platform`.

Effective access requires every applicable gate to allow the operation. An
extension-point grant does not grant model/task APIs, and a Platform grant does
not authorize a surface or outlet. None of these cooperative checks confines
trusted renderer code that directly reads or mutates renderer globals.

## Trust boundary

Surface schemas, host rendering, origin checks, route validation, and outlet
mount checks are real enforcement inside CordisX APIs. They reduce accidental
coupling and make cooperative plugins governable. They are not a security
sandbox. Plugins currently execute as trusted renderer code and can bypass
CordisX APIs to touch the renderer. Installation source verification, signing,
an isolated realm, capability RPC, immutable packages, and atomic rollback are
separate prerequisites for treating marketplace policy as a hostile-code
boundary.

## Delivery order and PR boundaries

After this owning architecture PR, delivery remains stacked and independently
reviewable:

1. **Protocol:** `cordisx-protocol` owns the versioned host descriptor schema,
   `LocalizedText` fields, point-policy values and identity, origin metadata,
   validation rules, and conformance vectors.
2. **Runtime:** `cordisx` owns descriptor and policy ledgers, adapter
   declarations, locale reprojection, surface command-origin enforcement,
   outlet route/page enforcement, reconciliation, and snapshots. It does not
   include manager layout.
3. **Manager:** a following `cordisx` PR owns the searchable scrolling catalog,
   second-level tabs, policy controls, diagnostics projection, accessibility,
   and regression tests against the runtime snapshot.
4. **Live smoke:** the compatible runtime and manager are exercised in an
   isolated real `app://` renderer, without modifying the installed app.
5. **Mono:** after owning repositories are pushed, CI is green, and the
   compatible set is verified, one separate CordisXMono PR pins exact gitlinks.

Do not combine the protocol and host histories, update the mono pointer before
owning commits are reachable, or describe a manager-only selector as enforced
policy.

## Validation matrix

| Layer | Required evidence |
| --- | --- |
| Protocol | Schema acceptance/rejection for both kinds; all descriptor text retained as message references; unique ids; host icons; tuple identity; `inherit`/`allow`/`deny`; origin and outlet enforcement vectors; compatible default allow. |
| Runtime | Exactly thirteen built-in descriptors; locale and dictionary reprojection; adapter augmentation and invalid declaration diagnostics; retained usage attribution; source identity non-spoofing; surface render plus command-origin denial; outlet navigation plus active-page disposal; plugin block, capability policy, context, and generation orthogonality. |
| Manager | Search every declared field without aggregate/result counts; both empty states; one content scroll owner; list/detail/back query and scroll restoration; localized names and descriptions; `Usage`/`Point information`/`Diagnostics` tabs; policy controls keyed by source/plugin/point; keyboard, focus, tab, list, and accessible-name semantics. |
| Live renderer | Scroll to the final point; filter by localized title, stable id, and plugin; open each point kind; change allow/deny and observe surface disappearance/restore plus outlet close/reopen rejection; keep native React nodes visible, connected, and updating; capture screenshots and a machine-readable report. |
| Mono | Exact pushed protocol and runtime/manager revisions, clean registered submodules, public modules initialized, private roadmap still `update = none`, and no unrelated pointer changes. |

Screenshots are product evidence, not a substitute for assertions. A passing
manager rendering test is not proof of runtime enforcement, and a denied
structured operation is not proof that trusted renderer code is isolated.
