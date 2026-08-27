# Settings Navigation Demo

Settings Navigation Demo adds one editable demonstration setting to CordisX
Manager.

It is the real end-to-end example for
`manager.settings.navigation-items` and `manager.content`. The plugin submits
only a route reference and stable grouping/order. CordisX renders the primary
sidebar entry, icon, selected state, keyboard behavior, breadcrumbs, and
standard page header, then gives the plugin page mount only a controlled body
container below that header.

The example uses `/manager/extensions/settings-tab-demo`,
`chrome: 'standard'`, and `manager.content`. Both route and page submit English
and Simplified Chinese `title` and `description` metadata. User-facing copy and
icons are Host projections of that structured metadata. The plugin receives no
navigation DOM, header seat, Manager root, or Codex selector, and it injects no
arbitrary HTML, SVG, or CSS string. Blocking the plugin, denying permission,
replacing its generation, or closing Manager aborts and then disposes the
active mount.

`manager.settings.tabs` and `manager.settings.content` remain compatibility
contracts for Hosts that explicitly mount a Settings page. The current Manager
IA has no global Configuration product page, so the compatibility point remains
a `not-mounted` diagnostic instead of creating an empty clickable tab.

The page mount is trusted local renderer code, not a process or security
sandbox. Access to Platform, Agent, and other services still passes through the
existing permission system.

The plugin exports Schemastery `Config` with
`configApplies = 'plugin-restart'`. `demoValue` is a real 1–64 character user
setting with the default `CordisX`; saving it rebuilds only this plugin fiber.
The executable, debug port, profile, and launch environment are frozen at
startup and do not belong to this Manager page.

Run it from the repository root:

```bash
npm run dev -- --config cordisx.config.settings-demo.json
```
