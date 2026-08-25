import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CHANNEL_SERVICE_CONFIG_SCHEMA_V1,
  CHANNEL_SERVICE_CONFIG_INITIAL,
  ChannelRuntime,
  LauncherChannelServiceHost,
  createChannelHostServiceConfigContract,
  parseChannelServiceConfig,
  type ActiveLauncherChannelService,
  type ChannelRuntimeSnapshot,
} from '@cordisx/channel-runtime'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager.js'

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
  dispose(): Promise<void>
}

function selectorLabel(value: { readonly useDefault: true } | { readonly id: string }): string {
  return 'id' in value ? value.id : 'default'
}

/** Build the only renderer-visible Channel state from redacted local service data. */
export function projectLocalChannelManager(input: {
  readonly configuration: unknown
  readonly revision: number
  readonly lastGoodRevision: number
  readonly writable: boolean
  readonly runtime?: ChannelRuntimeSnapshot
}): ChannelManagerProjectionV1 {
  const configuration = parseChannelServiceConfig(input.configuration)
  const runtimeAccounts = new Map((input.runtime?.accounts ?? []).map(account => [
    JSON.stringify([account.ref.adapterId, account.ref.accountId, account.ref.tenantId]), account,
  ]))
  const connections = configuration.connections.map(connection => ({
    ref: connection.ref,
    adapterKind: connection.adapterKind,
    enabled: connection.enabled,
    transportMode: connection.transport.mode,
    secretState: connection.adapterKind === 'simulator' ? 'unavailable' as const : 'missing' as const,
  }))
  const accounts = connections.map(connection => {
    const runtime = runtimeAccounts.get(JSON.stringify([
      connection.ref.adapterId, connection.ref.accountId, connection.ref.tenantId,
    ]))
    return {
      ...connection,
      implementationStatus: connection.adapterKind === 'simulator' ? 'verified' as const : 'unavailable' as const,
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
      configurationKind: 'host', configApplies: 'service-restart',
      revision: input.revision, lastGoodRevision: input.lastGoodRevision, writable: input.writable,
    },
    connections,
    routes: configuration.routes.map(route => ({
      id: route.id, connection: route.connection, enabled: route.enabled, workspaceAlias: route.task.workspaceAlias,
      provider: selectorLabel(route.task.provider), model: selectorLabel(route.task.model),
      profile: selectorLabel(route.task.profile), notifications: route.notifications,
    })),
    accounts,
    bindings: (input.runtime?.bindings ?? []).map(binding => ({
      bindingId: binding.bindingId,
      channel: binding.channel,
      session: binding.session,
      routeId: binding.routeId,
      state: binding.state,
    })),
    diagnostics: [{
      id: 'channel-simulator', status: 'verified',
      message: 'The local simulator is active. Official channel adapters are not connected.',
    }],
  }
}

function localGateway() {
  return {
    /** The simulator owns transport only; it must not manufacture a Codex task. */
    execute: async () => ({ data: { status: 'unavailable' as const } }),
  }
}

function localPermissions() {
  return {
    // Only the built-in simulator is granted its local registration seat.
    // Task execution is still unavailable through the local gateway above.
    authorize: async (request: { readonly source: { readonly adapterId: string } }) => (
      request.source.adapterId === 'simulator' ? 'allow' as const : 'deny' as const
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
}): LocalChannelService {
  const artifactDirectory = input.artifactDirectory
  let active: ActiveRuntime | undefined
  let sequence = 0

  const createActive = async (value: unknown): Promise<ActiveRuntime> => {
    const configuration = parseChannelServiceConfig(value)
    sequence += 1
    const generation = `channel-local-${Date.now()}-${sequence}-${randomBytes(4).toString('hex')}`
    await mkdir(input.dataDir, { recursive: true })
    const runtime = await ChannelRuntime.open({
      gateway: localGateway(),
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
      return {
        generation,
        runtime,
        host,
        service,
        dispose: async () => { await host.dispose() },
      }
    } catch (error) {
      await host.dispose().catch(() => undefined)
      throw error
    }
  }

  return {
    async start(configuration) {
      const next = await createActive(configuration)
      const prior = active
      active = next
      await prior?.dispose()
      return next.generation
    },
    async restart(configuration) {
      const next = await createActive(configuration)
      const prior = active
      active = next
      return {
        generation: next.generation,
        rollback: async () => {
          if (active !== next) return
          active = prior
          await next.dispose()
        },
        finalize: async () => { await prior?.dispose() },
      }
    },
    snapshot: () => active?.runtime.snapshot(),
    async dispose() {
      const prior = active
      active = undefined
      await prior?.dispose()
    },
  }
}
