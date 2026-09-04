---
name: cordisx-plugin-development
description: Assess the feasibility of a requested CordisX customization, then create, update, debug, or verify plugins in standalone, dedicated multi-plugin, or embedded business projects. Use for natural-language requests to customize a CordisX-launched Codex UI, React pages, composer or send behavior, celebrations, plugin manifests, contributions, configuration, routes, slots, commands, localization, packaging, Vite development, or plugin-facing documentation. Identify public CordisX or Cordis capability gaps instead of using private Host fallbacks. Do not use for official Codex plugins or unrelated Host-core implementation.
---

# CordisX Plugin Development

Build plugins against the public CordisX contract. Keep the Host responsible for product UI and runtime policy.

## Read the relevant references

- Assess any requested product behavior before scaffolding or editing: [feasibility-assessment.md](references/feasibility-assessment.md)
- Choose or inspect the project shape and development loop: [project-layouts-and-development.md](references/project-layouts-and-development.md)
- Start or package a plugin: [plugin-authoring.md](references/plugin-authoring.md)
- Add any Manager page, contribution, action, collection, or icon: [ui-system.md](references/ui-system.md)
- Add or change plugin configuration: [schema-configuration.md](references/schema-configuration.md)
- Run or deliver the result: [verification.md](references/verification.md)
- Continue work inside an already-running development session: [live-plugin-development.md](references/live-plugin-development.md)

## Core contract

- Plugins provide manifests, localized labels, structured schemas, state, commands, icons, contribution descriptors, and React bodies in documented plugin-owned seats.
- A React body uses `cordisx/react` and `cordisx/ui`. Plugins must not provide arbitrary HTML, CSS, Host selectors or DOM nodes, replacement renderers, popovers, breadcrumbs, tabs, page chrome, or shell navigation.
- The Host owns DOM, layout, styling, themes, accessibility, search, scrolling, routing chrome, permissions, diagnostics, portals, and cleanup.
- Treat `manager.content` as a body seat. Do not add a second header, back button, breadcrumb, title/description block, tabs, outer padding, or outer scroll container.
- Assign spacing to one layer only. A parent may own `gap` or a child may own margin, never both for the same separation.
- Represent unavailable capabilities honestly. Do not pair an “unavailable” badge with an apparently editable control or imply a connection that does not exist.
- Dispose every registration, listener, timer, request, and mounted contribution during reload, deactivation, abort, or generation replacement.

## Universal workflow

1. Inspect the repository guide, installed CordisX version, public contracts, active Host adapter, and nearest CordisX project config. Classify the requested behavior with the feasibility reference.
2. Proceed directly for a supported plugin request. If it needs a missing CordisX or Cordis capability, do not fake it with private Host state; explain the gap and smallest public contribution path. A plugin request alone does not authorize Host-core changes or an external PR.
3. Select the creation mode from the user's project: one standalone plugin, a dedicated multi-plugin workspace, or `.cordisx/plugins/<id>` embedded in an existing business project. Preserve an existing package-manager workspace instead of rebuilding the project around CordisX.
4. If `CORDISX_DEV_ENTRY` is set, use that exact legacy single-plugin entry and running launch. For config-driven development, use the explicit or discovered project config and all enabled entries. Do not start a second Vite or Electron process for each plugin.
5. When creating a plugin, infer a concise product slug and use the maintained `create-cordisx-plugin` generator in the selected mode. Keep the scaffolding command as an implementation detail unless the user asks for it.
6. Define the manifest, localized product copy, contributions, config schema, permissions, React boundaries, and lifecycle behavior. Put activation effects under Cordis ownership and keep ESM top-level evaluation free of product side effects.
7. Keep visual choices inside Host-supported components, tokens, and semantic roles. Locate a maintained example, but do not copy generated fixtures wholesale.
8. Add focused contract, React, and lifecycle tests before visual inspection.
9. Run the project through `cordisx dev`. Verify automatic file updates and, when relevant, the Manager's development reload for one active local plugin.
10. Exercise the real isolated native `app://` path for native claims; use Playground evidence only for the behavior it actually hosts.
11. Report implementation, verification, limitations, and planned work separately.

## Product boundaries

- Simple scalar arrays may edit inline. Complex object arrays open a Host-owned dialog or child page chosen by schema semantics, and that surface must reuse the same renderer.
- Plugins may select or extend safe presentation variants through public tokens and parameters. They may not self-render the form.
- Unsupported schema roles remain unsupported with a concise diagnostic; never silently downgrade them to a misleading input.
- Routes and pages are structured declarations. The Host composes headers, breadcrumbs, navigation, scroll ownership, and close controls.
- Treat built-in `cordisx:*` specifiers as runtime identifiers, not filesystem paths.

## Delivery

Provide exact evidence: focused tests, owner-repository gates, diff check, generated-project checks, and the relevant real runtime. For Vite/native work, distinguish React Fast Refresh, plugin lifecycle replacement, CordisX renderer restart, and full Electron restart. If the user is actively reviewing a running session, keep it available while validating a replacement separately.
