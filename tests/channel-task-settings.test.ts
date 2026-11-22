import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelTaskSettings } from '../packages/cli/src/launcher/channel-task-settings.js'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { type ChannelTaskPatch, parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const roots: string[] = [], stores: ChannelConversationStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const source = {
  adapterId: 'feishu',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group' as const,
  threadId: 'oc_group',
  semantics: 'conversation' as const,
  eventId: 'om_event',
  actor: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant', userId: 'alice' },
}
const user = (name: string) => ({ ...source, actor: { ...source.actor, userId: name } })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-task-settings-')), file = path.join(root, 'state.json')
  roots.push(root)
  const store = await ChannelConversationStore.open(file)
  stores.push(store)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({ enabled: true })
    state.taskConfig = parseChannelTaskConfig({
      permissions: [{ id: 'owners', effect: 'allow', userIds: ['alice'], fields: ['providerId', 'model', 'effort'] }],
    })
    state.bindings.one = {
      id: 'one',
      channel: source,
      sessionId: 'chat',
      hostId: 'local',
      profileId: 'test',
      createdAt: new Date().toISOString(),
      fromSequence: 0,
      mode: 'deliver',
      autoReply: false,
      state: 'active',
    }
  })
  let selection: ChannelTaskPatch = { providerId: 'one', model: 'old', effort: 'low' }
  let busy = false, observeEffort = true
  const cards: object[] = []
  const native = {
    taskSelection: vi.fn(async () => ({ ...selection })),
    modelOperation: vi.fn(async () => ({
      providers: [
        {
          providerId: 'one',
          models: [{ id: 'old', supportsFastMode: true, reasoningCapabilities: { efforts: ['low', 'high'] } }, {
            id: 'new',
            reasoningCapabilities: { efforts: ['low', 'high'] },
          }],
        },
        { providerId: 'two', models: [{ id: 'other', reasoningCapabilities: { efforts: ['low'] } }] },
      ],
    })),
    idle: vi.fn(async () => !busy),
    applyTaskSelection: vi.fn(async (_thread: string, patch: typeof selection, before?: () => Promise<boolean>) => {
      const onDisk = JSON.parse(await readFile(file, 'utf8'))
      expect(onDisk.taskSettings.chat.application).toBe('applying')
      if (before && !await before()) return { status: 'rejected', reason: 'selection-changed' }
      if (observeEffort) selection = { ...selection, ...patch }
      else selection = { ...selection, providerId: patch.providerId, model: patch.model }
      return { status: 'selected', application: observeEffort ? 'applied' : 'saved' }
    }),
    label: async () => '飞书 · 群聊',
    sourceFor: (thread: string) => thread === 'chat' ? source : undefined,
    contextFor: (token: string) => token === 'current' ? { source, threadId: 'chat', turnId: 'turn' } : undefined,
    creationSelection: () => ({ providerId: 'one', model: 'old' }),
    projects: async () => [{ projectId: 'repo', name: 'Repository' }],
    validateTaskConfiguration: vi.fn(async (patch: ChannelTaskPatch) => {
      if (patch.projectId && patch.projectId !== 'repo') throw new Error('PROJECT_UNAVAILABLE')
    }),
    configurationRevision: async () => 3,
    hasPreparation: () => false,
    isPreparing: () => false,
  }
  const tasks = new ChannelTaskSettings({
    store,
    native: () => native as never,
    agent: new ChannelAgentAccess(() => store.snapshot(), () => native as never),
    access: () =>
      ({
        sendCard: async (_event: unknown, card: object) => {
          cards.push(card)
          return 'om_card'
        },
        updateCard: async (_event: unknown, _id: string, card: object) => {
          cards.push(card)
        },
      }) as never,
  })
  return {
    tasks,
    store,
    file,
    native,
    cards,
    setBusy: (value: boolean) => {
      busy = value
    },
    selection: (value: typeof selection) => {
      selection = value
    },
    deferEffort: () => {
      observeEffort = false
    },
  }
}

describe('exact Channel task changes', () => {
  it('records a definitive provider refusal without leaving the chat uncertain', async () => {
    const f = await fixture()
    f.native.applyTaskSelection.mockResolvedValueOnce({
      status: 'rejected',
      reason: 'provider-switch-unavailable',
    } as never)
    await f.tasks.request(undefined, 'chat', { providerId: 'two', model: 'other' })
    await f.tasks.pump()
    expect(await f.tasks.read('chat')).toMatchObject({
      application: 'applied',
      code: 'NATIVE_PROVIDER_SWITCH_UNAVAILABLE',
      settings: { providerId: 'one', model: 'old' },
    })
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
  })
  it('routes common configuration commands through the real actor approval workflow instead of applying directly', async () => {
    const f = await fixture()
    const tools = new ChannelConversationTools(
      () => undefined,
      {
        taskSettings: f.tasks,
        agentAccess: new ChannelAgentAccess(() => f.store.snapshot(), () => f.native as never),
      } as never,
    )
    const metadata = { 'cordisx/channelContext': 'current', 'openai/threadId': 'chat', 'openai/turnId': 'turn' }
    expect(await tools.executionGuard('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 3 }, metadata))
      .toMatchObject({ application: 'approval-required', settings: { fast: true } })
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
    expect(
      await tools.executionGuard('fast-set', { sessionId: 'chat', fast: true, expectedRevision: 3 }, {
        ...metadata,
        'cordisx/channelContext': 'expired',
      }),
    ).toMatchObject({ code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
    expect(await tools.executionGuard('project', { sessionId: 'unbound' }, metadata))
      .toMatchObject({ code: 'CHANNEL_TARGET_NOT_BOUND' })
    expect(
      await tools.executionGuard('project-set', {
        sessionId: 'chat',
        projectId: 'repo',
        expectedRevision: 3,
        cwd: '/extra',
      }, metadata),
    )
      .toMatchObject({ code: 'INVALID_REQUEST' })
    tools.dispose()
  })
  it('uses exact Fast/project grants and human approval, persists all fields across restart, and never retries a decision', async () => {
    const f = await fixture()
    await f.store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({
        permissions: [{
          id: 'owner',
          effect: 'allow',
          userIds: ['alice'],
          fields: ['fast', 'projectId'],
          fastModes: [true],
          projectIds: ['repo'],
        }],
      })
    })
    const result = await f.tasks.request(user('bob'), 'chat', { fast: true, projectId: 'repo' })
    expect(result.application).toBe('approval-required')
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
    expect(JSON.stringify(f.cards[0])).toContain('Fast')
    await expect(f.tasks.answer(user('bob'), result.requestId!, 'accept')).rejects.toThrow(
      'MODEL_CHANGE_PERMISSION_DENIED',
    )
    await f.tasks.answer(source, result.requestId!, 'accept', 'om_card')
    await f.tasks.pump()
    expect(await f.tasks.read('chat')).toMatchObject({
      application: 'applied',
      settings: { fast: true, projectId: 'repo' },
    })
    const restored = await ChannelConversationStore.open(f.file)
    stores.push(restored)
    expect(restored.snapshot().taskSettings.chat!.settings).toMatchObject({ fast: true, projectId: 'repo' })
    await f.tasks.answer(source, result.requestId!, 'accept')
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).toHaveBeenCalledTimes(1)
  })
  it('does not let stale context or an inactive bound caller fall through to generic provider selection', async () => {
    const f = await fixture()
    expect(
      await f.tasks.externalSelection({ threadId: 'unbound', providerId: 'one', model: 'old' }, {
        'cordisx/channelContext': 'expired',
        'openai/threadId': 'ordinary',
      }),
    ).toMatchObject({ status: 'rejected', reason: 'channel-context-required' })
    f.native.sourceFor = () => undefined as never
    expect(
      await f.tasks.externalSelection({ threadId: 'unbound', providerId: 'one', model: 'old' }, {
        'openai/threadId': 'chat',
        'openai/turnId': 'inactive',
      }),
    ).toMatchObject({ status: 'rejected', reason: 'channel-context-required' })
    expect(
      await f.tasks.externalSelection({ threadId: 'unbound', providerId: 'one', model: 'old' }, {
        'openai/threadId': 'ordinary',
      }),
    ).toBeUndefined()
  })
  it('persists intent before the native effect, waits for idle and applies an authorized user change once', async () => {
    const f = await fixture()
    f.setBusy(true)
    const result = await f.tasks.request(source, 'chat', { model: 'new' })
    expect(result.application).toBe('saved')
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
    f.setBusy(false)
    await f.tasks.pump()
    expect(await f.tasks.read('chat')).toMatchObject({
      settings: { providerId: 'one', model: 'new' },
      application: 'applied',
    })
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    expect(f.store.snapshot().taskRequests[result.requestId!]!.state).toBe('applied')
  })

  it('requires the eligible real actor and exact card, refuses general approvals, then rejects duplicate decisions', async () => {
    const f = await fixture()
    const result = await f.tasks.request(user('bob'), 'chat', { model: 'new' })
    expect(result.application).toBe('approval-required')
    expect(f.store.snapshot().taskSettings.chat).toBeUndefined()
    await expect(f.tasks.answer(user('bob'), result.requestId!, 'accept')).rejects.toThrow(
      'MODEL_CHANGE_PERMISSION_DENIED',
    )
    await expect(f.tasks.answer(source, result.requestId!, 'accept', 'om_wrong')).rejects.toThrow(
      'APPROVAL_CARD_MISMATCH',
    )
    await expect(f.tasks.call('task-approve', { requestId: result.requestId }, { 'cordisx/channelContext': 'current' }))
      .rejects.toThrow('EXPLICIT_CHANNEL_USER_REQUIRED')
    await f.tasks.answer(source, result.requestId!, 'accept', 'om_card')
    await f.tasks.pump()
    expect(await f.tasks.answer(source, result.requestId!, 'accept')).toContain('不会重复执行')
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
  })

  it('checks old native configuration and revoked authority before any effect', async () => {
    const f = await fixture()
    const first = await f.tasks.request(user('bob'), 'chat', { model: 'new' })
    f.selection({ providerId: 'one', model: 'old', effort: 'high' })
    await expect(f.tasks.answer(source, first.requestId!, 'accept')).rejects.toThrow('REVISION_CONFLICT')
    await f.tasks.answer(user('bob'), first.requestId!, 'decline')
    const second = await f.tasks.request(source, 'chat', { model: 'new' })
    await f.store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({})
    })
    await f.tasks.pump()
    expect(f.store.snapshot().taskRequests[second.requestId!]!.state).toBe('denied')
    expect(f.native.applyTaskSelection).not.toHaveBeenCalled()
  })

  it('does not repeat an uncertain native effect across restart and rejects stale revisions', async () => {
    const f = await fixture()
    const result = await f.tasks.request(source, 'chat', { model: 'new' })
    f.native.applyTaskSelection.mockRejectedValue(new Error('lost acknowledgement'))
    await f.tasks.pump()
    expect(f.store.snapshot().taskSettings.chat!.application).toBe('unknown')
    await f.tasks.pump()
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
    await f.store.mutate(state => {
      const record = state.taskSettings.chat!
      record.application = 'applying'
      record.pending = { providerId: 'one', model: 'new', effort: 'low' }
      record.pendingPatch = { model: 'new' }
      record.requested = record.pending
      state.taskRequests[result.requestId!]!.state = 'applying'
    })
    await f.store.close()
    const reopened = await ChannelConversationStore.open(f.file)
    stores.push(reopened)
    expect(reopened.snapshot().taskSettings.chat!.application).toBe('unknown')
    expect(reopened.snapshot().taskRequests[result.requestId!]!.state).toBe('unknown')
    await expect(f.tasks.request(source, 'chat', { model: 'new' }, 0)).rejects.toThrow('REVISION_CONFLICT')
  })

  it('saves effort for the next turn and waits for an independently observed matching value', async () => {
    const f = await fixture()
    f.deferEffort()
    await f.tasks.request(source, 'chat', { effort: 'high' })
    await f.tasks.pump()
    expect(f.store.snapshot().taskSettings.chat!.application).toBe('submitted')
    await f.tasks.pump()
    expect(f.store.snapshot().taskSettings.chat!.application).toBe('submitted')
    f.selection({ providerId: 'one', model: 'old', effort: 'high' })
    await f.tasks.pump()
    expect(f.store.snapshot().taskSettings.chat!.application).toBe('applied')
    expect(f.native.applyTaskSelection).toHaveBeenCalledOnce()
  })

  it('keeps ordinary reads available, prevents forged or missing source from becoming local owner, and validates defaults', async () => {
    const f = await fixture()
    expect(await f.tasks.call('task-settings', { sessionId: 'chat' }, { 'openai/threadId': 'chat' })).toMatchObject({
      status: 'ok',
    })
    await expect(
      f.tasks.call('task-settings-set', { settings: { model: 'new' } }, {
        'cordisx/channelContext': 'invalid',
        'openai/threadId': 'chat',
      }),
    ).rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    await expect(
      f.tasks.call('task-config-set', { config: {}, expectedRevision: 0 }, { 'openai/threadId': 'ordinary-chat' }),
    ).rejects.toThrow('PROFILE_SETTINGS_REQUIRE_LOCAL_USER')
    await expect(
      f.tasks.call('task-config-set', {
        config: { scopes: [{ id: 'group', settings: { providerId: 'two', model: 'old' } }] },
        expectedRevision: 0,
      }),
    ).rejects.toThrow('SELECTION_OUTSIDE_CATALOG')
    await f.tasks.call('task-config-set', {
      config: {
        defaults: { model: 'new', effort: 'high' },
        scopes: [{ id: 'alice', userIds: ['alice'], settings: { effort: 'low' } }],
      },
      expectedRevision: 0,
    })
    expect(await f.tasks.defaults(source)).toEqual({ providerId: 'one', model: 'new', effort: 'low' })
  })
})
