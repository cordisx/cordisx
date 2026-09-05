import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ActiveLauncherChannelService,
  CHANNEL_SERVICE_CONFIG_INITIAL,
  CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
  ChannelRuntime,
  type ChannelRuntimeSnapshot,
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

export { CHANNEL_SERVICE_CONFIG_INITIAL, createChannelHostServiceConfigContract }

interface ActiveRuntime {
  readonly generation: string
  readonly runtime: ChannelRuntime
  readonly host: LauncherChannelServiceHost
  readonly service: ActiveLauncherChannelService
  dispose(): Promise<void>
}

export interface LocalChannelService {
  start(configuration: unknown): Promise<string>
  restart(configuration: unknown): Promise<{
    readonly generation: string
    rollback(): Promise<void>
    finalize(): Promise<void>
  }>
  snapshot(): ChannelRuntimeSnapshot | undefined
  auditSnapshot(): ReturnType<ChannelRuntime['auditSnapshot']>
  /** Launcher-private runtime controls; never bind this object into renderer code. */
  readonly manager: ChannelManagerApi
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
  const connections = configuration.connections.map(connection => {
    const runtime = runtimeAccounts.get(JSON.stringify([
      connection.ref.adapterId,
      connection.ref.accountId,
      connection.ref.tenantId,
    ]))
    return {
      ref: connection.ref,
      adapterKind: connection.adapterKind,
      enabled: connection.enabled,
      transportMode: connection.transport.mode,
      secretState: runtime?.secretState
        ?? (connection.adapterKind === 'simulator' ? 'unavailable' as const : 'missing' as const),
    }
  })
  const accounts = connections.map(connection => {
    const runtime = runtimeAccounts.get(JSON.stringify([
      connection.ref.adapterId,
      connection.ref.accountId,
      connection.ref.tenantId,
    ]))
    return {
      ...connection,
      implementationStatus: runtime?.implementationStatus
        ?? (connection.adapterKind === 'simulator' ? 'verified' as const : 'implemented' as const),
      connectionState: runtime?.connectionState ?? (connection.enabled ? 'starting' as const : 'disabled' as const),
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
    // Only built-in connection adapters are granted their local registration seat.
    authorize: async (request: { readonly source: { readonly adapterId: string } }) => (
      ['simulator', 'feishu', 'lark'].includes(request.source.adapterId) ? 'allow' as const : 'deny' as const
    ),
  }
}

/**
 * Starts the built-in Channel simulator as a Node-owned service.  It is
 * intentionally not an official adapter: Feishu/Lark/WeCom configurations
 * fail closed in service.mjs before any credentials or network are touched.
 */
export function createLocalChannelService(input: {
  readonly artifactDirectory: string
  readonly dataDir: string
  readonly source: string
  /** Effective launcher environment; never project it or any resolved secret. */
  readonly environment?: NodeJS.ProcessEnv
}): LocalChannelService {
  const artifactDirectory = input.artifactDirectory
  let active: ActiveRuntime | undefined
  let activeConfiguration: ReturnType<typeof parseChannelServiceConfig> | undefined
  let sequence = 0

  const createActive = async (value: unknown): Promise<ActiveRuntime> => {
    const configuration = parseChannelServiceConfig(value)
    sequence += 1
    const generation = `channel-local-${Date.now()}-${sequence}-${randomBytes(4).toString('hex')}`
    await mkdir(input.dataDir, { recursive: true })
    const runtime = await ChannelRuntime.open({
      permissions: localPermissions(),
      storePath: path.join(input.dataDir, `${generation}.json`),
    })
    const host = new LauncherChannelServiceHost(runtime)
    try {
      const serviceSource = path.join(artifactDirectory, 'service.mjs')
      const integrity = `sha256:${createHash('sha256').update(await readFile(serviceSource)).digest('hex')}` as const
      const service = await host.activate({
        packageIdentity: { pluginId: 'channel', version: 'development', integrity },
        pluginIdentity: { source: input.source, pluginId: 'channel', generation },
        serviceId: 'runtime',
        serviceKind: 'channel-adapter',
        configuration: { kind: 'host', schema: CHANNEL_SERVICE_CONFIG_SCHEMA_V1, configApplies: 'restart' },
        artifactDirectory,
        runtimeEntry: './service.mjs',
      }, configuration)
      // The official adapter is deliberately launcher-owned: it gets an
      // opaque secret reference only, resolves it privately, and publishes
      // only the redacted runtime snapshot. A bad/missing credential leaves
      // that account unavailable without preventing the rest of CordisX from
      // starting.
      for (
        const definition of feishuDefinitionsForConfig(configuration, {
          source: input.source,
          configurationRevision: sequence,
          ...(input.environment === undefined ? {} : { secretResolver: { environment: input.environment } }),
        })
      ) {
        await runtime.activate(definition, { source: input.source, pluginId: 'channel', generation }).catch(() =>
          undefined
        )
      }
      return {
        generation,
        runtime,
        host,
        service,
        dispose: async () => {
          await host.dispose()
        },
      }
    } catch (error) {
      await host.dispose().catch(() => undefined)
      throw error
    }
  }

  const replaceActive = async (
    configuration: ReturnType<typeof parseChannelServiceConfig>,
    expectedGeneration: string,
  ): Promise<ChannelManagerActionStatus> => {
    const prior = active
    if (prior === undefined || prior.generation !== expectedGeneration) return 'unavailable'
    const next = await createActive(configuration)
    if (active !== prior) {
      await next.dispose().catch(() => undefined)
      return 'unavailable'
    }
    active = next
    activeConfiguration = configuration
    await prior.dispose()
    return 'applied'
  }

  const manager = createChannelManagerApi({
    active: () => active === undefined ? undefined : { generation: active.generation, runtime: active.runtime },
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
      return await replaceActive(parseChannelServiceConfig(next), expectedGeneration)
    },
  })

  return {
    async start(configuration) {
      const nextConfiguration = parseChannelServiceConfig(configuration)
      const next = await createActive(nextConfiguration)
      const prior = active
      active = next
      activeConfiguration = nextConfiguration
      await prior?.dispose()
      return next.generation
    },
    async restart(configuration) {
      const nextConfiguration = parseChannelServiceConfig(configuration)
      const next = await createActive(nextConfiguration)
      const prior = active
      const priorConfiguration = activeConfiguration
      active = next
      activeConfiguration = nextConfiguration
      return {
        generation: next.generation,
        rollback: async () => {
          if (active !== next) return
          active = prior
          activeConfiguration = priorConfiguration
          await next.dispose()
        },
        finalize: async () => {
          await prior?.dispose()
        },
      }
    },
    snapshot: () => active?.runtime.snapshot(),
    auditSnapshot: () => active?.runtime.auditSnapshot() ?? [],
    manager,
    async dispose() {
      const prior = active
      active = undefined
      activeConfiguration = undefined
      await prior?.dispose()
    },
  }
}
