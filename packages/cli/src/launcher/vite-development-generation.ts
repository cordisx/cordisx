import { EntityDirectoryAuthority, type EntityTemplatePayload } from './entity-directory.js'
import { entityInstallationId, entityPluginGeneration } from './owner-document-rpc.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import { ManagedServicePluginLifecycleRuntime } from './managed-service-plugin-lifecycle.js'
import type { ManagedServiceUICapabilityMutation, PluginRuntimeMutation } from './plugin-lifecycle-model.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'

export interface NativeVitePluginGeneration {
  readonly pluginId: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly moduleGeneration: string
  readonly entityTemplates: readonly EntityTemplatePayload[]
}

export interface NativeVitePluginGenerationTransaction {
  readonly managedServiceUICapabilities?: readonly ManagedServiceUICapabilityMutation[]
  commit(): Promise<void>
  rollback(): Promise<void>
}

export type NativeVitePluginGenerationHandler = (
  generation: NativeVitePluginGeneration,
) => Promise<NativeVitePluginGenerationTransaction>

export function composeNativeVitePluginGenerationHandlers(
  handlers: readonly NativeVitePluginGenerationHandler[],
): NativeVitePluginGenerationHandler {
  return async generation => {
    const transactions: NativeVitePluginGenerationTransaction[] = []
    try {
      for (const handler of handlers) transactions.push(await handler(generation))
    } catch (error) {
      await Promise.allSettled([...transactions].reverse().map(async transaction => await transaction.rollback()))
      throw error
    }
    return {
      managedServiceUICapabilities: transactions.flatMap(transaction => transaction.managedServiceUICapabilities ?? []),
      async commit() {
        for (const transaction of transactions) await transaction.commit()
      },
      async rollback() {
        await Promise.allSettled([...transactions].reverse().map(async transaction => await transaction.rollback()))
      },
    }
  }
}

export interface NativeViteManagedServiceProjection {
  readonly handler: NativeVitePluginGenerationHandler
  readonly managedServiceUI: ManagedServicePluginLifecycleRuntime['managedServiceUI']
  capabilities(): readonly ManagedServiceUICapabilityMutation[]
  dispose(): Promise<void>
}

/** Rebind one installed backend activation to each exact source-HMR generation. */
export async function createNativeViteManagedServiceProjection(input: {
  readonly activation: ManagedServiceNodeActivation
  readonly profileId: string
  readonly runtimeGeneration: string
}): Promise<NativeViteManagedServiceProjection> {
  const staged = new Map<string, PluginRuntimeMutation>()
  let active: CordisXPluginActivationRecordV1 = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: input.profileId,
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: input.runtimeGeneration,
    plugins: [],
  }
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    profileId: input.profileId,
    runtimeGeneration: input.runtimeGeneration,
    runtime: {
      async stage(mutation) {
        staged.set(mutation.transactionId, mutation)
      },
      async commit(transactionId) {
        staged.delete(transactionId)
      },
      async abort(transactionId) {
        staged.delete(transactionId)
      },
      async reload() {},
    },
    activate: async activation =>
      Object.freeze({
        hostGeneration: input.activation.hostGeneration,
        authorities: input.activation.authorities,
        sources: Object.freeze(input.activation.sources.flatMap(source => {
          const owner = activation.plugins.find(plugin => plugin.id === source.pluginId && plugin.enabled)
          return owner === undefined ? [] : [Object.freeze({ ...source, pluginGeneration: owner.moduleGeneration })]
        })),
        get nativeProviderIds() {
          return input.activation.nativeProviderIds
        },
        prepareNativeConnection: (providerId: string) => input.activation.prepareNativeConnection(providerId),
        async dispose() {},
      }),
  })
  await lifecycle.initialize(active)
  const handler = shareGenerationTransactions(async generation => {
    const transactionId = `vite-managed-${generation.pluginId}-${generation.moduleGeneration}`
    const item = {
      id: generation.pluginId,
      version: generation.version,
      digest: generation.digest,
      moduleGeneration: generation.moduleGeneration,
      dependencies: [],
      enabled: true,
    }
    const candidate: CordisXPluginActivationRecordV1 = {
      ...active,
      recordKind: 'candidate',
      transactionId,
      revision: active.revision + 1,
      lastGoodRevision: active.revision,
      plugins: active.plugins.some(plugin => plugin.id === generation.pluginId)
        ? active.plugins.map(plugin => plugin.id === generation.pluginId ? item : plugin)
        : [...active.plugins, item],
    }
    await lifecycle.stage({
      transactionId,
      operation: active.plugins.some(plugin => plugin.id === generation.pluginId) ? 'update' : 'install',
      previous: active,
      candidate,
      targetId: generation.pluginId,
      affectedPluginIds: [generation.pluginId],
    })
    const capabilities = staged.get(transactionId)?.managedServiceUICapabilities ?? []
    let settled = false
    return {
      managedServiceUICapabilities: capabilities,
      async commit() {
        if (settled) return
        settled = true
        await lifecycle.commit(transactionId)
        active = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
      },
      async rollback() {
        if (settled) return
        settled = true
        await lifecycle.abort(transactionId)
      },
    }
  })
  return {
    handler,
    managedServiceUI: lifecycle.managedServiceUI,
    capabilities: () => lifecycle.capabilities(),
    async dispose() {
      await lifecycle.dispose()
    },
  }
}

/** Keep Host entity declarations aligned with generations acknowledged by the renderer. */
export function createNativeViteEntityGenerationHandler(
  authority: EntityDirectoryAuthority,
  profileId: string,
): NativeVitePluginGenerationHandler {
  const committed = new Map<string, readonly EntityTemplatePayload['declaration'][]>()
  const staging = new Set<string>()
  return shareGenerationTransactions(async generation => {
    if (staging.has(generation.pluginId)) {
      throw new Error(`plugin ${generation.pluginId} already has a staged entity generation`)
    }
    staging.add(generation.pluginId)
    const binding = {
      profileId,
      installationId: entityInstallationId(profileId, generation.pluginId),
      pluginId: generation.pluginId,
      pluginGeneration: entityPluginGeneration(generation.moduleGeneration),
    }
    const declarations = generation.entityTemplates.map(template => template.declaration)
    const previous = committed.get(generation.pluginId)
    authority.register(binding, declarations)
    try {
      const materialized = await authority.materialize(
        binding,
        generation.version,
        generation.digest,
        generation.entityTemplates,
      )
      const rejected = materialized.find(result => result.status === 'rejected')
      if (rejected !== undefined) throw new Error(`entity template ${rejected.agentId} was rejected: ${rejected.code}`)
    } catch (error) {
      authority.register(binding, previous ?? [])
      staging.delete(generation.pluginId)
      throw error
    }
    let settled = false
    return {
      async commit() {
        if (settled) return
        settled = true
        committed.set(generation.pluginId, declarations)
        staging.delete(generation.pluginId)
      },
      async rollback() {
        if (settled) return
        settled = true
        authority.register(binding, previous ?? [])
        staging.delete(generation.pluginId)
      },
    }
  })
}

/** Native windows share Host declarations but settle their renderer transactions independently. */
function shareGenerationTransactions(handler: NativeVitePluginGenerationHandler): NativeVitePluginGenerationHandler {
  const committed = new Map<string, {
    readonly generation: string
    readonly managedServiceUICapabilities?: readonly ManagedServiceUICapabilityMutation[]
  }>()
  const staging = new Map<string, {
    generation: string
    handle: Promise<NativeVitePluginGenerationTransaction>
    participants: number
    commit?: Promise<void>
    committed: boolean
  }>()
  return async generation => {
    const id = generation.pluginId
    let shared = staging.get(id)
    if (shared !== undefined && shared.generation !== generation.moduleGeneration) {
      throw new Error(`plugin ${id} already has a staged entity generation`)
    }
    const current = committed.get(id)
    if (shared === undefined && current?.generation === generation.moduleGeneration) {
      return {
        ...(current.managedServiceUICapabilities === undefined
          ? {}
          : { managedServiceUICapabilities: current.managedServiceUICapabilities }),
        commit: async () => undefined,
        rollback: async () => undefined,
      }
    }
    if (shared === undefined) {
      shared = {
        generation: generation.moduleGeneration,
        handle: handler(generation),
        participants: 0,
        committed: false,
      }
      staging.set(id, shared)
    }
    const transaction = shared
    transaction.participants += 1
    let handle: NativeVitePluginGenerationTransaction
    try {
      handle = await transaction.handle
    } catch (error) {
      if (staging.get(id) === transaction) staging.delete(id)
      throw error
    }
    let settled = false
    return {
      ...(handle.managedServiceUICapabilities === undefined
        ? {}
        : { managedServiceUICapabilities: handle.managedServiceUICapabilities }),
      async commit() {
        if (settled) return
        transaction.commit ??= handle.commit().then(() => {
          transaction.committed = true
          committed.set(id, {
            generation: transaction.generation,
            ...(handle.managedServiceUICapabilities === undefined
              ? {}
              : { managedServiceUICapabilities: handle.managedServiceUICapabilities }),
          })
          if (staging.get(id) === transaction) staging.delete(id)
        })
        await transaction.commit
        settled = true
        transaction.participants -= 1
      },
      async rollback() {
        if (settled) return
        settled = true
        transaction.participants -= 1
        // One failed window must not undo another window's successful publish.
        await transaction.commit?.catch(() => undefined)
        if (transaction.participants === 0 && !transaction.committed) {
          try {
            await handle.rollback()
          } finally {
            if (staging.get(id) === transaction) staging.delete(id)
          }
        }
      },
    }
  }
}
