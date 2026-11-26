import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelTaskSettings } from '../packages/cli/src/launcher/channel-task-settings.js'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { type ChannelTaskPatch, parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'

const roots: string[] = [], stores: ChannelConversationStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const channel = {
  adapterId: 'test',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'direct',
  threadId: 'direct',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const event = {
  ...channel,
  eventId: 'event',
  actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'owner' },
}
const configuration = {
  providerId: 'source',
  model: 'old',
  cwd: '/workspace',
  serviceTier: null,
  approvalsReviewer: 'user',
  permissionProfile: null,
  sandbox: { type: 'readOnly' },
  execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-task-provider-'))
  roots.push(root)
  const file = path.join(root, 'state.json'), store = await ChannelConversationStore.open(file)
  stores.push(store)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['owner'] },
        { id: 'commands', action: 'command', effect: 'allow', userIds: ['owner'] },
      ],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [{
        id: 'grant',
        effect: 'allow',
        userIds: ['owner'],
        fields: ['providerId', 'model', 'effort', 'fast', 'projectId'],
      }],
    })
    state.bindings.one = {
      id: 'one',
      channel,
      sessionId: 'source',
      hostId: 'local',
      profileId: 'test',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
  })
  const selections: Record<string, ChannelTaskPatch> = {
    source: { providerId: 'source', model: 'old', effort: 'low', fast: false },
  }
  let busy = false, nextTarget = 0, uncertain = false
  let afterCreate: (() => Promise<void>) | undefined
  const native = {
    idle: vi.fn(async () => !busy),
    taskSelection: vi.fn(async (thread: string) => structuredClone(selections[thread])),
    modelOperation: vi.fn(async () => ({
      providers: ['source', 'target'].map(providerId => ({
        providerId,
        models: [{
          id: providerId === 'source' ? 'old' : 'new',
          supportsFastMode: true,
          reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'low' },
        }],
      })),
    })),
    supportsCrossProviderFork: vi.fn(async () => true),
    validateTaskConfiguration: vi.fn(async () => {}),
    continuationConfiguration: vi.fn(async (thread: string) => {
      const current = selections[thread]
      if (!current) return undefined
      return {
        ...configuration,
        providerId: current.providerId,
        model: current.model,
        serviceTier: current.fast ? 'priority' : null,
        execution: { ...configuration.execution, effort: current.effort ?? 'low' },
      }
    }),
    logicalSourceVersion: vi.fn(async () => 'sha256:fixture'),
    createLogicalDestination: vi.fn(async (request: any, evidence: any) => {
      if (uncertain) throw new Error('lost fork acknowledgement')
      const id = `destination-${++nextTarget}`
      selections[id] = {
        ...request.target,
        effort: evidence.sourceConfiguration.execution.effort,
        fast: evidence.sourceConfiguration.serviceTier === 'priority',
      }
      await afterCreate?.()
      return { state: 'created', confirmed: true, destination: { ...request.source, sessionId: id } }
    }),
    applyTaskSelection: vi.fn(async (thread: string, patch: ChannelTaskPatch, before: () => Promise<boolean>) => {
      if (!await before()) return { status: 'rejected', reason: 'selection-changed' }
      selections[thread] = { ...selections[thread], ...patch }
      return { status: 'selected', application: 'applied' }
    }),
    label: async () => 'Fixture',
  }
  const fence = new ChannelNativeSourceFence(id => ChannelConversationStore.logicalSessionFenced(store.snapshot(), id))
  const tasks = new ChannelTaskSettings({
    store,
    native: () => native as never,
    agent: new ChannelAgentAccess(() => store.snapshot(), () => native as never),
    access: () => undefined,
    logical: { appId: 'codex', profileId: 'test', fence, claims: new Set() },
  })
  return {
    store,
    file,
    tasks,
    native,
    selections,
    busy: (value: boolean) => {
      busy = value
    },
    uncertain: () => {
      uncertain = true
    },
    afterCreate: (value: () => Promise<void>) => {
      afterCreate = value
    },
  }
}

describe('automatic Channel provider continuation', () => {
  it('moves the exact binding and queued input, and retains a shared logical history in both directions', async () => {
    const f = await fixture()
    await f.store.mutate(state => {
      state.inputs.queued = { recordId: 'queued', input: { source: { event } }, accepted: true } as never
      state.jobs.queued = {
        id: 'queued',
        recordId: 'queued',
        bindingId: 'one',
        autoCreate: false,
        state: 'queued',
        sessionId: 'source',
      }
    })
    const first = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new' })
    await f.tasks.pump()
    let state = f.store.snapshot()
    expect(state.bindings.one?.sessionId).toBe('destination-1')
    expect(state.jobs.queued?.sessionId).toBe('destination-1')
    expect(state.taskRequests[first.requestId!]?.state).toBe('applied')
    expect(state.taskSettings.source?.settings).toMatchObject({ providerId: 'source', model: 'old' })
    expect(state.taskSettings['destination-1']?.settings).toMatchObject({ providerId: 'target', model: 'new' })
    expect(f.native.createLogicalDestination).toHaveBeenCalledTimes(1)
    await f.tasks.pump()
    expect(f.native.createLogicalDestination).toHaveBeenCalledTimes(1)

    const second = await f.tasks.request(event, 'destination-1', { providerId: 'source', model: 'old' })
    await f.tasks.pump()
    state = f.store.snapshot()
    expect(state.bindings.one?.sessionId).toBe('destination-2')
    expect(state.jobs.queued?.sessionId).toBe('destination-2')
    expect(state.taskRequests[second.requestId!]?.state).toBe('applied')
    expect(Object.values(state.logicalContinuations!.relations)).toHaveLength(2)
    expect(new Set(Object.values(state.logicalContinuations!.relations).map(row => row.logicalConversationId)).size)
      .toBe(1)
    const reopened = await ChannelConversationStore.open(f.file)
    stores.push(reopened)
    expect(reopened.snapshot().bindings.one?.sessionId).toBe('destination-2')
  })

  it('keeps a combined project change queued until it is actually applied on the destination', async () => {
    const f = await fixture()
    const pending = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new', projectId: 'repo' })
    await f.tasks.pump()
    const target = f.store.snapshot().bindings.one!.sessionId
    expect(f.store.snapshot().taskSettings[target]).toMatchObject({
      application: 'saved',
      pending: { projectId: 'repo' },
    })
    expect(f.store.snapshot().taskRequests[pending.requestId!]?.state).toBe('queued')
    expect(f.tasks.ready(target)).toBe(false)
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    expect(f.store.snapshot().taskSettings[target]).toMatchObject({
      application: 'applied',
      settings: { providerId: 'target', model: 'new', projectId: 'repo' },
    })
    expect(f.store.snapshot().taskRequests[pending.requestId!]?.state).toBe('applied')
  })

  it('expires a moved approval on the destination rather than leaving its queue blocked', async () => {
    const f = await fixture()
    const pending = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new', projectId: 'repo' })
    await f.tasks.pump()
    const target = f.store.snapshot().bindings.one!.sessionId
    await f.store.mutate(state => {
      state.taskRequests[pending.requestId!] = {
        ...state.taskRequests[pending.requestId!]!,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() - 1,
      }
    })
    await f.tasks.pump()
    expect(f.store.snapshot().taskRequests[pending.requestId!]?.state).toBe('expired')
    expect(f.store.snapshot().taskSettings[target]).toMatchObject({
      application: 'applied',
      code: 'TASK_REQUEST_EXPIRED',
    })
    expect(f.tasks.ready(target)).toBe(true)
  })

  it('recovers a moved in-flight settings change as unknown after restart', async () => {
    const f = await fixture()
    const pending = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new', projectId: 'repo' })
    await f.tasks.pump()
    const target = f.store.snapshot().bindings.one!.sessionId
    await f.store.mutate(state => {
      const setting = state.taskSettings[target]!
      setting.application = 'applying'
      setting.requested = setting.pending!
      state.taskRequests[pending.requestId!]!.state = 'applying'
    })
    const reopened = await ChannelConversationStore.open(f.file)
    stores.push(reopened)
    expect(reopened.snapshot().taskSettings[target]).toMatchObject({
      application: 'unknown',
      code: 'NATIVE_EFFECT_UNCERTAIN',
    })
    expect(reopened.snapshot().taskRequests[pending.requestId!]).toMatchObject({
      state: 'unknown',
      code: 'NATIVE_EFFECT_UNCERTAIN',
    })
  })

  it('waits while busy, then applies the requested effort and Fast setting to the new thread', async () => {
    const f = await fixture()
    f.busy(true)
    const pending = await f.tasks.request(event, 'source', {
      providerId: 'target',
      model: 'new',
      effort: 'high',
      fast: true,
    })
    await f.tasks.pump()
    expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
    expect(f.store.snapshot().taskRequests[pending.requestId!]?.state).toBe('queued')
    f.busy(false)
    await f.tasks.pump()
    expect(f.store.snapshot().taskSettings['destination-1']?.settings).toMatchObject({
      providerId: 'target',
      model: 'new',
      effort: 'high',
      fast: true,
    })
    expect(f.native.createLogicalDestination.mock.calls[0]![1].sourceConfiguration).toMatchObject({
      serviceTier: 'priority',
      execution: { effort: 'high' },
    })
  })

  it('fences an unknown fork and does not create or dispatch again after restart', async () => {
    const f = await fixture()
    f.uncertain()
    const pending = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new' })
    await f.tasks.pump()
    expect(f.store.snapshot().bindings.one?.sessionId).toBe('source')
    expect(f.store.snapshot().taskRequests[pending.requestId!]?.state).toBe('unknown')
    expect(f.tasks.ready('source')).toBe(false)
    await f.tasks.pump()
    expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
    const reopened = await ChannelConversationStore.open(f.file)
    stores.push(reopened)
    expect(ChannelConversationStore.logicalSourceFenced(reopened.snapshot(), 'source')).toBe(true)
  })

  it('does not move the binding if permission is revoked during creation', async () => {
    const f = await fixture()
    f.afterCreate(() =>
      f.store.mutate(state => {
        state.taskConfig = parseChannelTaskConfig({ permissions: [] })
      })
    )
    const pending = await f.tasks.request(event, 'source', { providerId: 'target', model: 'new' })
    await f.tasks.pump()
    const state = f.store.snapshot()
    expect(state.bindings.one?.sessionId).toBe('source')
    expect(state.taskRequests[pending.requestId!]?.state).toBe('unknown')
    expect(ChannelConversationStore.logicalSourceFenced(state, 'source')).toBe(true)
  })
})
