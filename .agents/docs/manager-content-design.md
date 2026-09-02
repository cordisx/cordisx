# Manager content design

This document is the single design-guideline entry point for CordisX
manager-owned pages and projections. It applies to built-in runtime, Platform,
marketplace, configuration, and future manager slices. Product-specific
documents may define their data and operations, but they must not redefine the
content hierarchy below.

## Semantic hierarchy

Manager content has one active semantic context at each level:

1. the primary page title identifies the manager area;
2. an optional breadcrumb identifies a selected record;
3. an optional selected tab identifies the record facet;
4. body groups introduce only dimensions not already named above.

Once a title, breadcrumb, or tab establishes a subject, descendants must not
repeat that subject or prepend a source name merely to restate it. For example,
the plugin `权限` tab must not add a `Platform 权限` body heading, `配置管理`
must not add `插件配置`, and a plugin detail header must not repeat the plugin
name inside `运行状态`.

Embedded plugin-owned documents such as README content retain their own
document outline. The manager does not rewrite third-party headings to imitate
host navigation.

## Structured navigation and breadcrumb ancestry

The Host owns one structured `ManagerRouteState` and derives one
`ManagerPageRoute` from it. A page route has a stable page id, primary area,
record identity where applicable, selected facet, optional leaf identity, and
an ordered ancestor chain. Breadcrumb DOM is projected only from that chain.
Plugins may contribute localized settings-tab data and a same-owner route/page
reference through the existing structured contracts, but they never receive a
breadcrumb container, create breadcrumb nodes, or concatenate a display path.
Plugins may also contribute a first-level Settings-adjacent route through
`manager.settings.navigation-items`; route-v2/page-v3 metadata is projected
into the same Host-owned history, breadcrumb, and standard header model. The B
item itself contains no display metadata or DOM.

The semantic path includes every page context needed to return to the current
leaf:

- primary pages use one current segment, such as `插件`;
- installed-plugin facets use `插件 / 插件名 / README`, `配置管理`, `权限`,
  `运行状态`, `扩展点位`, or `路由` as the current segment;
- permission leaves use `插件 / 插件名 / 权限 / 能力名`;
- extension-point facets use `扩展点 / 点位名 / 使用情况`, `点位信息`, or
  `诊断`;
- a route detail uses `路由 / 路由名`;
- marketplace facets use `插件商店 / 插件名 / 概览` or `作者与来源`, while
  source tasks use `插件商店 / 商店来源 / 新增来源` or a source name; and
- settings facets use `配置 / 插件商店`, `运行状态`, `启动器`, or the
  current localized external settings-tab title.

The selected facet is not repeated as a body heading. It appears as the
current breadcrumb segment and as the selected tab label because those two
controls serve different navigation and tab-selection semantics. The current
breadcrumb item is text with `aria-current="page"`; it is never a link or
button. Every preceding segment is a Host-owned button that navigates to that
exact structured ancestor. A record ancestor resolves to its stable default
facet (`README`, `使用情况`, or `概览`), while a primary ancestor resolves to
its browse page and restores that page's query and scroll state.

The leading back control is present whenever the route has more than one
segment. It follows the manager's internal history stack rather than assuming
that the immediate structural parent was the previous page. Opening a record,
opening a permission leaf, selecting a primary area, and explicitly choosing
an ancestor each create a normal history entry. A Host-rendered sibling tab in
one `manager.content` tabset is different: click, Enter/Space, Left/Right, and
Home/End activation replace the current Manager route entry. Back therefore
returns to the route visited before entering that tabset instead of walking
through previously selected sibling facets. Direct entry to a detail facet,
plugin page-body navigation, and cross-page navigation remain normal push
operations. Manager navigation never changes `app://`, calls `window.history`,
invokes the Codex router, or mutates native Codex route state, so native Host
Back/Forward state is unaffected by these replacements.

Breadcrumb overflow is also a Host projection. When every segment fits, the
complete path stays inline. When it does not fit, the root and current segment
always remain visible, the nearest fitting ancestors remain visible from the
current page outward, and the omitted middle ancestors move into one
structured ellipsis menu in their original order. The menu uses real buttons
with the same ancestor targets. CSS clipping, text replacement, or silent
ancestor removal is not an overflow strategy.

Route validity is reconciled against every new Manager snapshot:

- plugin block or restore keeps built-in plugin detail routes inspectable, but
  an active A/content-tab page falls back to `配置 / 插件商店`, while an active
  B/first-level plugin destination falls back to Host `配置`; neither steals
  activation when restored;
- owner disposal or generation replacement aborts active external content
  before disposal and replaces a missing leaf or record with its nearest
  surviving ancestor without adding a history entry;
- locale reprojection replaces segment labels from the current structured
  snapshot without changing page identity, history, query, or scroll state;
- an unavailable permission, extension point, route, marketplace record, or
  settings tab similarly falls back to its nearest surviving ancestor; and
- closing the dialog records no navigation entry. Host-owned routes and list
  state remain available for reopening, while the existing settings-content
  lifecycle still aborts external content and resets that surface to the
  built-in marketplace fallback before it can mount again. B also aborts and
  disposes on close, but may retain its structured selected route and remount
  it on reopen only while every current eligibility gate still passes.

Queries, filters, and list scroll offsets belong to their primary browse page,
not to a breadcrumb label or DOM node. Re-render, locale changes, leaf
navigation, history Back, explicit ancestor navigation, dialog close/reopen,
block/restore, and generation reconciliation must not clear them unless the
user explicitly edits or clears the filter.

## Groups and titles

A single content group is presented directly, without a section title that
only renames the active page or tab. When a page contains multiple groups,
each visible group title must add a new distinction such as `能力声明`,
`宿主连接`, `本地化`, `结构化运行时`, or `关键词`.

The same fact appears once, closest to the control or state it explains.
Breadcrumbs, tabs, groups, records, notices, and footers must not progressively
restate it. A diagnostic, blocked reason, adapter fact, or security boundary is
attached to its owning group and is not repeated as a general page notice.

The installed-plugin `路由` facet is the intentional multi-group case. It
projects separate `路由` and `页面` sections, each as one rounded Host-owned
group card with row dividers. Route rows lead with the current-locale product
title and one or two lines of purpose, followed by canonical path, outlet,
associated page, named parameters, contribution identity, and owner. Page rows
lead with the current-locale title and content/context description, followed by
canonical page id, the outlets derived from referencing routes, and the
`standard` or `body-only` chrome value. Machine identity is never translated
or repeated merely to fill a visual row.

The product title and description come only from the route/page structured
metadata and the shared localization kernel. Search indexes their current
locale projection plus path, outlet, parameter, page/contribution identity,
and owner, and reprojects immediately after locale change. Legacy records that
lack metadata use the stable id and a restrained localized `未提供说明` / `No
description provided` fallback. The same row exposes a muted author diagnostic;
the Host never guesses purpose from a path, outlet, mounted DOM, or plugin
implementation. Normal route/page rows have no type or availability badge.
Only invalid, denied, missing-metadata, or unavailable state adds concise
diagnostic text.

## Configuration task surfaces

The default plugin `配置管理` panel is a user task surface, not an implementation
inspector. In its normal state it contains only settings the user can act on,
their product-facing labels and help or validation text, the Host-owned control
or renderer seat, and necessary save, reset, unavailable, and operation-error
feedback. It stays flat and compact; it does not wrap fields in summary cards or
repeat the selected tab as a body heading.

Schema implementation, application mode, revision, last-good state, writer
availability, generation, and raw field paths are diagnostic facts. They do not
occupy the normal configuration panel. Stable configuration diagnostics may
appear inside the existing collapsed `运行状态` diagnostic disclosure; a
conflict or failed write may expose only the facts needed to resolve that error
beside the affected operation.

Field labels use developer-supplied product text when available and otherwise
fall back to a readable projection of the final field-path segment. The raw
path/key is never shown beside that label in the default form. A schema may
show a stable, product-facing disabled value in the same Host-owned field row;
it has no save/reset action or custom renderer seat. Secret and credential
roles remain visible only as a single Host-owned unavailable state: their value
and path do not enter a normal control, custom renderer, or repeated summary
notice.

## Tabs and panels

Local tabs use `role="tablist"` and `role="tab"` with an accurate
`aria-selected` state. The active body uses `role="tabpanel"` and an accessible
name matching the selected tab. Only the active panel is present in the
manager-owned content DOM.

A tab panel is a semantic container, not a visual card. It must not add a
border, background, or redundant heading merely to make the panel visible.

Local tabs pair every label with a host-owned semantic icon. The icon is part
of the structured tab descriptor, is hidden from accessibility APIs, and is
rendered directly without its own border, background, chip, or card. The label
remains the accessible tab name and the shared rounded active background is
the only persistent selection accent. Local tablists use the horizontal ARIA tabs
keyboard pattern: only the active tab has `tabindex="0"`; inactive tabs use
`tabindex="-1"`; Left/Right wrap and activate the adjacent tab; Home/End
activate the first/last tab. After an activation re-renders manager-owned DOM,
whether by pointer, Enter, or navigation key, focus is restored to the
replacement active tab rather than falling back to the document body. Icons
and focus restoration must not cause tab geometry to jump between panels.

All local tablists share one leading inset. The left edge of the first tab's
icon aligns exactly with the page-header leading seat, including installed
plugin detail, marketplace detail, settings, extension-point detail, and any
future tabbed page. Tab icons and header icons use the same zero-line-height
grid and optical vertical adjustment; fixing one page with a local padding
override is forbidden.

The top-level `配置` tablist may merge host built-ins with external structured
`manager.settings.tabs` contributions. This does not transfer tab rendering to
plugins: CordisX still owns the complete tablist and panel semantics above.
External page code mounts only inside the active
`manager.settings.content` panel-body child. Ordering, fallback, point policy,
route/page ownership, lifecycle, and protocol versioning are defined in
[`manager-settings-tabs.md`](manager-settings-tabs.md).

These are A/content tabs. A B/navigation item is a sibling in the left primary
navigation and opens a complete standard page in `manager.content`; it never
appears in this tablist. Its route-v2 title/description label the navigation
destination, and its page-v3 title/description/required Host icon label the
standard header. See
[`manager-settings-navigation.md`](manager-settings-navigation.md).

### Manager Content child routes

`manager-content-navigation.v1` and v2 are the only plugin-to-Host declarations
for a B subroute. They contain an exact same-owner route reference, optional
parent route, a route or renderer-safe-record header title, and exact sibling
tab route references; v2 may additionally localize a tab label. They contain
no DOM, CSS, callbacks, URLs, secret data, history policy, or arbitrary header
action. The Host resolves and validates the declaration, then owns its
breadcrumb/back/history behavior, title, description, and tablist. Every
sibling tab declared by the resolved tabset uses the replace semantics above;
the wire shape stays unchanged and plugins cannot opt into push-per-tab
history. The plugin receives only the active page-body seat plus bounded
navigation helpers; therefore a detail page must not recreate a title, back
button, or tabs inside that seat.

When a writable Host mutation adds or removes a record, the owner replaces its
record-title catalog and exact child-route declarations as one atomic
projection. Observers must never receive an intermediate catalog without the
currently visible record: that would cause the Host history normalizer to
discard a valid detail route. Display labels are renderer-safe presentation
data, never route identity or credential material.

## Page headers

Every primary page reserves the same fixed-width leading seat immediately to
the left of its title. Any structured route with more than one breadcrumb
segment replaces the icon in that seat with an icon-only history-back button.
The title never moves when navigation depth changes.

The title occupies the first row. A primary page may add a distinct purpose
description on its own second row, aligned with the leading icon or back
control. Breadcrumb detail pages omit generic duplicate subtitles: their
complete breadcrumb is the product identity. Before collapsing any ancestor,
the Host measures the labels' intrinsic width; only real width pressure adds
the explicit, navigable overflow control.

Leading icons are rendered directly in a transparent 26-pixel seat. They do
not use a persistent border, background, chip, or rounded frame. The back
control follows the same frameless resting appearance while retaining a real
button target, an accessible `返回` label, and silver-grey hover and
`focus-visible` feedback that does not change its dimensions.

The close control is likewise a centred 30-pixel Host seat with a transparent,
borderless resting state. Its 18-pixel glyph is decorative inside the one
button target; hover and focus—not idle chrome—supply the surface feedback.

## Icon system

Manager-owned non-brand icons come from the rounded, weight-400 Material
Symbols SVG set in `@material-symbols/svg-400`. Every symbol is imported by its
individual SVG path and inlined into the renderer bundle at build time. The
manager does not load an icon font, request a network asset at runtime, or
bundle the complete icon catalog. CordisX brand marks are explicitly outside
this mapping and continue to use the official assets described below.

The semantic mapping is stable and host-owned:

| Manager meaning | Material symbol |
| --- | --- |
| plugins | `extension` |
| contributions and routes | `hub` |
| marketplace | `storefront` |
| settings page | `settings` |
| plugin configuration | `tune` |
| document / README | `description` |
| permissions | `shield` |
| runtime status | `monitor_heart` |
| outlets | `account_tree` |
| launcher | `rocket_launch` |
| enable, disable, reload, and favorite | `play_circle`, `pause_circle`, `refresh`, `star` / `star_outline` |
| overflow, share, and uninstall | `more_horiz`, `share`, `delete` |
| read models | `model_training` |
| list, read, create, and control tasks | `view_list`, `summarize`, `note_add`, `tune` |
| submit and control turns | `send`, `pause_circle` |
| back, disclosure, search, close, and external link | `chevron_left`, `chevron_right`, `search`, `close`, `open_in_new` |
| plugin favorite and overflow | `star`, `more_horiz` |
| unknown capability fallback | `help` |

All of these symbols are decorative beside a visible label or an
accessible-name-bearing control. Their wrappers and SVGs use
`aria-hidden="true"`, `focusable="false"`, `pointer-events: none`,
`user-select: none`, `-webkit-user-select: none`, and
`-webkit-user-drag: none`. Image-backed brand marks additionally set
`draggable=false`. Interaction, keyboard focus, tooltip semantics, and ARIA
names remain on the owning button, link, tab, or list item; an icon never
becomes a second hit target.

Material SVGs use `currentColor` and a zero-line-height grid wrapper, not the
text baseline. Header titles vertically center within the same 26-pixel row as
the leading seat, and the 18-pixel leading SVG receives one shared half-pixel
upward optical adjustment. Primary icons and back controls therefore occupy
identical geometry without making the title jump between navigation levels.

## Primary navigation, identity, and accent

The primary navigation leads with the product's principal workflow. `插件`
is the first item, followed by separate `扩展点`, `路由`, `插件商店`, and
`配置` areas. Their stable ids are `plugins`, `extension-points`, `routes`,
`marketplace`, and `settings`; the old `slots` / `贡献与路由` page is retired.
`关于 CordisX` (`about`) is the only item anchored to the bottom of the
navigation. Extension points mean host-declared surfaces and outlets. Routes
and pages are associated resources and therefore have their own primary page.

External B rows do not redefine those Host ids. `before-settings` rows follow
Marketplace and precede Settings; `after-settings` rows follow Settings and
precede bottom-anchored About. Each group sorts by order, owner, then qualified
id. Their row glyph and standard page-header glyph share the required page-v3
Host icon as one source of truth.

The sidebar begins directly with primary navigation. It does not contain a
separate `CORDISX` eyebrow, manager title, version, or logo block. Product
identity and runtime version belong to the About page, where the first content
row presents one direct CordisX mark beside `CordisX` and the current version.

The CordisX mark on the host-side manager trigger uses a 20-pixel visual size
inside its unchanged button target. Inside the manager, the same mark is
allowed only where it identifies the About area: the
bottom-anchored About navigation item, the About page header leading seat, and
the single About identity row. These marks are rendered directly without a
decorative container. Other primary pages use their own host-owned semantic
icons, while secondary pages use the back control.

Brand rendering preserves the official asset rather than approximating it.
The host-side manager trigger and every Manager About mark observe the host
root's `electron-dark` / `electron-light` theme projection and select the
matching official direct SVG. Theme changes update every already-mounted mark,
including an open dialog, and newly rendered/reopened Manager content begins
with the current Host projection. Every placement therefore retains the same
continuous per-segment grey depth shading and never flattens it into a
monochrome mask, recolors it with `currentColor`, redraws its paths, or adds a
frame or background.

The About body is a concise product hub, not a runtime dashboard. Its identity
is one horizontal row: the official mark occupies the left seat while the
`CordisX` name and dynamic runtime version form a non-wrapping copy column on
the right. After that row it exposes flat, actionable links such as issue
feedback, contribution, and documentation. It does not repeat manager
diagnostics, plugin counts, routes, outlets, locale metrics, trust notices, or
blocking semantics that belong to their owning pages.

Each About action is one full-width anchor row inside the same rounded Manager
group-card boundary. The anchor—not its title span—is the pointer,
`:focus-visible`, and open unit. Title, description, and the decorative
external-link icon stay inside that hit target and retain transparent child
backgrounds; hover/focus applies one low-contrast Host-token background to the
complete padded row and raises the icon foreground without moving it. Row
separators remain outside the hover paint, the first/last row keep the group
inset and radius, and narrow layouts clamp copy without horizontal overflow.

Every manager-owned external link uses ordinary browser navigation with
`target="_blank"` and `rel="noopener noreferrer"`. Its click handler only
synchronously hides the manager modal and sets the host trigger's
`aria-expanded` to `false`; it does not cancel the default event, stop
propagation, call `window.open`, or restore focus to the obscured trigger. This
rule covers About links, marketplace author/source/homepage/manifest/icon
links, feed provenance, and future external destinations.

## Search and browsing lists

Search is a direct filter, not a dashboard. Plugin, extension-point, route,
and marketplace browse pages do not display result totals, ratios, aggregate
usage counts, feed summary chips, duplicate counts, or per-row usage counts.
Source health in configuration keeps only the source name and loading/loaded/
failed state; it does not expose a feed plugin count. Stable status, version,
source name, and diagnostics remain where they describe the current record.

Search query and scroll position are page state. Opening a second-level record
and returning restores both. The manager content viewport is the single
vertical scroll owner; page headers, primary navigation, and local tab rows do
not create competing vertical scroll containers.

## Installed and marketplace plugin details

Installed-plugin details use local tabs in this order: `README`, `配置管理`,
`权限`, `运行状态`, `扩展点位`, and `路由`. `扩展点位` includes only the
surface/outlet descriptors used by the plugin and their attributed
contributions. `路由` owns routes, pages, and outlet associations. The runtime
tab does not repeat route or page inventory.

Marketplace detail reuses the same local-tab component, breadcrumb/back seat,
roving tabindex, focus restoration, and panel semantics. Discovery v1/v2/v3
exposes only two honest facets: `概览` for description, version, compatibility,
license, keywords, and any Host-validated trust provenance; and `作者与来源`
for authors, source, optional homepage, manifest/icon links, and feed
provenance. Version 2 introduced localization for human-facing feed metadata;
version 3 adds immutable artifact identity plus a separate protected trust
contract. The Host reprojects name, description, author/publisher display
name, keywords, and feed source display name from its cached structured feed;
stable id, version, canonical source, artifact URL, and integrity remain raw
machine values. Current-locale and fallback/English projections are searchable,
and a locale change never reloads the feed.

Marketplace browse keeps the Manager header and Host search fixed. Filter
chips render on their own row immediately below search, and the compact result
grid is the only vertical scroll owner. The primary browse surface contains no
documentation CTA or ranking-policy prose; those explanations remain in
detail, diagnostics, or owning documentation. Source management is a
low-frequency Host action under the heading overflow menu; it opens a separate
breadcrumb page and never competes with search, filters, or results.

Marketplace does not host, build, publish, copy, or execute plugin code. Plugin
source and package artifacts remain in their owning repositories. `Official`
publisher identity and exact-artifact `CordisX Certified` review status are two
independent v3 dimensions accepted only from the configured protected
Marketplace trust root. Browse projects their current combined state through
the Host status indicator on the icon; detail keeps the dimensions separate
with independent evidence and policy copy. Neither is a free-standing card.
The chip row may filter to active Certified records. Search
first removes Host-projected incompatible, invisible, and policy-blocked
records, then preserves text-relevance tiers; Official and Certified each add
at most one point inside the same tier, followed by a stable canonical-identity
tie break. Detail copy includes the policy version, exact digest for Certified,
evidence reference, non-guarantee language, and the protected-merge-chain/
no-cryptographic-attestation boundary. The catalog does not synthesize README,
permission, extension-point, route, runtime, install, or activation facets when
their owning contracts do not provide them. Neither trust dimension changes
PermissionBroker, sandbox, lifecycle, Package Store, or installation review.

Manager-owned interaction accents use a neutral silver-grey palette for
selected navigation, local tabs, icons, focus rings, hover backgrounds, links,
and interactive borders. Purple is not a manager accent. Semantic status
colors remain independent: green for success/active, yellow for warning or
waiting, and red for failure, denial, or destructive affordances.

## Compact collections, rows, and settings

Every dynamic Manager catalog whose records have a whole-item detail
destination follows the Host-owned compact collection pattern. A normal item
has exactly one primary whole-card detail target, activated by pointer, Enter,
or Space. It never carries a trailing chevron, arrow button, or any other
second navigation affordance: navigation is already expressed by the card's
accessible name and focus/hover treatment. Installed plugins, extension
points, routes/pages, and Marketplace browse records use this pattern.
TDesign settings forms, permission controls, provider rows, and Marketplace
source reorder controls remain semantic grouped rows because they are controls,
not whole-card detail destinations. Marketplace reaches those source controls
through `更多插件商店操作 / 管理商店来源`, not a primary browse button.

A chevron is reserved solely for an in-place disclosure. Its owning control
must expose `aria-expanded`, reference or contain real independently visible
expanded content, and have behavior distinct from route/detail navigation.
It must never be a decorative route cue. Remove unused chevron DOM, handlers,
and test assumptions instead of hiding the icon in CSS.

The card action layer contains only Host-owned shortcut controls. It is
absolutely positioned over the top-right of the content, so it never reserves
copy width, changes wrapping, or shifts adjacent cards. Each shortcut stops
propagation for pointer and keyboard activation, has an accessible name,
no-drag/decorative icon treatment, and visible hover/focus/disabled feedback.
The layer is visually hidden at rest and shown on hover, `focus-within`, or an
open menu while remaining in the tab order. Menus restore focus to their
trigger when it survives the close, and menus and tooltips stay within the
viewport.

The Host uses one Manager Material icon-control primitive for clear, familiar
actions such as importing a local package, pausing or resuming Console capture,
following the newest Console entry, clearing/copying Console output, and closing
a transient Console surface. Each control has one fixed hit target, a decorative
bundled Material glyph, an `aria-label`, a Host tooltip, no-drag semantics, and
the same hover, keyboard-focus, disabled, and light/dark behavior. Keep a
visible text label for primary CTAs, ambiguous actions, and destructive or
permission confirmations; an icon must never hide the information needed to
understand a record or consequence.

Card collections use bounded `auto-fill` tracks rather than a fixed two-column
grid: the minimum is 220 pixels when available and the maximum is 360 pixels.
Narrow content becomes one column; medium and wide content add columns from
actual available width. Enable/disable, favorite, reload, and the overflow
trigger use deterministic direct-action priority. Share, public source,
diagnostics, and uninstall live in the Host-owned overflow menu without
squeezing the plugin name or state. Closing the menu restores focus to its
trigger when it remains connected, and both menu and tooltips are constrained
to the manager viewport.

The collection's scroll viewport may fill its available panel height, but its
grid aligns content at the start and every card is content-height. Unused space
therefore remains below a short result set; grid or flex stretch must never
turn three plugin cards into viewport-height columns. Compact catalog, route,
and page seats use one shared 22-pixel icon seat and 16-pixel decorative glyph
token. The seat is never an icon button, and its status dot must not outweigh
the title or create a second interaction target.
Unavailable lifecycle operations are absent or explicitly unavailable; a
button must never restart the launcher while claiming to reload one plugin.
A launcher-configured legacy plugin remains explicitly unavailable for package
generation actions; its block/restore behavior must not be relabeled as
package install, reload, generation replacement, or uninstall.

Favorite is a current-profile manager preference. Share requires a validated
public canonical HTTPS source and never projects a local source/store path,
configuration, or secret. Uninstall is destructive and remains behind a
second Host-owned confirmation containing the reverse-dependency impact.

The overflow popup is a Host-owned `menu` portal with Host-created Material
Symbol icons and `menuitem` controls. Its visible items include sharing and
opening the validated public canonical source, runtime diagnostics, and
uninstall. Disabled menu items retain `aria-disabled`, an exact
unavailability reason, and no listener that claims execution. In particular,
missing Package Store generation metadata, a missing lifecycle bridge, and a
missing/non-HTTPS canonical source are distinct availability states, not a
generic inert menu.

The menu is mutually exclusive with card navigation: trigger/item pointer and
keyboard events do not bubble into the row body. A second trigger activation,
outside pointer/click, Escape, executing an item, route/card switch, manager
close, runtime snapshot reconciliation, generation disposal, or a removed
anchor closes and removes the portal. Arrow keys, Home, End, Enter, and Space
operate enabled visible items; resize and scroll reposition the menu while an
intact anchor remains, otherwise they close it safely. Focus returns to the
trigger when that trigger survives the close; destructive confirmation then
owns focus normally.
The lifecycle broker is the sole source for product operation state: install
and upgrade render `source snapshot/candidate → plan → permission review →
generation-fenced activation → readiness → commit last-good`; an unresolved or
denied required permission never activates. Reload renders the formal
five-level ladder, while uninstall reports the actual `drain → dispose → lease
→ GC` outcome after confirmation rather than an optimistic completion.
The current v1 `导入` action accepts one user-entered absolute local package
directory and states that remote download, signing, and sandboxing are not
available. It never presents a browser directory picker as a native absolute
path chooser, lets a renderer write activation/config files, or loads an
arbitrary path directly; the launcher performs inspect/stage, authorization,
readiness, and atomic activation. The list toolbar keeps the Host search field
and import button at the same control height.

Installed-plugin status is a Host-owned badge on the icon's lower-right corner,
not persistent status copy mixed with the plugin id. Hovering or focusing the
whole-card detail target opens the Host tooltip with the exact lifecycle label
and, for failed or blocked states, the actual bounded failure reason. The text
stack is name, product introduction, then the stable machine id.

Every shared Manager local tab row, including installed-plugin details,
extension-point details, Marketplace details, built-in settings, and contributed
settings, uses the same rounded-button family as primary navigation. Selection
is a background highlight; there is no underline. Icon geometry, label gap,
roving tabindex, and focus treatment are shared across every call site.

Extension-point usage is a compact left-aligned list. Each plugin row shows its
product name, introduction, and necessary id once; source and status strings do
not repeat in the primary copy. Structured contributions form a separator-based
sublist with current-locale name, optional description plus actual state, and
the unmodified contribution id. Routes use the same pattern. There are no tag
chips, placeholder cards, decorative chevrons, or empty grid columns. Both the
usage list and plugin-specific extension-point/route lists use the common Host
search component and keep query state per record.

### Search is part of the list pattern

Every dynamic, user-manageable, or potentially growing list gets the common
Host search component by default. This includes plugin, Marketplace, extension
point, route, permission/capability, source, dependency, and call-log lists.
The component is rendered only by the Host; a plugin supplies structured,
authorized searchable fields and never contributes search DOM. A short,
fixed, non-growing metadata list may omit it only when its call site declares
`searchable: false` with a product reason; a current item count is never a
reason to omit search.

The component has one standard placement before its list, a Material `search`
icon, clear control, Escape-to-clear behavior, keyboard focus ring, and an
accessible label. It searches the applicable localized title/name, id,
description, owner, source, capability, and declared keywords using
case-insensitive NFKC and whitespace normalization for Chinese and Latin text.
Matches are highlighted without changing the source text. Search never shows
aggregate/result-count UI, reads unapproved fields, or triggers a permission
request.

Query, filter, sort, and scroll position are page/route state: returning from
detail restores them, while separate plugin or source contexts never share
them. Large sources must debounce and use an index or virtualization; async
providers cancel or fence stale queries and distinguish loading, error,
unconfigured, and no-match states. Current Manager lists are synchronous,
bounded Host snapshots; their common component keeps the same state boundary
when an async provider is introduced.

Ordinary Manager detail catalogs use the compact responsive collection.
Settings/configuration pages instead use a macOS System Settings information
architecture: a centered, limited-width body; semantic section title and only
necessary section copy; one rounded group card per section; label/help on the
left and the Host control on the right; and fine separators between related
rows. A capability declaration is a grouped setting row whose host-owned,
localized product name is the visible label. Its primary row contains only a
frameless semantic icon, name, one-sentence reason, a `必需` badge when
applicable, and an official TDesign Select/Option policy control. Runtime
availability never replaces or disables policy editing. Optional declarations
do not need an `可选` badge.

`日志与诊断` is an operational viewer only: its toolbar contains the log
search/filter/pause/export controls and its Luna Console body owns all remaining
tabpanel height and scroll. Invocation counters, denials, performance/usage,
and runtime lifecycle or ownership diagnostics belong in `运行状态`, not beneath
the Console. Plugin README fenced code is safely projected by Host-owned Shiki
token spans using the current Host light/dark theme; inline code stays compact
and code blocks do not receive an extra card wrapper.

The primary permission list never exposes capability ids, scope objects,
audit counters, blocked reasons, adapter diagnostics, transport facts, raw
bridge facts, or the trusted-renderer security boundary. Selecting the item
opens a third-level permission detail (`插件` list, plugin detail, permission
detail). That page owns the capability id, non-empty requested scope, current
run audit, required/optional status, host support state, and policy control.
Policy remains editable there when the host currently reports the capability
as unsupported, so a denied required declaration can be recovered without a
host-adapter state change.

Host connection, adapter, bridge, and trusted-renderer engineering facts live
in the plugin `运行状态` tab under one collapsed `诊断` disclosure. The summary
is concise; raw diagnostic codes and security-boundary detail are visible only
after the user expands it.

Cards are reserved for a genuine independent boundary: a settings section,
separately
actionable source, an independently mounted outlet or contribution, an
isolated status summary, or content whose background/border conveys state. A
card must not be placed inside another card solely to reproduce page, tab, or
section hierarchy. In particular, permission policy controls must not be
nested in `.cxm-slot-card` or a redundant detail card.

## Empty, multi-source, loading, and error states

De-duplication must not remove the context needed to understand exceptional
states:

- An empty message names the missing subject and identifies any remaining
  group that is still available.
- Multi-source views label the source dimension locally. Permission
  declarations and the current host connection, for example, are separate
  groups rather than one `Platform 权限` wrapper.
- Loading and errors stay beside the record, source, or operation that owns
  them. The same error is not copied into a page-level summary.
- Security and trust boundaries appear once, beside the operation or adapter
  facts they qualify. Removing repetition must never imply stronger isolation
  or capability enforcement than the runtime provides.

## Accessibility and regression evidence

Manager changes must audit all affected primary pages, secondary details, and
local tabs rather than checking only a screenshot. DOM regression tests assert
the visible manager-owned heading sequence and stable panel/list structure.
At minimum they prove:

- the `权限` tab contains no `Platform 权限` or `能力声明` heading;
- every capability policy uses the shared official TDesign Select adapter
  inside its group-card row, not a native `select`, `.cxm-slot-card`, or plugin
  renderer; unsupported runtime availability remains a secondary status and
  does not remove the policy control;
- permission items use host-owned names and semantic icons, expose only a
  `必需` badge, and hide ids, scope, audit, blocked reasons, adapter facts, and
  security notices until their owning deeper or diagnostic view;
- permission detail is a third-level page whose back control restores the
  plugin's selected `权限` tab, and it retains an editable policy even when the
  capability is unsupported;
- adapter diagnostics and security notices appear once inside the collapsed
  `运行状态` diagnostic disclosure;
- a plugin with no declarations retains an explicit permission empty state;
- configuration and launcher tabs do not repeat their selected tab label; and
- configuration panels expose no persistent schema, application-mode,
  revision, last-good, writer, generation, or raw-path metadata; those facts
  remain available only in the collapsed runtime diagnostics or an owning
  conflict/error state;
- editable configuration fields present one product label, never a second raw
  key/path, and plugins without an editable structured form show one concise
  empty state rather than raw JSON or schema implementation prose;
- Host-owned secret/credential unavailable states remain single, redacted, and
  unavailable to custom renderers;
- a static production-renderer scan fails on Host-owned native `select`
  creation, and runtime smoke records zero native selects in Manager Host UI;
- installed-plugin rows have no detail chevron, keep navigation and action
  activation mutually exclusive, support pointer/Enter/Space navigation, and
  preserve the deterministic enable/reload/favorite overflow priority;
- Marketplace browse cards reuse the Host collection structure: fixed Host
  icon, vertically ordered localized
  name/description, compact version/source metadata, whole-card
  pointer/Enter/Space navigation, no chevron, and no permanent generic trust or
  installability warning below the browse list;
- extension-point and route/page catalog cards use the Host compact collection
  icon seat and glyph token, rather than page-specific enlarged artwork. The
  decorative icon is never a control or a nested hit target; route/page detail
  rows use the same token. Extension-point cards retain three text levels
  (localized name, localized description, selectable stable id), while type
  and normal-state tags are absent. Only pending/unavailable/error emits a
  concise same-row diagnostic target that never becomes an orphan second grid
  row at constrained width. A catalog whose active breadcrumb already names
  its destination does not add a duplicate header subtitle;
- overflow restores focus, stays within the manager viewport, keeps uninstall
  behind dependency-aware confirmation, and exposes share only for a safe
  public canonical URL;
- empty/search-filtered lists and active, blocked, failed, installing, updating,
  enabling, disabling, reloading, rollback, and uninstalling states retain one
  stable product-facing label without raw lifecycle metadata;
- plugin and marketplace detail bodies do not repeat the breadcrumb record
  name in manager-owned headings.
- primary navigation exposes separate `扩展点` and `路由` pages; installed
  plugin detail exposes separate `扩展点位` and `路由` tabs, while runtime does
  not repeat route/page inventory;
- plugin, marketplace, extension-point, and route browse pages contain no
  aggregate count or result-summary UI, and marketplace source health contains
  no plugin count;
- marketplace detail has exactly `概览` and `作者与来源` tabs and does not
  present unsupported install/runtime/permission/README facets;
- every manager-owned external link preserves uncancelled default navigation,
  carries safe target/rel attributes, and synchronously hides the modal without
  forcing focus back to the manager trigger;
- primary navigation begins with Host `插件`, keeps `配置` in the main group,
  projects B entries only in their before/after Settings group, and anchors
  `关于 CordisX` at the bottom;
- the modal sidebar begins with navigation and contains no identity block;
  About alone uses the CordisX mark in its navigation item, header seat, and
  identity row; those three marks, like the host-side trigger, directly render
  the official Host-theme-matched asset with its multi-grey depth shading;
- the About identity uses the runtime version, its action links have verified
  public destinations and safe external-link attributes, and the old runtime
  metric grid and generic boundary copy are absent;
- every About action uses the whole padded anchor row for hover/focus/open,
  while title/copy remain transparent and the icon strengthens inside the same
  interaction target;
- every local tab has one decorative semantic icon and an unchanged accessible
  label, with no icon frame; roving tabindex, wrapped arrow navigation,
  Home/End, and focus restoration survive manager re-rendering; the first icon
  in every tablist shares the header leading seat's exact horizontal origin;
- non-brand icons resolve to the documented per-icon Material Symbols imports,
  contain no Unicode placeholder glyphs, remain hidden from accessibility APIs,
  and cannot be selected, dragged, focused, or intercept pointer activation;
- primary and breadcrumb headers keep a fixed 26-pixel frameless leading seat,
  optically center its SVG with the title row, align the second-row description
  with that seat, and retain visible back button hover/focus feedback;
- every primary, record, facet, and leaf page projects the documented complete
  Host-owned ancestor chain; current items are non-interactive, every visible
  or overflowed ancestor is navigable, and no plugin-provided HTML or path
  string enters breadcrumb DOM;
- internal history Back, explicit ancestor navigation, dialog close/reopen,
  plugin block/restore, generation disposal, missing-record fallback, locale
  reprojection, and query/filter/scroll restoration follow the structured
  state rules above without touching browser or Codex history;
- constrained-width breadcrumb evidence keeps root and current inline and
  exposes omitted middle ancestors through one ordered, keyboard-accessible
  ellipsis menu rather than clipping or deleting them; and
- manager CSS contains no purple accent tokens while preserving semantic
  success, warning, and error colors; and
- the desktop modal reaches `min(1440px, calc(100vw - 40px))` by
  `min(960px, calc(100vh - 40px))`, retains a 248-pixel sidebar, and remains
  bounded and usable on smaller viewports.

Run the repository's complete `check` and `build` gates after DOM changes.
Then capture a real isolated `app://` renderer screenshot of the affected
manager panel and inspect the visible heading/list hierarchy. Screenshots
complement DOM and accessibility assertions; they do not replace them.

## Navigation delivery and PR boundary

This navigation correction is Host-internal and lands in one owning
`cordisx` PR after this document. It may add Host route-state, breadcrumb, DOM,
style, and focused Manager tests, but it does not change `cordisx-protocol`,
plugin contracts, the Config Schema or persistence lifecycle, dynamic plugin
delivery, README rendering, external settings body ownership, Codex native DOM
data flow, or add a free-DOM slot. The PR must audit every primary page and the
installed-plugin, permission, extension-point, route, marketplace, built-in
settings, and external settings projections.

The owning PR gate is focused Manager/navigation/lifecycle coverage, full
`npm run check`, `npm run build`, package audit, and `git diff --check`, followed
by an isolated real `app://` renderer report and screenshots at normal and
constrained widths. The smoke report records the complete permission path,
clickable ancestor targets, non-clickable current item, back behavior,
structured overflow menu, query restoration, external settings close and
block fallback, locale reprojection, generation cleanup, and unchanged native
node identity/data flow. After normal CI and squash merge, one separate mono PR
from the latest mono `main` updates only the exact merged `cordisx` gitlink.

The B extension delivery is a separate protocol-backed change governed by
[`manager-settings-navigation.md`](manager-settings-navigation.md). It must
preserve this Manager productization and the Host form system, and it does not
update mono.
