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

The semantic path includes every page context needed to return to the current
leaf:

- primary pages use one current segment, such as `插件`;
- installed-plugin facets use `插件 / 插件名 / README`, `配置管理`, `权限`,
  `运行状态`, `扩展点位`, or `路由` as the current segment;
- permission leaves use `插件 / 插件名 / 权限 / 能力名`;
- extension-point facets use `扩展点 / 点位名 / 使用情况`, `点位信息`, or
  `诊断`;
- a route detail uses `路由 / 路由名`;
- marketplace facets use `插件商店 / 插件名 / 概览` or `作者与来源`; and
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
switching a local or settings tab, opening a permission leaf, selecting a
primary area, and explicitly choosing an ancestor each create a normal history
entry. Back restores the most recent surviving route, so a tab switch can go
back to the prior tab while an explicit ancestor click can go directly to a
list or default facet. Manager navigation never changes `app://`, calls
`window.history`, invokes the Codex router, or mutates native Codex route state.

Breadcrumb overflow is also a Host projection. When every segment fits, the
complete path stays inline. When it does not fit, the root and current segment
always remain visible, the nearest fitting ancestors remain visible from the
current page outward, and the omitted middle ancestors move into one
structured ellipsis menu in their original order. The menu uses real buttons
with the same ancestor targets. CSS clipping, text replacement, or silent
ancestor removal is not an overflow strategy.

Route validity is reconciled against every new Manager snapshot:

- plugin block or restore keeps built-in plugin detail routes inspectable, but
  an active external settings page falls back to `配置 / 插件商店` and cannot
  steal activation when restored;
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
  built-in marketplace fallback before it can mount again.

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
path/key is never shown beside that label in the default form. Fields that are
neither editable nor a Host-owned sensitive boundary are omitted. Secret and
credential roles remain visible only as a single Host-owned unavailable state:
their value and path do not enter a normal control, custom renderer, or repeated
summary notice.

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
remains the accessible tab name and the active underline remains the only
persistent selection accent. Local tablists use the horizontal ARIA tabs
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

## Page headers

Every primary page reserves the same fixed-width leading seat immediately to
the left of its title. Any structured route with more than one breadcrumb
segment replaces the icon in that seat with an icon-only history-back button.
The title never moves when navigation depth changes.

The title occupies the first row. The description occupies its own second row
and spans the complete header grid, so its left edge aligns with the leading
icon or back control rather than with the title text. This applies equally to
plain titles and breadcrumb titles.

Leading icons are rendered directly in a transparent 26-pixel seat. They do
not use a persistent border, background, chip, or rounded frame. The back
control follows the same frameless resting appearance while retaining a real
button target, an accessible `返回` label, and silver-grey hover and
`focus-visible` feedback that does not change its dimensions.

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
| back, detail, close, and external link | `chevron_left`, `chevron_right`, `close`, `open_in_new` |
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
The host-side manager trigger observes the host root's `electron-dark` /
`electron-light` theme projection and selects the matching official direct SVG.
The manager dialog has a fixed dark background, so all three About marks use
the official dark-background SVG directly. Every placement therefore retains
the same continuous per-segment grey depth shading and never flattens it into a
monochrome mask, recolors it with `currentColor`, redraws its paths, or adds a
frame or background.

The About body is a concise product hub, not a runtime dashboard. Its identity
is one horizontal row: the official mark occupies the left seat while the
`CordisX` name and dynamic runtime version form a non-wrapping copy column on
the right. After that row it exposes flat, actionable links such as issue
feedback, contribution, and documentation. It does not repeat manager
diagnostics, plugin counts, routes, outlets, locale metrics, trust notices, or
blocking semantics that belong to their owning pages.

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
roving tabindex, focus restoration, and panel semantics. Version 1 exposes
only two honest facets: `概览` for description, version, compatibility,
license, and keywords; and `作者与来源` for authors, source, optional homepage,
manifest/icon links, feed provenance, and the trust boundary. The catalog does
not synthesize README, permission, extension-point, route, runtime, install,
or activation tabs when the feed schema does not provide those capabilities.

Manager-owned interaction accents use a neutral silver-grey palette for
selected navigation, local tabs, icons, focus rings, hover backgrounds, links,
and interactive borders. Purple is not a manager accent. Semantic status
colors remain independent: green for success/active, yellow for warning or
waiting, and red for failure, denial, or destructive affordances.

## Flat lists and cards

An installed-plugin row has mutually exclusive navigation and action regions.
The complete row body is a button-like detail target activated by pointer,
Enter, or Space; it has no trailing chevron. Its right edge is a Host-rendered
icon-only action region. Action pointer and keyboard events stop row
navigation, use native tooltip and focus treatment, remain `no-drag`, and never
accept plugin-owned DOM.

Wide rows show enable/disable, reload, and favorite in that deterministic
priority. When width is insufficient, lower-priority controls move into one
Host-owned overflow menu without squeezing the plugin name or state. Share and
uninstall always live in that menu. Closing the menu restores focus to its
trigger, and both menu and tooltips are constrained to the manager viewport.
Unavailable lifecycle operations are absent or explicitly unavailable; a
button must never restart the launcher while claiming to reload one plugin.

Favorite is a current-profile manager preference. Share requires a validated
public canonical HTTPS source and never projects a local source/store path,
configuration, or secret. Uninstall is destructive and remains behind a
second Host-owned confirmation containing the reverse-dependency impact.

Ordinary repeated records use a flat list with separators and whitespace. The
container exposes list semantics and each item has a stable visible label plus
list-item semantics. A capability declaration is a flat item whose host-owned,
localized product name is the visible label. Its primary row contains only a
frameless semantic icon, name, one-sentence reason, a `必需` badge when
applicable, and either a localized policy selector or `暂不可用` when the
current host does not support that capability. Optional declarations do not
need an `可选` badge.

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

Cards are reserved for a genuine independent boundary: a separately
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
- supported capability selectors are inside flat list items, not
  `.cxm-slot-card` or nested `section section` structures, while unsupported
  declarations show only `暂不可用` in the list control seat;
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
- installed-plugin rows have no detail chevron, keep navigation and action
  activation mutually exclusive, support pointer/Enter/Space navigation, and
  preserve the deterministic enable/reload/favorite overflow priority;
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
- primary navigation begins with `插件`, keeps `配置` in the main group, and
  anchors `关于 CordisX` at the bottom;
- the modal sidebar begins with navigation and contains no identity block;
  About alone uses the CordisX mark in its navigation item, header seat, and
  identity row; those three marks directly render the official dark-background
  asset with its multi-grey depth shading, while the host-side trigger remains
  the only adaptive `currentColor` mask;
- the About identity uses the runtime version, its action links have verified
  public destinations and safe external-link attributes, and the old runtime
  metric grid and generic boundary copy are absent;
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
