import {
  Client,
  createLarkChannel,
  Domain,
  type LarkChannel,
  type LarkChannelOptions,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk'
import {
  type ChannelAdapterHandle,
  type ChannelMessageEvent,
  type ChannelPermissionRequest,
  ChannelRuntime,
} from '@cordisx/channel-runtime'
import { mkdir, readFile, rm } from 'node:fs/promises'
import type { Socket } from 'node:net'
import path from 'node:path'
import { validateOutboundMedia } from '../../../channel-runtime/src/outbound-media.js'
import { createFeishuAdapterDefinition } from '../launcher/feishu-adapter.js'
import { type ChannelCliScope, matchesChannelCliScope, requireCliValue } from './channel-cli-scope.js'
import { type ChannelCliRequest, type ChannelCliTransport, openChannelCliTransport } from './channel-cli-transport.js'

export interface CliSessionOptions {
  readonly directory: string
  readonly durationSeconds: number
  readonly scope: ChannelCliScope
  readonly secret: string
  readonly stdout: (line: string) => void
  readonly internalChannelFactory?: (options: LarkChannelOptions) => LarkChannel
  readonly internalClientFactory?: (options: ConstructorParameters<typeof Client>[0]) => Client
}

type SendReceipt = {
  readonly event: 'send-receipt'
  readonly operationId: string
  readonly deliveryId: string
  readonly externalMessageId: string
  readonly attempts: number
}
type SendState = { readonly operationId: string; readonly text: string; readonly promise: Promise<SendReceipt> }

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} }
const caller = { source: 'cordisx:channel-cli', pluginId: '@cordisx/channel-cli', generation: 'foreground' }

function sameAccount(scope: ChannelCliScope, request: ChannelPermissionRequest): boolean {
  const source = request.source
  return source.adapterId === scope.adapter && source.accountId === scope.account && source.tenantId === scope.tenant
    && (!('conversationId' in source) || source.conversationId === scope.conversation)
    && (!('actor' in source) || source.actor === undefined || source.actor.userId === scope.actor)
}

function write(socket: Socket, value: unknown, end = false): void {
  const line = `${JSON.stringify(value)}\n`
  if (end) socket.end(line)
  else socket.write(line)
}

function messageText(item: { body?: { content?: string | undefined } | undefined } | undefined): unknown {
  try {
    return JSON.parse(item?.body?.content ?? '{}').text
  } catch {
    return undefined
  }
}

/** Owns the adapter, store, scoped authority, API reader, and their shared lifetime. */
export async function serveChannelCli(options: CliSessionOptions): Promise<void> {
  const { scope, directory, stdout } = options
  if (!path.isAbsolute(directory) || Buffer.byteLength(path.join(directory, 'rpc.sock')) > 100) {
    throw new Error('invalid private directory')
  }
  await mkdir(directory, { mode: 0o700 })
  const storePath = path.join(directory, 'channel-store.json')
  const expiresAt = Date.now() + options.durationSeconds * 1000
  const account = { adapterId: scope.adapter, accountId: scope.account, tenantId: scope.tenant }
  let runtime: ChannelRuntime | undefined
  let handle: ChannelAdapterHandle | undefined
  let transport: ChannelCliTransport | undefined
  let sdk: LarkChannel | undefined
  let api: Client | undefined
  let unsubscribe: (() => void) | undefined
  let listener: Socket | undefined
  let listenSince = 0
  let claimedInbound = false
  let matched: ChannelMessageEvent | undefined
  let sendState: SendState | undefined
  let latestSend: SendReceipt | { readonly event: 'send-unknown'; readonly operationId: string } | undefined
  let sdkErrors = 0
  let primaryFailure: unknown
  let timer: NodeJS.Timeout | undefined
  let finishing = false
  let finish!: () => void
  const finished = new Promise<void>(resolve => {
    finish = resolve
  })
  const stop = (): void => {
    if (!finishing) {
      finishing = true
      finish()
    }
  }
  const signal = (): void => stop()
  process.once('SIGINT', signal)
  process.once('SIGTERM', signal)
  try {
    const permissions = {
      authorize: async (request: ChannelPermissionRequest) => (
        request.caller.source === caller.source && request.caller.pluginId === caller.pluginId
          && request.caller.generation === caller.generation && sameAccount(scope, request)
          && ['channel.accounts.connect', 'channel.events.receive', 'channel.events.subscribe', 'channel.messages.send']
            .includes(request.capability)
          ? 'allow' as const
          : 'deny' as const
      ),
    }
    runtime = await ChannelRuntime.open({ permissions, storePath, maxAttempts: 1 })
    let secret: string | undefined = options.secret
    const domain = scope.adapter === 'lark' ? Domain.Lark : Domain.Feishu
    const clientOptions = {
      appId: scope.account,
      appSecret: secret,
      domain,
      logger: silentLogger,
      loggerLevel: LoggerLevel.error,
    }
    api = options.internalClientFactory?.(clientOptions) ?? new Client(clientOptions)
    const definition = createFeishuAdapterDefinition({
      connection: {
        ref: account,
        adapterKind: scope.adapter,
        enabled: true,
        transport: { mode: 'websocket' },
        secretRef: 'host-secret:env/CORDISX_CHANNEL_CLI_STDIN',
      },
      configurationRevision: 1,
      source: caller.source,
      resolveSecret: async () => {
        if (secret === undefined) throw new Error('credential unavailable')
        return secret
      },
      acceptMessage: message => {
        if (listener === undefined || claimedInbound || !matchesChannelCliScope(scope, message, listenSince)) {
          return false
        }
        claimedInbound = true
        return true
      },
      createChannel: values => {
        const sdkOptions: LarkChannelOptions = {
          appId: values.appId,
          appSecret: values.appSecret,
          domain: values.domain,
          source: values.source,
          transport: 'websocket',
          includeRawEvent: true,
          logger: silentLogger,
          loggerLevel: LoggerLevel.error,
          policy: { dmMode: 'allowlist', dmAllowlist: [scope.actor], groupAllowlist: [], requireMention: false },
          outbound: { retry: { maxAttempts: 1 } },
          handshakeTimeoutMs: 12_000,
        }
        sdk = options.internalChannelFactory?.(sdkOptions) ?? createLarkChannel(sdkOptions)
        sdk.on('error', () => {
          sdkErrors += 1
        })
        return sdk
      },
    })
    handle = await runtime.activate(definition, caller)
    secret = undefined
    unsubscribe = await runtime.subscribe(
      caller,
      { account, conversationId: scope.conversation, userId: scope.actor },
      event => {
        if (matched !== undefined) return
        matched = event
        if (listener !== undefined) {
          write(listener, { event: 'message', input: event.input, delivery: event.delivery }, true)
          listener = undefined
        }
      },
    )

    const send = async (operationId: string, text: string): Promise<SendReceipt> => {
      if (matched === undefined || runtime === undefined || handle === undefined) throw new Error('no matched message')
      const target = matched.input.source.event
      const delivery = await runtime.notify({ target, kind: 'reply', text }, caller)
      await handle.drainOutbound(1)
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const store = JSON.parse(await readFile(storePath, 'utf8')) as {
          outbox: Record<string, { status: string; attempts: number; externalMessageId?: string }>
        }
        const result = store.outbox[delivery.deliveryId]
        if (result?.status === 'sent' && result.attempts === 1 && result.externalMessageId) {
          return {
            event: 'send-receipt',
            operationId,
            deliveryId: delivery.deliveryId,
            externalMessageId: result.externalMessageId,
            attempts: result.attempts,
          }
        }
        if (result?.status === 'dead-letter' || result?.status === 'cancelled') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('delivery outcome unknown')
    }
    const readback = async (): Promise<unknown> => {
      if (
        matched === undefined || latestSend?.event !== 'send-receipt' || sendState === undefined || api === undefined
      ) {
        throw new Error('readback unavailable')
      }
      const receipt = latestSend
      const incomingId = matched.input.source.event.messageId
      if (!incomingId) throw new Error('inbound id unavailable')
      const [inbound, outbound] = await Promise.all([
        api.im.v1.message.get({ path: { message_id: incomingId }, params: { user_id_type: 'open_id' } }),
        api.im.v1.message.get({ path: { message_id: receipt.externalMessageId }, params: { user_id_type: 'open_id' } }),
      ])
      const received = inbound.data?.items?.find(item => item.message_id === incomingId)
      const sent = outbound.data?.items?.find(item => item.message_id === receipt.externalMessageId)
      const inboundMatches = inbound.code === 0 && received?.chat_id === scope.conversation
        && received.sender?.id === scope.actor && received.sender.tenant_key === scope.tenant
        && messageText(received) === scope.match && received.deleted === false
      const outboundMatches = outbound.code === 0 && sent?.chat_id === scope.conversation
        && sent.sender?.id === scope.account && sent.sender.tenant_key === scope.tenant
        && messageText(sent) === sendState.text && sent.deleted === false
      return {
        event: 'readback',
        inboundMessageId: incomingId,
        outboundMessageId: receipt.externalMessageId,
        inboundMatches,
        outboundMatches,
        appId: scope.account,
        tenantId: scope.tenant,
        conversationId: scope.conversation,
        actorId: scope.actor,
        independentApi: true,
      }
    }
    const receive = (request: ChannelCliRequest, socket: Socket): void => {
      if (request.action === 'listen') {
        if (matched !== undefined) {
          return write(socket, { event: 'message', input: matched.input, delivery: matched.delivery }, true)
        }
        if (listener !== undefined || claimedInbound) {
          return write(socket, { event: 'error', code: 'listener-unavailable' }, true)
        }
        listener = socket
        listenSince = Date.now() - 1_000
        socket.once('close', () => {
          if (listener === socket) listener = undefined
        })
        return write(socket, { event: 'listening', expiresAt })
      }
      if (request.action === 'send') {
        if (request.media !== undefined) {
          try {
            validateOutboundMedia(request.media)
          } catch {
            return write(socket, { event: 'error', code: 'invalid-send' }, true)
          }
          return write(socket, { event: 'error', code: 'media-authority-unavailable' }, true)
        }
        let operationId: string
        let text: string
        try {
          operationId = requireCliValue(
            typeof request.operationId === 'string' ? request.operationId : undefined,
            'operation',
            128,
          )
          text = requireCliValue(typeof request.text === 'string' ? request.text : undefined, 'text', 8192)
        } catch {
          return write(socket, { event: 'error', code: 'invalid-send' }, true)
        }
        if (matched === undefined) return write(socket, { event: 'error', code: 'no-matched-message' }, true)
        if (sendState !== undefined && (sendState.operationId !== operationId || sendState.text !== text)) {
          return write(socket, { event: 'error', code: 'send-already-claimed' }, true)
        }
        if (sendState === undefined) {
          const promise = send(operationId, text)
          sendState = { operationId, text, promise }
          latestSend = { event: 'send-unknown', operationId }
          void promise.then(receipt => {
            latestSend = receipt
          }, () => undefined)
        }
        void sendState.promise.then(
          receipt => write(socket, receipt, true),
          () => write(socket, { event: 'error', code: 'send-outcome-unknown' }, true),
        )
        return
      }
      if (request.action === 'status') {
        return write(socket, {
          event: 'status',
          listening: listener !== undefined,
          matched: matched !== undefined,
          send: latestSend ?? null,
          sdkErrors,
          expiresAt,
        }, true)
      }
      if (request.action === 'readback') {
        void readback().then(
          value => write(socket, value, true),
          () => write(socket, { event: 'error', code: 'readback-unavailable' }, true),
        )
        return
      }
      if (request.action === 'stop') {
        write(socket, { event: 'stopped' }, true)
        socket.once('finish', stop)
        return
      }
      write(socket, { event: 'error', code: 'unknown-action' }, true)
    }
    transport = await openChannelCliTransport(directory, expiresAt, receive)
    timer = setTimeout(stop, Math.max(1, expiresAt - Date.now()))
    stdout(
      JSON.stringify({
        event: 'connection-ready',
        bindingPath: transport.bindingPath,
        account,
        conversationId: scope.conversation,
        actorId: scope.actor,
        botName: sdk?.botIdentity?.name,
        expiresAt,
      }),
    )
    await finished
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    process.off('SIGINT', signal)
    process.off('SIGTERM', signal)
    const failures: Array<{ stage: string; name: string; error: unknown }> = []
    const cleanup = async (stage: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run()
      } catch (error) {
        const name = (error instanceof Error ? error.name : 'Error').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80)
        failures.push({ stage, name, error })
      }
    }
    await cleanup('listener', () => {
      listener?.destroy()
    })
    await cleanup('subscription', () => unsubscribe?.())
    await cleanup('transport', async () => await transport?.close())
    await cleanup('runtime', async () => await runtime?.dispose())
    await cleanup('sdk-websocket', () => {
      sdk?.rawWsClient?.close({ force: true })
    })
    api = undefined
    await cleanup('private-directory', async () => await rm(directory, { recursive: true, force: true }))
    if (failures.length > 0) {
      stdout(
        JSON.stringify({ event: 'cleanup-failed', failures: failures.map(({ stage, name }) => ({ stage, name })) }),
      )
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...failures.map(failure => failure.error)],
        'channel cleanup failed',
      )
    }
    stdout(JSON.stringify({ event: 'cleanup-complete' }))
  }
}
