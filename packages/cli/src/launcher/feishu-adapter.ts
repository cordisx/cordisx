import {
  createLarkChannel,
  Domain,
  type LarkChannel,
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
import type { ChannelServiceConfigV1, ChannelServiceConnectionConfig } from '@cordisx/channel-runtime'
import {
  LauncherSecretResolutionError,
  type LauncherSecretResolverOptions,
  resolveLauncherSecret,
} from './secret-resolver.js'

type FeishuSdkChannel = Pick<LarkChannel, 'connect' | 'disconnect' | 'on' | 'send'>

export interface FeishuChannelFactoryOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain: typeof Domain.Feishu | typeof Domain.Lark
  readonly source: string
  readonly requireMention: boolean
}

export interface FeishuAdapterOptions {
  readonly connection: ChannelServiceConnectionConfig
  readonly configurationRevision: number
  readonly source: string
  readonly resolveSecret?: (reference: string | undefined) => Promise<string>
  readonly createChannel?: (options: FeishuChannelFactoryOptions) => FeishuSdkChannel
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

function inboundEnvelope(
  message: NormalizedMessage,
  connection: ChannelServiceConnectionConfig,
): ChannelInboundEnvelope {
  const threadId = message.rootId ?? message.threadId ?? message.chatId
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
          semantics: message.rootId === undefined && message.threadId === undefined ? 'conversation' : 'reply-chain',
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
      loggerLevel: LoggerLevel.warn,
      transport: 'websocket',
      policy: { dmMode: 'open', requireMention: options.requireMention },
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
      const channel = create({
        appId: input.connection.ref.accountId,
        appSecret: secret,
        domain: input.connection.adapterKind === 'lark' ? Domain.Lark : Domain.Feishu,
        source: input.source,
        requireMention: false,
      })
      // Never retain raw event bodies; the normalized text-only envelope is all
      // that crosses into the durable Channel core.
      const unsubscribe = channel.on('message', async message => {
        if (message.content.trim().length === 0) return
        await host.receive(inboundEnvelope(message, input.connection))
        await host.drainInbound(1)
      })
      await channel.connect()
      let stopped = false
      const interval = setInterval(() => {
        void host.drainOutbound(20).catch(() => undefined)
      }, 1_000)
      interval.unref()
      return {
        send: async (delivery: ChannelOutboundDelivery): Promise<ChannelSendResult> => {
          if (!sameTenant(delivery.target, input.connection.ref)) throw new FeishuAdapterError('OUTBOUND_UNAVAILABLE')
          const result = await channel.send(delivery.target.conversationId, { text: delivery.text }, {
            ...(delivery.target.semantics === 'reply-chain'
              ? { replyTo: delivery.target.threadId, replyInThread: true }
              : {}),
          })
          return {
            externalMessageId: result.messageId,
            ...(result.messageId.length > 0 ? { recallHandle: result.messageId } : {}),
          }
        },
        stop: async () => {
          if (stopped) return
          stopped = true
          clearInterval(interval)
          unsubscribe()
          await channel.disconnect()
        },
      }
    },
  }
}

/** Narrow adapter constructor used by the launcher; it intentionally never accepts a secret value. */
export function feishuDefinitionsForConfig(
  configuration: ChannelServiceConfigV1,
  input: {
    readonly source: string
    readonly configurationRevision: number
    readonly secretResolver?: LauncherSecretResolverOptions
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
        ...(input.secretResolver === undefined ? {} : {
          resolveSecret: async reference => await resolveLauncherSecret(reference, input.secretResolver),
        }),
      })
    )
}

export { LauncherSecretResolutionError }
