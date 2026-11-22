import path from 'node:path'
import { ChannelConversationConsumer } from '../launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../launcher/channel-conversation-tools.js'
import type { ChannelNativeSessions } from '../launcher/channel-native-sessions.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { OwnerDocumentBridgeHandler } from '../launcher/owner-document-rpc.js'
import type { ChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import { chatExecutionOperation } from '../launcher/chat-execution-operation.js'
import { ChannelAdminPairing } from '../launcher/channel-admin-pairing.js'
import { receiveAdminPairing } from '../launcher/channel-admin-pairing-rpc.js'
import { ChannelGroupGuidance } from '../launcher/channel-group-guidance.js'
import { channelGroupGuidanceReply } from '../launcher/channel-group-guidance-reply.js'
import { ChannelConversationStore } from '../launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../launcher/profile-logical-conversation-owner.js'
import { logicalContinuationManagement } from '../launcher/logical-continuation-management.js'

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
  readonly logicalRuntime?: boolean
  readonly logicalOwnerOnly?: boolean
  readonly profileId: string
  readonly native: () => ChannelNativeSessions | undefined
  readonly report: (code: string) => void
  readonly documents?: (input: unknown) => Promise<unknown>
}) {
  const service = input.service
  const execution = (operation: string, args: Record<string, unknown>) =>
    chatExecutionOperation(input.native(), operation, args)
  if (!service) {
    const logicalOwner = input.logicalRuntime || input.logicalOwnerOnly
      ? profileLogicalConversationOwner(
        await ChannelConversationStore.open(
          path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-conversations.json'),
        ),
      )
      : undefined
    const tools = new ChannelConversationTools(
      () => undefined,
      undefined,
      input.documents,
      execution,
      undefined,
      logicalOwner
        ? async (operation, value) =>
          await logicalContinuationManagement(
            {
              owner: logicalOwner,
              appId: input.appId,
              profileId: input.profileId,
              available: true,
              recoveryRequired: !!input.logicalOwnerOnly,
            },
            operation,
            value,
          )
        : undefined,
    )
    return {
      consumer: undefined,
      tools,
      logicalOwner,
      dispose: async () => {
        tools.dispose()
        logicalOwner?.desktopChannelGrants.clear()
        await logicalOwner?.store.close()
      },
    }
  }
  const consumer = await ChannelConversationConsumer.open({
    appId: input.appId,
    ...(input.logicalRuntime ? { logicalRuntime: true } : {}),
    ...(input.logicalOwnerOnly ? { logicalRecoveryRequired: true } : {}),
    profileId: input.profileId,
    file: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-conversations.json'),
    access: () => service.conversationAccess(),
    native: input.native,
    report: input.report,
  })
  const pairing = new ChannelAdminPairing()
  const guidance = new ChannelGroupGuidance(
    path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-group-guidance'),
  )
  const tools = new ChannelConversationTools(
    () => service.conversationAccess(),
    consumer,
    input.documents,
    execution,
    pairing,
  )
  service.setPairingHandler((ref, generation, message) =>
    receiveAdminPairing(pairing, guidance, consumer, ref, generation, message)
  )
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
  const disposeInputs = service.observeInputs(async (recordId, message, mentionedBot, persisted, addressing) => {
    await consumer.receive(recordId, message, mentionedBot, persisted, addressing)
    if (persisted) {
      await channelGroupGuidanceReply({
        message,
        recordId,
        mentionedBot,
        consumer,
        access: () => service.conversationAccess(),
        guidance,
      }).catch(() => input.report('CHANNEL_GROUP_GUIDANCE_UNAVAILABLE'))
    }
  })
  const disposeCards = service.observeCardActions((ref, event) => consumer.cardAction(ref, event))
  let disposal: Promise<void> | undefined
  return {
    consumer,
    tools,
    logicalOwner: input.logicalRuntime || input.logicalOwnerOnly ? consumer.profileLogicalOwner() : undefined,
    dispose: () =>
      disposal ??= (async () => {
        disposeInputs()
        disposeCards()
        service.setPairingHandler(undefined)
        pairing.dispose()
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

/** Attach the optional Desktop recovery owner before its native peer admits input. */
export async function createDesktopChannelConsumer(
  input: Parameters<typeof createConfiguredChannelConsumer>[0] & {
    logicalRecovery: boolean
    nativeBootstrap?: import('../launcher/native-submission-composition.js').NativeSubmissionBootstrap
  },
) {
  const configured = await createConfiguredChannelConsumer({
    ...input,
    ...(input.logicalRecovery && input.nativeBootstrap ? { logicalOwnerOnly: true } : {}),
  })
  try {
    if (configured.logicalOwner && input.nativeBootstrap) {
      input.nativeBootstrap.bindLogicalFenceOwner(configured.logicalOwner)
    }
    return configured
  } catch (error) {
    await configured.dispose()
    throw error
  }
}

/** All native and management Channel callers retain their real incoming metadata. */
export function configuredChannelToolHandler(
  tools: import('../launcher/channel-conversation-tools.js').ChannelConversationTools | undefined,
  consumer?: ChannelConversationConsumer,
) {
  return tools === undefined
    ? {}
    : {
      channel: (operation: string, input: unknown, metadata?: unknown) => tools.call(operation, input, metadata),
      chatSettingsGuard: (operation: string, args: Record<string, unknown>, metadata?: unknown) =>
        tools.executionGuard(operation, args, metadata),
      ...(consumer ? { logicalHistory: (params: unknown) => consumer.logicalHistoryCall(params) } : {}),
    }
}

export function desktopChannelCatalogOptions(
  service: LocalChannelService | undefined,
  consumer: ChannelConversationConsumer | undefined,
  tools: ChannelConversationTools,
  logicalOwner?: import('../launcher/profile-logical-conversation-owner.js').ProfileLogicalConversationOwner,
) {
  return {
    ...(logicalOwner ? { logicalOwner } : {}),
    channelName: (event: import('@cordisx/channel-runtime').ChannelEventRef) =>
      service?.conversationAccess()?.name?.(event) ?? Promise.resolve(undefined),
    channelSectionName: () =>
      consumer?.policy().policy.sidebarGroup === null
        ? undefined
        : consumer?.policy().policy.sidebarGroup ?? '外部连接',
    ...configuredChannelToolHandler(tools, consumer),
  }
}

/** Local management calls retain source context while allowing local-only inventory. */
export function configuredChannelManagementToolHandler(
  tools: import('../launcher/channel-conversation-tools.js').ChannelConversationTools | undefined,
) {
  return tools === undefined
    ? {}
    : {
      channel: (operation: string, input: unknown, metadata?: unknown) => tools.callLocal(operation, input, metadata),
    }
}
