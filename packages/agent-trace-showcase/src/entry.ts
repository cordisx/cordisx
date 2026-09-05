import type { Context } from '@deepseek-ai/cordis'

export const SURFACE_CONTRIBUTION_V3_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v3.schema.json'

export interface SessionHeaderActionContributionV3 {
  readonly $schema: typeof SURFACE_CONTRIBUTION_V3_SCHEMA
  readonly schemaVersion: 3
  readonly id: 'open-timeline'
  readonly surface: 'session.header.actions'
  readonly group: 'action'
  readonly order: 10
  readonly item: {
    readonly label: {
      readonly namespace: 'agent-trace-showcase'
      readonly key: 'action.open'
      readonly fallback: string
    }
    readonly ariaLabel: {
      readonly namespace: 'agent-trace-showcase'
      readonly key: 'action.open'
      readonly fallback: string
    }
    readonly icon: 'host:history'
    readonly route: { readonly id: 'session.timeline' }
    readonly routeBehavior: 'toggle'
  }
}

/** Exact route-toggle data contribution pinned to protocol merge 8036d7228fdc. */
export const TRACE_SESSION_HEADER_ACTION = Object.freeze(
  {
    $schema: SURFACE_CONTRIBUTION_V3_SCHEMA,
    schemaVersion: 3,
    id: 'open-timeline',
    surface: 'session.header.actions',
    group: 'action',
    order: 10,
    item: Object.freeze({
      label: Object.freeze({
        namespace: 'agent-trace-showcase',
        key: 'action.open',
        fallback: 'Open Agent Trace Timeline',
      }),
      ariaLabel: Object.freeze({
        namespace: 'agent-trace-showcase',
        key: 'action.open',
        fallback: 'Open Agent Trace Timeline',
      }),
      icon: 'host:history',
      route: Object.freeze({ id: 'session.timeline' }),
      routeBehavior: 'toggle',
    }),
  } as const satisfies SessionHeaderActionContributionV3,
)

/** Single seam that registers catalog-v3 data through the public host service. */
export interface SessionHeaderEntryAdapter {
  register(ctx: Context, contribution: SessionHeaderActionContributionV3): () => void
}

/** Host registration contains no Codex selector, DOM node, or renderer logic. */
export const STRUCTURED_SESSION_HEADER_ENTRY: SessionHeaderEntryAdapter = Object.freeze({
  register: (ctx: Context, contribution: SessionHeaderActionContributionV3) =>
    ctx.slots.register({
      name: contribution.surface,
      id: contribution.id,
      group: contribution.group,
      order: contribution.order,
    }, contribution.item),
})
