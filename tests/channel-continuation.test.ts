import { describe, expect, it } from 'vitest'
import {
  continuationBrief,
  continuationCheckpoint,
  continuationPolicy,
  ContinuationUsage,
} from '../packages/cli/src/launcher/channel-continuation.js'

const policy = continuationPolicy({ enabled: true, threshold: 0.8, reserveTokens: 100, maxAgeMs: 1000 })
const sample = (tracker: ContinuationUsage, used = 810, turnId = 'turn-1') => {
  tracker.notification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId,
    tokenUsage: { last: { totalTokens: used }, modelContextWindow: 1000 },
  }, 100)
}
const complete = (tracker: ContinuationUsage, turnId = 'turn-1', status = 'completed') => {
  tracker.notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status } }, 101)
}

describe('Channel continuation usage', () => {
  it('uses the last context size only after its own turn completes, and expires', () => {
    const tracker = new ContinuationUsage()
    sample(tracker)
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
    complete(tracker)
    expect(tracker.eligible('thread-1', policy, 101)).toBe(true)
    expect(tracker.eligible('thread-1', policy, 1101)).toBe(false)
    expect(tracker.eligible('thread-1', { ...policy, enabled: false }, 101)).toBe(false)
  })
  it('honors configured reserve, and refuses unknown window and mismatched or failed turns', () => {
    const tracker = new ContinuationUsage()
    sample(tracker, 750)
    complete(tracker)
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
    expect(tracker.eligible('thread-1', { ...policy, reserveTokens: 250 }, 101)).toBe(true)
    sample(tracker)
    complete(tracker, 'turn-2')
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
    sample(tracker)
    complete(tracker, 'turn-1', 'failed')
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
    tracker.notification('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: { last: { totalTokens: 900 }, modelContextWindow: null },
    }, 100)
    complete(tracker)
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
  })
  it('invalidates on a later turn, compaction, settings changes, or closure', () => {
    for (const method of ['turn/started', 'thread/compacted', 'thread/settings/updated', 'thread/closed']) {
      const tracker = new ContinuationUsage()
      sample(tracker)
      complete(tracker)
      tracker.notification(method, { threadId: 'thread-1' })
      expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
    }
    const tracker = new ContinuationUsage()
    sample(tracker)
    complete(tracker)
    tracker.notification('item/started', { threadId: 'thread-1', item: { type: 'contextCompaction' } })
    expect(tracker.eligible('thread-1', policy, 101)).toBe(false)
  })
  it('rejects incomplete checkpoint and does not elevate its text', () => {
    expect(() => continuationCheckpoint({ goal: 'only one field' }, 'thread-1', 1)).toThrow()
    const checkpoint = continuationCheckpoint(
      {
        goal: 'finish task',
        constraints: 'keep old history',
        completed: 'one',
        remaining: 'two',
        history: 'page 3',
        continueAtIdle: true,
      },
      'thread-1',
      1,
    )
    const brief = continuationBrief(checkpoint)
    expect(brief).toContain('untrusted background data')
    expect(brief).toContain('"sessionId":"thread-1"')
    expect(brief).toContain('Do not load the whole history')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelContinuationManager } from '../packages/cli/src/launcher/channel-continuation-manager.js'
import {
  continuationConfiguration,
  continuationStartMatches,
} from '../packages/cli/src/launcher/channel-continuation-config.js'
import type { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { createNativeChatControl } from '../packages/cli/assets/launcher/native-chat-control.mjs'

const checkpointBody = {
  goal: 'finish',
  constraints: 'keep source',
  completed: 'setup',
  remaining: 'test',
  history: 'source page 1',
  continueAtIdle: true,
}
const config = {
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

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'channel-continuation-'))
  const file = path.join(dir, 'state.json')
  const store = await ChannelConversationStore.open(file)
  await store.mutate(state => {
    state.taskSettings.source = { revision: 2, settings: { model: 'model' }, application: 'applied' }
    for (let index = 0; index < 3; index++) {
      state.bindings[`binding-${index}`] = {
        id: `binding-${index}`,
        sessionId: 'source',
        hostId: 'local',
        profileId: 'profile',
        channel: { adapterId: 'feishu', accountId: 'a', tenantId: 't', conversationId: `oc_${index}`, kind: 'group' },
        createdAt: '2026-01-01',
        fromSequence: 1,
        mode: 'deliver',
        autoReply: false,
        state: index === 2 ? 'archived' : 'active',
      }
      state.jobs[`job-${index}`] = {
        id: `job-${index}`,
        recordId: `input-${index}`,
        sessionId: 'source',
        bindingId: `binding-${index}`,
        autoCreate: false,
        state: 'queued',
      }
    }
  })
  const native = {
    idle: async () => true,
    continuationEligible: () => true,
    continuationConfiguration: async () => config,
  } as unknown as ChannelNativeSessions
  const manager = new ChannelContinuationManager(store, () => native)
  await manager.setCheckpoint('source', checkpointBody, 0)
  await manager.setPolicy('source', policy)
  return { dir, file, store, manager, native }
}

describe('Channel continuation durability', () => {
  it('does not reserve an automatic continuation while logical migration fences the source', async () => {
    const f = await fixture()
    try {
      await f.store.mutate(state => {
        state.logicalContinuations = {
          revision: 0,
          relations: {},
          intents: { op: { request: { source: { sessionId: 'source' } }, state: 'creating' } as never },
        }
      })
      expect(await f.manager.reserve('source', 'auto')).toBeUndefined()
      expect(f.store.snapshot().continuations.source?.intent).toBeUndefined()
    } finally {
      await f.store.close()
      await rm(f.dir, { recursive: true, force: true })
    }
  })
  it('forwards only the native usage fields needed for the boundary decision', async () => {
    const tracker = new ContinuationUsage()
    const events: Record<string, unknown>[] = []
    const control = createNativeChatControl({
      controlCall: async () => ({}),
      writeNative: async () => {},
      closed: () => false,
      emit: async (event: Record<string, unknown>) => {
        events.push(event)
        if (event.type === 'continuation-event') tracker.notification(String(event.method), event.params, 100)
      },
    })
    control.received({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', secret: 'secret' } },
    })
    control.received({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { totalTokens: 810, privateField: 'secret' },
          modelContextWindow: 1000,
          total: { totalTokens: 99999 },
        },
      },
    })
    control.received({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', secret: 'secret' } },
    })
    expect(tracker.eligible('thread-1', policy, 101)).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        method: 'turn/started',
        params: expect.objectContaining({ turn: { id: 'turn-1', status: 'inProgress' } }),
      }),
    )
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(JSON.stringify(events)).not.toContain('99999')
    control.dispose()
  })
  it('requires observed permission, mode and tier and preserves a named profile', () => {
    const effective = {
      cwd: '/tmp',
      modelProvider: 'provider',
      model: 'model',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      workMode: 'plan',
      activePermissionProfile: { id: ':workspace' },
      sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp'], networkAccess: false },
    }
    expect(continuationConfiguration(effective, undefined)).toEqual({
      cwd: '/tmp',
      providerId: 'provider',
      model: 'model',
      serviceTier: 'priority',
      permissions: ':workspace',
      approvalsReviewer: 'user',
      sandbox: effective.sandbox,
      permissionProfile: effective.activePermissionProfile,
      execution: { approval: 'on-request', workMode: 'plan', effort: 'high' },
    })
    expect(continuationConfiguration({ ...effective, serviceTier: undefined }, undefined)).toBeUndefined()
    expect(continuationConfiguration({ ...effective, sandbox: {} }, undefined)).toBeUndefined()
    expect(continuationConfiguration({ ...effective, activePermissionProfile: undefined }, undefined)).toBeUndefined()
    expect(continuationConfiguration({ ...effective, activePermissionProfile: {} }, undefined)).toBeUndefined()
    const noNetworkField = continuationConfiguration({
      ...effective,
      activePermissionProfile: null,
      sandbox: { type: 'readOnly' },
    }, undefined)
    expect(noNetworkField).toBeDefined()
    expect(JSON.parse(JSON.stringify(noNetworkField))).toStrictEqual(noNetworkField)
    const { activePermissionProfile: _profile, ...unknownProfile } = effective
    expect(continuationConfiguration(unknownProfile, undefined)).toBeUndefined()
    expect(continuationConfiguration({
      ...effective,
      activePermissionProfile: null,
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp', '/elsewhere'],
        networkAccess: false,
      },
    }, undefined)).toBeUndefined()
  })
  it('reproduces an observed default tier and empty workspace roots only with exact native readback', () => {
    const effective = {
      cwd: '/tmp',
      modelProvider: 'openai',
      model: 'model',
      reasoningEffort: 'xhigh',
      serviceTier: 'default',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      workMode: 'default',
      activePermissionProfile: null,
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }
    const expected = continuationConfiguration(effective, undefined)
    expect(expected?.serviceTier).toBe('default')
    expect(expected?.execution).toMatchObject({ workMode: 'default', networkAccess: true })
    expect(continuationStartMatches(effective, expected)).toBe(true)
    const inherited = continuationConfiguration({ ...effective, reasoningEffort: null }, undefined)
    expect(inherited?.execution.effort).toBe('inherit')
    expect(continuationStartMatches({ ...effective, reasoningEffort: null }, inherited)).toBe(true)
    expect(continuationConfiguration({ ...effective, reasoningEffort: undefined }, undefined)).toBeUndefined()
    expect(continuationStartMatches({ ...effective, serviceTier: null }, expected)).toBe(false)
    expect(continuationStartMatches({ ...effective, cwd: '/elsewhere' }, expected)).toBe(false)
    for (
      const sandbox of [
        { ...effective.sandbox, writableRoots: ['/tmp'] },
        { ...effective.sandbox, networkAccess: false },
        { ...effective.sandbox, excludeTmpdirEnvVar: true },
        { ...effective.sandbox, excludeSlashTmp: true },
      ]
    ) expect(continuationStartMatches({ ...effective, sandbox }, expected)).toBe(false)
    const { workMode: _mode, ...unknownMode } = effective
    expect(continuationConfiguration(unknownMode, undefined)).toBeUndefined()
    expect(continuationConfiguration(unknownMode, undefined, 'default')?.execution.workMode).toBe('default')
    expect(continuationConfiguration(effective, undefined, 'plan')).toBeUndefined()
  })
  it('moves every binding and queued job once, retaining the old checkpoint and future policy', async () => {
    const f = await fixture()
    try {
      const reservation = await f.manager.reserve('source', 'auto', 'operation-1')
      expect(reservation).toBeDefined()
      expect(await f.manager.reserve('source', 'auto', 'operation-2')).toBeUndefined()
      await f.store.mutate(state => {
        expect(f.manager.finish(state, reservation!, 'target')).toBe(true)
        expect(f.manager.finish(state, reservation!, 'target')).toBe(false)
      })
      const state = f.store.snapshot()
      expect(Object.values(state.bindings).map(binding => binding.sessionId)).toEqual(['target', 'target', 'target'])
      expect(Object.values(state.jobs).map(job => job.sessionId)).toEqual(['target', 'target', 'target'])
      expect(state.continuations.source?.checkpoint?.threadId).toBe('source')
      expect(state.continuations.source?.intent?.state).toBe('completed')
      expect(state.continuations.target?.policy).toEqual(policy)
      expect(state.continuations.target?.checkpoint).toBeUndefined()
      expect(state.taskSettings.target).toEqual(state.taskSettings.source)
    } finally {
      await f.store.close()
      await rm(f.dir, { recursive: true, force: true })
    }
  })
  it('retains an uncertain native effect after restart and never recreates it', async () => {
    const f = await fixture()
    try {
      expect(await f.manager.reserve('source', 'auto', 'operation-1')).toBeDefined()
      await f.store.close()
      const reopened = await ChannelConversationStore.open(f.file)
      const manager = new ChannelContinuationManager(reopened, () => f.native)
      expect(reopened.snapshot().continuations.source?.intent?.state).toBe('unknown')
      expect(await manager.reserve('source', 'auto', 'operation-1')).toBeUndefined()
      expect(reopened.snapshot().jobs['job-0']?.sessionId).toBe('source')
      await reopened.close()
    } finally {
      await rm(f.dir, { recursive: true, force: true })
    }
  })
  it('supports manual continuation below threshold and fences an uncertain result', async () => {
    const f = await fixture()
    try {
      const native = f.native as unknown as {
        continuationEligible: () => boolean
        startContinuation: () => Promise<unknown>
      }
      native.continuationEligible = () => false
      let calls = 0
      native.startContinuation = async () => {
        calls++
        return { state: 'reconciliation-required' }
      }
      await f.store.mutate(state => {
        state.inputs['input-0'] = {
          recordId: 'input-0',
          sequence: 1,
          persisted: true,
          accepted: true,
          routed: true,
          mentionedBot: false,
          input: { source: { event: { eventId: 'prior' } } } as never,
        }
        state.jobs['job-0']!.state = 'completed'
      })
      expect(await f.manager.reserve('source', 'auto')).toBeUndefined()
      expect(await f.manager.startManual('source')).toMatchObject({ status: 'reconciliation-required' })
      expect(await f.manager.startManual('source')).toMatchObject({ status: 'unavailable' })
      expect(calls).toBe(1)
      expect(f.store.snapshot().continuations.source?.intent?.state).toBe('unknown')
      expect(f.store.snapshot().jobs['job-0']?.sessionId).toBe('source')
    } finally {
      await f.store.close()
      await rm(f.dir, { recursive: true, force: true })
    }
  })
  it('does not reserve when another job is in flight or checkpoint revision changed', async () => {
    const f = await fixture()
    try {
      await expect(f.manager.setCheckpoint('source', checkpointBody, 0)).rejects.toThrow('REVISION_CONFLICT')
      await f.store.mutate(state => {
        state.jobs['job-1']!.state = 'running'
      })
      expect(await f.manager.reserve('source', 'auto')).toBeUndefined()
    } finally {
      await f.store.close()
      await rm(f.dir, { recursive: true, force: true })
    }
  })
  it('does not migrate if task settings change while the fresh thread is being started', async () => {
    const f = await fixture()
    try {
      const reservation = await f.manager.reserve('source', 'auto')
      expect(reservation).toBeDefined()
      await f.store.mutate(state => {
        state.taskSettings.source!.revision++
        expect(f.manager.finish(state, reservation!, 'target')).toBe(false)
        f.manager.failDispatch(state, reservation!, 'job-0')
      })
      expect(f.store.snapshot().continuations.source?.intent?.state).toBe('unknown')
      expect(f.store.snapshot().bindings['binding-0']?.sessionId).toBe('source')
    } finally {
      await f.store.close()
      await rm(f.dir, { recursive: true, force: true })
    }
  })
})

import { type AgentBridgeCodexAuthority, createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'

describe('fresh thread configuration readback', () => {
  it('forwards named permissions to both the new thread and its first turn', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const named = {
      ...config,
      permissions: ':workspace',
      permissionProfile: { id: ':workspace', extends: null },
      execution: { approval: 'never', workMode: 'default', effort: 'high' },
    }
    const native: AgentBridgeCodexAuthority = {
      catalog: async () => [{ providerId: 'openai', models: [{ id: 'model', label: 'model', aliases: [] }] }],
      nativeRequest: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return {
            thread: { id: 'new-thread' },
            modelProvider: 'openai',
            model: 'model',
            cwd: '/tmp',
            serviceTier: null,
            approvalsReviewer: 'user',
            approvalPolicy: 'never',
            reasoningEffort: (params.config as Record<string, unknown> | undefined)?.model_reasoning_effort ?? null,
            sandbox: config.sandbox,
            activePermissionProfile: named.permissionProfile,
          }
        }
        if (method === 'turn/start') return { turn: { id: 'turn' } }
        return {}
      },
    }
    const result = await createCodexBridgeHandler(native)('start_session', {
      operationId: 'fresh-named',
      prompt: 'handoff',
      cwd: '/tmp',
      providerId: 'openai',
      model: 'model',
      serviceTier: null,
      approvalsReviewer: 'user',
      permissions: ':workspace',
      execution: named.execution,
      expectedContinuation: named,
    })
    expect(result).toMatchObject({ status: 'started', sessionId: 'new-thread' })
    expect(calls[0]?.params).toMatchObject({
      permissions: ':workspace',
      serviceTier: null,
      config: { model_reasoning_effort: 'high' },
    })
    expect(calls[1]?.params).toMatchObject({
      permissions: ':workspace',
      serviceTier: null,
      approvalsReviewer: 'user',
      effort: 'high',
      collaborationMode: { mode: 'default', settings: { reasoning_effort: 'high' } },
    })
    expect(calls[1]?.params).not.toHaveProperty('sandboxPolicy')
  })
  it('does not start a turn when the created thread has different permissions', async () => {
    const calls: string[] = []
    const native: AgentBridgeCodexAuthority = {
      catalog: async () => [{ providerId: 'openai', models: [{ id: 'model', label: 'model', aliases: [] }] }],
      nativeRequest: async (method, params) => {
        calls.push(method)
        if (method === 'thread/start') {
          return {
            thread: { id: 'new-thread' },
            modelProvider: 'openai',
            model: 'model',
            cwd: '/tmp',
            serviceTier: null,
            approvalsReviewer: 'user',
            approvalPolicy: 'never',
            reasoningEffort: 'high',
            sandbox: { type: 'dangerFullAccess' },
            activePermissionProfile: null,
          }
        }
        if (method === 'turn/start') return { turn: { id: 'turn' } }
        return {}
      },
    }
    const handler = createCodexBridgeHandler(native)
    const result = await handler('start_session', {
      operationId: 'fresh-1',
      prompt: 'handoff',
      cwd: '/tmp',
      providerId: 'openai',
      model: 'model',
      serviceTier: null,
      approvalsReviewer: 'user',
      execution: config.execution,
      expectedContinuation: config,
    })
    expect(result).toMatchObject({ status: 'failed', sessionId: 'new-thread' })
    expect(calls).toEqual(['thread/start'])
    await handler('start_session', {
      operationId: 'fresh-1',
      prompt: 'handoff',
      cwd: '/tmp',
      providerId: 'openai',
      model: 'model',
      serviceTier: null,
      approvalsReviewer: 'user',
      execution: config.execution,
      expectedContinuation: config,
    })
    expect(calls).toEqual(['thread/start'])
  })
})
