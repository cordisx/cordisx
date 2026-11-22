import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { LogicalContinuationControl } from '../packages/cli/src/launcher/logical-continuation-control.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'personal', sessionId: 'source' }
const request = {
  contract: 'cordisx.conversation-continuation-request/v1' as const,
  operationId: 'op',
  logicalConversationId: 'conversation',
  source,
  expectedRevision: 0,
  target: { providerId: 'openai', model: 'model' },
  mode: 'linked' as const,
  historyConsent: 'on-demand' as const,
  handoffConsent: 'none' as const,
  historyCategories: ['user-text' as const],
}
const actor = { principal: 'owner', scope: 'account/tenant/chat' }
const evidence = {
  sourceHistoryVersion: 'v1',
  handoff: 'none' as const,
  sourceConfiguration: {
    providerId: 'old',
    model: 'old',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
    execution: {
      approval: 'on-request' as const,
      workMode: 'default' as const,
      effort: 'medium',
      execution: 'read-only' as const,
    },
  },
}

describe('Channel logical durable transaction', () => {
  it('keeps legacy state unchanged until an intent, then fences interrupted effects across restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-logical-store-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      const transaction = channelLogicalTransactionStore(store)
      await transaction.mutate(() => false)
      expect(store.snapshot().schemaVersion).toBe(1)
      const control = new LogicalContinuationControl(transaction, {
        state: root => root.logicalContinuations!,
        admitted: () => true,
        bind: () => true,
        preflight: async () => evidence,
        create: async () => {
          const disk = JSON.parse(await readFile(file, 'utf8'))
          expect(disk.schemaVersion).toBe(2)
          expect(disk.logicalContinuations.intents.op.state).toBe('creating')
          throw new Error('connection lost')
        },
        confirm: async () => true,
      })
      expect(await control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'op' })
      await store.close()
      const reopened = await ChannelConversationStore.open(file)
      expect(reopened.snapshot().schemaVersion).toBe(2)
      expect(reopened.snapshot().logicalContinuations?.intents.op?.state).toBe('unknown')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('recovers an interrupted reservation before dispatch and never guesses a destination', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-logical-store-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      await channelLogicalTransactionStore(store).mutate(root => {
        root.logicalContinuations!.intents.op = { request, actor, evidence, state: 'creating' }
      })
      await store.close()
      const reopened = await ChannelConversationStore.open(file)
      expect(reopened.snapshot().logicalContinuations?.intents.op).toMatchObject({
        state: 'unknown',
        code: 'NATIVE_EFFECT_UNCERTAIN',
      })
      expect(reopened.snapshot().logicalContinuations?.intents.op?.destination).toBeUndefined()
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
