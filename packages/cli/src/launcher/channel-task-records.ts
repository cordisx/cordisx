import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelTaskRequest, ChannelTaskSetting } from './channel-conversation-store.js'
import { channelExact, channelRecord, channelText } from './channel-conversation-policy.js'
import { parseChannelTaskPatch } from './channel-task-config.js'

const states = ['pending', 'queued', 'applying', 'submitted', 'applied', 'denied', 'expired', 'unknown']
function event(value: unknown): ChannelEventRef {
  const row = channelRecord(value)
  channelExact(row, [
    'adapterId',
    'accountId',
    'tenantId',
    'conversationId',
    'threadId',
    'semantics',
    'kind',
    'eventId',
    'messageId',
    'actor',
  ])
  for (const field of ['adapterId', 'accountId', 'tenantId', 'conversationId', 'eventId', 'threadId']) {
    channelText(row[field])
  }
  if (
    !['direct', 'group'].includes(String(row.kind))
    || !['conversation', 'topic', 'reply-chain'].includes(String(row.semantics))
  ) throw new Error('INVALID_TASK_RECORD')
  if (row.actor !== undefined) {
    const actor = channelRecord(row.actor)
    channelExact(actor, ['adapterId', 'accountId', 'tenantId', 'userId'])
    channelText(actor.userId)
    for (const field of ['adapterId', 'accountId', 'tenantId']) {
      if (actor[field] !== row[field]) throw new Error('INVALID_TASK_RECORD')
    }
  }
  if (row.messageId !== undefined) channelText(row.messageId)
  return structuredClone(row) as unknown as ChannelEventRef
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('INVALID_TASK_RECORD')
  return Number(value)
}
/** Persisted requests are immutable, exact intents; malformed authority data never becomes a grant. */
export function parseChannelTaskRecords(settingsValue: unknown, requestsValue: unknown) {
  const taskSettings: Record<string, ChannelTaskSetting> = {}, taskRequests: Record<string, ChannelTaskRequest> = {}
  for (const [id, value] of Object.entries(channelRecord(settingsValue))) {
    channelText(id)
    const row = channelRecord(value)
    channelExact(row, [
      'revision',
      'settings',
      'application',
      'pending',
      'pendingPatch',
      'baseSelection',
      'requested',
      'code',
    ])
    if (!['saved', 'applying', 'submitted', 'applied', 'unknown'].includes(String(row.application))) {
      throw new Error('INVALID_TASK_RECORD')
    }
    taskSettings[id] = {
      revision: revision(row.revision),
      settings: parseChannelTaskPatch(row.settings),
      application: row.application as ChannelTaskSetting['application'],
      ...(row.pending === undefined ? {} : { pending: parseChannelTaskPatch(row.pending) }),
      ...(row.pendingPatch === undefined ? {} : { pendingPatch: parseChannelTaskPatch(row.pendingPatch) }),
      ...(row.baseSelection === undefined ? {} : { baseSelection: parseChannelTaskPatch(row.baseSelection) }),
      ...(row.requested === undefined ? {} : { requested: parseChannelTaskPatch(row.requested) }),
      ...(row.code === undefined ? {} : { code: channelText(row.code) }),
    }
    if (row.pending !== undefined && (row.pendingPatch === undefined || row.baseSelection === undefined)) {
      throw new Error('INVALID_TASK_RECORD')
    }
    if (
      ['saved', 'applying'].includes(String(row.application)) && row.pending === undefined
      || ['applying', 'submitted'].includes(String(row.application)) && row.requested === undefined
    ) {
      throw new Error('INVALID_TASK_RECORD')
    }
  }
  for (const [id, value] of Object.entries(channelRecord(requestsValue))) {
    const row = channelRecord(value)
    channelExact(row, [
      'id',
      'token',
      'source',
      'threadId',
      'patch',
      'selection',
      'baseSelection',
      'createdAt',
      'expiresAt',
      'expectedRevision',
      'state',
      'approvedBy',
      'cardMessageId',
      'code',
    ])
    if (
      !/^[a-f0-9]{8}$/u.test(id) || row.id !== id || typeof row.token !== 'string' || !/^[a-f0-9]{48}$/u.test(row.token)
      || !states.includes(String(row.state)) || !Number.isSafeInteger(row.createdAt)
      || !Number.isSafeInteger(row.expiresAt)
      || Number(row.createdAt) < 0 || Number(row.expiresAt) <= Number(row.createdAt)
      || Number(row.expiresAt) - Number(row.createdAt) > 10 * 60_000
    ) throw new Error('INVALID_TASK_RECORD')
    taskRequests[id] = {
      id,
      token: row.token,
      source: event(row.source),
      threadId: channelText(row.threadId),
      patch: parseChannelTaskPatch(row.patch),
      selection: parseChannelTaskPatch(row.selection),
      baseSelection: parseChannelTaskPatch(row.baseSelection),
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      expectedRevision: revision(row.expectedRevision),
      state: row.state as ChannelTaskRequest['state'],
      ...(row.approvedBy === undefined ? {} : { approvedBy: event(row.approvedBy) }),
      ...(row.cardMessageId === undefined ? {} : { cardMessageId: channelText(row.cardMessageId) }),
      ...(row.code === undefined ? {} : { code: channelText(row.code) }),
    }
    const request = taskRequests[id]!
    if (
      !Object.keys(request.patch).length || !request.source.actor
      || ['queued', 'applying', 'submitted', 'applied'].includes(request.state) && !request.approvedBy
      || request.approvedBy
        && ['adapterId', 'accountId', 'tenantId', 'conversationId'].some(field =>
          request.source[field as keyof ChannelEventRef] !== request.approvedBy![field as keyof ChannelEventRef]
        )
    ) throw new Error('INVALID_TASK_RECORD')
  }
  return { taskSettings, taskRequests }
}
