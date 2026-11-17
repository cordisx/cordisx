import type { ChannelConversationStore } from './channel-conversation-store.js'

export interface ChannelContinuationDefaults {
  readonly revision: number
  readonly policy: { readonly enabled: boolean; readonly thresholdRatio: number }
}
export const INITIAL_CONTINUATION_DEFAULTS: ChannelContinuationDefaults = {
  revision: 0,
  policy: { enabled: false, thresholdRatio: 0.9 },
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function parseContinuationDefaults(value: unknown): ChannelContinuationDefaults {
  const row = object(value), policy = object(row.policy)
  if (
    Object.keys(row).some(key => !['revision', 'policy'].includes(key))
    || Object.keys(policy).some(key => !['enabled', 'thresholdRatio'].includes(key))
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || typeof policy.enabled !== 'boolean' || typeof policy.thresholdRatio !== 'number'
    || !Number.isFinite(policy.thresholdRatio) || policy.thresholdRatio <= 0 || policy.thresholdRatio > 0.95
  ) throw new Error('INVALID_CONTINUATION_DEFAULTS')
  return { revision: Number(row.revision), policy: { enabled: policy.enabled, thresholdRatio: policy.thresholdRatio } }
}

/** Profile defaults never rewrite an existing session's explicit override. */
export async function continuationDefaultsOperation(
  store: ChannelConversationStore,
  operation: string,
  args: Record<string, unknown>,
) {
  if (operation === 'continuation-defaults') {
    if (Object.keys(args).length) throw new Error('INVALID_REQUEST')
    return { status: 'ok' as const, ...store.snapshot().continuationDefaults }
  }
  if (
    operation !== 'continuation-defaults-set'
    || Object.keys(args).some(key => !['policy', 'expectedRevision'].includes(key))
    || !Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0
  ) throw new Error('INVALID_REQUEST')
  const next = parseContinuationDefaults({ revision: Number(args.expectedRevision) + 1, policy: args.policy })
  return store.mutate(state => {
    if (state.continuationDefaults.revision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
    state.continuationDefaults = next
    return { status: 'ok' as const, ...next }
  })
}
