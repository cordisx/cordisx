import { ChannelMemoryStore } from '../../packages/cli/src/launcher/channel-memory-store.js'
import { ChannelAgentAccess } from '../../packages/cli/src/launcher/channel-agent-access.js'
import { channelMemoryCommand } from '../../packages/cli/src/launcher/channel-memory-command.js'
export { ChannelMemoryPersonas } from '../../packages/cli/src/launcher/channel-memory-personas.js'
import { ChannelMemoryAuthority } from '../../packages/cli/src/launcher/channel-memory-authority.js'
import path from 'node:path'
import { ChannelMemoryPersonas } from '../../packages/cli/src/launcher/channel-memory-personas.js'
import { ChannelNativeSessions } from '../../packages/cli/src/launcher/channel-native-sessions.js'
import { ChannelConversationTools } from '../../packages/cli/src/launcher/channel-conversation-tools.js'
import { parseChannelConversationPolicy } from '../../packages/cli/src/launcher/channel-conversation-policy.js'

export function mockMemoryBoundary(root: string) {
  let store = new ChannelMemoryStore(root)
  const authorization = new ChannelMemoryAuthority(path.join(root, 'authority'))
  let source: Record<string, unknown> = {}
  let token = ''
  let requestText = ''
  let policy = parseChannelConversationPolicy({ enabled: true })
  const outbound: { text: string; target: unknown }[] = []
  const receipts = new Map<string, { state: string }>()
  const tools = new ChannelConversationTools(() =>
    ({
      generation: 'synthetic',
      accounts: () => [{
        ref: { adapterId: 'feishu', accountId: 'synthetic-bot', tenantId: 'synthetic-tenant' },
        state: 'ready',
      }],
      conversations: async () => ({ conversations: [], complete: true }),
      drain: async () => {},
      runtime: {
        notifyOnce: async (message: any, _caller: any, id: string) => {
          outbound.push({ text: message.text, target: message.target })
          receipts.set(id, { state: 'sent' })
          return { deliveryId: id }
        },
        deliverySnapshot: (id: string) => receipts.get(id),
        pluginSnapshot: () => ({ state: 'active' }),
      },
    }) as never
  )
  const access = new ChannelAgentAccess(
    () =>
      ({
        policy,
        inputs: { current: { input: { source: { event: source }, content: [{ type: 'text', text: requestText }] } } },
      }) as never,
    () =>
      ({
        contextFor: (candidate: string) => candidate === token ? { threadId: 'synthetic-thread' } : undefined,
        sourceFor: () => source,
        hasPreparation: () => false,
        isPreparing: () => false,
      }) as never,
  )
  return {
    async initializePersona(registry: ChannelMemoryPersonas, taskId: string, text: string) {
      let prompt = ''
      const event = source as any
      const native = new ChannelNativeSessions({
        cwd: root,
        nativeRequest: async () => ({}),
        bridge: () =>
          ({
            call: async (_provider: string, action: string, input: any) => {
              if (action === 'start_session') {
                prompt = input.prompt
                return { status: 'started', sessionId: taskId, turnId: 'synthetic-turn' }
              }
              return {}
            },
          }) as never,
      })
      native.setPersonaRegistry(registry)
      const result = await native.start(
        taskId,
        { source: { event }, receivedAt: new Date().toISOString(), content: [{ type: 'text', text }] } as never,
      )
      if (result.state !== 'running') throw new Error('SCENARIO_NATIVE_INIT_FAILED')
      store = await registry.memoryForTask(taskId, event)
      return prompt
    },
    dispatch(
      actor: string,
      conversation: string,
      kind: string,
      adapter: string,
      messageId: string,
      context: string,
      text = '',
      accountId = 'synthetic-bot',
    ) {
      requestText = text
      token = context
      source = {
        adapterId: adapter,
        accountId,
        tenantId: 'synthetic-tenant',
        actor: { adapterId: adapter, accountId, tenantId: 'synthetic-tenant', userId: actor },
        conversationId: conversation,
        kind,
        messageId,
      }
    },
    async call(input: Record<string, unknown>, context: string) {
      try {
        if (input.action === 'send') {
          if (context !== token) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
          return await tools.call('send', {
            account: { adapterId: 'feishu', accountId: 'synthetic-bot', tenantId: 'synthetic-tenant' },
            target: { id: source.conversationId, kind: source.kind, replyMode: 'conversation' },
            text: input.text,
            operationId: input.operationId,
          })
        }
        return await channelMemoryCommand(store, access, input, { 'cordisx/channelContext': context }, authorization)
      } catch (error) {
        return { status: 'rejected', code: error instanceof Error ? error.message : 'UNKNOWN' }
      }
    },
    outbound() {
      return outbound
    },
    async configureAdministrator(userId: string, conversations: string[]) {
      const account = { adapterId: 'feishu', accountId: 'synthetic-bot', tenantId: 'synthetic-tenant', userId }
      return authorization.configure(account, conversations.map(conversationId => ({ ...account, conversationId })), 0)
    },
    policy(value: unknown) {
      policy = parseChannelConversationPolicy(value)
    },
    async records() {
      await store.files.prepare()
      const state = await store.files.read('state.json') as { records: Record<string, number> }
      return Promise.all(
        Object.entries(state.records).map(([id, revision]) => store.files.read(`${id}-${revision}.json`)),
      )
    },
  }
}
