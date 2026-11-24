import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { channelLogicalCommand } from '../packages/cli/src/launcher/channel-logical-command.js'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import { attemptChannelIdlePriority } from '../packages/cli/src/launcher/channel-idle-priority-attempt.js'
import {
  channelIdlePriorityOperation,
  recoverChannelIdlePriorityJob,
} from '../packages/cli/src/launcher/channel-idle-priority-status.js'
import { abandonChannelLogicalContinuation } from '../packages/cli/src/launcher/channel-logical-abandon.js'
import { channelModelConnectivityEvidence } from '../packages/cli/src/launcher/channel-model-connectivity.js'
import {
  a as consumerSource,
  channel as consumerChannel,
  fixture as consumerFixture,
  message as consumerMessage,
  settle,
} from './helpers/channel-conversation-fixture.js'

const channel = {
  adapterId: 'test',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'chat',
  threadId: 'chat',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const event = {
  ...channel,
  eventId: 'event',
  actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'user' },
}
const roots: string[] = [], stores: ChannelConversationStore[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-idle-priority-'))
  roots.push(root)
  const store = await ChannelConversationStore.open(path.join(root, 'state.json'))
  stores.push(store)
  await store.bindCommitBarrier(async () => {})
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['user'] },
        { id: 'command', action: 'command', effect: 'allow', userIds: ['user'] },
      ],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [
        { id: 'grant', effect: 'allow', userIds: ['user'], fields: ['providerId', 'model'] },
      ],
    })
    state.modelPriority = {
      revision: 1,
      candidates: [
        { providerId: 'old', model: 'one' },
        { providerId: 'new', model: 'two' },
      ],
    }
    state.bindings.b = {
      id: 'b',
      channel,
      sessionId: 'source',
      hostId: 'local',
      profileId: 'profile',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
    state.inputs.r = { recordId: 'r', input: { source: { event } }, accepted: true } as never
    state.jobs.j = { id: 'j', recordId: 'r', bindingId: 'b', autoCreate: false, state: 'queued', sessionId: 'source' }
  })
  const selection = { providerId: 'old', model: 'one', effort: 'low', fast: false }
  const config = {
    providerId: 'old',
    model: 'one',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
  }
  const catalog = {
    providers: [{ providerId: 'new', models: [{ id: 'two', reasoningCapabilities: { efforts: ['low'] } }] }],
  }
  const native = {
    idle: vi.fn(async () => true),
    taskSelection: vi.fn(async () => ({ ...selection })),
    modelOperation: vi.fn(async () => catalog),
    validateTaskConfiguration: vi.fn(async () => {}),
    continuationConfiguration: vi.fn(async () => config),
    logicalSourceVersion: vi.fn(async () => 'sha256:fixture'),
    priorityEvidence: vi.fn(async (candidate: { providerId: string }) =>
      candidate.providerId === 'old' ? 'unavailable' : 'healthy'
    ),
    logicalMigrationLease: vi.fn(async () => ({
      state: 'acquired' as const,
      destination: () => undefined,
      releaseSource: async () => true,
      nativeRequest: async () => ({}),
    })),
    createLogicalDestination: vi.fn(async (
      request: { source: { hostId: string; appId: string; profileId: string } },
    ) => ({
      state: 'created' as const,
      confirmed: true,
      destination: { ...request.source, sessionId: 'destination' },
    })),
  }
  const fence = new ChannelNativeSourceFence(() => false), claims = new Set<string>()
  const idlePriorityOffers = new Map()
  const command = (argument: string) =>
    channelLogicalCommand({
      store,
      native: native as never,
      fence,
      claims,
      appId: 'codex',
      profileId: 'profile',
      event,
      idlePriorityOffers,
      recordId: 'command',
      argument,
    })
  const run = () =>
    attemptChannelIdlePriority({
      store,
      native: native as never,
      fence,
      claims,
      appId: 'codex',
      profileId: 'profile',
      event,
      job: store.snapshot().jobs.j!,
      signal: new AbortController().signal,
    })
  return { store, native, command, run, selection, root, idlePriorityOffers }
}
async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  const disclosure = await f.command('auto-suggest old one new two')
  expect(disclosure).toContain('目标服务可按需读取获准的用户和助手文本')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  return f.command(`auto old one new two --history=user,assistant --no-checkpoint --confirm=${token}`)
}

it('requires a live single-use confirmation of the disclosed history scope', async () => {
  const f = await fixture()
  const disclosure = await f.command('auto-suggest old one new two')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  const confirmation = `auto old one new two --history=user,assistant --no-checkpoint --confirm=${token}`
  f.idlePriorityOffers.get(token!)!.expiresAt = Date.now() - 1
  expect(await f.command(confirmation)).toContain('确认已过期')
  expect(f.store.snapshot().logicalContinuations?.idlePriorityGrants).toBeUndefined()
  expect(await enable(f)).toContain('已授权一次')
  expect(await f.command('auto-off')).toContain('已撤销')
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
})

it('requires explicit exact-target consent and commits the binding and queued input before dispatch', async () => {
  const f = await fixture()
  expect(await f.run()).toBe(false)
  expect(f.native.priorityEvidence).not.toHaveBeenCalled()
  expect(
    await f.command(
      'auto old one new two --history=user,assistant --no-checkpoint --confirm=00000000000000000000000000000000',
    ),
  )
    .toContain('确认已过期')
  expect(await enable(f)).toContain('已授权一次')
  expect(await f.run()).toBe(true)
  expect(f.native.priorityEvidence.mock.calls.map(([candidate]) => candidate.providerId)).toEqual(['old', 'new'])
  const state = f.store.snapshot()
  expect(state.bindings.b!.sessionId).toBe('destination')
  expect(state.jobs.j).toMatchObject({ state: 'queued', sessionId: 'destination' })
  expect(state.inputs.r!.input.source.event).toEqual(event)
  expect(state.logicalContinuations!.idlePriorityGrants?.b).toBeUndefined()
  expect(state.logicalContinuations!.relations[channelIdlePriorityOperation('j')]).toMatchObject({
    mode: 'linked',
    historyCategories: ['user-text', 'assistant-text'],
    handoff: 'none',
  })
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(f.native.createLogicalDestination.mock.calls[0]![1]).toMatchObject({
    sourceConfiguration: {
      cwd: '/workspace',
      approvalsReviewer: 'user',
      serviceTier: null,
      execution: { effort: 'low', execution: 'read-only', approval: 'on-request' },
    },
  })
})

it('refuses to create a target when Fast readback conflicts with the native configuration', async () => {
  const f = await fixture()
  await enable(f)
  f.native.continuationConfiguration.mockResolvedValueOnce({
    providerId: 'old',
    model: 'one',
    cwd: '/workspace',
    serviceTier: 'priority',
    approvalsReviewer: 'user',
    execution: { workMode: 'default', execution: 'read-only', approval: 'on-request', effort: 'low' },
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
  })
  expect(await f.run()).toBe(true)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  expect(f.store.snapshot().bindings.b!.sessionId).toBe('source')
})

it('keeps the source when probe evidence is inconclusive or the user changed the selection', async () => {
  const f = await fixture()
  await enable(f)
  f.native.priorityEvidence.mockResolvedValueOnce('inconclusive')
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  f.native.taskSelection.mockResolvedValue({ ...f.selection, model: 'explicit' })
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  expect(f.store.snapshot().bindings.b!.sessionId).toBe('source')
  expect(f.store.snapshot().logicalContinuations?.idlePriorityGrants).toBeUndefined()
})

it('does not transfer an unapproved sender, revoked configuration or unsupported target', async () => {
  const f = await fixture()
  await enable(f)
  await f.store.mutate(state => {
    state.modelPriority.revision += 1
  })
  expect(await f.run()).toBe(false)
  expect(f.native.priorityEvidence).not.toHaveBeenCalled()
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  expect(f.store.snapshot().jobs.j!.state).toBe('queued')
})

it('does not probe an active native session or migrate when another sender has queued work', async () => {
  const f = await fixture()
  await enable(f)
  f.native.idle.mockResolvedValueOnce(false)
  expect(await f.run()).toBe(true)
  expect(f.native.priorityEvidence).not.toHaveBeenCalled()
  await f.store.mutate(state => {
    const input = structuredClone(state.inputs.r!)
    input.recordId = 'other'
    input.input.source.event.actor!.userId = 'different'
    state.inputs.other = input
    state.jobs.other = { ...state.jobs.j!, id: 'other', recordId: 'other' }
  })
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
})

it('fails the undispatched input safely when target health cannot be established', async () => {
  const f = await fixture()
  await enable(f)
  f.native.priorityEvidence.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('inconclusive')
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().jobs.j).toMatchObject({
    state: 'failed',
    code: 'MODEL_PRIORITY_UNAVAILABLE',
    failureNotice: 'pending',
  })
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
})

it('serializes simultaneous attempts for the same source', async () => {
  const f = await fixture()
  await enable(f)
  const results = await Promise.all([f.run(), f.run()])
  expect(results).toEqual([true, true])
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(f.store.snapshot().jobs.j!.sessionId).toBe('destination')
})

it('uses real-probe evidence without sending the queued message or tools to either provider', async () => {
  const f = await fixture()
  await f.store.mutate(state => {
    state.inputs.r!.input = { ...state.inputs.r!.input, content: [{ type: 'text', text: 'synthetic task' }] }
  })
  await enable(f)
  const fetch = vi.fn(async (url: string) =>
    url.includes('old.example.test')
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify({ status: 'completed', model: 'two' }))
  )
  vi.stubGlobal('fetch', fetch)
  const connect = async (providerId: string) => ({
    baseUrl: `https://${providerId}.example.test`,
    headers: {},
    dispose: () => {},
  })
  f.native.priorityEvidence.mockImplementation(
    (async (candidate, signal, guard) =>
      channelModelConnectivityEvidence(connect, candidate, signal, 1_000, guard)) as never,
  )
  expect(await f.run()).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, request] of fetch.mock.calls as unknown as [string, RequestInit][]) {
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({ tools: [], tool_choice: 'none', store: false })
    expect(JSON.stringify(body)).not.toContain('synthetic task')
  }
  expect(f.store.snapshot().bindings.b!.sessionId).toBe('destination')
})

it('invalidates consent on changed user, conversation, policy or binding', async () => {
  const f = await fixture()
  await enable(f)
  await f.store.mutate(state => {
    state.inputs.r!.input.source.event.actor!.userId = 'different'
  })
  expect(await f.run()).toBe(false)
  expect(f.native.priorityEvidence).not.toHaveBeenCalled()
  await f.store.mutate(state => {
    state.inputs.r!.input.source.event.actor!.userId = 'user'
    state.policyRevision += 1
  })
  expect(await f.run()).toBe(false)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
})

it('does not create a destination when consent is revoked during the target probe', async () => {
  const f = await fixture()
  await enable(f)
  f.native.priorityEvidence.mockImplementation(async candidate => {
    if (candidate.providerId === 'old') return 'unavailable'
    await f.command('auto-off')
    return 'healthy'
  })
  expect(await f.run()).toBe(true)
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  expect(f.store.snapshot().jobs.j!.state).toBe('queued')
})

it('fences a lost native creation receipt and never retries it', async () => {
  const f = await fixture()
  await enable(f)
  f.native.createLogicalDestination.mockRejectedValueOnce(new Error('synthetic lost response'))
  expect(await f.run()).toBe(true)
  const state = f.store.snapshot()
  expect(state.jobs.j).toMatchObject({ state: 'reconciliation-required', code: 'IDLE_PRIORITY_MIGRATION_UNCERTAIN' })
  expect(state.logicalContinuations!.intents[channelIdlePriorityOperation('j')]!.state).toBe('unknown')
  await f.run()
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(state.bindings.b!.sessionId).toBe('source')
  expect(
    await abandonChannelLogicalContinuation({
      store: f.store,
      fence: new ChannelNativeSourceFence(() => false),
      claims: new Set(),
      appId: 'codex',
      profileId: 'profile',
      event,
      operationId: channelIdlePriorityOperation('j'),
    }),
  ).toBe(true)
  expect(f.store.snapshot().jobs.j!.state).toBe('cancelled')
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
})

it('holds the input for review when acquiring the native source fence has an unknown result', async () => {
  const f = await fixture()
  await enable(f)
  f.native.logicalMigrationLease.mockResolvedValueOnce({ state: 'unknown' } as never)
  expect(await f.run()).toBe(true)
  expect(f.store.snapshot().jobs.j).toMatchObject({
    state: 'reconciliation-required',
    code: 'IDLE_PRIORITY_MIGRATION_UNCERTAIN',
    failureNotice: 'pending',
  })
  expect(f.native.createLogicalDestination).not.toHaveBeenCalled()
  await f.run()
  expect(f.native.logicalMigrationLease).toHaveBeenCalledOnce()
})

it('keeps an orphan fenced when consent changes after native creation', async () => {
  const f = await fixture()
  await enable(f)
  f.native.createLogicalDestination.mockImplementationOnce(async request => {
    await f.command('auto-off')
    return { state: 'created', confirmed: true, destination: { ...request.source, sessionId: 'destination' } }
  })
  expect(await f.run()).toBe(true)
  const state = f.store.snapshot()
  expect(state.bindings.b!.sessionId).toBe('source')
  expect(state.logicalContinuations!.intents[channelIdlePriorityOperation('j')]!.state).toBe('unknown')
  expect(state.jobs.j!.state).toBe('reconciliation-required')
  await f.run()
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
})

it('preserves and validates an active grant across restart and removes it after explicit revocation', async () => {
  const f = await fixture()
  await enable(f)
  await f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const reopened = await ChannelConversationStore.open(path.join(f.root, 'state.json'))
  stores.push(reopened)
  expect(reopened.snapshot().logicalContinuations?.idlePriorityGrants?.b?.target).toEqual({
    providerId: 'new',
    model: 'two',
  })
})

it('recovers an interrupted destination creation as uncertain without dispatching the queued input', async () => {
  const f = await fixture()
  await enable(f)
  f.native.createLogicalDestination.mockRejectedValueOnce(new Error('lost response'))
  await f.run()
  await f.store.mutate(state => {
    const intent = state.logicalContinuations!.intents[channelIdlePriorityOperation('j')]!
    intent.state = 'creating'
    delete intent.code
    state.jobs.j!.state = 'queued'
    delete state.jobs.j!.code
    delete state.jobs.j!.failureNotice
  })
  await f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const reopened = await ChannelConversationStore.open(path.join(f.root, 'state.json'))
  stores.push(reopened)
  expect(await recoverChannelIdlePriorityJob(reopened, 'j')).toBe(true)
  expect(reopened.snapshot().jobs.j).toMatchObject({ state: 'reconciliation-required', failureNotice: 'pending' })
  expect(reopened.snapshot().bindings.b!.sessionId).toBe('source')
  expect(f.native.createLogicalDestination).toHaveBeenCalledOnce()
})

it('dispatches a new Channel input exactly once on the committed destination', async () => {
  const base = await fixture(), c = await consumerFixture()
  const owner = c.consumer.profileLogicalOwner(), store = owner.store
  await store.bindCommitBarrier(async () => {})
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['alice'] },
        { id: 'command', action: 'command', effect: 'allow', userIds: ['alice'] },
      ],
    })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [
        { id: 'grant', effect: 'allow', userIds: ['alice'], fields: ['providerId', 'model'] },
      ],
    })
    state.modelPriority = {
      revision: 1,
      candidates: [
        { providerId: 'old', model: 'one' },
        { providerId: 'new', model: 'two' },
      ],
    }
    state.bindings.b = {
      id: 'b',
      channel: consumerChannel(),
      sessionId: consumerSource,
      hostId: 'local',
      profileId: 'fixture',
      createdAt: '',
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
  })
  const native = { ...base.native, contextObservations: () => undefined }
  c.consumer.setNativeExtras(() => native as never)
  const input = consumerMessage('synthetic-message', 'synthetic task')
  const sendCommand = (argument: string) =>
    channelLogicalCommand({
      store,
      native: native as never,
      fence: owner.fence,
      claims: new Set(),
      appId: 'codex',
      profileId: 'fixture',
      event: input.source.event,
      recordId: 'synthetic-authorization',
      argument,
      idlePriorityOffers: owner.idlePriorityOffers,
    })
  const disclosure = await sendCommand('auto-suggest old one new two')
  const token = disclosure.match(/--confirm=([a-f0-9]{32})/u)?.[1]
  expect(token).toBeDefined()
  expect(await sendCommand(`auto old one new two --history=user,assistant --no-checkpoint --confirm=${token}`))
    .toContain('已授权一次')
  await c.consumer.receive('synthetic-record', input)
  await settle(c.consumer)
  await settle(c.consumer)
  expect(c.native.start).toHaveBeenCalledOnce()
  expect(c.native.start.mock.calls[0]![1]).toEqual(input)
  expect(c.native.start.mock.calls[0]![2]).toBe('destination')
  expect(c.native.start.mock.calls[0]![9]).toBe(true)
  expect(native.createLogicalDestination).toHaveBeenCalledOnce()
  expect(store.snapshot().bindings.b!.sessionId).toBe('destination')
})
