# Plugin authoring

## Start from the maintained contract

- Prefer the maintained CordisX plugin scaffold or generator when one exists.
- Do not copy development fixtures as production packages without auditing every field.
- Keep plugin id, display name, descriptions, permissions, contributions, package files, and localization explicit.
- Include build, focused tests, package inspection, and install/dry-run checks appropriate to the owner repository.
- Declare license and distribution metadata intentionally.

## Structured contributions

Declare only data the Host can validate and render:

- routes and pages;
- commands and actions;
- slots and collection items;
- configuration schemas and safe presentation hints;
- permission requests;
- localized text and Host icon tokens.

The plugin owns business state and command behavior. The Host owns shell navigation, page chrome, control geometry, focus, keyboard handling, portals, and lifecycle fences.

## Runtime boundaries

- Register contributions during activation and retain every returned disposer.
- Abort or dispose in-flight work before publishing a replacement generation.
- Never keep a hidden DOM fallback or raw bridge when the structured contribution is unavailable.
- Never expose secrets through renderer-safe descriptors, diagnostics, logs, screenshots, or config values. Use Host-supported secret references.
