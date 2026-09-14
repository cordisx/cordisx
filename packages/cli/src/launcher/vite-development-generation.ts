import { EntityDirectoryAuthority, type EntityTemplatePayload } from './entity-directory.js'
import { entityInstallationId, entityPluginGeneration } from './owner-document-rpc.js'

export interface NativeVitePluginGeneration {
  readonly pluginId: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly moduleGeneration: string
  readonly entityTemplates: readonly EntityTemplatePayload[]
}

export interface NativeVitePluginGenerationTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export type NativeVitePluginGenerationHandler = (
  generation: NativeVitePluginGeneration,
) => Promise<NativeVitePluginGenerationTransaction>

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
  const committed = new Map<string, string>()
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
    if (shared === undefined && committed.get(id) === generation.moduleGeneration) {
      return { commit: async () => undefined, rollback: async () => undefined }
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
      async commit() {
        if (settled) return
        transaction.commit ??= handle.commit().then(() => {
          transaction.committed = true
          committed.set(id, transaction.generation)
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
