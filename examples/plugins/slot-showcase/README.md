# Slot Showcase

Slot Showcase demonstrates CordisX extension points, navigation, pages, and
state interactions in Plugin Manager.

This is the end-to-end structured UI example. It submits data through
`ctx.commands`, `ctx.routes`, `ctx.pages`, and the DSH-style
`ctx.slots.register`; the Host owns shell DOM, interaction, ordering,
accessibility, and cleanup.

## What it demonstrates

- Controls before and after the sidebar footer, plus a footer menu item.
- A primary navigation row with an independent shortcut that does not bubble
  into the row action.
- Semantic anchors before and after the workspace toolbar, plus a toolbar menu
  item.
- Environment panel header actions, sections, section actions, rows, and
  trailing actions.
- `app`, `main`, and `session.content` page outlets.
- English and Simplified Chinese product titles and descriptions for every
  route and page, including purpose, entry point, and target region.
- Dynamic message arguments and locale reprojection while paths, outlets,
  parameters, and stable IDs remain machine values.

Manager groups the three route and page families in **Routes** and projects
their descriptions using the active Host locale. `app.overview` opens the
application overview from the sidebar footer or demo settings entry;
`main.analytics` opens workspace analytics from the navigation row, toolbar,
or session header; and `session.analytics` opens analysis in the active
conversation after a native session ID is configured. The plugin declares only
structured `LocalizedText`; the Host owns list DOM, search, diagnostics, and
accessibility.

## Configuration

```json
{ "sessionId": "Native session UUID without the local: prefix" }
```

The plugin exports Schemastery `Config` with
`configApplies = 'plugin-restart'`. `sessionId` accepts at most 128 characters.
When empty, the session-analysis shortcut remains hidden. When it matches the
selected native session, that action navigates to the controlled
`session.content` page. Saving configuration rebuilds only this plugin fiber.

Blocking the plugin disposes the current Cordis fiber, revokes its
contributions, and aborts/disposes active pages. Restoring it creates a new
generation from the same trusted local bundle. Page mounts are trusted local
controlled DOM, not a permission sandbox.
