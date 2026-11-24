import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { parseChannelTaskConfig } from '../packages/cli/src/launcher/channel-task-config.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { type AgentBridge, createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'
import { a, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'

describe('Channel priority and failure notices', () => {
  it('composes real preflight with an authentication failure and selects the next model', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    const catalog = [
      { providerId: 'first', models: [{ id: 'one' }] },
      { providerId: 'second', models: [{ id: 'two' }] },
    ]
    const nativeRequest = vi.fn(async () => ({}))
    const handler = createCodexBridgeHandler({ catalog: async () => catalog, nativeRequest } as never, '/tmp')
    const sessions = new ChannelNativeSessions({
      cwd: '/tmp',
      nativeRequest,
      bridge: () =>
        ({ call: (_app: string, operation: string, value: unknown) => handler(operation, value) }) as AgentBridge,
      memoryConnect: async providerId => ({ baseUrl: `https://${providerId}.example`, headers: {}, dispose() {} }),
    })
    const fetch = vi.fn(async (url: string) =>
      url.includes('first.example')
        ? new Response(null, { status: 401 })
        : new Response('{"status":"completed"}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetch)
    try {
      Object.assign(f.native, { priorityPreflight: sessions.priorityPreflight })
      f.consumer.setNativeExtras(() =>
        ({
          ...f.native,
          modelOperation: async () => ({ providers: catalog }),
          validateTaskConfiguration: async () => {},
        }) as never
      )
      const store = (f.consumer as unknown as { store: ChannelConversationStore }).store
      await store.mutate(state => {
        state.taskConfig = parseChannelTaskConfig({
          permissions: [{ id: 'allow', effect: 'allow', userIds: ['alice'], fields: ['providerId', 'model'] }],
        })
      })
      await f.consumer.modelPriorityOperation('model-priority-set', {
        expectedRevision: 0,
        candidates: [{ providerId: 'first', model: 'one' }, { providerId: 'second', model: 'two' }],
      })
      await f.consumer.receive('inbox:probe', message('om_probe', 'private fixture message'))
      await settle(f.consumer)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(fetch.mock.calls)).not.toContain('private fixture message')
      expect(nativeRequest).not.toHaveBeenCalled()
      expect(f.native.start.mock.calls[0]![6]).toEqual({ providerId: 'second', model: 'two' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('notifies on failure when automatic final replies are disabled', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: false, replyMode: 'none' }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: false }, a)
    f.native.completion.mockResolvedValue({ state: 'failed', code: 'PRIVATE' } as never)
    await f.consumer.receive('inbox:agent-mode', message('om_agent_mode'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).toHaveBeenCalledOnce()
    expect(f.runtime.notifyOnce.mock.calls[0]![0]).toMatchObject({
      text: '任务处理失败，请联系管理员。',
      target: { ...channel(), threadId: 'om_agent_mode', semantics: 'reply-chain' },
    })
  })
  it('honors the explicit failure notice setting independently of automatic final replies', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    await f.consumer.modelPriorityOperation('failure-notices-set', { expectedRevision: 0, enabled: false })
    f.native.completion.mockResolvedValue({ state: 'failed', code: 'PRIVATE' } as never)
    await f.consumer.receive('inbox:notice-off', message('om_notice_off'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
  })
  it('chooses the first authorized candidate passing a side-effect-free preflight for a new chat', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    const preflight = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    Object.assign(f.native, { priorityPreflight: preflight })
    const extra = {
      ...f.native,
      modelOperation: async () => ({
        providers: [
          { providerId: 'first', models: [{ id: 'one' }] },
          { providerId: 'second', models: [{ id: 'two' }] },
        ],
      }),
      validateTaskConfiguration: async () => {},
    }
    f.consumer.setNativeExtras(() => extra as never)
    const store = (f.consumer as unknown as { store: ChannelConversationStore }).store
    await store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({
        permissions: [{ id: 'allow', effect: 'allow', userIds: ['alice'], fields: ['providerId', 'model'] }],
      })
    })
    await f.consumer.modelPriorityOperation('model-priority-set', {
      expectedRevision: 0,
      candidates: [{ providerId: 'first', model: 'one' }, { providerId: 'second', model: 'two' }],
    })
    await f.consumer.receive('inbox:priority', message('om_priority'))
    await settle(f.consumer)
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(f.native.start).toHaveBeenCalledOnce()
    expect(f.native.start.mock.calls[0]![6]).toEqual({ providerId: 'second', model: 'two' })
  })
  it('does not override an explicit scoped model or use an unauthorized priority candidate', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
    const preflight = vi.fn().mockResolvedValue(true)
    Object.assign(f.native, { priorityPreflight: preflight })
    const store = (f.consumer as unknown as { store: ChannelConversationStore }).store
    await f.consumer.modelPriorityOperation('model-priority-set', {
      expectedRevision: 0,
      candidates: [{ providerId: 'first', model: 'one' }],
    })
    await f.consumer.receive('inbox:unauthorized', message('om_unauthorized'))
    await settle(f.consumer)
    expect(preflight).not.toHaveBeenCalled()
    expect(f.native.start).not.toHaveBeenCalled()
    expect(f.consumer.status().jobs[0]).toMatchObject({ state: 'failed', code: 'MODEL_PRIORITY_UNAVAILABLE' })
    expect(f.runtime.notifyOnce.mock.calls[0]![0].text).toBe('任务处理失败，请联系管理员。')
    await store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({ defaults: { providerId: 'chosen', model: 'chosen-model' } })
    })
    const defaults = vi.spyOn(f.consumer.taskSettings, 'defaults').mockResolvedValue({
      providerId: 'chosen',
      model: 'chosen-model',
    })
    await f.consumer.receive('inbox:explicit', message('om_explicit', 'hello', channel('other')))
    await settle(f.consumer)
    expect(preflight).not.toHaveBeenCalled()
    expect(f.native.start.mock.calls[0]![6]).toEqual({ providerId: 'chosen', model: 'chosen-model' })
    defaults.mockRestore()
  })
  it('rechecks priority changes made while preflight is in progress', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    Object.assign(f.native, {
      priorityPreflight: vi.fn(async () => {
        entered()
        await gate
        return true
      }),
    })
    f.consumer.setNativeExtras(() =>
      ({
        ...f.native,
        modelOperation: async () => ({ providers: [{ providerId: 'first', models: [{ id: 'one' }] }] }),
        validateTaskConfiguration: async () => {},
      }) as never
    )
    const store = (f.consumer as unknown as { store: ChannelConversationStore }).store
    await store.mutate(state => {
      state.taskConfig = parseChannelTaskConfig({
        permissions: [{ id: 'allow', effect: 'allow', userIds: ['alice'], fields: ['providerId', 'model'] }],
      })
    })
    await f.consumer.modelPriorityOperation('model-priority-set', {
      expectedRevision: 0,
      candidates: [{ providerId: 'first', model: 'one' }],
    })
    await f.consumer.receive('inbox:priority-race', message('om_priority_race'))
    await started
    await f.consumer.modelPriorityOperation('model-priority-set', { expectedRevision: 1, candidates: [] })
    release()
    await f.consumer.pump()
    expect(f.native.start).not.toHaveBeenCalled()
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledOnce()
    expect(f.native.start.mock.calls[0]![6]).toEqual({})
  })
  it('sends one generic failure notice to the original conversation without provider errors', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true, replyMode: 'reply' }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    f.native.completion.mockResolvedValue({ state: 'failed', code: 'SECRET_BACKEND_DETAILS' } as never)
    await f.consumer.receive('inbox:failure', message('om_failure'))
    await settle(f.consumer)
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).toHaveBeenCalledOnce()
    expect(f.runtime.notifyOnce.mock.calls[0]![0]).toMatchObject({
      text: '任务处理失败，请联系管理员。',
      target: { ...channel(), threadId: 'om_failure', semantics: 'reply-chain' },
    })
    expect(f.consumer.status(a).jobs[0]!.state).toBe('failed')
  })
  it('keeps uncertain dispatch fenced and sends at most one notice', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    f.native.start.mockRejectedValueOnce(new Error('private diagnostic'))
    await f.consumer.receive('inbox:uncertain', message('om_uncertain'))
    await settle(f.consumer)
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledOnce()
    expect(f.runtime.notifyOnce).toHaveBeenCalledOnce()
    expect(f.runtime.notifyOnce.mock.calls[0]![0].text).toBe('任务状态暂时无法确认，请联系管理员核查。')
    expect(f.consumer.status(a).jobs[0]!.state).toBe('reconciliation-required')
  })
  it('does not send a failure notice when sending is denied', async () => {
    const f = await fixture()
    await f.consumer.policySet({
      enabled: true,
      autoReply: true,
      rules: [{ id: 'deny-send', action: 'send', effect: 'deny', userIds: ['alice'] }],
    }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    f.native.completion.mockResolvedValue({ state: 'failed', code: 'PRIVATE' } as never)
    await f.consumer.receive('inbox:denied', message('om_denied'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
  })
})
