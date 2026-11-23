import { channelRemoteHistory } from './channel-remote-history.js'
import { channelMessageRead } from './channel-message-read.js'
import { ChannelMessageOperationLedger } from './channel-message-operation-ledger.js'
import { channelMessageOperationsRpc } from './channel-message-operations-rpc.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type ActiveLauncherChannelService,
  CHANNEL_SERVICE_CONFIG_INITIAL,
  CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
  ChannelRuntime,
  type ChannelRuntimeSnapshot,
  channelServiceInputV1,
  type ChannelTenantRef,
  type ChannelUserInput,
  createChannelHostServiceConfigContract,
  LauncherChannelServiceHost,
  parseChannelServiceConfig,
} from '@cordisx/channel-runtime'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager.js'
import {
  type ChannelManagerActionStatus,
  type ChannelManagerApi,
  createChannelManagerApi,
} from './channel-manager-api.js'
import { feishuDefinitionsForConfig } from './feishu-adapter.js'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'
import { createChannelForwardService } from './channel-forward-service.js'
import { channelOutboundRuntimeOptions } from './channel-outbound-runtime-options.js'
import { type ChannelAccountIdentity, ChannelAccountIdentityStore } from './channel-account-identity.js'
import { ChannelLiveDirectory } from './channel-live-directory.js'
import { ChannelConversationDisplayStore } from './channel-conversation-display-store.js'
import type { ChannelCommandAddressing } from './channel-command-users.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { HostServiceCapabilityOwner } from '../service-capability-ownership.js'
import { bindDiagnosticContext } from '../diagnostics/context.js'
import { updateFeishuCard } from './feishu-card-update.js'
import { channelFeedbackSdk } from './channel-feedback-sdk.js'

export { CHANNEL_SERVICE_CONFIG_INITIAL, createChannelHostServiceConfigContract }

interface ActiveRuntime {
  readonly forward: ReturnType<typeof createChannelForwardService>
  readonly outbound: ChannelOutboundRpc
  readonly messageOperations: ChannelMessageOperationLedger
  generation: string
  readonly runtime: ChannelRuntime
  readonly host: LauncherChannelServiceHost
  service: ActiveLauncherChannelService
  readonly identities: ChannelAccountIdentityStore
  readonly directory: ChannelLiveDirectory
  dispose(): Promise<void>
}

export interface LocalChannelService {
  managementOwner(): HostServiceCapabilityOwner | undefined
  generation(): string | undefined
  start(configuration: unknown): Promise<string>
  restart(configuration: unknown, expectedGeneration?: string): Promise<{
    readonly generation: string
    rollback(): Promise<void>
    finalize(): Promise<void>
  }>
  snapshot(): ChannelRuntimeSnapshot | undefined
  identity(ref: ChannelRuntimeSnapshot['accounts'][number]['ref']): ChannelAccountIdentity | undefined
  auditSnapshot(): ReturnType<ChannelRuntime['auditSnapshot']>
  /** Launcher-private runtime controls; never bind this object into renderer code. */
  readonly manager: ChannelManagerApi
  conversationAccess(): ChannelConversationAccess | undefined
  observeInputs(
    listener: (
      recordId: string,
      input: ChannelUserInput,
      mentionedBot: boolean,
      persisted: boolean,
      addressing?: ChannelCommandAddressing,
    ) => Promise<void>,
  ): () => void
  setConversationManager(value: {
    bindings(): readonly import('./channel-manager-api.js').ChannelManagerBindingProjection[]
    binding(action: 'archive' | 'restore' | 'unbind', id: string): Promise<boolean>
  }): void
  observeCardActions(
    listener: (ref: ChannelTenantRef, event: import('@larksuiteoapi/node-sdk').CardActionEvent) => Promise<void>,
  ): () => void
  setPairingHandler(
    handler:
      | ((
        ref: ChannelTenantRef,
        generation: string,
        message: import('@larksuiteoapi/node-sdk').NormalizedMessage,
      ) => Promise<{ accepted: boolean; reply: boolean }>)
      | undefined,
  ): void
  dispose(): Promise<void>
}

/** Build the only renderer-visible Channel state from redacted local service data. */
export function projectLocalChannelManager(input: {
  readonly configuration: unknown
  readonly revision: number
  readonly lastGoodRevision: number
  readonly writable: boolean
  readonly runtime?: ChannelRuntimeSnapshot
  readonly audit?: ReturnType<ChannelRuntime['auditSnapshot']>
  readonly identity?: (ref: ChannelRuntimeSnapshot['accounts'][number]['ref']) => ChannelAccountIdentity | undefined
}): ChannelManagerProjectionV1 {
  const configuration = parseChannelServiceConfig(input.configuration)
  const runtimeAccounts = new Map((input.runtime?.accounts ?? []).map(account => [
    JSON.stringify([account.ref.adapterId, account.ref.accountId, account.ref.tenantId]),
    account,
  ]))
  const refForAccountKey = new Map(configuration.connections.map(connection => [
    JSON.stringify([connection.ref.adapterId, connection.ref.accountId, connection.ref.tenantId]),
    connection.ref,
  ]))
  const connections: ChannelManagerProjectionV1['connections'][number][] = configuration.connections.map(connection => {
    const runtime = runtimeAccounts.get(JSON.stringify([
      connection.ref.adapterId,
      connection.ref.accountId,
      connection.ref.tenantId,
    ]))
    return {
      ref: connection.ref,
      ...('displayName' in connection && connection.displayName !== undefined
        ? { displayName: connection.displayName }
        : {}),
      adapterKind: connection.adapterKind,
      enabled: connection.enabled,
      transportMode: connection.transport.mode,
      secretState: runtime?.secretState
        ?? (connection.adapterKind === 'simulator' ? 'unavailable' as const : 'missing' as const),
    }
  })
  if (configuration.schemaVersion === 3) {
    connections.push(...configuration.pendingConnections.map(connection => ({
      ref: { ...connection.account, tenantId: '' },
      pendingTenant: true as const,
      displayName: connection.displayName,
      adapterKind: connection.adapterKind,
      enabled: false,
      transportMode: 'websocket',
      secretState: 'unavailable' as const,
    })))
  }
  const accounts = connections.map(connection => {
    const runtime = runtimeAccounts.get(JSON.stringify([
      connection.ref.adapterId,
      connection.ref.accountId,
      connection.ref.tenantId,
    ]))
    return {
      ...connection,
      ...input.identity?.(connection.ref),
      implementationStatus: runtime?.implementationStatus
        ?? (connection.adapterKind === 'simulator' ? 'verified' as const : 'implemented' as const),
      connectionState: runtime?.connectionState ?? (connection.pendingTenant
        ? 'unavailable' as const
        : connection.enabled
        ? 'starting' as const
        : 'disabled' as const),
      generation: runtime?.generation ?? 0,
      inbound: runtime?.inbound ?? { pending: 0, retrying: 0, deadLetter: 0 },
      outbound: runtime?.outbound ?? { pending: 0, retrying: 0, deadLetter: 0 },
    }
  })
  return {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: 'experimental',
    service: {
      configurationKind: 'host',
      configApplies: 'service-restart',
      revision: input.revision,
      lastGoodRevision: input.lastGoodRevision,
      writable: input.writable,
    },
    connections,
    routes: [],
    accounts,
    bindings: [],
    logs: (input.audit ?? []).flatMap(entry => {
      const account = refForAccountKey.get(entry.accountKey)
      return account === undefined
        ? []
        : [{ id: entry.auditId, account, recordedAt: entry.recordedAt, action: entry.action, outcome: entry.outcome }]
    }),
    diagnostics: configuration.connections
      .filter(connection => connection.adapterKind === 'simulator')
      .map(() => ({ id: 'channel-simulator', status: 'verified' as const, message: 'The local simulator is active.' })),
  }
}

function localPermissions() {
  return {
    // Only the external simulator and Host-owned official adapters receive a local registration seat.
    authorize: async (request: { readonly source: { readonly adapterId: string } }) => (
      ['simulator', 'feishu', 'lark'].includes(request.source.adapterId) ? 'allow' as const : 'deny' as const
    ),
  }
}

/**
 * Starts the external Channel package's simulator service beside the Host-owned
 * official adapters. The package receives neither credentials nor a secret resolver.
 */
export function createLocalChannelService(input: {
  readonly artifactDirectory: string
  /** Immutable package services use their stored module; direct source entries retain service.mjs. */
  readonly runtimeEntry?: './services/runtime.mjs'
  readonly dataDir: string
  readonly source: string
  /** Effective launcher environment; never project it or any resolved secret. */
  readonly environment?: NodeJS.ProcessEnv
  readonly homeDir?: string
}): LocalChannelService {
  const artifactDirectory = input.artifactDirectory
  const runtimeEntry = input.runtimeEntry ?? './service.mjs'
  const updateCard = bindDiagnosticContext(updateFeishuCard)
  let active: ActiveRuntime | undefined
  let managementOwner: HostServiceCapabilityOwner | undefined
  let activeConfiguration: ReturnType<typeof parseChannelServiceConfig> | undefined
  let sequence = 0
  let disposed = false
  let mutationTail: Promise<unknown> = Promise.resolve()
  let pendingConfiguration: string | undefined
  let conversationManager: Parameters<LocalChannelService['setConversationManager']>[0] | undefined
  let pairingHandler: Parameters<LocalChannelService['setPairingHandler']>[0] | undefined
  const listeners = new Set<
    (
      recordId: string,
      input: ChannelUserInput,
      mentionedBot: boolean,
      persisted: boolean,
      addressing?: ChannelCommandAddressing,
    ) => Promise<void>
  >()
  const cardListeners = new Set<
    (ref: ChannelTenantRef, event: import('@larksuiteoapi/node-sdk').CardActionEvent) => Promise<void>
  >()
  const key = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
  const feedbackAccess = new WeakMap<ActiveRuntime, ReturnType<typeof channelFeedbackSdk>>()
  const caller = (generation: string) => ({ source: input.source, pluginId: 'channel', generation })
  const definitions = (configuration: ReturnType<typeof parseChannelServiceConfig>, current: ActiveRuntime) =>
    feishuDefinitionsForConfig(configuration, {
      outboundMediaAuthority: current.outbound.authority,
      source: input.source,
      configurationRevision: sequence,
      identities: current.identities,
      channelConnected: (ref, channel) => current.directory.connected(ref, channel),
      onPairingInput: async (ref, message) => {
        const generation = current.generation
        const result = await pairingHandler?.(ref, generation, message)
        return !disposed && active === current && current.generation === generation
          ? result ?? { accepted: false, reply: false }
          : { accepted: false, reply: false }
      },
      onCardAction: async (ref, event) => {
        for (const listener of cardListeners) await listener(ref, event)
      },
      onNormalizedInput: async (recordId, message, mentionedBot, persisted, addressing) => {
        if (persisted) current.directory.observe(message, addressing)
        await Promise.all(
          [...listeners].map(listener => listener(recordId, message, mentionedBot, persisted, addressing)),
        )
      },
      readConnection: ref => activeConfiguration?.connections.find(connection => key(connection.ref) === key(ref)),
      secretResolver: {
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
      },
    })
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = mutationTail.then(operation)
    mutationTail = task.catch(() => undefined)
    return task
  }

  const simulatorConfiguration = (configuration: ReturnType<typeof parseChannelServiceConfig>) =>
    channelServiceInputV1({
      ...configuration,
      connections: configuration.connections.filter(connection => connection.adapterKind === 'simulator'),
    })

  const createActive = async (value: unknown): Promise<ActiveRuntime> => {
    const configuration = parseChannelServiceConfig(value)
    sequence += 1
    const generation = `channel-local-${Date.now()}-${sequence}-${randomBytes(4).toString('hex')}`
    await mkdir(input.dataDir, { recursive: true })
    const outbound = new ChannelOutboundRpc()
    const messageOperations = await ChannelMessageOperationLedger.open(
      path.join(input.dataDir, 'message-operations.json'),
    )
    try {
      const runtime: ChannelRuntime = await ChannelRuntime.open({
        ...channelOutboundRuntimeOptions(
          outbound,
          async (target, caller) => (await runtime.outboundCapabilities(target, caller)).maxMediaBytes,
        ),
        permissions: localPermissions(),
        // One profile-owned transport ledger survives service replacement and launcher restart.
        storePath: path.join(input.dataDir, 'transport.json'),
      })
      const host = new LauncherChannelServiceHost(runtime)
      const identities = new ChannelAccountIdentityStore()
      const display = await ChannelConversationDisplayStore.open(path.join(input.dataDir, 'conversation-display.json'))
      display.retainAccounts(configuration.connections.map(connection => connection.ref))
      const senders = await ChannelConversationDisplayStore.open(path.join(input.dataDir, 'sender-display.json'))
      senders.retainAccounts(configuration.connections.map(connection => connection.ref))
      const directory = new ChannelLiveDirectory(display, senders)
      sequence = Math.max(sequence, ...runtime.snapshot().accounts.map(account => account.lastGoodRevision + 1))
      try {
        const serviceSource = path.resolve(artifactDirectory, runtimeEntry)
        const integrity = `sha256:${createHash('sha256').update(await readFile(serviceSource)).digest('hex')}` as const
        const service = await host.activate({
          packageIdentity: { pluginId: 'channel', version: 'development', integrity },
          pluginIdentity: { source: input.source, pluginId: 'channel', generation },
          serviceId: 'runtime',
          serviceKind: 'channel-adapter',
          configuration: { kind: 'host', schema: CHANNEL_SERVICE_CONFIG_SCHEMA_V1, configApplies: 'restart' },
          configurationRevision: sequence,
          artifactDirectory,
          runtimeEntry,
        }, simulatorConfiguration(configuration))
        // The official adapter is deliberately launcher-owned: it gets an
        // opaque secret reference only, resolves it privately, and publishes
        // only the redacted runtime snapshot. A bad/missing credential leaves
        // that account unavailable without preventing the rest of CordisX from
        // starting.
        const current: ActiveRuntime = {
          forward: createChannelForwardService({
            filename: path.join(input.dataDir, 'forward.json'),
            channel: request => directory.channel(request.source),
            active: () => !disposed && active === current,
            supported: request =>
              configuration.connections.some(connection =>
                ['feishu', 'lark'].includes(connection.adapterKind) && key(connection.ref) === key(request.source)
              ),
          }),
          outbound,
          messageOperations,
          generation,
          runtime,
          host,
          service,
          identities,
          directory,
          dispose: async () => {
            outbound.dispose()
            directory.clear()
            await display.close()
            await senders.close()
            await identities.dispose()
            await host.dispose()
          },
        }
        for (const definition of definitions(configuration, current)) {
          await runtime.activate(definition, { source: input.source, pluginId: 'channel', generation }).catch(() =>
            undefined
          )
        }
        let cursor = 'channel-input:0:empty'
        for (;;) {
          if (!configuration.connections.length) break
          const readback = await runtime.inputsSince(
            caller(generation),
            configuration.connections.map(connection => ({ account: connection.ref })),
            cursor,
            100,
          )
          for (const record of readback.messages) directory.observe(record.input)
          if (readback.cursor === cursor || !readback.messages.length) break
          cursor = readback.cursor
        }
        return current
      } catch (error) {
        outbound.dispose()
        directory.clear()
        await display.close()
        await senders.close()
        await identities.dispose()
        await host.dispose().catch(() => undefined)
        throw error
      }
    } catch (error) {
      outbound.dispose()
      throw error
    }
  }

  const fingerprint = (connection: ReturnType<typeof parseChannelServiceConfig>['connections'][number] | undefined) =>
    connection === undefined
      ? ''
      : JSON.stringify([
        connection.ref,
        connection.adapterKind,
        connection.enabled,
        connection.transport,
        connection.secretRef,
      ])
  const applyConfiguration = async (configuration: ReturnType<typeof parseChannelServiceConfig>, forceKey?: string) => {
    const current = active
    const priorConfiguration = activeConfiguration
    if (!current || !priorConfiguration || disposed) throw new Error('CHANNEL_UNAVAILABLE')
    if (pendingConfiguration !== undefined) throw new Error('CHANNEL_CONFIGURATION_PENDING')
    const transaction = randomBytes(24).toString('hex')
    pendingConfiguration = transaction
    const prior = new Map(priorConfiguration.connections.map(connection => [key(connection.ref), connection]))
    const next = new Map(configuration.connections.map(connection => [key(connection.ref), connection]))
    const changed = [...new Set([...prior.keys(), ...next.keys()])].filter(id =>
      id === forceKey || fingerprint(prior.get(id)) !== fingerprint(next.get(id))
    )
    const officialChanged = changed.filter(id => (next.get(id) ?? prior.get(id))?.adapterKind !== 'simulator')
    const simulatorChanged = changed.some(id => (next.get(id) ?? prior.get(id))?.adapterKind === 'simulator')
    const install = async (value: ReturnType<typeof parseChannelServiceConfig>) => {
      sequence += 1
      for (const id of officialChanged) {
        const existing = prior.get(id) ?? next.get(id)
        if (existing) await current.runtime.deactivate(existing.ref)
        const definition = definitions(value, current).find(definition => key(definition.descriptor.ref) === id)
        if (definition) await current.runtime.activate(definition, caller(current.generation))
      }
      if (simulatorChanged) {
        await current.service.dispose()
        const serviceSource = path.resolve(artifactDirectory, runtimeEntry)
        const integrity = `sha256:${createHash('sha256').update(await readFile(serviceSource)).digest('hex')}` as const
        current.service = await current.host.activate({
          packageIdentity: { pluginId: 'channel', version: 'development', integrity },
          pluginIdentity: caller(current.generation),
          serviceId: 'runtime',
          serviceKind: 'channel-adapter',
          configuration: { kind: 'host', schema: CHANNEL_SERVICE_CONFIG_SCHEMA_V1, configApplies: 'restart' },
          configurationRevision: sequence,
          artifactDirectory,
          runtimeEntry,
        }, simulatorConfiguration(value))
      }
      activeConfiguration = value
      current.directory.retainAccounts(value.connections.map(connection => connection.ref))
      current.generation = `channel-local-${Date.now()}-${sequence}-${randomBytes(4).toString('hex')}`
    }
    try {
      await install(configuration)
    } catch (error) {
      try {
        await install(priorConfiguration)
      } catch {
        throw new Error('CHANNEL_ROLLBACK_FAILED')
      } finally {
        pendingConfiguration = undefined
      }
      throw error
    }
    let settled = false
    return {
      generation: current.generation,
      rollback: () =>
        serial(async () => {
          if (settled || pendingConfiguration !== transaction) return
          try {
            await install(priorConfiguration)
          } finally {
            settled = true
            pendingConfiguration = undefined
          }
        }),
      finalize: () =>
        serial(async () => {
          if (pendingConfiguration === transaction) pendingConfiguration = undefined
          settled = true
        }),
    }
  }

  const replaceActive = async (
    configuration: ReturnType<typeof parseChannelServiceConfig>,
    expectedGeneration: string,
  ): Promise<ChannelManagerActionStatus> => {
    const prior = active
    if (prior === undefined || prior.generation !== expectedGeneration) return 'unavailable'
    const result = await serial(async () => {
      if (active?.generation !== expectedGeneration) return undefined
      return applyConfiguration(configuration)
    })
    if (!result) return 'unavailable'
    await result.finalize()
    return 'applied'
  }

  const manager = createChannelManagerApi({
    active: () =>
      active === undefined || disposed ? undefined : { generation: active.generation, runtime: active.runtime },
    identity: ref => active?.identities.snapshot(ref),
    bindings: () => conversationManager?.bindings() ?? [],
    binding: (action, id) => conversationManager?.binding(action, id) ?? Promise.resolve(false),
    connection: async (action, ref, expectedGeneration) => {
      const configuration = activeConfiguration
      if (configuration === undefined) return 'unavailable'
      const index = configuration.connections.findIndex(connection => (
        connection.ref.adapterId === ref.adapterId
        && connection.ref.accountId === ref.accountId
        && connection.ref.tenantId === ref.tenantId
      ))
      if (index < 0) return 'not-found'
      const next = action === 'reconnect' ? configuration : {
        ...configuration,
        connections: configuration.connections.map((connection, candidate) => (
          candidate === index ? { ...connection, enabled: action === 'enable' } : connection
        )),
      }
      if (action === 'reconnect') {
        const result = await serial(async () => {
          if (active?.generation !== expectedGeneration) return undefined
          return applyConfiguration(configuration, key(ref))
        })
        if (!result) return 'unavailable'
        await result.finalize()
        return 'applied'
      }
      return await replaceActive(parseChannelServiceConfig(next), expectedGeneration)
    },
  })

  return {
    async start(configuration) {
      return serial(async () => {
        if (disposed) throw new Error('CHANNEL_UNAVAILABLE')
        if (active !== undefined) throw new Error('CHANNEL_ALREADY_STARTED')
        const nextConfiguration = parseChannelServiceConfig(configuration)
        const next = await createActive(nextConfiguration)
        if (disposed) {
          await next.dispose()
          throw new Error('CHANNEL_UNAVAILABLE')
        }
        active = next
        activeConfiguration = nextConfiguration
        managementOwner = Object.freeze({
          source: next.service.identity.source,
          pluginId: next.service.identity.pluginId,
          serviceId: next.service.serviceId,
          serviceKind: 'channel-adapter',
          serviceGeneration: next.service.identity.generation,
          capabilities: Object.freeze([
            'channel.accounts.read',
            'channel.accounts.connect',
            'channel.bindings.read',
            'channel.bindings.write',
            'channel.events.subscribe',
          ].map(name => Object.freeze({ name, scope: Object.freeze({}) }))) as HostServiceCapabilityOwner[
            'capabilities'
          ],
        })
        return next.generation
      })
    },
    async restart(configuration, expectedGeneration) {
      return serial(() => {
        if (expectedGeneration !== undefined && active?.generation !== expectedGeneration) {
          throw new Error('service configuration generation is stale')
        }
        return applyConfiguration(parseChannelServiceConfig(configuration))
      })
    },
    generation: () => disposed ? undefined : active?.generation,
    managementOwner: () => disposed ? undefined : managementOwner,
    snapshot: () => active?.runtime.snapshot(),
    identity: ref => active?.identities.snapshot(ref),
    auditSnapshot: () => active?.runtime.auditSnapshot() ?? [],
    manager,
    conversationAccess: () => {
      const current = active, configuration = activeConfiguration
      if (!current || disposed) return undefined
      let feedback = feedbackAccess.get(current)
      if (!feedback) {
        feedback = channelFeedbackSdk(event => current.directory.channel(event), () => !disposed && active === current)
        feedbackAccess.set(current, feedback)
      }
      return {
        generation: current.generation,
        runtime: current.runtime,
        outbound: current.outbound,
        forward: current.forward,
        messageOperations: (operation, request, context) =>
          channelMessageOperationsRpc(operation, request, {
            ...context,
            ledger: current.messageOperations,
            channel: event => current.directory.channel(event),
            active: () => active === current && !disposed,
            ownsPlainCard: (event, messageId) => current.runtime.ownsPlainCard(event, messageId),
          }),
        ...feedback,
        accounts: () =>
          (configuration?.connections ?? []).map(connection => ({
            ref: connection.ref,
            name: 'displayName' in connection && typeof connection.displayName === 'string'
              ? connection.displayName
              : connection.ref.accountId,
            state: current.runtime.snapshot().accounts.find(account => key(account.ref) === key(connection.ref))
              ?.connectionState ?? 'disabled',
          })),
        conversations: ref => current.directory.conversations(ref),
        remoteHistory: (ref, request) => channelRemoteHistory(ref, request, current.directory.channel(ref)),
        readMessage: async (event, messageId) => {
          const channel = current.directory.channel(event)
          const result = await channelMessageRead(event, messageId, channel)
          return current.directory.channel(event) === channel
            ? result
            : { status: 'unavailable', code: 'CHANNEL_MESSAGE_UNAVAILABLE' }
        },
        displayConversations: ref => current.directory.displayConversations(ref),
        conversationDisplay: ref => current.directory.conversationDisplay(ref),
        users: event => current.directory.users(event),
        senderName: event => current.directory.senderName(event),
        messageContext: (message, addressing) => current.directory.messageContext(message, addressing),
        name: event => current.directory.name(event),
        conversationIdentity: event => current.directory.conversationIdentity(event),
        replyCapabilities: event => current.directory.replyCapabilities(event),
        sendCard: async (event, card) => {
          const channel = current.directory.channel(event)
          if (!channel) throw new Error('CHANNEL_CARD_UNAVAILABLE')
          return (await channel.send(event.conversationId, { card })).messageId
        },
        updateCard: async (event, messageId, card) => {
          const channel = current.directory.channel(event)
          if (!channel) throw new Error('CHANNEL_CARD_UNAVAILABLE')
          await updateCard(channel, event.accountId, messageId, card)
        },
        drain: async ref => {
          await current.runtime.drainOutbound(ref, 100)
        },
      }
    },
    observeInputs: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setPairingHandler: handler => {
      pairingHandler = handler
    },
    observeCardActions: listener => {
      cardListeners.add(listener)
      return () => cardListeners.delete(listener)
    },
    setConversationManager: value => {
      conversationManager = value
    },
    async dispose() {
      cardListeners.clear()
      disposed = true
      listeners.clear()
      await mutationTail
      const prior = active
      active = undefined
      activeConfiguration = undefined
      await prior?.dispose()
    },
  }
}
