import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationManagement } from '../packages/cli/src/launcher/channel-conversation-management.js'
import { ChannelConversationWorkflow } from '../packages/cli/src/renderer/channel-conversation-workflow.js'
import { PublicChannelManagerController } from '../packages/cli/src/renderer/channel-manager-public.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import type { ChannelManagerProjectionV1 } from '../packages/cli/src/renderer/channel-manager.js'
import type { ChannelTransportActivity } from '../packages/channel-runtime/src/index.js'

const ref = { adapterId: 'feishu', accountId: 'cli_own', tenantId: 'tenant' }
const group = { ...ref, conversationId: 'group', kind: 'group' as const }
const other = { ...group, accountId: 'cli_other' }
function fixture() {
  let generation = 1, transportRevision = 2, live = true, allowed = true
  let directory = [{ id: 'group', name: 'Actual group', kind: 'group' as const }, {
    id: 'other-group',
    name: 'Second group',
    kind: 'group' as const,
  }]
  let entries: ChannelTransportActivity[] = [
    {
      conversation: group,
      id: 'in',
      eventId: 'event',
      direction: 'incoming',
      state: 'received',
      occurredAt: '2026-11-16T01:00:00Z',
      text: 'Actual incoming',
    },
    {
      conversation: group,
      id: 'out',
      direction: 'outgoing',
      state: 'sent',
      occurredAt: '2026-11-16T02:00:00Z',
      text: 'Explicit outgoing',
      sessionId: 'native-chat',
    },
    {
      conversation: group,
      id: 'unknown',
      direction: 'outgoing',
      state: 'unknown',
      occurredAt: '2026-11-16T03:00:00Z',
      text: 'Unknown delivery',
    },
  ]
  let projection: ChannelManagerProjectionV1 = {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: 'implemented',
    service: {
      configurationKind: 'host',
      configApplies: 'service-restart',
      revision: 1,
      lastGoodRevision: 1,
      writable: true,
    },
    connections: [{ ref, adapterKind: 'feishu', enabled: true, transportMode: 'websocket', secretState: 'ready' }],
    accounts: [],
    routes: [],
    diagnostics: [],
    bindings: [{
      bindingId: 'binding',
      channel: { ...group, threadId: 'group' },
      session: { providerId: 'codex', remoteSessionId: 'native-chat' },
      routeId: 'route',
      state: 'active',
    }],
  }
  const binding = {
    id: 'binding',
    channel: { ...group, threadId: 'group', semantics: 'conversation' as const },
    sessionId: 'native-chat',
    hostId: 'local' as const,
    profileId: 'test',
    createdAt: '2026-11-16T00:00:00Z',
    fromSequence: 1,
    mode: 'listen' as const,
    autoReply: false,
    state: 'active' as const,
  }
  let related = [binding]
  const access = {
    generation: 'service',
    accounts: () => [{ ref, state: 'ready' }],
    runtime: {
      accountConversationReadback: () => ({ revision: transportRevision, entries }),
      localConversationRefs: () => [group],
      snapshot: () => ({ accounts: [{ ref, generation }] }),
    },
    conversations: async () => ({ conversations: directory, complete: true }),
    conversationIdentity: async () => ({ name: 'Actual group' }),
  } as unknown as ChannelConversationAccess
  const consumer = {
    managementReadback: () => ({
      revision: 1,
      bindings: related,
      senders: [{ event: { ...other, eventId: 'event' }, name: 'Foreign sender' }, {
        event: { ...group, eventId: 'event' },
        name: 'Correct sender',
      }],
      deliveries: [],
    }),
    bindingLabels: vi.fn(async (ids?: readonly string[]) =>
      related.filter(item => ids === undefined || ids.includes(item.id)).map(item => ({
        bindingId: item.id,
        sessionName: 'Actual local chat',
        conversationName: 'Actual group',
      }))
    ),
    bindingNavigation: vi.fn(async () => 'native-chat'),
  }
  const management = new ChannelConversationManagement(() => access, consumer as never)
  const actions = {
    run: vi.fn(async (action: string, input: Record<string, unknown>) => ({
      status: 'applied' as const,
      ...await management.read(action, input),
    })),
  }
  const controller = new PublicChannelManagerController({
    profileId: 'test',
    hostGeneration: 'host',
    projection: () => projection,
    actionsAvailable: () => true,
    runAction: async () => ({ status: 'applied' }),
  })
  const connectionToken = controller.snapshot().accounts[0]!.connectionToken
  const navigate = vi.fn(), authorize = vi.fn(async () => allowed)
  const workflow = new ChannelConversationWorkflow({
    caller: 'owner',
    profileId: 'test',
    hostGeneration: 'host',
    controller,
    actions,
    live: () => live,
    authorize,
    navigate,
  })
  return {
    access,
    workflow,
    management,
    controller,
    actions,
    authorize,
    navigate,
    connectionToken,
    consumer,
    retire: () => {
      live = false
    },
    deny: () => {
      allowed = false
    },
    replace: () => {
      generation += 1
    },
    mutate: () => {
      transportRevision += 1
    },
    changeDirectory: () => {
      directory = directory.slice(1)
    },
    manyBindings: () => {
      related = Array.from({ length: 10_001 }, (_, index) => ({ ...binding, id: `binding-${index}` }))
      projection = {
        ...projection,
        bindings: related.map(item => ({ ...projection.bindings[0]!, bindingId: item.id })),
      }
    },
    remove: () => {
      projection = { ...projection, connections: [], bindings: [] }
    },
    waitIdentity: () => {
      let resolve!: () => void
      let entered!: () => void
      const started = new Promise<void>(done => {
        entered = done
      })
      access.conversationIdentity = () =>
        new Promise(done => {
          resolve = () => done({ name: 'Later group' })
          entered()
        })
      return { started, resume: () => resolve() }
    },
    foreignReadback: () => {
      entries = [{ ...entries[0]!, conversation: other }]
    },
  }
}
const signal = () => new AbortController().signal
describe('conversation relationships and scoped public readback', () => {
  it('keeps a real directory name when cold lookup takes more than a second and decoration falls back to the raw ID', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.access.conversations = () =>
      new Promise(resolve => {
        setTimeout(() =>
          resolve({
            conversations: [{ id: 'group', name: 'Actual group', kind: 'group' }],
            complete: true,
          }), 1_500)
      })
    f.access.conversationIdentity = async () => ({ name: 'group' })
    try {
      const reading = f.management.read('conversation-page', { ref, limit: 1 })
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(reading).resolves.toMatchObject({
        conversationPage: { directoryComplete: true, conversations: [{ name: 'Actual group' }] },
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('returns actual inbound/outbound records, names, all binding controls and navigation without a model dispatch', async () => {
    const f = fixture()
    const page = await f.workflow.page({ connectionToken: f.connectionToken }, signal())
    const target = page.conversations.find(item => item.name === 'Actual group')!
    expect(target).toMatchObject({ bindingCount: 1, receivedCount: 1, sentCount: 1 })
    const activity = await f.workflow.activity({ conversationToken: target.conversationToken }, signal())
    expect(activity.source).toBe('local-transport')
    expect(activity.entries.find(item => item.text === 'Actual incoming')?.senderName).toBe('Correct sender')
    expect(activity.entries.find(item => item.text === 'Explicit outgoing')?.sessionName).toBe('Actual local chat')
    expect(activity.entries.find(item => item.text === 'Unknown delivery')?.state).toBe('unknown')
    expect(JSON.stringify(activity)).not.toMatch(/native-chat|cli_own|tenant|eventId|sessionId/u)
    const refreshed = await f.workflow.activity({ conversationToken: target.conversationToken }, signal())
    expect(refreshed.entries.map(item => item.entryId)).toEqual(activity.entries.map(item => item.entryId))
    const bindings = await f.workflow.bindings({ conversationToken: target.conversationToken }, signal())
    expect(bindings.bindings[0]?.sessionName).toBe('Actual local chat')
    await expect(f.workflow.openBinding(bindings.bindings[0]!.bindingToken, signal())).resolves.toEqual({
      status: 'opened',
    })
    expect(f.navigate).toHaveBeenCalledWith('native-chat')
    expect(f.actions.run.mock.calls.map(call => call[0])).not.toContain('send')
  })
  it('paginates all relationships beyond the legacy 10000-entry snapshot without truncating', async () => {
    const f = fixture()
    f.manyBindings()
    const page = await f.workflow.page({ connectionToken: f.connectionToken }, signal())
    const target = page.conversations.find(item => item.bindingCount === 10_001)!
    expect(target).toBeDefined()
    const ids = new Set<string>()
    let afterCursor: string | undefined
    do {
      const result = await f.workflow.bindings({
        conversationToken: target.conversationToken,
        limit: 100,
        ...(afterCursor ? { afterCursor } : {}),
      }, signal())
      expect(result.total).toBe(10_001)
      for (const item of result.bindings) ids.add(item.bindingToken)
      afterCursor = result.nextCursor
    } while (afterCursor)
    expect(ids.size).toBe(10_001)
  })
  it('binds cursors to the operation, target, account incarnation, snapshot and page budget', async () => {
    const f = fixture()
    const page = await f.workflow.page({ connectionToken: f.connectionToken, limit: 1 }, signal())
    expect(page.nextCursor).toBeDefined()
    await expect(
      f.workflow.page({ connectionToken: f.connectionToken, afterCursor: page.nextCursor!, limit: 2 }, signal()),
    ).rejects.toThrow('STALE_CURSOR')
    await expect(
      f.workflow.activity({
        conversationToken: page.conversations[0]!.conversationToken,
        afterCursor: page.nextCursor!,
        limit: 1,
      }, signal()),
    ).rejects.toThrow('STALE_CURSOR')
    f.changeDirectory()
    await expect(
      f.workflow.page({ connectionToken: f.connectionToken, afterCursor: page.nextCursor!, limit: 1 }, signal()),
    ).rejects.toThrow('STALE_CURSOR')
    f.replace()
    await expect(f.workflow.detail(page.conversations[0]!.conversationToken, signal())).rejects.toThrow(
      'TARGET_UNAVAILABLE',
    )
  })
  it('rechecks permission and service retirement after asynchronous decoration and rejects borrowed targets', async () => {
    const f = fixture()
    const page = await f.workflow.page({ connectionToken: f.connectionToken }, signal())
    const borrowed = f.workflow.forCaller({ caller: 'different', live: () => true, authorize: async () => true })
    await expect(borrowed.detail(page.conversations[0]!.conversationToken, signal())).rejects.toThrow(
      'TARGET_UNAVAILABLE',
    )
    const wait = f.waitIdentity()
    const reading = f.workflow.detail(page.conversations[0]!.conversationToken, signal())
    await wait.started
    f.deny()
    wait.resume()
    await expect(reading).rejects.toThrow('PERMISSION_DENIED')
    f.retire()
    await expect(f.workflow.page({ connectionToken: f.connectionToken }, signal())).rejects.toThrow('STALE_GENERATION')
  })
  it('rejects a changed transport revision and ignores other account records in the launcher', async () => {
    const f = fixture()
    const page = await f.workflow.page({ connectionToken: f.connectionToken }, signal())
    const target = page.conversations[0]!.conversationToken
    const first = await f.workflow.activity({ conversationToken: target, limit: 1 }, signal())
    f.mutate()
    await expect(f.workflow.activity({ conversationToken: target, afterCursor: first.nextCursor!, limit: 1 }, signal()))
      .rejects.toThrow('STALE_CURSOR')
    f.foreignReadback()
    const safe = await f.workflow.activity({ conversationToken: target }, signal())
    expect(safe.entries).toEqual([])
    f.remove()
    await expect(f.workflow.detail(target, signal())).rejects.toThrow('TARGET_UNAVAILABLE')
  })
})
