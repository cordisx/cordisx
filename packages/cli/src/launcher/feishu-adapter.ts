import { channelQuestionCard } from './channel-question-card.js'
import { renderFeishuMarkdown } from './feishu-markdown.js'
import { createHash } from 'node:crypto'
import {
  type CardActionEvent,
  createLarkChannel,
  Domain,
  type LarkChannel,
  type Logger,
  LoggerLevel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk'
import type {
  ChannelAdapterConnection,
  ChannelAdapterDefinition,
  ChannelAdapterHost,
  ChannelInboundEnvelope,
  ChannelOutboundDelivery,
  ChannelSendResult,
  ChannelTenantRef,
} from '@cordisx/channel-runtime'
import { channelInboxRecordId } from '@cordisx/channel-runtime'
import type { ChannelServiceConfig, ChannelServiceConnectionConfigV2 } from '@cordisx/channel-runtime'
import type { ChannelAccountIdentityStore, FeishuBotProfile } from './channel-account-identity.js'
import { ChannelInboundResources } from './channel-inbound-resources.js'
import { feishuInboundContent } from './feishu-inbound-media.js'
import { prepareFeishuOutboundMedia } from './feishu-outbound-media.js'
import { channelReactionInput, type KnownBotMessage } from './channel-reaction-input.js'
import { feishuProfileHttp } from './feishu-profile-http.js'
import { createFeishuDiagnostics } from './feishu-diagnostics.js'
import { FeishuCardActionQueue } from './feishu-card-action-queue.js'
import { type ChannelCommandAddressing, channelCommandAddressing } from './channel-command-users.js'
import {
  LauncherSecretResolutionError,
  type LauncherSecretResolverOptions,
  resolveLauncherSecret,
} from './secret-resolver.js'

export type FeishuSdkChannel =
  & Pick<LarkChannel, 'connect' | 'disconnect' | 'on' | 'send'>
  & Partial<Pick<LarkChannel, 'rawClient' | 'botIdentity' | 'getChatInfo' | 'updateCard'>>

export interface FeishuChannelFactoryOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain: typeof Domain.Feishu | typeof Domain.Lark
  readonly source: string
  readonly requireMention: boolean
  readonly onProfile: (profile: FeishuBotProfile) => void
  readonly logger: Logger
}

export interface FeishuAdapterOptions {
  readonly resources?: ChannelInboundResources
  readonly connection: ChannelServiceConnectionConfigV2
  readonly configurationRevision: number
  readonly source: string
  readonly resolveSecret?: (reference: string | undefined) => Promise<string>
  readonly createChannel?: (options: FeishuChannelFactoryOptions) => FeishuSdkChannel
  readonly identities?: ChannelAccountIdentityStore
  readonly acceptMessage?: (message: NormalizedMessage) => boolean
  readonly readConnection?: () => ChannelServiceConnectionConfigV2 | undefined
  readonly channelConnected?: (ref: ChannelTenantRef, channel: FeishuSdkChannel | undefined) => void
  readonly onNormalizedInput?: (
    recordId: string,
    input: ChannelInboundEnvelope['input'],
    mentionedBot: boolean,
    persisted: boolean,
    addressing: ChannelCommandAddressing,
  ) => Promise<void>
  readonly onCardAction?: (ref: ChannelTenantRef, event: CardActionEvent) => Promise<void>
  readonly onPairingInput?: (
    ref: ChannelTenantRef,
    message: NormalizedMessage,
  ) => Promise<{ accepted: boolean; reply: boolean }>
}

class FeishuAdapterError extends Error {
  constructor(code: 'CONNECTION_UNAVAILABLE' | 'OUTBOUND_UNAVAILABLE') {
    super(code)
    this.name = `CHANNEL_FEISHU_${code}`
  }
}

function sameTenant(left: ChannelTenantRef, right: ChannelTenantRef): boolean {
  return left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId
}

// The official SDK preserves empty root_id/thread_id fields for ordinary messages.
// Only a nonblank identifier establishes a reply chain, including receive selectors.
const replyThreadId = (message: NormalizedMessage): string | undefined =>
  message.rootId?.trim() || message.threadId?.trim() || message.replyToMessageId?.trim() || undefined

function inboundEnvelope(
  message: NormalizedMessage,
  connection: ChannelServiceConnectionConfigV2,
): ChannelInboundEnvelope {
  const replyId = replyThreadId(message)
  const threadId = replyId ?? message.chatId
  return {
    input: {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: message.content }],
      source: {
        kind: 'channel',
        event: {
          adapterId: connection.ref.adapterId,
          accountId: connection.ref.accountId,
          tenantId: connection.ref.tenantId,
          conversationId: message.chatId,
          kind: message.chatType === 'p2p' ? 'direct' : 'group',
          threadId,
          semantics: replyId === undefined ? 'conversation' : message.threadId?.trim() ? 'topic' : 'reply-chain',
          eventId: message.messageId,
          messageId: message.messageId,
          actor: {
            adapterId: connection.ref.adapterId,
            accountId: connection.ref.accountId,
            tenantId: connection.ref.tenantId,
            userId: message.senderId,
          },
        },
      },
      receivedAt: new Date(message.createTime).toISOString(),
    },
  }
}

function compatible(input: FeishuAdapterOptions): void {
  if (
    (input.connection.adapterKind !== 'feishu' && input.connection.adapterKind !== 'lark')
    || input.connection.transport.mode !== 'websocket'
  ) {
    throw new FeishuAdapterError('CONNECTION_UNAVAILABLE')
  }
}

export function createFeishuAdapterDefinition(input: FeishuAdapterOptions): ChannelAdapterDefinition {
  compatible(input)
  const create = input.createChannel ?? (options =>
    createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.domain,
      source: options.source,
      loggerLevel: LoggerLevel.debug,
      logger: options.logger,
      transport: 'websocket',
      // The SDK drops form_value unless raw events are enabled. The queue extracts
      // only the bounded answer and discards the raw body before retaining it.
      includeRawEvent: true,
      // A pairing code must never be merged into a neighbouring ordinary
      // message, and each actor/event needs its own authorization boundary.
      // Keep the SDK's per-chat queue and deduplication, but flush each event.
      safety: { batch: { text: { delayMs: 0, longDelayMs: 0, maxMessages: 1 } } },
      policy: { dmMode: 'open', requireMention: options.requireMention },
      httpInstance: feishuProfileHttp(options.onProfile),
    }))
  return {
    descriptor: {
      ref: input.connection.ref,
      kind: input.connection.adapterKind,
      implementationStatus: 'implemented',
      configurationRevision: input.configurationRevision,
      secretState: input.connection.secretRef === undefined ? 'missing' : 'ready',
    },
    start: async (host: ChannelAdapterHost): Promise<ChannelAdapterConnection> => {
      const secret = await (input.resolveSecret ?? (async reference => await resolveLauncherSecret(reference)))(
        input.connection.secretRef,
      )
      const observation = createFeishuDiagnostics(input.connection.ref.accountId)
      const channel = create({
        appId: input.connection.ref.accountId,
        appSecret: secret,
        domain: input.connection.adapterKind === 'lark' ? Domain.Lark : Domain.Feishu,
        source: input.source,
        requireMention: false,
        onProfile: profile => input.identities?.receive(input.connection.ref, profile),
        logger: observation.logger,
      })
      let stopped = false
      const knownBotMessages = new Map<string, KnownBotMessage>()
      const originalInputs = new Map<string, ChannelInboundEnvelope['input']>()
      const ambiguousOriginals = new Set<string>()
      const resources = input.resources ?? new ChannelInboundResources()
      const cardActions = new FeishuCardActionQueue(
        async event => {
          if (!stopped) await input.onCardAction?.(input.connection.ref, event)
        },
        (phase, error) => observation.failure(phase, error),
      )
      const unsubscribe = channel.on('message', async message => {
        if (stopped) return
        // Pairing codes are capabilities: consume these control messages before
        // ordinary ingress, so neither their text nor raw event enters the inbox.
        if (/(?:^|\s)\/pair(?:\s|$)/iu.test(message.content)) {
          const selectors = (input.readConnection?.() ?? input.connection).selectors
          if (
            input.acceptMessage?.(message) === false || selectors !== undefined
              && !selectors.includes(message.chatType === 'p2p' ? 'direct' : 'group')
              && !(selectors.includes('mentions') && message.mentionedBot)
              && !(selectors.includes('replies') && replyThreadId(message) !== undefined)
          ) return
          const result = await input.onPairingInput?.(input.connection.ref, message)
          if (!stopped && result?.reply) {
            await channel.send(message.chatId, {
              text: message.chatType === 'group'
                ? '请私聊机器人，并由本机用户发起和确认配对。配对不会自动授予任务权限。'
                : result.accepted
                ? '配对请求已收到，请在本机确认。'
                : '配对请求无效或已过期，请在本机重新发起。',
            }).catch(() => undefined)
          }
          return
        }
        observation.message('normalized', message.messageId, {
          reason: message.chatType,
          outcome: message.mentionedBot ? 'mentioned' : 'unaddressed',
        })
        if (input.acceptMessage?.(message) === false) {
          observation.message('filtered', message.messageId, { reason: 'empty-or-accept-filter' })
          return
        }
        const selectors = (input.readConnection?.() ?? input.connection).selectors
        if (
          selectors !== undefined && !selectors.includes(message.chatType === 'p2p' ? 'direct' : 'group')
          && !(selectors.includes('mentions') && message.mentionedBot)
          && !(selectors.includes('replies') && replyThreadId(message) !== undefined)
        ) {
          observation.message('filtered', message.messageId, { reason: 'selectors' })
          return
        }
        const base = inboundEnvelope(message, input.connection)
        const content = await feishuInboundContent(
          message,
          base.input.source.event,
          resources,
          channel.rawClient?.im.v1.messageResource,
        )
        if (stopped) return
        const envelope = { input: { ...base.input, content } }
        const existingOriginal = originalInputs.get(envelope.input.source.event.threadId)
        if (
          !ambiguousOriginals.has(envelope.input.source.event.threadId)
          && (!existingOriginal || existingOriginal.source.event.eventId === envelope.input.source.event.eventId)
        ) {
          originalInputs.set(envelope.input.source.event.threadId, envelope.input)
        } else {
          originalInputs.delete(envelope.input.source.event.threadId)
          ambiguousOriginals.add(envelope.input.source.event.threadId)
          if (ambiguousOriginals.size > 128) ambiguousOriginals.delete(ambiguousOriginals.values().next().value!)
        }
        if (originalInputs.size > 128) originalInputs.delete(originalInputs.keys().next().value!)
        const addressing = channelCommandAddressing(message)
        const event = envelope.input.source.event
        const recordId = channelInboxRecordId(event)
        try {
          // Stage addressing metadata before the transport commit can wake subscribers.
          // Only a persisted core receipt (or catch-up read) makes it eligible for routing.
          await input.onNormalizedInput?.(recordId, envelope.input, message.mentionedBot, false, addressing)
          observation.message('staged', message.messageId)
          if (stopped) return
          const receipt = await host.receive(envelope)
          observation.message('persisted', message.messageId, {
            verified: receipt.recordId === recordId,
            outcome: receipt.duplicate ? 'duplicate' : receipt.status,
          })
          await input.onNormalizedInput?.(receipt.recordId, envelope.input, message.mentionedBot, true, addressing)
          await host.drainInbound(1)
          observation.message('drained', message.messageId)
        } catch (error) {
          // SDK handler errors otherwise disappear into a generic safety-pipeline log.
          // Never log text, raw bodies, URLs, credentials or the original exception.
          observation.failure('inbound-failed', error)
        }
      })
      const subscriptions = [
        unsubscribe,
        channel.on('reaction', async event => {
          if (stopped) return
          const message = channelReactionInput(
            event,
            knownBotMessages.get(event.messageId),
            channel.botIdentity?.openId,
          )
          if (!message) return
          const recordId = channelInboxRecordId(message.source.event)
          const addressing = { mentions: [] }
          try {
            await input.onNormalizedInput?.(recordId, message, true, false, addressing)
            const receipt = await host.receive({ input: message })
            await input.onNormalizedInput?.(receipt.recordId, message, true, true, addressing)
            await host.drainInbound(1)
          } catch (error) {
            observation.failure('reaction-failed', error)
          }
        }),
        channel.on('cardAction', event => cardActions.enqueue(event)),
        channel.on('reject', value => observation.reject(value.messageId, value.reason)),
        channel.on('error', error => observation.failure('channel-error', error)),
        channel.on('reconnecting', () => observation.event('reconnecting')),
        channel.on('reconnected', () => observation.event('reconnected')),
      ]
      const disposeObservation = () => {
        for (const dispose of subscriptions) dispose()
        observation.dispose()
      }
      try {
        await channel.connect()
        observation.event('connected')
      } catch {
        stopped = true
        await resources.dispose()
        await cardActions.dispose()
        disposeObservation()
        await channel.disconnect().catch(() => undefined)
        throw new FeishuAdapterError('CONNECTION_UNAVAILABLE')
      }
      input.channelConnected?.(input.connection.ref, channel)
      const interval = setInterval(() => {
        void host.drainOutbound(20).catch(() => undefined)
      }, 1_000)
      interval.unref()
      return {
        supportsOutboundMedia: channel.rawClient !== undefined,
        send: async (delivery: ChannelOutboundDelivery): Promise<ChannelSendResult> => {
          if (!sameTenant(delivery.target, input.connection.ref)) throw new FeishuAdapterError('OUTBOUND_UNAVAILABLE')
          if (stopped) throw new FeishuAdapterError('OUTBOUND_UNAVAILABLE')
          let messageId: string
          if (channel.rawClient) {
            // The existing authenticated SDK supports server-side deduplication.
            // Reclaiming a delivery uses the same UUID rather than creating a second message.
            const uuid = createHash('sha256').update(delivery.deliveryId).digest('hex').slice(0, 32)
            const media = delivery.media
              ? await prepareFeishuOutboundMedia(delivery.media, delivery.target, resources, {
                image: async data => ({ code: 0, data: await channel.rawClient!.im.v1.image.create({ data }) ?? {} }),
                file: async data => ({ code: 0, data: await channel.rawClient!.im.v1.file.create({ data }) ?? {} }),
              })
              : undefined
            const rendered = delivery.questionCard
              ? { msg_type: 'interactive' as const, content: channelQuestionCard(delivery.questionCard) }
              : renderFeishuMarkdown(delivery.text)
            const content = media?.content ?? JSON.stringify(rendered.content)
            const msg_type = media?.msg_type ?? rendered.msg_type
            const response = delivery.target.semantics !== 'conversation'
              ? await channel.rawClient.im.v1.message.reply({
                path: { message_id: delivery.target.threadId },
                data: { msg_type, content, uuid, reply_in_thread: delivery.target.semantics === 'topic' },
              })
              : await channel.rawClient.im.v1.message.create({
                params: { receive_id_type: delivery.target.conversationId.startsWith('ou_') ? 'open_id' : 'chat_id' },
                data: { receive_id: delivery.target.conversationId, msg_type, content, uuid },
              })
            if (response.code !== 0 || !response.data?.message_id) throw new FeishuAdapterError('OUTBOUND_UNAVAILABLE')
            messageId = response.data.message_id
          } else {
            if (delivery.questionCard || delivery.media) throw new FeishuAdapterError('OUTBOUND_UNAVAILABLE')
            const result = await channel.send(delivery.target.conversationId, { text: delivery.text }, {
              ...(delivery.target.semantics !== 'conversation'
                ? { replyTo: delivery.target.threadId, replyInThread: delivery.target.semantics === 'topic' }
                : {}),
            })
            messageId = result.messageId
          }
          knownBotMessages.set(messageId, {
            target: delivery.target,
            text: delivery.text,
            ...(originalInputs.get(delivery.target.threadId)
              ? { original: originalInputs.get(delivery.target.threadId)! }
              : {}),
          })
          if (knownBotMessages.size > 256) knownBotMessages.delete(knownBotMessages.keys().next().value!)
          return {
            externalMessageId: messageId,
            ...(messageId.length > 0 ? { recallHandle: messageId } : {}),
          }
        },
        stop: async () => {
          if (stopped) return
          stopped = true
          await resources.dispose()
          clearInterval(interval)
          await cardActions.dispose()
          disposeObservation()
          input.channelConnected?.(input.connection.ref, undefined)
          await channel.disconnect()
        },
      }
    },
  }
}

/** Narrow adapter constructor used by the launcher; it intentionally never accepts a secret value. */
export function feishuDefinitionsForConfig(
  configuration: ChannelServiceConfig,
  input: {
    readonly source: string
    readonly configurationRevision: number
    readonly secretResolver?: LauncherSecretResolverOptions
    readonly identities?: ChannelAccountIdentityStore
    readonly channelConnected?: FeishuAdapterOptions['channelConnected']
    readonly onNormalizedInput?: FeishuAdapterOptions['onNormalizedInput']
    readonly onCardAction?: FeishuAdapterOptions['onCardAction']
    readonly onPairingInput?: FeishuAdapterOptions['onPairingInput']
    readonly readConnection?: (ref: ChannelTenantRef) => ChannelServiceConnectionConfigV2 | undefined
  },
): readonly ChannelAdapterDefinition[] {
  return configuration.connections
    .filter(connection =>
      connection.enabled && (connection.adapterKind === 'feishu' || connection.adapterKind === 'lark')
    )
    .map(connection =>
      createFeishuAdapterDefinition({
        connection,
        source: input.source,
        configurationRevision: input.configurationRevision,
        ...(input.identities === undefined ? {} : { identities: input.identities }),
        ...(input.channelConnected === undefined ? {} : { channelConnected: input.channelConnected }),
        ...(input.onNormalizedInput === undefined ? {} : { onNormalizedInput: input.onNormalizedInput }),
        ...(input.onCardAction === undefined ? {} : { onCardAction: input.onCardAction }),
        ...(input.onPairingInput === undefined ? {} : { onPairingInput: input.onPairingInput }),
        ...(input.readConnection === undefined ? {} : { readConnection: () => input.readConnection!(connection.ref) }),
        ...(input.secretResolver === undefined ? {} : {
          resolveSecret: async reference => await resolveLauncherSecret(reference, input.secretResolver),
        }),
      })
    )
}

export { LauncherSecretResolutionError }
