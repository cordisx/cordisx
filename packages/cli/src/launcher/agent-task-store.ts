import { createHash } from 'node:crypto'
import type { AgentTaskContext, AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import { type AgentTaskRecord, canonicalTaskJson } from '../agent-task-record.js'
import { resolveAgentTaskContext } from './agent-task-context.js'

type Snapshot = { revision: number; value: unknown }
export async function handleAgentTaskStore(
  request: Record<string, unknown>,
  storage: {
    load(id: string): Promise<Snapshot | undefined>
    write(id: string, revision: number, value: unknown): Promise<void>
    context(sessionId: string): Promise<AgentTaskResolvedContext | undefined>
  },
): Promise<unknown> {
  if (request.operation === 'native-session-task-context') {
    return await resolveAgentTaskContext(request.context as AgentTaskContext, { inherited: storage.context })
  }
  const operationId = request.operationId
  if (typeof operationId !== 'string' || !operationId.length || operationId.length > 512) {
    throw new Error('Invalid task operation')
  }
  const key = agentTaskStoreKey(operationId)
  const snapshot = await storage.load(key)
  const existing = snapshot?.value as AgentTaskRecord | undefined
  if (existing !== undefined && existing.operationId !== operationId) throw new Error('Task operation scope mismatch')
  if (request.operation === 'native-session-task-load') {
    if (existing === undefined) return null
    if (existing.result?.status === 'accepted' || await storage.context(existing.sessionId) === undefined) {
      return existing
    }
    // Native binding acknowledgement can survive failure before the runtime ledger or task checkpoint.
    return {
      ...existing,
      result: {
        ...(existing.result ?? { status: 'unavailable', operationId, code: 'reconciliation-required' }),
        sessionId: existing.sessionId,
      },
    }
  }
  if (request.operation === 'native-session-task-recover') {
    if (existing === undefined) throw new Error('Task intent unavailable')
    if (existing.bindingPolicy !== 'required' || existing.phase !== 'approval-install-failed') {
      return { claimed: false, record: existing }
    }
    const { result: _result, ...rest } = existing
    const recovered: AgentTaskRecord = { ...rest, phase: 'approval-installing' }
    try {
      await storage.write(key, snapshot!.revision, recovered)
      return { claimed: true, record: recovered }
    } catch (error) {
      const competing = await storage.load(key)
      if (competing === undefined) throw error
      return { claimed: false, record: competing.value }
    }
  }
  const record = request.record as AgentTaskRecord
  if (!record || record.operationId !== operationId || !record.sessionId || !record.messageId || !record.context?.cwd) {
    throw new Error('Invalid task checkpoint')
  }
  canonicalTaskJson(record)
  if (request.operation === 'native-session-task-claim') {
    if (existing !== undefined) return { claimed: false, record: existing }
    if (record.phase !== 'intent' || record.result !== undefined) throw new Error('Invalid task intent')
    try {
      await storage.write(key, 0, record)
      return { claimed: true, record }
    } catch (error) {
      const competing = await storage.load(key)
      if (competing === undefined) throw error
      return { claimed: false, record: competing.value }
    }
  }
  if (request.operation !== 'native-session-task-save' || existing === undefined) {
    throw new Error('Task intent unavailable')
  }
  for (const field of ['operationId', 'fingerprint', 'sessionId', 'messageId', 'context'] as const) {
    if (canonicalTaskJson(record[field]) !== canonicalTaskJson(existing[field])) {
      throw new Error('Task correlation conflict')
    }
  }
  if ((record.bindingPolicy ?? 'none') !== (existing.bindingPolicy ?? 'none')) {
    throw new Error('Task approval policy conflict')
  }
  const phases = [
    'intent',
    'creating',
    'created',
    'binding',
    'approval-installing',
    'approval-install-failed',
    'submitting',
    'finished',
  ]
  if (phases.indexOf(record.phase) < phases.indexOf(existing.phase) || !phases.includes(record.phase)) {
    throw new Error('Task phase conflict')
  }
  if (existing.phase === 'finished' && canonicalTaskJson(existing) !== canonicalTaskJson(record)) {
    throw new Error('Task result is immutable')
  }
  if (
    record.result?.status === 'accepted' && (existing.phase !== 'submitting'
      || record.result.task.sessionId !== record.sessionId || record.result.task.messageId !== record.messageId
      || canonicalTaskJson(record.result.task.context) !== canonicalTaskJson(record.context))
  ) {
    throw new Error('Task acceptance correlation conflict')
  }
  await storage.write(key, snapshot!.revision, record)
  return null
}

export const agentTaskStoreKey = (operationId: string): string =>
  `native-task.${createHash('sha256').update(operationId).digest('hex').slice(0, 40)}`
