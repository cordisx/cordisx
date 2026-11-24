import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { LogicalContinuationActor, LogicalContinuationState } from './logical-continuation-control.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'
import { channelExact, channelPolicyAllows, channelRecord, channelText } from './channel-conversation-policy.js'
import { type ChannelTaskPatch, parseChannelTaskPatch } from './channel-task-config.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelLogicalBindingAdmitted } from './channel-logical-continuation-bind.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import { channelHistoryChain } from './channel-logical-history-chain.js'

/** A single actor's explicit, revocable consent for one exact future linked migration. */
export interface ChannelIdlePriorityGrant {
  readonly bindingId: string
  readonly source: LogicalSessionRef
  readonly actor: LogicalContinuationActor
  readonly logicalId: string
  readonly priorityRevision: number
  readonly taskConfigRevision: number
  readonly policyRevision: number
  readonly selection: ChannelTaskPatch
  readonly target: { readonly providerId: string; readonly model: string }
  readonly expiresAt: number
}

export function removeChannelIdlePriorityGrant(state: LogicalContinuationState, bindingId: string): void {
  if (!state.idlePriorityGrants) return
  delete state.idlePriorityGrants[bindingId]
  if (!Object.keys(state.idlePriorityGrants).length) delete state.idlePriorityGrants
}

export function parseChannelIdlePriorityGrants(value: unknown): Record<string, ChannelIdlePriorityGrant> {
  const rows = channelRecord(value), grants: Record<string, ChannelIdlePriorityGrant> = {}
  for (const [key, value] of Object.entries(rows)) {
    const row = channelRecord(value), source = channelRecord(row.source), actor = channelRecord(row.actor)
    const target = channelRecord(row.target), selection = parseChannelTaskPatch(row.selection)
    channelExact(row, [
      'bindingId',
      'source',
      'actor',
      'logicalId',
      'priorityRevision',
      'taskConfigRevision',
      'policyRevision',
      'selection',
      'target',
      'expiresAt',
    ])
    channelExact(source, ['hostId', 'appId', 'profileId', 'sessionId'])
    channelExact(actor, ['principal', 'scope'])
    channelExact(target, ['providerId', 'model'])
    for (const field of ['hostId', 'appId', 'profileId', 'sessionId']) channelText(source[field])
    for (const field of ['principal', 'scope']) channelText(actor[field])
    channelText(target.providerId, 128)
    channelText(target.model, 512)
    channelText(row.logicalId)
    if (
      key !== row.bindingId || key !== channelText(row.bindingId) || source.hostId !== 'local'
      || !selection.providerId || !selection.model || !selection.effort || typeof selection.fast !== 'boolean'
      || !Number.isSafeInteger(row.priorityRevision) || Number(row.priorityRevision) < 0
      || !Number.isSafeInteger(row.taskConfigRevision) || Number(row.taskConfigRevision) < 0
      || !Number.isSafeInteger(row.policyRevision) || Number(row.policyRevision) < 0
      || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= 0
    ) throw new Error('INVALID_IDLE_PRIORITY_GRANT')
    grants[key] = {
      bindingId: key,
      source: source as unknown as LogicalSessionRef,
      actor: actor as unknown as LogicalContinuationActor,
      logicalId: String(row.logicalId),
      priorityRevision: Number(row.priorityRevision),
      taskConfigRevision: Number(row.taskConfigRevision),
      policyRevision: Number(row.policyRevision),
      selection,
      target: target as unknown as ChannelIdlePriorityGrant['target'],
      expiresAt: Number(row.expiresAt),
    }
  }
  return grants
}

/** Rechecked against the transaction snapshot before each persistent native effect. */
export function channelIdleGrantCurrent(
  state: ChannelConversationState,
  grant: ChannelIdlePriorityGrant,
  event: ChannelEventRef,
  jobId?: string,
): boolean {
  const { source, selection, target } = grant
  const candidates = state.modelPriority.candidates
  const index = candidates.findIndex(row => row.providerId === selection.providerId && row.model === selection.model)
  const job = jobId ? state.jobs[jobId] : undefined
  const parents = Object.values(state.logicalContinuations?.relations ?? {}).filter(relation =>
    isDeepStrictEqual(relation.destination, source)
  )
  if (parents.length > 1) return false
  if (parents[0]?.mode === 'linked') {
    try {
      channelHistoryChain(state, parents[0], JSON.stringify(grant.actor))
    } catch {
      return false
    }
  }
  return grant.expiresAt > Date.now() && state.modelPriority.revision === grant.priorityRevision
    && state.taskConfigRevision === grant.taskConfigRevision && state.policyRevision === grant.policyRevision
    && index >= 0 && isDeepStrictEqual(candidates[index + 1], target)
    && isDeepStrictEqual(state.logicalContinuations?.idlePriorityGrants?.[grant.bindingId], grant)
    && isDeepStrictEqual(grant.actor, channelLogicalActor(event))
    && grant.logicalId === logicalConversationIdentity(state.logicalContinuations, source)
    && state.bindings[grant.bindingId]?.sessionId === source.sessionId
    && state.bindings[grant.bindingId]?.state === 'active' && state.bindings[grant.bindingId]?.mode === 'deliver'
    && channelPolicyAllows(state.policy, 'command', event, 'continue-provider')
    && channelLogicalBindingAdmitted(state, event, source.profileId, source.sessionId)
    && (!jobId || !!job && job.state === 'queued' && job.sessionId === source.sessionId
        && job.bindingId === grant.bindingId)
}
