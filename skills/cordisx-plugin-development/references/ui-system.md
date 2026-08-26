# Host-owned UI system

Apply these rules before implementation. They are authoring constraints, not screenshot-cleanup suggestions.

## Page chrome and hierarchy

- The Host renders the page header, icon, breadcrumb, back/close behavior, description, tabs, and route transitions.
- Do not repeat a page title or introduction inside the body when the Host already displays it.
- A `manager.content` contribution fills its body seat without a second outer padding or scroll layer.
- Keep direct-page headers and detail breadcrumbs on the same icon size, font scale, line height, and baseline.

## Spacing and geometry

- One layer owns each spacing relationship. Avoid parent `gap` plus child margin, or Host padding plus plugin padding.
- Inputs, selects, textareas, cards, and menus receive one visible shell only.
- Full-width text controls may stretch. Intrinsic controls such as checkbox, switch, radio group, segmented controls, steppers, and compact actions align to the semantic edge rather than stretching.
- Use one button height, icon box, radius, and focus ring per toolbar. Familiar actions should be icon-only with tooltip and accessible name.
- Hover and selected backgrounds follow the component radius; never reveal a square wrapper around a rounded control.

## Collections

- Keep search and filters fixed and give one result region the scroll ownership.
- Cards in the same grid row align icon/title, description, and metadata and share row height.
- Do not stretch sparse rows to fill the entire viewport.
- Card body opens detail; common actions stay at the semantic edge; rare actions use a More menu.

## State and tokens

- Place state in the control that represents it. An unavailable policy is a disabled control whose displayed value is “Unavailable”, not a separate badge beside an active select.
- Use `currentColor` and Host icon tokens. Verify visible contrast in both light and dark themes.
- Keep concise status copy in the primary UI. Put causal or architectural details in diagnostics, tooltips, or documentation.
