import path from 'node:path'
import { ChannelConversationConsumer } from '../launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../launcher/channel-conversation-tools.js'
import type { ChannelNativeSessions } from '../launcher/channel-native-sessions.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { OwnerDocumentBridgeHandler } from '../launcher/owner-document-rpc.js'
import type { ChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import { chatExecutionOperation } from '../launcher/chat-execution-operation.js'

/** Finish every owned boundary even when an earlier cleanup reports a failure. */
export function configuredLaunchCleanup(input: {
  readonly documents: OwnerDocumentBridgeHandler
  readonly credentials: ChannelCredentialBridgeHandler | undefined
  readonly channel: () => Promise<void>
  readonly providers: () => Promise<void>
}): () => Promise<void> {
  let disposal: Promise<void> | undefined
  return () =>
    disposal ??= (async () => {
      const failures: unknown[] = []
      const operations = [
        () => input.documents.walletSpend?.dispose(),
        () => input.documents.http.dispose(),
        () => input.documents.agentTools?.close(),
        () => input.credentials?.dispose?.(),
        input.channel,
        input.providers,
      ]
      for (const operation of operations) {
        try {
          await operation()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Configured launch cleanup failed')
    })()
}

/** One profile-owned consumer, tool authority and input subscription for the launch lifetime. */
export async function createConfiguredChannelConsumer(input: {
  readonly service: LocalChannelService | undefined
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly native: () => ChannelNativeSessions | undefined
  readonly report: (code: string) => void
  readonly documents?: (input: unknown) => Promise<unknown>
}) {
  const service = input.service
  const execution = (operation: string, args: Record<string, unknown>) =>
    chatExecutionOperation(input.native(), operation, args)
  if (!service) {
    const tools = new ChannelConversationTools(() => undefined, undefined, input.documents, execution)
    return { consumer: undefined, tools, dispose: async () => tools.dispose() }
  }
  const consumer = await ChannelConversationConsumer.open({
    profileId: input.profileId,
    file: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-conversations.json'),
    access: () => service.conversationAccess(),
    native: input.native,
    report: input.report,
  })
  const tools = new ChannelConversationTools(() => service.conversationAccess(), consumer, input.documents, execution)
  consumer.setNativeExtras(() => input.native())
  service.setConversationManager({
    bindings: () =>
      consumer.bindings().map(binding => ({
        bindingId: binding.id,
        channel: {
          adapterId: binding.channel.adapterId,
          accountId: binding.channel.accountId,
          tenantId: binding.channel.tenantId,
          conversationId: binding.channel.conversationId,
          threadId: binding.channel.threadId,
        },
        session: { providerId: 'codex', remoteSessionId: binding.sessionId },
        routeId: 'host-channel-consumer',
        state: binding.state,
      })),
    binding: (action, id) => consumer.bindingAction(action, id),
  })
  const disposeInputs = service.observeInputs((recordId, message, mentionedBot, persisted, addressing) =>
    consumer.receive(recordId, message, mentionedBot, persisted, addressing)
  )
  const disposeCards = service.observeCardActions((ref, event) => consumer.cardAction(ref, event))
  let disposal: Promise<void> | undefined
  return {
    consumer,
    tools,
    dispose: () =>
      disposal ??= (async () => {
        disposeInputs()
        disposeCards()
        tools.dispose()
        const failures: unknown[] = []
        try {
          await consumer.dispose()
        } catch (error) {
          failures.push(error)
        }
        try {
          await service.dispose()
        } catch (error) {
          failures.push(error)
        }
        if (failures.length) throw new AggregateError(failures, 'Channel cleanup failed')
      })(),
  }
}

/** All native and management Channel callers retain their real incoming metadata. */
export function configuredChannelToolHandler(
  tools: import('../launcher/channel-conversation-tools.js').ChannelConversationTools | undefined,
) {
  return tools === undefined
    ? {}
    : { channel: (operation: string, input: unknown, metadata?: unknown) => tools.call(operation, input, metadata) }
}
