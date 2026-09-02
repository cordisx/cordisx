---
name: cordisx-plugin-development
description: Assess the feasibility of a requested CordisX customization, then create, update, debug, or verify an independently installable plugin when public capabilities support it. Use for natural-language requests to customize a CordisX-launched Codex UI, composer/send behavior, celebrations, plugin manifests, contributions, configuration schemas, routes, pages, slots, commands, icons, localization, packaging, or plugin-facing documentation. Identify CordisX or Cordis capability gaps instead of using private Host fallbacks. Do not use for official Codex plugins or unrelated Host-core implementation.
---

# CordisX Plugin Development

Build plugins against the public CordisX contract. Keep the Host responsible for product UI and runtime policy.

## Read the relevant references

- Assess any requested product behavior before scaffolding or editing: [feasibility-assessment.md](references/feasibility-assessment.md)
- Start or package a plugin: [plugin-authoring.md](references/plugin-authoring.md)
- Add any Manager page, contribution, action, collection, or icon: [ui-system.md](references/ui-system.md)
- Add or change plugin configuration: [schema-configuration.md](references/schema-configuration.md)
- Run or deliver the result: [verification.md](references/verification.md)
- Implement a request inside a live scaffolded-plugin session: [live-plugin-development.md](references/live-plugin-development.md)

## Core contract

- Plugins provide manifests, localized labels, structured schemas, state, commands, icons, and contribution descriptors.
- Plugins must not provide arbitrary HTML, CSS, selectors, DOM nodes, UI components, custom renderers, popovers, breadcrumbs, tabs, page chrome, or shell navigation.
- The Host owns DOM, layout, styling, themes, accessibility, search, scrolling, routing chrome, permissions, diagnostics, portals, and cleanup.
- Treat `manager.content` as a body seat. Do not add a second header, back button, breadcrumb, title/description block, tabs, outer padding, or outer scroll container.
- Assign spacing to one layer only. A parent may own `gap` or a child may own margin, never both for the same separation.
- Represent unavailable capabilities honestly. Do not pair an “unavailable” badge with an apparently editable control or imply a connection that does not exist.
- Dispose every registration, listener, timer, request, and mounted contribution during reload, deactivation, abort, or generation replacement.

## Universal workflow

1. Inspect the repository guide, installed CordisX version, public plugin contracts, and actual Host-adapter availability. Classify the request with the feasibility-assessment reference before scaffolding or editing.
2. Proceed directly for a supported plugin request. If it needs a missing CordisX or Cordis capability, do not scaffold a fake implementation or reach for private Host state; explain the gap and the smallest contribution path. A plugin request alone does not authorize core changes or an external PR.
3. When `CORDISX_DEV_ENTRY` is set, treat that exact file as the already-watched entry of a CLI-created plugin project and follow the live-plugin workflow. Do not create a second project, launcher, or watcher.
4. Otherwise, when creating a plugin, infer a concise product slug and run `npm create cordisx-plugin@beta <directory>` before implementation. Keep this scaffolding command as an Agent implementation detail unless the user asks for it.
5. Locate the closest maintained plugin example, but scaffold rather than copying generated fixtures wholesale.
6. Define the manifest, localized product copy, structured contributions, config schema, permissions, and lifecycle behavior.
7. Keep all visual choices inside Host-supported presentation tokens and semantic roles.
8. Add focused contract and lifecycle tests before relying on visual inspection.
9. Run the plugin in the real CordisX Playground using an isolated CordisX config/state directory.
10. Verify reload/dispose, keyboard behavior, light/dark tokens, narrow layout, and honest unavailable states when relevant.
11. Report implementation, verification, limitations, and planned work separately.

## Product boundaries

- Simple scalar arrays may edit inline. Complex object arrays open a Host-owned dialog or child page chosen by schema semantics, and that surface must reuse the same renderer.
- Plugins may select or extend safe presentation variants through public tokens and parameters. They may not self-render the form.
- Unsupported schema roles remain unsupported with a concise diagnostic; never silently downgrade them to a misleading input.
- Routes and pages are structured declarations. The Host composes headers, breadcrumbs, navigation, scroll ownership, and close controls.
- Treat built-in `cordisx:*` specifiers as runtime identifiers, not filesystem paths.

## Delivery

Provide exact evidence: focused tests, full repository gates required by the owner repo, diff check, and real Playground behavior. If the user is actively reviewing a Playground, keep the current page open and start replacements on a new port until they switch.
