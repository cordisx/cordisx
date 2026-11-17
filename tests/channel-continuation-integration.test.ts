import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { type AgentBridge, createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'

const source = '01a10000-0000-7000-8000-000000000001'
const target = '01a10000-0000-7000-8000-000000000002'
const account = { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant' }
const channel = {
  ...account,
  conversationId: 'oc_one',
  kind: 'direct' as const,
  threadId: 'oc_one',
  semantics: 'conversation' as const,
}
const message = (id: string): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text: id }],
  source: { kind: 'channel', event: { ...channel, eventId: id, messageId: id, actor: { ...account, userId: 'user' } } },
  receivedAt: '2026-01-01T00:00:00Z',
})
const configuration = {
  providerId: 'openai',
  model: 'model',
  cwd: '/tmp',
  serviceTier: null,
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly' },
  permissionProfile: null,
  execution: {
    approval: 'never' as const,
    workMode: 'default' as const,
    effort: 'high',
    execution: 'read-only' as const,
  },
}

describe('Channel continuation dispatch composition', () => {
  it('retires a manual handoff context when no first turn was acknowledged', async () => {
    const bridge = { call: async () => ({ status: 'failed', sessionId: target }) } as unknown as AgentBridge
    const sessions = new ChannelNativeSessions({ bridge: () => bridge, nativeRequest: async () => ({}), cwd: '/tmp' })
    expect(
      await sessions.startContinuation('manual-operation', 'checkpoint', configuration, message('prior').source.event),
    )
      .toMatchObject({ state: 'reconciliation-required', sessionId: target })
    expect(sessions.sourceFor(target)).toBeUndefined()
  })
  it('starts a fresh task at idle even when no new message is queued', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'continuation-idle-'))
    let eligible = false
    const native = {
      contextObservations: () => undefined,
      hasPreparation: () => false,
      isPreparing: () => false,
      exists: vi.fn(async () => true),
      idle: vi.fn(async () => true),
      continuationEligible: vi.fn(() => eligible),
      continuationConfiguration: vi.fn(async () => configuration),
      start: vi.fn(async (_id: string, _message: ChannelUserInput, session?: string) => ({
        state: 'running' as const,
        sessionId: session ?? target,
        turnId: session ? 'old-turn' : 'new-turn',
      })),
      completion: vi.fn(async (_session: string, turn: string) => ({
        state: turn === 'old-turn' ? 'completed' as const : 'running' as const,
      })),
      reconcile: vi.fn(async () => ({ state: 'reconciliation-required' as const })),
    }
    const access = {
      generation: 'fixture',
      runtime: { inputsSince: async (_a: unknown, _b: unknown, cursor: string) => ({ cursor, messages: [] }) },
      accounts: () => [{ ref: account, state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      drain: async () => {},
    } as unknown as ChannelConversationAccess
    const consumer = await ChannelConversationConsumer.open({
      profileId: 'fixture',
      file: path.join(root, 'state.json'),
      access: () => access,
      native: () => native,
    })
    try {
      consumer.setNativeExtras(() => native as unknown as ChannelNativeSessions)
      await consumer.policySet({ enabled: true }, 0)
      await consumer.bind({ channel, mode: 'deliver', autoReply: false }, source)
      await consumer.continuation.setCheckpoint(source, {
        goal: 'goal',
        constraints: 'constraints',
        completed: 'done',
        remaining: 'next',
        history: 'source',
        continueAtIdle: false,
      }, 0)
      await consumer.continuation.setPolicy(source, {
        enabled: true,
        threshold: 0.8,
        reserveTokens: 200,
        maxAgeMs: 60000,
      })
      await consumer.receive('idle-input', message('prior'))
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(1)
      eligible = true
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(1)
      await consumer.continuation.setCheckpoint(source, {
        goal: 'goal',
        constraints: 'constraints',
        completed: 'done',
        remaining: 'next',
        history: 'source',
        continueAtIdle: true,
      }, 1)
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(2)
      const call = native.start.mock.calls[1] as unknown as unknown[]
      expect(call[2]).toBeUndefined()
      expect(call[1]).toMatchObject({ content: [{ text: expect.stringContaining('No new Channel message') }] })
      expect(consumer.bindings()[0]?.sessionId).toBe(target)
      expect(consumer.status().jobs).toContainEqual(
        expect.objectContaining({ sessionId: target, state: 'running', turnId: 'new-turn' }),
      )
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(2)
    } finally {
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('does not promote or resend an uncertain fresh start through ordinary job reconciliation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'continuation-uncertain-'))
    const native = {
      contextObservations: () => undefined,
      hasPreparation: () => false,
      isPreparing: () => false,
      exists: vi.fn(async () => true),
      idle: vi.fn(async () => true),
      continuationEligible: vi.fn(() => true),
      continuationConfiguration: vi.fn(async () => configuration),
      start: vi.fn(async () => ({ state: 'reconciliation-required' as const, sessionId: target, turnId: 'turn-1' })),
      completion: vi.fn(async () => ({ state: 'running' as const })),
      reconcile: vi.fn(async () => ({ state: 'running' as const, sessionId: target, turnId: 'turn-1' })),
    }
    const access = {
      generation: 'fixture',
      runtime: { inputsSince: async (_a: unknown, _b: unknown, cursor: string) => ({ cursor, messages: [] }) },
      accounts: () => [{ ref: account, state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      drain: async () => {},
    } as unknown as ChannelConversationAccess
    const consumer = await ChannelConversationConsumer.open({
      profileId: 'fixture',
      file: path.join(root, 'state.json'),
      access: () => access,
      native: () => native,
    })
    try {
      consumer.setNativeExtras(() => native as unknown as ChannelNativeSessions)
      await consumer.policySet({ enabled: true }, 0)
      await consumer.bind({ channel, mode: 'deliver', autoReply: false }, source)
      await consumer.continuation.setCheckpoint(source, {
        goal: 'goal',
        constraints: 'constraints',
        completed: 'done',
        remaining: 'next',
        history: 'source',
        continueAtIdle: true,
      }, 0)
      await consumer.continuation.setPolicy(source, {
        enabled: true,
        threshold: 0.8,
        reserveTokens: 200,
        maxAgeMs: 60000,
      })
      await consumer.receive('record-uncertain', message('uncertain'))
      await consumer.pump()
      await consumer.pump()
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(1)
      expect(native.reconcile).not.toHaveBeenCalled()
      expect(consumer.status().jobs).toMatchObject([{
        state: 'reconciliation-required',
        code: 'CONTINUATION_EFFECT_UNCERTAIN',
      }])
      expect(consumer.continuation.read(source).intent).toMatchObject({
        state: 'unknown',
        targetThreadId: target,
        targetTurnId: 'turn-1',
      })
      expect(consumer.bindings()[0]?.sessionId).toBe(source)
    } finally {
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('keeps the Channel operation correlated while the fresh native operation has its own deduplication ID', async () => {
    let sessions!: ChannelNativeSessions
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === 'thread/start') {
        return {
          thread: { id: target },
          modelProvider: 'openai',
          model: 'model',
          cwd: '/tmp',
          serviceTier: null,
          approvalsReviewer: 'user',
          approvalPolicy: 'never',
          reasoningEffort: 'high',
          sandbox: configuration.sandbox,
          activePermissionProfile: null,
        }
      }
      if (method === 'turn/start') {
        expect(sessions.sourceFor(target, 'turn-1')?.eventId).toBe('one')
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    const handler = createCodexBridgeHandler({
      nativeRequest,
      catalog: async () => [{ providerId: 'openai', models: [{ id: 'model', label: 'model', aliases: [] }] }],
      observedDispatch: (operationId, threadId, turnId) => sessions.observedDispatch(operationId, threadId, turnId),
    }, '/tmp')
    sessions = new ChannelNativeSessions({
      bridge: () => ({ call: (_app, operation, args, signal) => handler(operation, args, signal) }) as AgentBridge,
      nativeRequest,
      cwd: '/tmp',
    })
    expect(
      await sessions.start(
        'channel-job',
        message('one'),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          operationId: 'fresh-operation',
          brief: 'checkpoint',
          configuration,
        },
      ),
    ).toMatchObject({ state: 'running', sessionId: target })
  })
  it('allows the exact active Channel turn to save its own checkpoint, and rejects forged or expired contexts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'continuation-context-'))
    const event = message('one').source.event
    let active = true
    const native = {
      contextObservations: () => undefined,
      hasPreparation: () => false,
      isPreparing: () => false,
      exists: async () => true,
      contextFor: (token: string) =>
        token === 'valid' ? { source: event, token, threadId: source, turnId: 'turn-1' } : undefined,
      sourceFor: (threadId: string, turnId?: string) =>
        threadId === source && (!turnId || turnId === 'turn-1') ? event : undefined,
      continuationTurnActive: async (threadId: string, turnId: string) =>
        active && threadId === source && turnId === 'turn-1',
    }
    const access = {
      generation: 'fixture',
      accounts: () => [{ ref: account, state: 'ready' }],
    } as ChannelConversationAccess
    const consumer = await ChannelConversationConsumer.open({
      profileId: 'fixture',
      file: path.join(root, 'state.json'),
      access: () => access,
      native: () => native as never,
    })
    const tools = new ChannelConversationTools(() => access, consumer)
    try {
      consumer.setNativeExtras(() => native as unknown as ChannelNativeSessions)
      await consumer.bind({ channel, mode: 'deliver', autoReply: false }, source)
      const checkpoint = {
        goal: 'goal',
        constraints: 'constraints',
        completed: 'done',
        remaining: 'next',
        history: 'source',
        continueAtIdle: true,
      }
      expect(await tools.callLocal('continuation-checkpoint', {}, { 'cordisx/channelContext': 'valid' }))
        .toMatchObject({ status: 'ok', revision: 0, checkpoint: null })
      expect(
        await tools.callLocal('continuation-checkpoint-set', { expectedRevision: null, checkpoint }, {
          'cordisx/channelContext': 'valid',
        }),
      ).toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
      expect(
        await tools.callLocal('continuation-checkpoint-set', { expectedRevision: 0, checkpoint }, {
          'cordisx/channelContext': 'forged',
        }),
      ).toMatchObject({ status: 'rejected' })
      expect(
        await tools.callLocal('continuation-checkpoint-set', { expectedRevision: 0, checkpoint }, {
          'cordisx/channelContext': 'valid',
          'openai/threadId': target,
        }),
      ).toMatchObject({ status: 'rejected' })
      expect(
        await tools.callLocal('continuation-checkpoint-set', { expectedRevision: 0, checkpoint }, {
          'cordisx/channelContext': 'valid',
          'openai/threadId': source,
        }),
      ).toMatchObject({ status: 'ok', checkpoint: { threadId: source, revision: 1 } })
      expect(await tools.callLocal('continuation-checkpoint', {}, { 'cordisx/channelContext': 'valid' }))
        .toMatchObject({ status: 'ok', revision: 1, checkpoint: { threadId: source } })
      active = false
      expect(await tools.callLocal('continuation-checkpoint', {}, { 'cordisx/channelContext': 'valid' }))
        .toMatchObject({ status: 'rejected' })
      expect(
        await tools.callLocal('continuation-policy-set', { sessionId: source, policy: {} }, {
          'cordisx/channelContext': 'valid',
        }),
      ).toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
    } finally {
      tools.dispose()
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('creates a fresh task with the checkpoint once and moves the next queued message', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'continuation-composition-'))
    const native = {
      contextObservations: () => undefined,
      hasPreparation: () => false,
      isPreparing: () => false,
      exists: vi.fn(async () => true),
      idle: vi.fn(async () => true),
      continuationEligible: vi.fn(() => true),
      continuationConfiguration: vi.fn(async () => configuration),
      start: vi.fn(async () => ({ state: 'running' as const, sessionId: target, turnId: 'turn-1' })),
      contextFor: vi.fn((token: string) =>
        token === 'history-token'
          ? { source: message('one').source.event, token, threadId: target, turnId: 'turn-1' }
          : undefined
      ),
      sourceFor: vi.fn((threadId: string) => threadId === target ? message('one').source.event : undefined),
      continuationTurnActive: vi.fn(async () => true),
      continuationHistory: vi.fn(async () => ({ entries: [{ role: 'user', text: 'older' }], truncated: false })),
      completion: vi.fn(async () => ({ state: 'running' as const })),
      reconcile: vi.fn(async () => ({ state: 'reconciliation-required' as const })),
    }
    const access = {
      generation: 'fixture',
      runtime: { inputsSince: async (_a: unknown, _b: unknown, cursor: string) => ({ cursor, messages: [] }) },
      accounts: () => [{ ref: account, state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      drain: async () => {},
    } as unknown as ChannelConversationAccess
    const consumer = await ChannelConversationConsumer.open({
      profileId: 'fixture',
      file: path.join(root, 'state.json'),
      access: () => access,
      native: () => native,
    })
    try {
      consumer.setNativeExtras(() => native as unknown as ChannelNativeSessions)
      await consumer.policySet({ enabled: true }, 0)
      await consumer.bind({ channel, mode: 'deliver', autoReply: false }, source)
      await consumer.continuation.setCheckpoint(source, {
        goal: 'goal',
        constraints: 'constraints',
        completed: 'done',
        remaining: 'next',
        history: 'source',
        continueAtIdle: true,
      }, 0)
      await consumer.continuation.setPolicy(source, {
        enabled: true,
        threshold: 0.8,
        reserveTokens: 200,
        maxAgeMs: 60000,
      })
      await consumer.receive('record-1', message('one'))
      await consumer.receive('record-2', message('two'))
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(1)
      const call = native.start.mock.calls[0] as unknown as unknown[]
      expect(call[2]).toBeUndefined()
      expect(call[8]).toMatchObject({ configuration, brief: expect.stringContaining(source) })
      expect(consumer.bindings()[0]?.sessionId).toBe(target)
      const tools = new ChannelConversationTools(() => access, consumer)
      const metadata = { 'cordisx/channelContext': 'history-token', 'openai/threadId': target }
      expect(await tools.callLocal('continuation-history', { limit: 1 }, metadata)).toMatchObject({
        status: 'ok',
        source,
        entries: [{ text: 'older' }],
      })
      expect(native.continuationHistory).toHaveBeenCalledWith(source, { limit: 1 })
      expect(await tools.callLocal('continuation-history', { sourceId: 'different-thread' }, metadata))
        .toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
      tools.dispose()
      await consumer.pump()
      const jobs = consumer.status().jobs
      expect(jobs.map(job => job.sessionId)).toEqual([target, target])
      expect(jobs.filter(job => job.state === 'running')).toHaveLength(1)
      expect(jobs.filter(job => job.state === 'queued')).toHaveLength(1)
      await consumer.pump()
      expect(native.start).toHaveBeenCalledTimes(1)
    } finally {
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
