# Host-owned form system

Status: approved Host architecture and implementation boundary. This document
owns CordisX form composition, field selection, validation projection, theme
scope, and Manager integration. It does not add a plugin renderer capability
or change the version-1 plugin-configuration protocol.

## Outcome

CordisX presents configuration and launcher-owned inputs through one
Host-owned form system backed by the official TDesign Web Components
implementation and its desktop interaction and visual language.
Plugins continue to provide Schemastery/Standard Schema data, defaults,
localized labels and descriptions, roles, and `configApplies`; the Host alone
chooses a field primitive and owns its DOM, CSS, accessibility, validation,
draft state, operations, diagnostics, and cleanup.

The same primitives cover plugin configuration, explicit-local package path
intake, Marketplace feed URLs, permission/policy selection, and subsequent
Provider or Channel descriptor forms. A call site may not create a parallel
form style or give a plugin a TDesign component, selector, CSS class, or
arbitrary rendering callback.

## Requirement ledger

| Requirement | State | Evidence / boundary |
| --- | --- | --- |
| Closed semantic field/group/action icon contract | formally merged in `cordisx-protocol` | Protocol PR #41, formal `699691c`; Host validates and renders only closed `host:*` tokens. |
| Slider rail, thumb, and editable value | verified | Official TDesign Slider and InputNumber share one unframed control seat; narrow real-app report scrolls `reviewThreshold` into view. |
| One visible Select chrome | verified | Every Host-owned `t-select` is audited. The extension-point policy layout seat deliberately has no border, radius, padding, or background; official TDesign alone owns visible chrome, focus, and portal. |
| TDesign change-event boundary | verified | The Host unwraps the official `CustomEvent.detail.value` once before every input, textarea, number, slider, checkbox, switch, radio, select, multi-select, and TagInput draft callback. A draft can never stringify an event; the production gallery keyboard/save/reopen flow validates the actual Shadow input. |
| Action icons, contrast, and sticky position | verified | The Host action contract provides closed semantic icons, icon-only with `aria-label`/tooltip title, and icon-plus-label density. Per-field actions are compact menu triggers; undo/save remain labeled. The action/status bar sticks above the field list, not over its bottom rows; real dark app evidence verifies default/primary contrast. |
| Per-field default, rollback, and path actions | verified | One compact Host-owned icon button sits in each editable field header. Its isolated portal menu uses only closed Host tokens (`host:reset` for default/revert, `host:files` for copy) and distinguishes **Use default value** (`unset` mutation), **Revert field change** (drop only that draft operation), and **Copy configuration path**. Default/rollback availability is honest, copy reports a short status, and keyboard, outside-click, Escape, focus return, and disposal stay Host-owned. |
| Date / Time / Color editing | verified | Date uses official DatePicker. The official package lacks TimePicker and ColorPicker, so Time is an official Select/portal adapter and Color is an official palette Select plus editable HEX Input; neither falls back to native inputs. |
| Multi-select and bounded primitive arrays | verified | Official multiple Select/Option and TagInput respectively; complex arrays retain the pre-existing bounded JSON editor. |
| Gallery coverage | verified | `form-schema-gallery` is available only through `cordisx.config.ui-demos.json` and its plugin-detail Configuration route, never a global Demo tab. |
| Host TDesign form delivery | implemented | Focused tests, full gate, audit, and isolated `app://` artifacts are required again after every formal-main rebase; formal merge remains the last ledger step. |

## Official TDesign package audit

The official `tdesign-web-components@1.2.10` release was evaluated on
2026-08-24 from the npm registry and the upstream TDesign repository.

| Property | Verified result |
| --- | --- |
| Implementation | Omi-based Web Components; no React root is required. |
| License | MIT. |
| Browser target | Compatible with the Chromium generation used by CordisX. |
| Published tarball | 26,094,586 bytes compressed; 123,318,174 bytes unpacked; 3,888 files. |
| Full install graph | About 233 packages / 481 MiB in the audited clean install, including unrelated Markdown and Mermaid paths; the production dependency audit (`npm audit --omit=dev --audit-level=high`) reports 0 vulnerabilities for this Host checkout. |
| Form coverage | Input, Textarea, InputNumber, Select, TagInput, Checkbox, Switch, Radio, Slider, DatePicker, Button, Alert, Tooltip, and Loading exist; Form, FormItem, Empty, TimePicker, and ColorPicker do not. |
| Component entries | `lib/<component>/index.js` is bundleable by the current esbuild path. The `esm` entries import raw Less and are not usable directly. |
| Measured subset | Thirteen imported components (Input, Textarea, InputNumber, Select/Option, DatePicker, TagInput, Checkbox, Switch, Radio, Slider, Button, Alert, Loading) produce 652,270 bundled JavaScript bytes after removing embedded CSS source maps and 40,342 bytes of scoped base CSS. |
| Style isolation | The official controls render component CSS inside Omi open Shadow roots. CordisX does not load the package-wide global stylesheet into the document; it mechanically extracts only variable blocks below `.cxf-scope` and popup rules into a CordisX-owned Shadow portal. |
| Theme | Host `--cx-*` semantic tokens override the official `--td-*` variables. The popup Shadow host uses `:host-context([data-cordisx-app-theme="dark"])`, so App theme—not system preference—also owns dropdowns. |
| Accessibility gap | The audited Select does not provide the complete combobox/listbox keyboard and ARIA contract by itself. The Host adapter supplies roles, active option, focus return, Escape/outside-close behavior, typeahead, Home/End, disabled/read-only, and validation relationships without exposing these mechanics to plugins. |

CordisX distributes a reproducible, controlled subset of the official
`tdesign-web-components@1.2.10` implementation instead of adding the full npm
package to production dependencies. `scripts/build-tdesign-vendor.mjs` packs
the exact npm tarball, verifies SHA-256
`e1929f06eda5c3d2ee194da0d6bc9f81e187184fe1054627afeabad2ae71db0e`,
imports only the thirteen components above, bundles them, removes embedded CSS
source maps, and emits the pinned renderer module. The only source-level patch
removes Omi's legacy assignment to `window.HTMLElement`; modern Chromium keeps
its native constructor. The generated module records version and tarball hash.

The resulting bundled runtime contains only TDesign plus the code actually
reached from Omi 7.7.13, reactive-signal 2.0.1, weakmap-polyfill 2.0.4, clsx
2.1.1, tailwind-merge 2.6.1, lodash-es 4.18.1, omi-transition 0.1.11, and
@popperjs/core 2.11.8. They are MIT licensed and are recorded in
`THIRD_PARTY_NOTICES.md` and `third_party/tdesign-web-components-subset-MIT.txt`.
There is no React/Vue root, package CDN, runtime package resolution, or second
schema registry.

## Primitive registry

`HostFormAdapter` is the only field/control factory. Its primitive vocabulary
is Form, FormItem, Input, Textarea, NumberInput, Select/Option (including
multiple mode), TagInput, DatePicker, Checkbox, Switch, Radio, Slider,
explicit path input, Button, Alert, Tooltip, Loading, and Empty.

Form and FormItem are semantic Host containers because the official package
does not ship those components; they are not plugin-visible contracts.
Alert and Loading are official TDesign controls. The audited package has no
Empty component, so Empty is an honest Host semantic state rather than a
component imitation. Tooltip uses the existing
Host body-portal controller and theme projection rather than creating a second
popover service.

Default schema selection is deterministic:

| Schema field | Host primitive |
| --- | --- |
| finite scalar choices | Select; Radio only for explicit `radio` role |
| bounded array of finite scalar choices / `multi-select` | official TDesign Select/Option in multiple mode, with Host-owned listbox portal and keyboard policy |
| bounded primitive array with `max <= 64` | official TDesign TagInput; Host normalizes the declared scalar item type |
| complex object array, unbounded primitive array, or unknown array element | existing bounded JSON Textarea editor until a dedicated structured editor is declared; it is real read/write support, not an unavailable placeholder |
| boolean | Checkbox; Switch only for explicit `switch` role |
| number / natural | NumberInput; Slider only for explicit `slider` role |
| string | Input |
| string with `textarea` / `multiline` role | Textarea |
| string with `path`, `file`, or `directory` role | Path input |
| string with `date` role | official TDesign DatePicker |
| string with `time` role | Host TimePicker adapter made from official TDesign Select/Option + Host portal; the pinned official package has no TimePicker |
| string with `color` role | Host ColorPicker adapter: official TDesign palette Select plus editable HEX Input and a noninteractive preview; the pinned official package has no ColorPicker |
| JSON object or unknown serializable field | bounded JSON Textarea fallback plus a stable diagnostic |
| reserved sensitive role | Host credential-unavailable Alert; no value/control/renderer seat |

Schema object recursion only derives stable field paths. It never creates a
visual section by inference: a field joins a group-card only when that leaf
declares the closed `cordisxForm.group` metadata. This preserves one explicit
Host-owned schema truth and avoids turning implementation nesting into guessed
page chrome.

An unknown role never grants a renderer. The Host uses the safe primitive for
the underlying field type and records `unsupported-schema-role`; an unknown
non-JSON field stays unavailable with `unsupported-schema-field`. Diagnostics
are available to runtime inspection but are not product copy in the normal
form.

The formal protocol `plugin-config-common.v1#formPresentation` additionally
permits only a closed Host icon token, semantic group id/localized title/help,
and save/reset icon hint. Schemastery contributes the serializable
`meta.extra.cordisxForm` equivalent; the Host validates it against the same
closed vocabulary before it reaches a field snapshot. Icons are decorative
bundled Material symbols with the label/action as the accessible name. Schema
authors use them only for real semantic cues (path, credential boundary,
schedule, color, or tags), never generic row decoration. SVG, URL, CSS, DOM,
component instances, popup targets, and callbacks are rejected by construction.

## Ownership and custom renderers

The version-1 custom-renderer seam remains public and lifecycle-owned. The
Host creates one content seat inside the FormItem control region. It retains:

- product label, required/optional state, help, error, and accessible
  relationships;
- dirty state and the form Save/Reset operations;
- focus order and focus restoration after Host rerender;
- validation and mutation authority; and
- abort-before-dispose, generation fencing, and fallback after a mount error.

A custom renderer receives only its existing bounded field controller and the
body seat. It cannot replace FormItem, add form actions, access another field,
receive a secret, or mount a portal outside that seat.

## Draft, validation, and transaction state

Committed descriptor data is immutable. Each open form owns a separate draft
map keyed by canonical field path. Editing never mutates the descriptor.

The operation state is:

```text
pristine -> dirty -> validating -> saving -> saved
                   \-> invalid
                              saving -> conflict | error
reset(draft) -> pristine
field-use-default -> dirty (unset operation) -> normal Save transaction
field-rollback -> draft value at that path only -> pristine | dirty
```

Local field validation covers required values, finite numbers, min/max/step,
single/multiple choice membership, bounded array cardinality, ISO date/time,
HEX color, and JSON parsing before mutation. The Host then submits one
revision-fenced mutation. The configuration registry performs the authoritative
Standard Schema validation and launcher CAS transaction. Field issues are
attached through `aria-describedby`; operation/conflict errors use one
form-level `role=alert` and never discard the user's draft.

Protocol v1 formally permits only synchronous `Config` validators even though
the TypeScript structural type can describe a Promise. This Host slice must not
silently make asynchronous validation a public behavior. Async Standard Schema
support requires a protocol version with cancellation, stale-result fencing,
error paths, restart staging, and conformance vectors before Host adoption.

`live`, owning-fiber `restart`, generation restart, and app restart remain
runtime application scopes. The ordinary form mentions an apply scope only
when it changes what the user must do after Save. Revision, schema kind,
generation, last-good, and writer implementation stay in runtime diagnostics;
CAS conflict text may expose only the current revision needed to refresh.

Secrets and credentials remain outside ordinary draft and mutation objects.

Field actions deliberately do not show a persistent "restore default" button
beside every control. `Use default value` is an explicit `unset` mutation and
projects the declared schema default for immediate preview; it is not the same
as `Revert field change`, which removes only that field's local draft and
returns it to the last saved descriptor value. `Copy configuration path` copies
the stable dotted Host path (for example `workspaceName` or
`appearance.density`) without exposing schema internals in the normal UI.

## Layout, direction, and accessibility

The form root uses logical CSS properties and inherits `lang`/`dir`. It is one
column at narrow widths and may use two columns only when each FormItem has
enough inline space; Textarea, JSON, path, sensitive, error, and custom-renderer
items span the full row. Labels, help, controls, and errors keep one stable
vertical order. Long Chinese/English text wraps without changing control order.

Every FormItem provides stable label, help, and error ids. Required state is
announced by the control and visible marker; optional state is not repeated on
every ordinary field. Disabled and read-only remain distinct. Keyboard order is
DOM order, Radio uses native grouping, and Slider keeps a numeric accessible
value. Slider keeps one visible official rail/track/thumb and a synchronized
official number input in the same unframed control seat; it never wraps either
control in a second bordered shell. Form operations are reachable after the
last field and preserve visible focus rings in normal and high-contrast modes.

The minimum target size is 32 CSS pixels at normal density. Layout uses `rem`,
logical sizes, and intrinsic wrapping so 200% text and narrow Manager widths do
not cause horizontal clipping.

## Theme and style containment

The existing `HostThemeProjection` is authoritative. It resolves the renderer
App theme before system preference and updates attached Manager, Dialog,
Tooltip, and menu portals on live theme changes. The form adapter consumes only
its `--cx-*` semantic tokens.

Each form root introduces a private `.cxf-scope` mapping for official TDesign
tokens. The same semantic mappings are forwarded onto every official custom
element host because its visible chrome lives in a component Shadow root; this
keeps closed controls, popup options, hover/active/selected/disabled/error, and
live theme changes on one token contract. No TDesign global stylesheet, `:root`, `html`, `body`, universal
selector, or Codex selector is inserted into the document. Official component
styles remain in their component Shadow roots. Select popups attach only to a
CordisX Shadow portal below the Manager/Dialog owner, so theme projection and
generation cleanup apply before content disposal. Every Select, including
multiple Select, exposes an
idempotent Host `dispose()` seam; a lifecycle observer also releases document
and window listeners, its listbox, and itself after connected removal or after
a one-frame grace period when a speculative control is never connected.

Focus uses the Host focus token and remains visible under
`forced-colors: active`. Light/dark values follow the App theme even when the
system theme differs. Closing/reopening the Manager creates a fresh projection;
no form root retains observers or portal nodes after generation disposal.

## Current integration boundary

The production Host renderer has a static regression gate that rejects native
`select` creation. Every Host-owned choice control present in formal main uses
the same official TDesign Select/Option adapter:

- Schemastery plugin configuration, including custom renderer seats;
- explicit-local plugin package path intake;
- Marketplace source URL entry and source operations;
- permission/point-policy selectors and authorization choices.
- Plugin Console source/type/level selectors.

Agent Trace and CLIProxy plugin pages still contain plugin-owned native
selectors inside their own trusted page renderers. They are not Host-owned
Manager controls, do not receive TDesign or portal authority, and are not used
as evidence for this migration. A custom renderer may also render its bounded
seat with its existing public authority; the Host-owned label/help/error/save
frame around that seat never treats arbitrary plugin DOM as a TDesign control.

CLIProxy configuration is already Schemastery and therefore enters through the
same default form. Agent Trace and Settings Tab demonstrations exercise the
same Manager lifecycle. Provider Fleet and Channel currently expose read-only
snapshots/descriptors rather than an editable Host form; the adapter is their
required future entry point and no placeholder writer is invented.

## Validation matrix

Automated coverage must include primitive selection for every supported field,
unknown-role/JSON fallback, localized labels/help, RTL, required/disabled/
read-only semantics, native keyboard order, field/form errors, dirty/reset/
save/saved, CAS conflict draft retention, live/plugin/service/app-restart
status, secret refusal,
custom renderer fallback and cleanup, dynamic light/dark projection, portal
theme ownership, narrow/wide layout markers, and large-font-safe CSS.
Host-owned validation, apply status, switch, sensitive/unsupported, select
fallback, and JSON feedback are projected from the live `en`/`zh-CN` product
copy provider rather than field/plugin prose.

The full repository gates remain `npm run check`, `npm run build`, npm audit,
package allowlist, installed-tarball checks, and `git diff --check`. An isolated
real `app://` smoke must exercise plugin configuration, Agent Trace, CLIProxy,
Settings Tab/custom renderer content, and explicit-local package path intake in
light/dark and normal/constrained widths. Screenshots and a machine-readable
report complement the automated assertions; JSDOM is not product acceptance.

## Explicitly not implemented

- No full `tdesign-web-components` npm dependency or global TDesign stylesheet
  is installed; only the verified official component subset is bundled.
- No React root, Vue root, second Host form registry, or plugin-facing TDesign
  object is introduced.
- This form PR does not implement configuration application-plane contracts,
  mutation wiring, or restart orchestration. Its presentation helper can label
  live/plugin/service/app restart descriptors once their owning backend lands.
- Async Standard Schema, a credential broker, Provider/Channel mutation
  writers, an official Empty component absent from TDesign Web Components
  1.2.10, an upstream official TimePicker/ColorPicker, and hostile-code
  isolation remain future owner work. Time/Color are explicit Host adapters
  over official controls, not falsely named upstream components and never
  native-input fallbacks.
- A JSON fallback is an honest bounded editor for a known serializable field;
  it is not inference of arbitrary Standard Schema UI and is never offered for
  `schemaKind=standard`.
