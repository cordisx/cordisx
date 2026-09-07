import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  PlatformProviderAdapterV1,
  PlatformProviderDefinitionV1,
  PlatformProviderOwnerV1,
  PlatformProviderRegistrationProjectionV1,
  PlatformProviderServiceApplyV1,
} from '@cordisx/protocol/platform-provider/v1'
import type { ProviderConnection } from '../providers/contracts.js'
import { ProviderFleet } from '../providers/fleet.js'
import type { PlatformProviderRuntimeServiceModuleAccess } from './packages/authority.js'
import { HostBoundPlatformProviderBrokerV1, issuePlatformProviderBrokerPolicy } from './platform-provider-broker.js'
import {
  type HostPlatformProviderBrokerAuthorityV1,
  HostPlatformProviderConfigurationRegistryV1,
  PlatformProviderWorkspaceAuthority,
} from './platform-provider-authority.js'
import { providerConnection } from './platform-provider-connection.js'
import {
  assertAdapter,
  factoryConfiguration,
  immutable,
  PROVIDER_ID,
  providerDefinition,
} from './platform-provider-validation.js'

export interface ActivePlatformProviderServiceV1 {
  readonly owner: PlatformProviderOwnerV1
  readonly registrations: readonly PlatformProviderRegistrationProjectionV1[]
  dispose(): Promise<void>
}

export class PlatformProviderServiceHostV1 {
  constructor(
    private readonly options: {
      readonly configurations: HostPlatformProviderConfigurationRegistryV1
      readonly brokers: HostPlatformProviderBrokerAuthorityV1
      readonly fleet: ProviderFleet
    },
  ) {}

  async activate(
    access: PlatformProviderRuntimeServiceModuleAccess,
    rawConfiguration: unknown,
  ): Promise<ActivePlatformProviderServiceV1> {
    if (access.serviceKind !== 'platform-provider' || access.owner !== 'host') {
      throw new Error('Platform provider service authority is invalid')
    }
    const contract = this.options.configurations.resolve(access.schema, access.applicationMode)
    const configurations = contract.project(rawConfiguration).map(factoryConfiguration)
    const ids = new Set<string>()
    for (const configuration of configurations) {
      if (!PROVIDER_ID.test(configuration.providerId) || ids.has(configuration.providerId)) {
        throw new Error(`Platform provider configuration ${configuration.providerId} is invalid or duplicated`)
      }
      ids.add(configuration.providerId)
    }
    const owner: PlatformProviderOwnerV1 = immutable({
      ownerHandle: `ppo_${
        createHash('sha256').update([
          access.packageIdentity.integrity,
          access.pluginIdentity.pluginId,
          access.serviceId,
          access.hostGeneration,
          access.pluginIdentity.generation,
        ].join('\0')).digest('hex')
      }`,
      pluginId: access.pluginIdentity.pluginId,
      serviceId: access.serviceId,
      sourceDigest: access.packageIdentity.integrity,
      hostGeneration: access.hostGeneration,
      pluginGeneration: access.pluginIdentity.generation,
    })
    const controller = new AbortController()
    const workspaces = new PlatformProviderWorkspaceAuthority()
    let publicationPromise: Promise<Awaited<ReturnType<ProviderFleet['publishConnections']>> | undefined> | undefined
    const prepared: Array<{
      readonly projection: PlatformProviderRegistrationProjectionV1
      readonly connection: ProviderConnection
      readonly broker: HostBoundPlatformProviderBrokerV1
      disposed: boolean
    }> = []
    const context = {
      platformProviders: {
        owner,
        register: async (definition: PlatformProviderDefinitionV1) => {
          if (controller.signal.aborted) throw new Error('Platform provider generation is retired')
          const normalized = providerDefinition(definition)
          const configuration = configurations.find(item => item.providerId === normalized.descriptor.providerId)
          if (configuration === undefined) {
            throw new Error(`Provider ${normalized.descriptor.providerId} is not configured`)
          }
          if (!configuration.enabled) {
            throw new Error(`Provider ${normalized.descriptor.providerId} is disabled`)
          }
          if (prepared.some(item => item.projection.descriptor.providerId === normalized.descriptor.providerId)) {
            throw new Error(`Provider ${normalized.descriptor.providerId} is registered twice`)
          }
          const providerGeneration =
            `${access.hostGeneration}:${access.pluginIdentity.generation}:${normalized.descriptor.providerId}`
          const policy = issuePlatformProviderBrokerPolicy({
            owner,
            providerId: normalized.descriptor.providerId,
            providerGeneration,
            operations: normalized.descriptor.operations,
            request: normalized.brokerRequest,
            catalog: this.options.brokers.catalog(access.schema),
          })
          const transport = await this.options.brokers.open({
            owner,
            configuration,
            rawConfiguration,
            policy,
            workspaces,
          })
          const broker = new HostBoundPlatformProviderBrokerV1(policy, transport)
          let adapter: PlatformProviderAdapterV1
          try {
            adapter = await normalized.createAdapter({
              owner,
              providerId: normalized.descriptor.providerId,
              providerGeneration,
              configuration,
              broker,
              signal: controller.signal,
            })
          } catch (error) {
            await broker.dispose().catch(() => undefined)
            throw error
          }
          if (
            adapter.providerId !== normalized.descriptor.providerId || adapter.providerGeneration !== providerGeneration
          ) {
            await adapter.dispose('failed').catch(() => undefined)
            await broker.dispose().catch(() => undefined)
            throw new Error('Platform provider adapter identity drifted from its Host fence')
          }
          try {
            assertAdapter(adapter)
          } catch (error) {
            await adapter.dispose('failed').catch(() => undefined)
            await broker.dispose().catch(() => undefined)
            throw error
          }
          const projection: PlatformProviderRegistrationProjectionV1 = immutable({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-registration.v1.schema.json',
            contract: 'cordisx.platform-provider-registration/v1',
            schemaVersion: 1,
            registrationId: `ppr_${randomUUID()}`,
            owner,
            descriptor: normalized.descriptor,
            mapping: normalized.mapping,
            providerGeneration,
            brokerPolicy: policy,
            configuration,
            state: 'staged',
          })
          const record = {
            projection,
            connection: providerConnection({
              descriptor: normalized.descriptor,
              mapping: normalized.mapping,
              adapter,
              broker,
              workspaces,
            }),
            broker,
            disposed: false,
          }
          prepared.push(record)
          return Object.freeze({
            registration: projection,
            dispose: async () => {
              if (record.disposed) return
              record.disposed = true
              if (publicationPromise === undefined) await record.connection.close()
              else {
                const activePublication = await publicationPromise
                if (activePublication === undefined) await record.connection.close()
                else await activePublication.disposeProvider(record.connection.providerId)
              }
            },
          })
        },
      },
    }
    const modulePath = path.resolve(access.artifactDirectory, access.runtimeEntry)
    if (!modulePath.startsWith(`${path.resolve(access.artifactDirectory)}${path.sep}`)) {
      throw new Error('Platform provider service entry escapes its artifact directory')
    }
    try {
      const service = await import(
        `${pathToFileURL(modulePath).href}?generation=${encodeURIComponent(owner.pluginGeneration)}`
      ) as {
        readonly apply?: PlatformProviderServiceApplyV1
      }
      if (typeof service.apply !== 'function') throw new Error('Platform provider service exports no apply function')
      await service.apply(context as never, { owner, configurations, signal: controller.signal })
      const active = prepared.filter(item => !item.disposed)
      const activeIds = new Set(active.map(item => item.projection.descriptor.providerId))
      const missing = configurations.find(configuration =>
        configuration.enabled && !activeIds.has(configuration.providerId)
      )
      if (missing !== undefined) throw new Error(`Enabled provider ${missing.providerId} was not registered`)
      let resolvePublication = (
        _value: Awaited<ReturnType<ProviderFleet['publishConnections']>> | undefined,
      ): void => {}
      publicationPromise = new Promise(resolve => {
        resolvePublication = resolve
      })
      let activePublication: Awaited<ReturnType<ProviderFleet['publishConnections']>>
      try {
        activePublication = await this.options.fleet.publishConnections(active.map(item => ({
          connection: item.connection,
          displayName: item.projection.descriptor.displayName,
        })))
        resolvePublication(activePublication)
      } catch (error) {
        resolvePublication(undefined)
        throw error
      }
      await Promise.all(
        active.filter(item => item.disposed).map(async item => {
          await activePublication.disposeProvider(item.connection.providerId)
        }),
      )
      const published = active.filter(item => !item.disposed)
      let disposed = false
      return {
        owner,
        registrations: published.map(item => immutable({ ...item.projection, state: 'active' as const })),
        dispose: async () => {
          if (disposed) return
          disposed = true
          controller.abort()
          try {
            await activePublication.dispose()
          } finally {
            workspaces.dispose()
          }
        },
      }
    } catch (error) {
      controller.abort()
      await Promise.all(prepared.map(async item => {
        if (!item.disposed) await item.connection.close().catch(() => undefined)
      }))
      workspaces.dispose()
      throw error
    }
  }
}
