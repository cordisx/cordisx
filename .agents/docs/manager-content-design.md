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

## Primary navigation, identity, and accent

The primary navigation leads with the product's principal workflow. `插件`
is the first item, followed by other ordinary manager areas including
`贡献与路由`, `插件商店`, and `配置`. `关于 CordisX` is the only item anchored
to the bottom of the navigation; configuration remains in the ordinary main
group and must not share that bottom placement.

The sidebar identity block contains the `CORDISX` eyebrow, manager title, and
version without a large logo. The small CordisX mark belongs to the host-side
manager trigger and remains visible there; duplicating it beside the sidebar
identity creates an unnecessary competing brand landmark.

Manager-owned interaction accents use a neutral silver-grey palette for
selected navigation, local tabs, icons, focus rings, hover backgrounds, links,
and interactive borders. Purple is not a manager accent. Semantic status
colors remain independent: green for success/active, yellow for warning or
waiting, and red for failure, denial, or destructive affordances.

## Flat lists and cards

Ordinary repeated records use a flat list with separators and whitespace. The
container exposes list semantics and each item has a stable visible label plus
list-item semantics. A capability declaration is a flat item whose capability
id is the local label; its policy control, reason, scope, usage, blocked reason,
and errors remain inside that one item.

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

- the `权限` tab contains no `Platform 权限` heading;
- capability selectors are inside flat list items, not `.cxm-slot-card` or
  nested `section section` structures;
- adapter diagnostics, blocked reasons, and security notices appear once at
  their owning level;
- a plugin with no declarations retains an explicit permission empty state and
  a separately understandable host-connection group;
- configuration and launcher tabs do not repeat their selected tab label; and
- plugin and marketplace detail bodies do not repeat the breadcrumb record
  name in manager-owned headings.
- primary navigation begins with `插件`, keeps `配置` in the main group, and
  anchors `关于 CordisX` at the bottom;
- the modal sidebar contains no large CordisX mark while the host-side trigger
  retains its small mark; and
- manager CSS contains no purple accent tokens while preserving semantic
  success, warning, and error colors.

Run the repository's complete `check` and `build` gates after DOM changes.
Then capture a real isolated `app://` renderer screenshot of the affected
manager panel and inspect the visible heading/list hierarchy. Screenshots
complement DOM and accessibility assertions; they do not replace them.
