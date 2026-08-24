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

## Review gate

Before merging UI copy changes, verify representative empty, error,
unavailable, read-only, and configuration states in both themes and a narrow
viewport. Tests should reject implementation terms from the affected primary
surface while allowing them in diagnostics and this documentation.
