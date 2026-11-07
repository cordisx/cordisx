# Schemastery configuration

CordisX configuration forms are Host rendered. The plugin provides the schema, safe presentation hints, defaults, and values; the Host owns draft state, validation, controls, write flow, and accessibility.

## Control mapping

- short scalar string: input;
- multiline semantic string: textarea;
- bounded scalar choice: select, radio, or segmented according to presentation metadata;
- boolean: checkbox or switch according to semantics;
- bounded number: input, stepper, or slider with a visible value;
- directory, URL, date, time, color, and secret: only use roles supported by the public presenter catalog;
- unsupported roles: concise unavailable diagnostic, never a misleading text input.

Normalize TDesign events at the adapter boundary. Do not store a `CustomEvent` object as the field value; extract the control value and update the draft before rerendering.

## Grouping and arrays

- Do not invent a “General” section for a single unnamed object group.
- Show group headings when the schema names the group or multiple groups need hierarchy.
- Edit arrays of simple scalar elements inline.
- For arrays of complex objects, use schema semantics to choose a Host dialog or child page, then render the item with the same Schemastery renderer.
- Plugins may request safe presenter variants. They cannot provide custom form DOM or CSS.

## Actions

- Durable Manager create/edit workflows use a child page with the shared schema renderer. The owning Host page keeps Save/Cancel at the bottom of the entire content seat while fields scroll independently; only the current page footer is visible.
- Embedded public `SchemaForm` does not own an outer footer or scroll seat. Use the declared public surface for actions; do not import internal `HostSchemaFormPage` or patch Host DOM.
- Short confirmations use public Host dialogs. Choose the surface using [Manager form composition](https://github.com/cordisx/cordisx/blob/main/.agents/docs/manager-form-composition.md).
- Do not wrap the action bar in a second card or duplicate form gap, margin, and padding.
- In compact toolbars, use same-size icon-only undo/save actions with tooltip and accessible names when familiar. Page Save/Cancel footers follow the owning Host surface action descriptors.
- Put field-specific reset, rollback, copy-path, and similar actions behind a compact More button in the field header.
- Defaults are a schema authoring contract; do not add per-field reset buttons merely to make a gallery screenshot look busy.
