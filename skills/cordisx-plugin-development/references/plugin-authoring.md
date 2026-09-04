# Plugin authoring

## Start from the maintained contract

- Read [project-layouts-and-development.md](project-layouts-and-development.md) before creating files. Choose the layout from the user's project; do not force a business repository into a dedicated plugin monorepo.
- Use the maintained `create-cordisx-plugin` generator. Infer a concise product slug, keep standalone single-plugin as the default, and select workspace or embedded mode when those shapes fit. Keep the scaffolding command as an implementation detail unless the user asks for it.
- Do not copy development fixtures as production packages without auditing every field.
- Keep plugin id, display name, descriptions, permissions, contributions, package files, runtime localization, and both `README.md` and `README.zh-Hans.md` explicit.
- Include build, focused tests, package inspection, and install/dry-run checks appropriate to the owner repository.
- Declare license and distribution metadata intentionally.
- Keep a newly created plugin private and `UNLICENSED` by default. Ask only for missing publication metadata when the user requests sharing or publication; an explicit publication request is already authorization and must not trigger redundant confirmation.

## Structured contributions

Declare only data the Host can validate and render:

- routes and pages;
- commands and actions;
- slots and collection items;
- configuration schemas and safe presentation hints;
- permission requests;
- localized text and Host icon tokens.

The plugin owns business state and command behavior. The Host owns shell navigation, page chrome, control geometry, focus, keyboard handling, portals, and lifecycle fences.

## React body seats

Use `cordisx/react` and `cordisx/ui` for a documented React page body. The Host
supplies the React singleton, root lifecycle, error boundary, theme projection,
and semantic components. Do not install or bundle another React renderer or a
component library. The React body remains inside the Host-composed page; it does
not take over headers, breadcrumbs, tabs, navigation, or outer scrolling.

## Runtime boundaries

- Register contributions during activation and retain every returned disposer.
- Abort or dispose in-flight work before publishing a replacement generation.
- Keep top-level plugin modules declarative. Vite evaluates ESM before Cordis creates the owning plugin fiber, so subscriptions, timers, registrations, and other product effects belong in `apply(ctx)` or a Cordis-owned service.
- Put React components intended for Fast Refresh in component modules with refresh-compatible exports. Keep manifest and `apply` exports in the plugin entry so changes there can replace the owning plugin generation cleanly.
- Never keep a hidden DOM fallback or raw bridge when the structured contribution is unavailable.
- Never expose secrets through renderer-safe descriptors, diagnostics, logs, screenshots, or config values. Use Host-supported secret references.
