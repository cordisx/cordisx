# CordisX UI Copy Principles

## Product rule

Primary UI states describe the current condition and, when useful, offer one
clear next action. They do not teach implementation details.

Use short, direct status copy:

- `暂无数据` / `No data yet`
- `文件不存在` / `File not found`
- `加载失败` / `Failed to load`
- `当前不可用` / `Currently unavailable`

Documentation is secondary context, never the primary action on a product
page. A user must be able to complete the available product flow without a
`查看文档` / `View docs` button. Keep error details behind a diagnostic affordance
when they are needed; never present a bare URL or an ambiguous `了解更多` /
`Learn more` action.

Marketplace discovery keeps documentation out of its primary actions. Source
management shows concise states such as `已停用` / `Disabled` and `更新失败` /
`Failed to update`; a source URL is a secondary machine field. Do not expose
raw fetch errors, cache implementation, profile storage, or identity-model
terms in the source list or form.

## Copy layers

| Layer | Include | Do not include |
| --- | --- | --- |
| Primary screen | Current state and the immediate next action | Causal chains, architecture, or security implementation detail |
| Expandable diagnostic | Error code, failed request detail, support data | A substitute for the primary state |
| Documentation | Architecture boundaries, protocol terms, setup, and full remediation | A hidden requirement needed to understand the current state |
| Confirmation | Material impact, irreversibility, and affected plugins | Avoidable implementation jargon |

Safety-critical confirmations keep the impact: uninstall, disabling dependent
plugins, permission grants, and destructive data operations must state what
will change before confirmation.

## Terms and localization

`fiber`, `generation`, `canonical identity`, schema internals, profile storage,
and Host/renderer boundaries are diagnostic or documentation terms. Do not put
them in normal empty states, headings, or settings introductions.

Every new user-visible product string must have matching `en` and `zh-CN`
messages when it is emitted through a plugin localization catalog. Keep status
meaning and available actions equivalent; diagnostic codes and user-provided
error text may remain unchanged.

Host-owned Manager states and actions are cataloged in
`packages/cli/src/renderer/ui-copy.ts` before their owner integrates them. Add
a pair to that catalog before using it in a primary surface. Resolve the
catalog from the current UI locale; use English only when the locale has no
Chinese language subtag. Do not use a translated label to replace a machine
id, URL, diagnostic code, or raw error.

## Interaction and layout system

- Host owns page chrome, layout, responsive behavior, theme tokens, focus, and
  native-looking controls. Plugins provide structured data and actions only.
- A heading and its introduction are rendered once. Do not repeat them in the
  first content section or use an empty page as an implicit description.
- A Host overlay uses the same type scale, icon geometry, spacing, and semantic
  tokens as the Manager that opened it. It has one title, at most one concise
  introduction, a rounded-square close control, and one content surface. Do not
  place a second section card around a single field or repeat the field help in
  the overlay introduction.
- Prefer an icon button with an accessible name and tooltip for a familiar,
  compact action. Text labels remain for names, state, and an action whose
  meaning would otherwise be ambiguous. Icon buttons use the Host rounded-square
  geometry; do not introduce a circular variant for the same control family.
- A configurable account is a compact account card: avatar when available (or
  an initial fallback), a platform badge at its lower edge, and connection
  state at the card edge. An empty capability is hidden rather than represented
  by a fake configuration page.
- Normal state comes before detail. Raw events, implementation vocabulary,
  machine identifiers, and dependency failures are only shown in Logs &
  diagnostics or an explicit expandable detail.
- Theme, narrow-width, focus, keyboard, and overflow behavior are component and
  page-template guarantees covered during implementation. Final acceptance
  checks the real user journey; it must not be the first place basic layout
  defects are found.
- Official custom elements own their visible border, background, radius, and
  padding inside their component shadow root. Host CSS may size and position
  the custom-element host, but must not draw a second button, Select, or Input
  shell around the official control.

## Review gate

Before merging UI copy changes, verify representative empty, error,
unavailable, read-only, and configuration states in both themes and a narrow
viewport. Tests should reject implementation terms from the affected primary
surface while allowing them in diagnostics and this documentation.

`tests/ui-copy-principles.test.ts` is the minimum gate for the Host catalog:
it requires a non-empty `en` and `zh-CN` entry for every governed key and
checks locale selection. An owner integrating a catalog entry must extend the
gate with its semantic surface, not add a one-off string assertion.
