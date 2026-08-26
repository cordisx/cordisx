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

- Keep unsaved status and form actions in a lightweight sticky bar above the scrolling fields.
- Do not wrap the action bar in a second card or duplicate form gap, margin, and padding.
- Use same-size icon-only undo and save actions with tooltip and accessible names when their meanings are familiar.
- Put field-specific reset, rollback, copy-path, and similar actions behind a compact More button in the field header.
- Defaults are a schema authoring contract; do not add per-field reset buttons merely to make a gallery screenshot look busy.
