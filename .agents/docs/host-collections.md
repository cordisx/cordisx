# Host-owned collection primitive

Status: approved implementation boundary for the CordisX Manager compact
collection migration. The isolated primitive and tests may land independently;
Manager call-site migration must rebase onto the formal TDesign form,
Marketplace source, and settings-navigation merges before changing shared
renderer files.

## Product contract

`createHostCollection()` is the single Host-owned renderer for dynamic Manager
collections that are best expressed as compact cards or rows. It covers
installed plugins, Marketplace records, extension points, routes/pages,
Marketplace sources, permission/capability declarations, dependencies, and
future diagnostics or call logs when their product semantics fit the pattern.

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

## Delivery sequence

1. Land the isolated primitive, contract document, and focused DOM tests without
   changing shared Manager integration files.
2. Consume the formal TDesign/form merge and reuse its semantic tokens, portal
   theme projection, and control ownership.
3. Consume the formal Marketplace-source and settings-navigation merges.
4. Migrate Manager call sites from current one-off rows/cards to this primitive,
   preserving each page's structured route/query state and operation brokers.
5. Run focused and full gates, then isolated `app://-/index.html` smoke in
   light/dark and narrow/medium/wide layouts with pointer and keyboard input.

The mono repository is intentionally outside this owning delivery.
