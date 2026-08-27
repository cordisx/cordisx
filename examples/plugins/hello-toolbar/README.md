# Hello Toolbar

Hello Toolbar adds a simple greeting action to the workspace toolbar.

It is the smallest structured toolbar plugin: the plugin submits only a
localized action, a Host icon token, and a command reference. CordisX owns the
DOM, styling, tooltip, accessibility, ordering, permission projection, and
cleanup when the plugin unloads.

The plugin has no user configuration. It still exports the explicit empty
Schemastery `Config = Schema.object({})` and
`configApplies = 'plugin-restart'`, so Manager can show an honest read-only
“no editable settings” state instead of inventing a meaningless switch.

Run it from the repository root:

```bash
npm run dev -- --config cordisx.config.hello-toolbar.json
```

This example is trusted local renderer code, not an isolated process or
security sandbox.
