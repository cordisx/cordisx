# Host-owned form system

This reference owns CordisX form composition, field selection, validation,
theme scope, and Manager integration. The Host renders the official
`tdesign-react@1.18.2` components. Plugins supply structured schema, defaults,
localized copy, roles, and application semantics through existing contracts.
The Host owns DOM, layout, validation, draft state, actions, focus, and cleanup.

For editor/page/dialog selection and outer layout, use [Manager form composition](manager-form-composition.md).

## Outcome

The production Manager enters through `manager/install.tsx` and `ManagerApp`.
`PluginDetailPage` mounts `HostForm` for configuration. Structured content
configuration uses `HostForm` and the same `HostFieldRow` and presenter
resolver. Permission authorization owns an independent React surface because
requests may arrive while Manager is closed.

There is one maintained schema renderer. `@cordisx/schemastery-ui` supplies
normalization, closed presenter selection, immutable drafts, and validation
codes; `renderer/host-ui/HostForm.tsx` renders the selected components. The
configuration registry remains the authority for persistence and application.

## Requirement ledger

Implementation, automated verification, formal merge, real-App proof, and user
acceptance are separate states. The current delivery task records its exact
candidate, test logs, review, and merge. The migration does not reuse historical
screenshots or retired implementation tests as evidence for the React controls.
Real-App save/reopen, theme, constrained-width, keyboard, and cleanup acceptance
must name the tested formal revision and runtime.

## Official TDesign package audit

Both root and CLI package manifests pin `tdesign-react` to `1.18.2`; the lockfile
owns its resolved dependency graph. Components are imported from the official
package, including DatePicker, TimePicker, ColorPicker, Form, Input, Select,
RadioGroup, and Button. Upstream CSS is bundled locally with Host theme
projection. There is no separately generated control bundle or form runtime.
Third-party attribution is maintained in the CLI's `THIRD_PARTY_NOTICES.md`.

## Primitive registry

The closed presenter resolver selects actual React components:

| Schema / presenter          | Host control                                     |
| --------------------------- | ------------------------------------------------ |
| string                      | Input                                            |
| multiline / textarea        | Textarea                                         |
| number / natural            | InputNumber                                      |
| slider                      | Slider with synchronized InputNumber             |
| finite scalar choices       | Select                                           |
| radio / segmented choices   | RadioGroup                                       |
| finite choice array         | multiple Select                                  |
| bounded primitive array     | TagInput, preserving declared item types         |
| bounded object array        | ArrayEditor with the same recursive HostFieldRow |
| boolean / switch            | Checkbox / Switch                                |
| date / datetime             | DatePicker with the declared format              |
| time                        | TimePicker                                       |
| color                       | ColorPicker                                      |
| path / file / directory     | Host-owned Input                                 |
| supported serializable JSON | bounded Textarea editor                          |
| reserved sensitive role     | Host-owned unavailable state                     |

### Form Presenter Catalog v1

The catalog accepts only the closed version, kind, and options from Protocol.
The resolver verifies the descriptor shape before choosing a primitive.
Incompatible or unknown tokens produce the existing diagnostic and safe base
presentation. They never grant component, CSS, DOM, SVG, callback, or portal
access. Manager forms and nested array editors use the same resolver.

Object recursion derives stable field paths; explicit `cordisxForm.group`
metadata alone selects a group. Host semantic icons decorate authoritative
labels and actions. Product code does not infer page chrome from schema nesting.

## Ownership and custom renderers

The existing version-1 custom renderer seam retains its bounded content seat.
The Host keeps the label, required state, help, validation errors, draft,
Save/Reset, focus relationships, and mutation authority. The existing
configuration runtime owns generation fencing, cancellation, and disposal.
A custom renderer does not gain a form root, another field, a secret, or an
external portal. A late successful mount after disposal is disposed immediately.

## Draft, validation, and transaction state

Committed snapshots are immutable. Each open form owns draft operations keyed
by canonical field path. Typing changes the draft only. Save validates and
submits one revision-fenced mutation; Reset restores the saved snapshot.

```text
pristine -> dirty -> validating -> saving -> saved
                       |             |
                     invalid      conflict / error
```

A failed save retains the draft. Schema-disabled controls and all controls while saving cannot change.
A configuration without a persistence writer still allows local draft
inspection when its schema permits editing; Save remains unavailable. Field-default actions emit an `unset` operation;
field rollback removes only that field's draft operation. Copy-path actions copy
the canonical path without exposing internal diagnostics in ordinary UI.

The Host validates required values, finite choices, number range/step, array
cardinality and item types, date/time/color values, and JSON parsing before
mutation. The configuration registry performs authoritative synchronous
Standard Schema validation and launcher CAS. Async validation remains outside
the existing public protocol. Secrets stay outside ordinary draft objects.

`live`, owning-fiber restart, service restart, and app restart are runtime
application scopes. The registry owns the applicable restart semantics; the form reports successful
saving. A form does not implement a second persistence or restart path.

## Layout, direction, and accessibility

HostFieldRow gives labels, help, and errors stable IDs and associates them with
the real React control. Required, invalid, disabled, and read-only states remain
accessible. Textarea and array/JSON editors use full control width; compact
numeric and choice controls respect narrow layouts. Keyboard order follows the
Host layout, with visible focus and labelled action buttons.

Nested array editors preserve the parent transaction. Their Host-owned dialog
or page stack manages cancellation and return focus. No nested form saves a
partial configuration outside the parent mutation.

## Theme and style containment

HostThemeProjection resolves the App theme before system preference and owns
live updates for attached roots. The React Manager provides ConfigProvider
attachment targets for popups and dialogs beneath its owning surface. An
independent authorization root owns its own styles and theme lifetime.

Official controls use Host semantic tokens. Popup contents inherit the same
scope and are removed when the owning React tree unmounts. Closing a surface
releases root observers, subscriptions, focus listeners, and portal contents.

## Current integration boundary

The maintained product chain includes Manager plugin configuration, structured
content configuration, Marketplace source inputs, permission/policy selection,
and Plugin Console filters. They use official TDesign React controls.

Only existing Host actions and public structured contracts supply data and
mutations. This migration does not add a Provider/Channel writer, revive an
unreachable Manager page, or expand plugin DOM authority. Plugin-owned bounded
content continues to use its existing contract; it is not an alternate Host
schema renderer.

## Validation matrix

Regression checks exercise actual React component imports and DOM input,
selection, keyboard, and submit events. They verify draft/save/reset, validation,
busy/schema-disabled state and unavailable persistence, failure retention, accessibility, nested editors,
permission decisions, locale changes, theme ownership, and teardown.
Production bundle checks prove that the runtime installs the React Manager.
Source gates inspect executable import/render paths rather than comments.

Select affected tests, compile, formatting and lint through [Host testing](testing.md).
Complete `npm run check`, release/package/installed evidence belongs to formal
release and Mono integration gates; reuse matching CI evidence. During active
pure-style feedback, follow [functional delivery](../rules/functional-delivery.md)
and run the combined affected checks when that window closes. PR evidence
applies to the exact final head. Real-App and user acceptance remain separately
recorded evidence; automated DOM tests do not substitute for them.

## Explicitly not implemented

This migration does not change public configuration contracts, add a schema
registry or persistence ledger, implement asynchronous Standard Schema
validation, provide hostile-code isolation, or grant plugins new UI authority.
Real App interaction must be explicitly authorized and reported separately.

## Embedded plugin forms

`SchemaForm` from `cordisx/ui` embeds the same field projection, `HostFieldRow`,
validation messages, and nested editors used by Host configuration pages and
`form-schema-gallery`. The plugin supplies a trusted Schemastery object and a
controlled draft; it does not implement field widgets. The public contract is
[Schema form v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/schema-form.md).

```tsx
import Schema from '@deepseek-ai/schemastery'
import { useState } from 'cordisx/react'
import { SchemaForm } from 'cordisx/ui'

const schema = Schema.object({
  size: Schema.number().min(9).max(19).default(15),
})
export function BoardConfig() {
  const [value, setValue] = useState<Record<string, unknown>>({ size: 15 })
  return (
    <SchemaForm
      identity="board"
      schema={schema}
      value={value}
      onChange={snapshot => setValue({ ...snapshot.value })}
    />
  )
}
```

Keep invalid edits in the draft and use `snapshot.valid`/`issues` to control
submission. `onValidationChange` also reports initial and externally changed
values. Switch `identity` when editing another record or immutable game package.
SchemaForm owns no save operation, page header, footer or outer scroll region.
The caller owns persistence and layout. Only synchronous Schemastery validation
is supported; asynchronous validators produce an explicit validation error.
Remote game metadata must first pass a bounded data-only schema validator and be
compiled through trusted factories; never construct executable Schemastery
callbacks from a downloaded document.
