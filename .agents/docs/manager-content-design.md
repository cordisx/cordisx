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

## Groups and titles

A single content group is presented directly, without a section title that
only renames the active page or tab. When a page contains multiple groups,
each visible group title must add a new distinction such as `能力声明`,
`宿主连接`, `本地化`, `结构化运行时`, or `关键词`.

The same fact appears once, closest to the control or state it explains.
Breadcrumbs, tabs, groups, records, notices, and footers must not progressively
restate it. A diagnostic, blocked reason, adapter fact, or security boundary is
attached to its owning group and is not repeated as a general page notice.

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

## Page headers

Every primary page reserves the same fixed-width leading seat immediately to
the left of its title. Secondary and deeper pages replace the icon in that
seat with an icon-only back button. The title never moves when navigation
depth changes.

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
is the first item, followed by other ordinary manager areas including
`贡献与路由`, `插件商店`, and `配置`. `关于 CordisX` is the only item anchored
to the bottom of the navigation; configuration remains in the ordinary main
group and must not share that bottom placement.

The sidebar begins directly with primary navigation. It does not contain a
separate `CORDISX` eyebrow, manager title, version, or logo block. Product
identity and runtime version belong to the About page, where the first content
row presents one direct CordisX mark beside `CordisX` and the current version.

The small CordisX mark remains on the host-side manager trigger. Inside the
manager, the same mark is allowed only where it identifies the About area: the
bottom-anchored About navigation item, the About page header leading seat, and
the single About identity row. These marks are rendered directly without a
decorative container. Other primary pages use their own host-owned semantic
icons, while secondary pages use the back control.

Brand rendering preserves the official asset rather than approximating it.
The host-side manager trigger alone may use the light-background SVG as an
adaptive `currentColor` mask because it lives in an unknown host theme. The
manager dialog has a fixed dark background, so all three About marks use the
official dark-background SVG directly. They retain its continuous per-segment
grey depth shading and never flatten it into a monochrome mask, recolor it with
`currentColor`, redraw its paths, or add a frame or background.

The About body is a concise product hub, not a runtime dashboard. After its
identity row it exposes flat, actionable links such as issue feedback,
contribution, and documentation. It does not repeat manager diagnostics,
plugin counts, routes, outlets, locale metrics, trust notices, or blocking
semantics that belong to their owning pages.

Manager-owned interaction accents use a neutral silver-grey palette for
selected navigation, local tabs, icons, focus rings, hover backgrounds, links,
and interactive borders. Purple is not a manager accent. Semantic status
colors remain independent: green for success/active, yellow for warning or
waiting, and red for failure, denial, or destructive affordances.

## Flat lists and cards

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
- plugin and marketplace detail bodies do not repeat the breadcrumb record
  name in manager-owned headings.
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
  Home/End, and focus restoration survive manager re-rendering;
- non-brand icons resolve to the documented per-icon Material Symbols imports,
  contain no Unicode placeholder glyphs, remain hidden from accessibility APIs,
  and cannot be selected, dragged, focused, or intercept pointer activation;
- primary and breadcrumb headers keep a fixed 26-pixel frameless leading seat,
  optically center its SVG with the title row, align the second-row description
  with that seat, and retain visible back button hover/focus feedback; and
- manager CSS contains no purple accent tokens while preserving semantic
  success, warning, and error colors.

Run the repository's complete `check` and `build` gates after DOM changes.
Then capture a real isolated `app://` renderer screenshot of the affected
manager panel and inspect the visible heading/list hierarchy. Screenshots
complement DOM and accessibility assertions; they do not replace them.
