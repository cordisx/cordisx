import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, vi } from 'vitest'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelConversationConsumer } from '../../packages/cli/src/launcher/channel-conversation-consumer.js'
import type { ChannelConversationAccess } from '../../packages/cli/src/launcher/channel-conversation-tools.js'

export const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
export const a = '01a10000-0000-7000-8000-000000000001', b = '01a10000-0000-7000-8000-000000000002'
export const channel = (id = 'oc_one', kind: 'direct' | 'group' = 'direct') => ({
  ...account,
  conversationId: id,
  kind,
  threadId: id,
  semantics: 'conversation' as const,
})
export const message = (id: string, text = 'hello', source = channel()): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'channel', event: { ...source, eventId: id, messageId: id, actor: { ...account, userId: 'alice' } } },
  receivedAt: '2026-11-15T00:00:00Z',
})
const roots: string[] = [], consumers: ChannelConversationConsumer[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
export async function fixture(existingFile?: string, logicalRuntime = true, logicalRecoveryRequired = false) {
  const root = existingFile ? path.dirname(existingFile) : await mkdtemp(path.join(os.tmpdir(), 'channel-consumer-'))
  if (!existingFile) roots.push(root)
  const file = existingFile ?? path.join(root, 'consumer.json')
  const receipts = new Map<string, { state: string }>()
  const native = {
    contextObservations: () => undefined,
    hasPreparation: () => false,
    isPreparing: () => false,
    exists: vi.fn(async () => true),
    start: vi.fn(async (_id: string, _input: ChannelUserInput, session?: string) => ({
      state: 'running' as const,
      sessionId: session ?? a,
      turnId: 'turn-1',
    })),
    completion: vi.fn(async () => ({ state: 'completed' as const, text: 'reply' })),
    reconcile: vi.fn(async () => ({
      state: 'reconciliation-required' as const,
      code: 'NATIVE_OPERATION_UNAVAILABLE_AFTER_RESTART',
    })),
  }
  const runtime = {
    inputsSince: vi.fn(async (_caller, _filters, cursor) => ({ cursor, messages: [] })),
    notifyOnce: vi.fn(async (_value, _caller, id: string) => {
      receipts.set(id, { state: 'sent' })
      return { deliveryId: id }
    }),
    deliverySnapshot: (id: string) => receipts.get(id),
  }
  const access = {
    generation: 'fixture',
    runtime,
    accounts: () => [{ ref: account, state: 'ready' }],
    conversations: async () => ({ complete: true, conversations: [] }),
    users: vi.fn(async () => ({
      complete: true,
      users: [{ id: 'ou_bob', name: 'Bob Smith' }],
    })),
    replyCapabilities: event => ({ reply: true, thread: event.kind === 'group' }),
    drain: async () => {},
  } as unknown as ChannelConversationAccess
  const report = vi.fn()
  const consumer = await ChannelConversationConsumer.open({
    appId: 'codex',
    logicalRuntime,
    logicalRecoveryRequired,
    profileId: 'fixture',
    file,
    access: () => access,
    native: () => native,
    report,
  })
  consumers.push(consumer)
  return { consumer, native, runtime, file, access, report }
}
export async function settle(consumer: ChannelConversationConsumer) {
  await consumer.pump()
  await consumer.pump()
}
