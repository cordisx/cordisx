import type { ChannelContinuationDefaults } from './channel-continuation-defaults.js'
import type { ChannelContinuationRecord, ChannelConversationStore } from './channel-conversation-store.js'

export interface ChannelLivePolicyOverride {
  readonly revision: number
  readonly overrides: { readonly enabled?: boolean; readonly thresholdRatio?: number }
}

export function parseLivePolicy(value: unknown): ChannelLivePolicyOverride {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const overrides = row.overrides && typeof row.overrides === 'object' && !Array.isArray(row.overrides)
    ? row.overrides as Record<string, unknown>
    : {}
  if (
    !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || Object.keys(row).some(key => !['revision', 'overrides'].includes(key))
    || !row.overrides || typeof row.overrides !== 'object' || Array.isArray(row.overrides)
    || Object.keys(overrides).some(key => !['enabled', 'thresholdRatio'].includes(key))
    || overrides.enabled !== undefined && typeof overrides.enabled !== 'boolean'
    || overrides.thresholdRatio !== undefined && (typeof overrides.thresholdRatio !== 'number'
        || !Number.isFinite(overrides.thresholdRatio) || overrides.thresholdRatio <= 0
        || overrides.thresholdRatio > 0.95)
  ) {
    throw new Error('INVALID_CONTINUATION_POLICY')
  }
  return {
    revision: Number(row.revision),
    overrides: {
      ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled as boolean }),
      ...(overrides.thresholdRatio === undefined ? {} : { thresholdRatio: overrides.thresholdRatio as number }),
    },
  }
}

export function effectiveLivePolicy(defaults: ChannelContinuationDefaults, entry?: ChannelContinuationRecord) {
  const legacy = entry?.policy !== undefined && entry.livePolicy === undefined
  return {
    policy: { ...defaults.policy, ...entry?.livePolicy?.overrides, ...(legacy ? { enabled: false } : {}) },
    defaultsRevision: defaults.revision,
    overrideRevision: entry?.livePolicy?.revision ?? 0,
    legacy,
  }
}

/** Existing window-denominated policies are kept separate until explicitly opted into live policy. */
export async function livePolicyOperation(
  store: ChannelConversationStore,
  operation: string,
  args: Record<string, unknown>,
) {
  if (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 512) {
    throw new Error('INVALID_REQUEST')
  }
  const sessionId = args.sessionId
  const read = () => {
    const state = store.snapshot()
    if (!Object.values(state.bindings).some(binding => binding.sessionId === sessionId && binding.state === 'active')) {
      throw new Error('CHANNEL_TARGET_NOT_BOUND')
    }
    const entry = state.continuations[sessionId]
    return {
      status: 'ok' as const,
      ...effectiveLivePolicy(state.continuationDefaults, entry),
      overrides: entry?.livePolicy?.overrides ?? {},
    }
  }
  if (operation === 'continuation-live-policy' && Object.keys(args).every(key => key === 'sessionId')) return read()
  if (
    operation !== 'continuation-live-policy-set'
    || Object.keys(args).some(key => !['sessionId', 'expectedRevision', 'overrides'].includes(key))
    || !Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0
  ) throw new Error('INVALID_REQUEST')
  const policy = parseLivePolicy({ revision: Number(args.expectedRevision) + 1, overrides: args.overrides })
  return await store.mutate(state => {
    if (!Object.values(state.bindings).some(binding => binding.sessionId === sessionId && binding.state === 'active')) {
      throw new Error('CHANNEL_TARGET_NOT_BOUND')
    }
    const entry = state.continuations[sessionId] ??= {}
    if (entry.intent) throw new Error('CONTINUATION_ALREADY_RESERVED')
    if ((entry.livePolicy?.revision ?? 0) !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
    entry.livePolicy = policy
    return {
      status: 'ok' as const,
      ...effectiveLivePolicy(state.continuationDefaults, entry),
      overrides: policy.overrides,
    }
  })
}
