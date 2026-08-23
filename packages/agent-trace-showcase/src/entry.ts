import type { Context } from '@deepseek-ai/cordis'

export const SURFACE_CONTRIBUTION_V2_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v2.schema.json'

export interface SessionHeaderActionContributionV2 {
  readonly $schema: typeof SURFACE_CONTRIBUTION_V2_SCHEMA
  readonly schemaVersion: 2
  readonly id: 'open-timeline'
  readonly surface: 'session.header.actions'
  readonly group: 'action'
  readonly order: 10
  readonly item: {
    readonly label: { readonly namespace: 'agent-trace-showcase'; readonly key: 'action.open'; readonly fallback: string }
    readonly ariaLabel: { readonly namespace: 'agent-trace-showcase'; readonly key: 'action.open'; readonly fallback: string }
    readonly icon: 'host:history'
    readonly command: { readonly id: 'open-timeline' }
  }
}

/** Exact catalog-v2 data contribution pinned to protocol merge 2ec9ca15234e. */
export const TRACE_SESSION_HEADER_ACTION = Object.freeze({
  $schema: SURFACE_CONTRIBUTION_V2_SCHEMA,
  schemaVersion: 2,
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
    command: Object.freeze({ id: 'open-timeline' }),
  }),
} as const satisfies SessionHeaderActionContributionV2)

/** Single seam that registers catalog-v2 data through the public host service. */
export interface SessionHeaderEntryAdapter {
  register(ctx: Context, contribution: SessionHeaderActionContributionV2): () => void
}

/** Host registration contains no Codex selector, DOM node, or renderer logic. */
export const STRUCTURED_SESSION_HEADER_ENTRY: SessionHeaderEntryAdapter = Object.freeze({
  register: (ctx: Context, contribution: SessionHeaderActionContributionV2) => ctx.slots.register({
    name: contribution.surface,
    id: contribution.id,
    group: contribution.group,
    order: contribution.order,
  }, contribution.item),
})
