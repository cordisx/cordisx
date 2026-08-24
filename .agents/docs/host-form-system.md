# Host-owned form system

Status: approved Host architecture and implementation boundary. This document
owns CordisX form composition, field selection, validation projection, theme
scope, and Manager integration. It does not add a plugin renderer capability
or change the version-1 plugin-configuration protocol.

## Outcome

CordisX presents configuration and launcher-owned inputs through one
Host-owned form system with TDesign desktop interaction and visual language.
Plugins continue to provide Schemastery/Standard Schema data, defaults,
localized labels and descriptions, roles, and `configApplies`; the Host alone
chooses a field primitive and owns its DOM, CSS, accessibility, validation,
draft state, operations, diagnostics, and cleanup.

The same primitives cover plugin configuration, explicit-local package path
intake, Marketplace feed URLs, permission/policy selection, and subsequent
Provider or Channel descriptor forms. A call site may not create a parallel
form style or give a plugin a TDesign component, selector, CSS class, or
arbitrary rendering callback.

## Official TDesign package audit

The official `tdesign-web-components@1.2.10` release was evaluated on
2026-08-24 from the npm registry and the upstream TDesign repository.

| Property | Verified result |
| --- | --- |
| Implementation | Omi-based Web Components; no React root is required. |
| License | MIT. |
| Browser target | Compatible with the Chromium generation used by CordisX. |
| Published tarball | 26,094,586 bytes compressed; 123,318,174 bytes unpacked; 3,888 files. |
| Runtime graph | 19 direct dependencies, including unrelated Markdown, Mermaid, patching, and copy utilities. |
| Form coverage | Input, Textarea, InputNumber, Select, Checkbox, Switch, Radio, Slider, DatePicker, Button, Alert, Tooltip, and Loading exist; Form, FormItem, Empty, and TimePicker do not. |
| Tree shaking | Per-component JavaScript entries exist, but the published package remains the installed dependency and declares all `esm`, `lib`, and `cjs` paths as side effects. |
| Style isolation | Per-component `lib/*` entries call Omi `globalCSS`, adding unscoped `.t-*` rules to the renderer document. The current Manager is not a Shadow-root application. |
| Theme | TDesign variables can be overridden, but popup ownership and the global style injection cannot currently be fenced to a CordisX root. |

The package is therefore not shipped in this slice. Adding it would materially
expand every CLI install, add unrelated production dependencies, still leave
several required primitives Host-authored, and fail the requirement to prove
that Codex native DOM is unaffected by global component CSS. CordisX does not
substitute another library and does not add React or another application root.

The minimum compatible path is a thin Host adapter whose DOM remains native,
whose API and density follow the TDesign desktop form model, and whose tokens
are scoped below a CordisX form root. A future official Web Components release
may replace individual adapter internals only after it provides a complete
bounded form set, an audited dependency graph, and a style/popup isolation seam.
That replacement must not change plugin schemas or the Host form registry.

Because no TDesign code or asset is distributed, it is deliberately absent
from `THIRD_PARTY_NOTICES.md`. If a later slice starts distributing it, that PR
must add the exact version, license, copyright notice, package allowlist, and
installed-tarball audit together.

## Primitive registry

`HostFormAdapter` is the only field/control factory. Its initial primitive
vocabulary is Form, FormItem, Input, Textarea, NumberInput, Select, Option,
Checkbox, Switch, Radio, Slider, Date, Time, explicit path input, Button,
Alert, Tooltip, Loading, and Empty.

Form and FormItem are semantic Host containers, not plugin-visible contracts.
Alert, Loading, and Empty are bounded form states. Tooltip uses the existing
Host body-portal controller and theme projection rather than creating a second
popover service.

Default schema selection is deterministic:

| Schema field | Host primitive |
| --- | --- |
| finite scalar choices | Select; Radio only for explicit `radio` role |
| boolean | Checkbox; Switch only for explicit `switch` role |
| number / natural | NumberInput; Slider only for explicit `slider` role |
| string | Input |
| string with `textarea` / `multiline` role | Textarea |
| string with `path`, `file`, or `directory` role | Path input |
| string with `date` / `time` role | native Date / Time input behind the adapter |
| JSON object/array or unknown serializable field | bounded JSON Textarea fallback plus a stable diagnostic |
| reserved sensitive role | Host credential-unavailable Alert; no value/control/renderer seat |

An unknown role never grants a renderer. The Host uses the safe primitive for
the underlying field type and records `unsupported-schema-role`; an unknown
non-JSON field stays unavailable with `unsupported-schema-field`. Diagnostics
are available to runtime inspection but are not product copy in the normal
form.

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
reset(field-to-default) -> dirty -> normal Save transaction
```

Local field validation covers required values, finite numbers, min/max/step,
choice membership, and JSON parsing before mutation. The Host then submits one
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
value. Form operations are reachable after the last field and preserve visible
focus rings in normal and high-contrast modes.

The minimum target size is 32 CSS pixels at normal density. Layout uses `rem`,
logical sizes, and intrinsic wrapping so 200% text and narrow Manager widths do
not cause horizontal clipping.

## Theme and style containment

The existing `HostThemeProjection` is authoritative. It resolves the renderer
App theme before system preference and updates attached Manager, Dialog,
Tooltip, and menu portals on live theme changes. The form adapter consumes only
its `--cx-*` semantic tokens.

Each form root introduces a private `.cxf-scope` mapping for the TDesign-aligned
token vocabulary. No `:root`, `html`, `body`, universal selector, Codex class,
or unqualified native element rule is allowed. All selectors begin with a
CordisX-owned class or data attribute. A portal created for a form control must
be mounted through the Manager portal owner so theme projection and generation
cleanup apply before content disposal.

Focus uses the Host focus token and remains visible under
`forced-colors: active`. Light/dark values follow the App theme even when the
system theme differs. Closing/reopening the Manager creates a fresh projection;
no form root retains observers or portal nodes after generation disposal.

## Current integration boundary

This slice migrates the existing product form surfaces that are present in the
formal Host main:

- Schemastery plugin configuration, including custom renderer seats;
- explicit-local plugin package path intake;
- Marketplace source URL entry and source operations;
- permission/point-policy selectors and authorization choices.

CLIProxy configuration is already Schemastery and therefore enters through the
same default form. Agent Trace and Settings Tab demonstrations exercise the
same Manager lifecycle. Provider Fleet and Channel currently expose read-only
snapshots/descriptors rather than an editable Host form; the adapter is their
required future entry point and no placeholder writer is invented.

## Validation matrix

Automated coverage must include primitive selection for every supported field,
unknown-role/JSON fallback, localized labels/help, RTL, required/disabled/
read-only semantics, native keyboard order, field/form errors, dirty/reset/
save/saved, CAS conflict draft retention, live/restart status, secret refusal,
custom renderer fallback and cleanup, dynamic light/dark projection, portal
theme ownership, narrow/wide layout markers, and large-font-safe CSS.

The full repository gates remain `npm run check`, `npm run build`, npm audit,
package allowlist, installed-tarball checks, and `git diff --check`. An isolated
real `app://` smoke must exercise plugin configuration, Agent Trace, CLIProxy,
Settings Tab/custom renderer content, and explicit-local package path intake in
light/dark and normal/constrained widths. Screenshots and a machine-readable
report complement the automated assertions; JSDOM is not product acceptance.

## Explicitly not implemented

- No official TDesign runtime or CSS is bundled in this slice.
- No React root, Vue root, second Host form registry, or plugin-facing TDesign
  object is introduced.
- Async Standard Schema, a credential broker, Provider/Channel mutation
  writers, Date/Time roles not declared by current schemas, and hostile-code
  isolation remain future protocol/owner work.
- A JSON fallback is an honest bounded editor for a known serializable field;
  it is not inference of arbitrary Standard Schema UI and is never offered for
  `schemaKind=standard`.
