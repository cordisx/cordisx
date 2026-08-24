# CordisX UI Copy Principles

## Product rule

Primary UI states describe the current condition and, when useful, offer one
clear next action. They do not teach implementation details.

Use short, direct status copy:

- `暂无数据` / `No data yet`
- `文件不存在` / `File not found`
- `加载失败` / `Failed to load`
- `当前不可用` / `Currently unavailable`

For configuration, lifecycle, Marketplace, and permission context, use an
actionable link such as `查看配置文档` / `View configuration docs` or
`查看错误详情` / `View error details`. Never present a bare URL or an ambiguous
`了解更多` / `Learn more` action.

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

## Review gate

Before merging UI copy changes, verify representative empty, error,
unavailable, read-only, and configuration states in both themes and a narrow
viewport. Tests should reject implementation terms from the affected primary
surface while allowing them in diagnostics and this documentation.

`tests/ui-copy-principles.test.ts` is the minimum gate for the Host catalog:
it requires a non-empty `en` and `zh-CN` entry for every governed key and
checks locale selection. An owner integrating a catalog entry must extend the
gate with its semantic surface, not add a one-off string assertion.
