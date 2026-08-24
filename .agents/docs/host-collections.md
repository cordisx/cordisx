# Host-owned collection primitive

Status: implemented Host primitive and Manager integration boundary. The
primitive landed independently, and the Manager call sites consume it only
after the formal TDesign form, Marketplace source, Settings navigation, and
CLIProxy Provider UI merges.

## Product contract

`createHostCollection()` is the single Host-owned renderer for dynamic Manager
collections that are best expressed as compact cards or rows. Current call
sites cover installed plugins, Marketplace records, extension points, and
routes/pages. Permission policy, configuration, provider, and Marketplace
source reorder controls remain TDesign System Settings rows because they are
forms or ordered controls rather than whole-card detail destinations. The
Marketplace browse header exposes that low-frequency source-management page
only through its Host-owned overflow menu. Future
dependencies, diagnostics, or call logs use this primitive only when their
product semantics fit the same contract.

Every item is projected from Host-validated structured data. An item has a
stable id, localized title, optional short description, optional machine id,
a Host-created icon, optional Host state, a whole-card detail command, and
Host-authorized actions. Plugins never receive a collection DOM node, selector,
stylesheet, tooltip controller, menu portal, or responsive breakpoint.

The visible text hierarchy is:

1. product title;
2. one short product introduction; and
3. stable machine id as secondary information.

State is a Host-owned indicator on the icon's lower-right corner. It does not
consume a text row or become a plugin-supplied badge. Navigation has one
whole-card button with an accessible name and no chevron.

## Density and responsive layout

Card collections use CSS Grid with repeat/auto-fill and bounded tracks: the
minimum track is 220 pixels when available and the maximum is 360 pixels.
Narrow content therefore becomes one column, while medium and wide content
adds columns according to actual available width. Call sites must not prescribe
"two cards per row" or set page-specific column counts. Row collections use the
same DOM and interaction contract with one full-width track.

The action region is absolutely positioned above the top-right of card content.
It is not a flex or grid sibling that can change the title width, description
wrap, card height, adjacent-card position, or column count. It remains in the
tab order while visually hidden and becomes visible on card hover,
`focus-within`, or while its menu is open. This makes the first keyboard-focused
action visible without a pointer.

## Navigation and actions

The card body and actions are mutually exclusive controls. Every direct action,
overflow trigger, and menu item stops pointer and click propagation. Common
operations use direct icon-only controls ordered by explicit priority. Rare,
destructive, or width-dependent operations use one Host-owned `menu` portal.

The menu owns viewport positioning, outside click, Escape, Arrow Up/Down,
Home/End, focus restoration, theme attachment, disabled reasons, and cleanup.
Action icons are decorative; labels remain on the button through ARIA and the
shared Host tooltip controller. A plugin supplies a command reference or
structured operation request, never an event handler or menu node.

## Search and state

Search is enabled by default. The Host input filters NFKC-normalized,
case-insensitive title, description, machine id, and explicitly authorized
search fields. It provides a clear button, Escape-to-clear, match highlighting,
an accessible label, and distinct empty/no-match states without result counts.

A fixed, non-growing metadata collection may omit search only with an explicit
product reason. The current item count is not a valid reason. Call sites keep
query, filters, sort, and scroll in their structured page/route state and pass
the query back to the primitive after navigation or locale reprojection.

## Lifecycle and ownership

The returned view has one `dispose()` method. Disposal closes and removes any
menu portal, detaches theme and tooltip effects, removes document/window
listeners, and removes the collection root. Snapshot replacement, Manager
close, route change, plugin block, generation disposal, and owner removal must
invoke it through the existing Manager lifecycle.

This primitive is internal Host implementation. It does not change
`cordisx-protocol`: existing structured catalogs, routes/pages, configuration,
Marketplace, permission, and lifecycle contracts already provide the required
data and command references. A future plugin-visible collection contract would
require a separate protocol-first review; this module is not that contract.

## Delivery record

1. The isolated primitive, contract document, and focused DOM tests landed
   without changing the shared Manager renderer.
2. Integration rebased onto the formal Host merges for TDesign forms,
   Marketplace sources, Settings navigation, and CLIProxy Provider UI.
3. Installed plugins, Marketplace browse, extension-point catalogs, and
   route/page catalogs use the primitive while preserving structured query,
   route, lifecycle, trust, and operation state.
4. Owning delivery requires focused and full gates plus isolated
   `app://-/index.html` smoke in light/dark and narrow/medium/wide layouts with
   pointer and keyboard input.

The mono repository is intentionally outside this owning delivery.
