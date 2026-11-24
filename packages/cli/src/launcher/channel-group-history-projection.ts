import { createHash } from 'node:crypto'
import type { ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { LogicalContinuationActor } from './logical-continuation-control.js'
import { CALLER } from './channel-conversation-consumer-contract.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { identity, sameConversation, thread } from './channel-conversation-refs.js'
import { channelExact, channelRecord, channelText } from './channel-conversation-policy.js'
import { channelCommandDenied } from './channel-conversation-policy.js'
import { channelTaskChangeDenied, channelTaskFields, type ChannelTaskPatch } from './channel-task-config.js'

export interface ChannelGroupHistoryProjection {
  readonly bindingId: string
  readonly group: ChannelThreadRef
  readonly authorizer: LogicalContinuationActor
  readonly policyRevision: number
  readonly taskConfigRevision: number
  readonly expiresAt: number
  readonly entries: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  revoked?: true
}

/** Only accepted group jobs and their positively acknowledged final deliveries enter the snapshot. */
export function captureChannelGroupHistory(input: {
  state: ChannelConversationState
  access: ChannelConversationAccess | undefined
  bindingId: string
  beforeSequence: number
  authorizer: LogicalContinuationActor
  expiresAt: number
  target: { readonly providerId: string; readonly model: string }
  selection: ChannelTaskPatch
}): ChannelGroupHistoryProjection | undefined {
  const { state, access, bindingId, beforeSequence, authorizer, expiresAt, target, selection } = input
  const binding = state.bindings[bindingId]
  if (
    !binding || binding.state !== 'active' || binding.mode !== 'deliver' || binding.channel.kind !== 'group'
    || !access || !Number.isSafeInteger(beforeSequence)
  ) return undefined
  const ref = binding.channel
  if (
    !access.accounts().some(account =>
      account.state === 'ready'
      && account.ref.adapterId === ref.adapterId && account.ref.accountId === ref.accountId
      && account.ref.tenantId === ref.tenantId
    )
  ) return undefined
  const jobs = Object.values(state.jobs).flatMap(job => {
    const record = state.inputs[job.recordId], event = record?.input.source.event
    if (
      job.bindingId !== bindingId || !job.turnId || !['completed', 'failed'].includes(job.state)
      || !record?.accepted || !record.routed || !record.persisted || record.sequence >= beforeSequence || !event
      || event.kind !== 'group' || !sameConversation(event, ref) || !event.actor?.userId
      || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
      || event.actor.tenantId !== event.tenantId || !channelDispatchAllowed(state, event)
      || [...channelTaskFields(target), 'continue-provider', 'task-settings'].some(command =>
        channelCommandDenied(state.policy, event, command)
      )
      || channelTaskChangeDenied(state.taskConfig, state.policy, event, target, { ...selection, ...target })
    ) return []
    return [{ job, record, event }]
  }).sort((a, b) => a.record.sequence - b.record.sequence || a.job.id.localeCompare(b.job.id)).slice(-16)
  const entries: { role: 'user' | 'assistant'; text: string }[] = []
  for (const { job, record, event } of jobs) {
    const text = record.input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      .replace(/\0/gu, '').slice(0, 4_096)
    if (text) entries.push({ role: 'user', text })
    const id = `delivery:${identity([job.id, event])}`
    const reply = job.finalDeliveryEnabled === true
      ? access.runtime.confirmedGroupDeliveryText(id, CALLER, ref)
      : undefined
    if (reply) {
      const text = reply.replace(/\0/gu, '').slice(0, 4_096)
      if (text) entries.push({ role: 'assistant', text })
    }
  }
  return {
    bindingId,
    group: structuredClone(ref),
    authorizer: structuredClone(authorizer),
    policyRevision: state.policyRevision,
    taskConfigRevision: state.taskConfigRevision,
    expiresAt,
    entries,
  }
}

export function channelGroupProjectionVersion(projection: ChannelGroupHistoryProjection): string {
  const { group, authorizer } = projection
  const canonical = [
    projection.bindingId,
    group.adapterId,
    group.accountId,
    group.tenantId,
    group.conversationId,
    group.kind,
    group.threadId,
    group.semantics,
    authorizer.principal,
    authorizer.scope,
    projection.policyRevision,
    projection.taskConfigRevision,
    projection.expiresAt,
    projection.entries.map(entry => [entry.role, entry.text]),
  ]
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

export function parseChannelGroupHistoryProjection(value: unknown): ChannelGroupHistoryProjection {
  const row = channelRecord(value), actor = channelRecord(row.authorizer), group = thread(row.group)
  channelExact(row, [
    'bindingId',
    'group',
    'authorizer',
    'policyRevision',
    'taskConfigRevision',
    'expiresAt',
    'entries',
    'revoked',
  ])
  channelExact(actor, ['principal', 'scope'])
  if (
    group.kind !== 'group' || !Number.isSafeInteger(row.policyRevision) || Number(row.policyRevision) < 0
    || !Number.isSafeInteger(row.taskConfigRevision) || Number(row.taskConfigRevision) < 0
    || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= 0
    || row.revoked !== undefined && row.revoked !== true || !Array.isArray(row.entries) || row.entries.length > 32
  ) {
    throw new Error('INVALID_GROUP_HISTORY')
  }
  const entries = row.entries.map(value => {
    const entry = channelRecord(value)
    channelExact(entry, ['role', 'text'])
    if (
      !['user', 'assistant'].includes(String(entry.role)) || typeof entry.text !== 'string'
      || !entry.text.length || entry.text.length > 4_096 || entry.text.includes('\0')
    ) throw new Error('INVALID_GROUP_HISTORY')
    return { role: entry.role as 'user' | 'assistant', text: entry.text }
  })
  return {
    bindingId: channelText(row.bindingId),
    group,
    authorizer: { principal: channelText(actor.principal), scope: channelText(actor.scope, 4096) },
    policyRevision: Number(row.policyRevision),
    taskConfigRevision: Number(row.taskConfigRevision),
    expiresAt: Number(row.expiresAt),
    entries,
    ...(row.revoked === true ? { revoked: true as const } : {}),
  }
}
