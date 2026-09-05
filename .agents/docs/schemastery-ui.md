# `@cordisx/schemastery-ui` v1

Status: Host-owned workspace package. It is a form-engine core, not a Manager
page package and not a plugin DOM SDK.

## Dependency direction

```text
cordisx-protocol formPresentation v1
              │
              ▼
@cordisx/schemastery-ui (descriptor normalization, catalog, draft semantics)
              │
              ▼
cordisx TDesign Host adapter ──► Manager / Dialog / subpage / UI Playground
```

The package deliberately has no import of CordisX Manager routing, plugin
generation, configuration files, TDesign, or browser DOM. The CLI adapter owns
the official TDesign controls, Host portal, lifecycle, accessibility wiring,
localized copy, and the revision-fenced configuration transaction. Manager
owns sticky actions, field menus, breadcrumbs, dialog/page chrome, and save or
restart application. This keeps one renderer decision without making a
business plugin a renderer provider.

## Public v1 boundary

The package accepts serializable `FormDescriptor` data and the formal closed
`FormPresentation` v1 token. It exports:

- `normalizeFormDescriptor()` and `normalizeFormPresentation()` for safe
  descriptor intake;
- `resolveFormPresenter()` for deterministic type/role/presenter selection and
  fallback diagnostics;
- copy-free validation issue codes, so each Host can localize them; and
- `FormDraft`, an immutable-baseline operation map available to recursive
  presenters without coupling them to Manager storage.

The catalog accepts no component, DOM node, HTML, CSS, SVG, selector, popup
target, renderer callback, or user-defined presenter. `version: 1` plus a
known kind is required. Incompatible presentation returns a compatible base
primitive plus `unsupported-presenter`; unsupported schema returns an explicit
diagnostic instead of a blank surface or simulated editor.

## Catalog and layout

The formal Protocol v1 catalog is shared by Manager, object-array dialog/page
editors, and UI Playground:

| Descriptor shape     | v1 tokens                                                       | fallback                   |
| -------------------- | --------------------------------------------------------------- | -------------------------- |
| finite scalar choice | `choice.select`, `choice.radio`, `choice.segmented`             | Select                     |
| bounded number       | `number.input`, `number.stepper`, `number.slider`               | NumberInput                |
| bounded scalar array | `array.scalar-tags`, `array.scalar-rows`                        | TagInput / multiple Select |
| bounded object array | `array.object-auto`, `array.object-dialog`, `array.object-page` | compact Host collection    |

Layout is also a catalog decision. Inputs, textareas, paths, date/time/color
and Select fill the control column. Number steppers, slider/value pairs,
checkboxes, switches, radio and segmented groups use intrinsic width and align
to the trailing edge; no plugin field name or page CSS can change that policy.

## Relationship to Schemastery and ZodUI

Schemastery remains the source of data shape, defaults, validation and
serializable metadata. Its field description/object grouping semantics inform
the descriptor projection. ZodUI demonstrates a useful separation of
type-to-component mapping and bounded presentation modes. CordisX adopts that
separation, not either project's styles, prose, DOM, or component code. No
upstream source is copied, so no additional attribution beyond the existing
dependency license records is needed.

## Requirement ledger

| Capability                                  | State           | Evidence / next gate                                                                                      |
| ------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| Protocol `formPresentation` v1              | formally merged | `cordisx-protocol#43`, `17dda260`                                                                         |
| Core package normalize/resolve/draft API    | implemented     | package build, tarball allowlist, and package-level tests required before Host PR                         |
| CLI/Manager/Playground consume one resolver | implemented     | CLI adapter imports package; real isolated smoke still required                                           |
| TDesign recursive object-array dialog       | implemented     | shared parent draft callback; focused lifecycle/keyboard tests still required                             |
| Object-array page chrome and dynamic unions | unimplemented   | requires Manager navigation adapter and formal schema projection; cannot be represented as dialog success |
| Generic map/set/dict/tuple editors          | unimplemented   | current Host has an explicit bounded fallback/diagnostic, not a false structured editor                   |
| Full gallery and formal Host merge          | unimplemented   | requires current-main rebase, full gates, isolated `app://`, PR/CI/head-fenced merge                      |
