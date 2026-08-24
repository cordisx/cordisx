import { RetryableChannelError } from './runtime.js'
import {
  CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
  parseChannelServiceConfig,
  type ChannelServiceConfigV1,
  type ChannelServiceConfigurationDeclaration,
} from './config.js'
import type {
  ChannelAdapterDefinition,
  ChannelAdapterHost,
  ChannelCapability,
  ChannelClock,
  ChannelInboundEnvelope,
  ChannelOutboundDelivery,
  ChannelPermissionBroker,
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelSendResult,
  ChannelTaskContext,
  ChannelTaskGateway,
  ChannelTaskResult,
  ChannelTenantRef,
  PlatformSessionRef,
  ResolvedChannelTaskOperation,
} from './types.js'

export const SIMULATOR_ADAPTER_IDENTITY: ChannelPluginIdentity = Object.freeze({
  source: 'workspace:@cordisx/channel-runtime/simulator',
  pluginId: 'channel-simulator',
  generation: 'simulator-plugin-generation-1',
})

export const SIMULATOR_CONSUMER_IDENTITY: ChannelPluginIdentity = Object.freeze({
  source: 'workspace:@cordisx/channel-runtime/consumer-fixture',
  pluginId: 'channel-consumer-fixture',
  generation: 'consumer-plugin-generation-1',
})

export const SIMULATOR_CHANNEL_SERVICE_DECLARATION: ChannelServiceConfigurationDeclaration = Object.freeze({
  kind: 'host',
  schema: CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
  configApplies: 'restart',
})

/** Explicit no-config fixture for services that must not get a dummy form. */
export const STATIC_NOTIFIER_NO_CONFIG_DECLARATION: ChannelServiceConfigurationDeclaration = Object.freeze({
  kind: 'none',
})

/** Complete local-only configuration fixture; it needs no account or secret. */
export const SIMULATOR_CHANNEL_SERVICE_CONFIG: ChannelServiceConfigV1 = parseChannelServiceConfig({
  contract: 'cordisx.channel-service-config/v1',
  schemaVersion: 1,
  connections: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator',
    enabled: true,
    transport: { mode: 'simulator' },
  }],
  routes: [{
    id: 'default',
    connection: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    enabled: true,
    policy: {
      conversationKinds: ['direct', 'group'],
      allowedUserIds: ['alice'],
      groupTrigger: 'mention-or-command',
      commandPrefixes: ['/cordisx'],
    },
    task: {
      provider: { id: 'codex' },
      model: { useDefault: true },
      profile: { id: 'work' },
      workspaceAlias: 'cordisx',
    },
    notifications: ['completion', 'failure', 'approval-required'],
  }],
  reliability: {
    leaseMs: 30_000,
    retry: {
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      maxAgeMs: 86_400_000,
      jitterRatio: 0.2,
    },
    rateLimit: {
      perAccountPerMinute: 120,
      perUserPerMinute: 20,
      perConversationPerMinute: 60,
      maxConcurrent: 8,
      maxBacklog: 1_000,
    },
    attachments: {
      maxFiles: 4,
      maxBytesPerFile: 10_485_760,
      allowedMediaTypes: ['image/png', 'text/plain'],
    },
  },
})

export class ManualChannelClock implements ChannelClock {
  #time: number

  constructor(initial = '2026-08-24T00:00:00.000Z') {
    this.#time = Date.parse(initial)
  }

  now(): Date {
    return new Date(this.#time)
  }

  advance(milliseconds: number): void {
    if (milliseconds < 0) throw new RangeError('Manual Channel clock cannot move backwards')
    this.#time += milliseconds
  }
}

function permissionKey(identity: ChannelPluginIdentity, capability: ChannelCapability): string {
  return JSON.stringify([identity.source, identity.pluginId, identity.generation, capability])
}

export class SimulatedPermissionBroker implements ChannelPermissionBroker {
  readonly requests: ChannelPermissionRequest[] = []
  readonly #rules = new Map<string, ChannelPermissionDecision>()
  #fallback: ChannelPermissionDecision

  constructor(fallback: ChannelPermissionDecision = 'allow') {
    this.#fallback = fallback
  }

  setFallback(decision: ChannelPermissionDecision): void {
    this.#fallback = decision
  }

  set(
    identity: ChannelPluginIdentity,
    capability: ChannelCapability,
    decision: ChannelPermissionDecision,
  ): void {
    this.#rules.set(permissionKey(identity, capability), decision)
  }

  async authorize(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision> {
    this.requests.push(structuredClone(request))
    return this.#rules.get(permissionKey(request.caller, request.capability)) ?? this.#fallback
  }
}

export class SimulatedTaskGateway implements ChannelTaskGateway {
  readonly calls: Array<{ readonly operation: ResolvedChannelTaskOperation; readonly context: ChannelTaskContext }> = []
  readonly #results = new Map<string, ChannelTaskResult>()
  readonly #remainingFailures = new Map<ResolvedChannelTaskOperation['kind'], number>()
  #sessionSequence = 0

  failNext(kind: ResolvedChannelTaskOperation['kind'], count = 1): void {
    this.#remainingFailures.set(kind, count)
  }

  callCount(kind?: ResolvedChannelTaskOperation['kind']): number {
    return kind === undefined ? this.calls.length : this.calls.filter(call => call.operation.kind === kind).length
  }

  async execute(
    operation: ResolvedChannelTaskOperation,
    context: ChannelTaskContext,
  ): Promise<ChannelTaskResult> {
    const prior = this.#results.get(context.operationId)
    if (prior !== undefined) return structuredClone(prior)
    this.calls.push({ operation: structuredClone(operation), context: structuredClone(context) })
    const remaining = this.#remainingFailures.get(operation.kind) ?? 0
    if (remaining > 0) {
      this.#remainingFailures.set(operation.kind, remaining - 1)
      throw new RetryableChannelError('SIMULATED_GATEWAY_RETRY', 'Simulated gateway retry')
    }

    let result: ChannelTaskResult
    if (operation.kind === 'create') {
      this.#sessionSequence += 1
      const provider = operation.provider ?? { useDefault: true as const }
      const providerId = 'id' in provider
        ? provider.id
        : 'sim-provider'
      result = {
        session: { providerId, remoteSessionId: `sim-session-${this.#sessionSequence}` },
        data: { operation: 'create', workspaceAlias: operation.workspace.alias },
      }
    } else if (operation.kind === 'list') {
      result = { data: { operation: 'list', count: this.#sessionSequence } }
    } else {
      result = { session: operation.session, data: { operation: operation.kind } }
    }
    this.#results.set(context.operationId, structuredClone(result))
    return result
  }
}

export interface SimulatedChannelAdapterOptions {
  readonly ref?: ChannelTenantRef
  readonly configurationRevision?: number
  readonly sendFailures?: number
  readonly recallable?: boolean
  readonly failStart?: boolean
}

export class SimulatedChannelAdapter implements ChannelAdapterDefinition {
  readonly descriptor
  readonly sent: ChannelOutboundDelivery[] = []
  readonly stopReasons: Array<'replaced' | 'disposed' | 'failed'> = []
  readonly #sendResults = new Map<string, ChannelSendResult>()
  #host: ChannelAdapterHost | undefined
  #sendFailures: number
  readonly #recallable: boolean
  readonly #failStart: boolean

  constructor(options: SimulatedChannelAdapterOptions = {}) {
    this.descriptor = Object.freeze({
      ref: options.ref ?? { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
      kind: 'simulator' as const,
      implementationStatus: 'verified' as const,
      configurationRevision: options.configurationRevision ?? 1,
      secretState: 'unavailable' as const,
    })
    this.#sendFailures = options.sendFailures ?? 0
    this.#recallable = options.recallable ?? false
    this.#failStart = options.failStart ?? false
  }

  async start(host: ChannelAdapterHost) {
    if (this.#failStart) throw new Error('Simulated adapter start failure')
    this.#host = host
    return {
      send: async (delivery: ChannelOutboundDelivery): Promise<ChannelSendResult> => {
        const prior = this.#sendResults.get(delivery.deliveryId)
        if (prior !== undefined) return prior
        if (this.#sendFailures > 0) {
          this.#sendFailures -= 1
          throw new RetryableChannelError('SIMULATED_SEND_RETRY', 'Simulated send retry')
        }
        this.sent.push(structuredClone(delivery))
        const result: ChannelSendResult = {
          externalMessageId: `sim-message-${this.sent.length}`,
          ...(this.#recallable ? { recallHandle: `sim-recall-${this.sent.length}` } : {}),
        }
        this.#sendResults.set(delivery.deliveryId, result)
        return result
      },
      stop: async (reason: 'replaced' | 'disposed' | 'failed') => {
        this.stopReasons.push(reason)
        if (this.#host === host) this.#host = undefined
      },
    }
  }

  async emit(envelope: ChannelInboundEnvelope) {
    if (this.#host === undefined) throw new Error('Simulated adapter is not active')
    return await this.#host.receive(envelope)
  }
}

export function simulatedAdapterFromConfig(
  value: unknown,
  configurationRevision = 1,
): SimulatedChannelAdapter {
  const config = parseChannelServiceConfig(value)
  const connection = config.connections.find(item => item.enabled && item.adapterKind === 'simulator')
  if (connection === undefined) throw new Error('Channel simulator configuration has no enabled simulator connection')
  return new SimulatedChannelAdapter({ ref: connection.ref, configurationRevision })
}

export function simulatedInput(
  eventId: string,
  text: string,
  options: {
    readonly conversationId?: string
    readonly threadId?: string
    readonly userId?: string
    readonly receivedAt?: string
  } = {},
): ChannelInboundEnvelope['input'] {
  const conversationId = options.conversationId ?? 'direct-alice'
  return {
    contract: 'cordisx.channel-user-input/v1',
    schemaVersion: 1,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'channel',
      event: {
        adapterId: 'simulator',
        accountId: 'local',
        tenantId: 'test',
        conversationId,
        kind: 'direct',
        threadId: options.threadId ?? conversationId,
        semantics: 'conversation',
        eventId,
        messageId: `message-${eventId}`,
        actor: {
          adapterId: 'simulator',
          accountId: 'local',
          tenantId: 'test',
          userId: options.userId ?? 'alice',
        },
      },
    },
    receivedAt: options.receivedAt ?? '2026-08-24T00:00:00.000Z',
  }
}

export function sessionRef(providerId: string, remoteSessionId: string): PlatformSessionRef {
  return Object.freeze({ providerId, remoteSessionId })
}
