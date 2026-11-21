import type { CordisXPluginModule } from '../contracts.js'
import type { RendererPluginMutation } from '../renderer/runtime-shared.js'
import type { ManagerRendererLoadedStage, ManagerRendererStageLoader } from './lifecycle-client.js'

/** Public-to-this-renderer projection; graph paths are never bearer credentials. */
export interface ManagerRendererGraph {
  readonly leaseId: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly baseUrl: string
  readonly entryUrl: string
  readonly initialStyleUrls: readonly string[]
}

export interface ManagerRendererResourceRegistry {
  stage(input: {
    readonly id: string
    readonly baseUrl: string
    readonly initialStyles: readonly string[]
  }): { readonly id: string; readonly ready: Promise<void> }
  publish(id: string): boolean
  retire(id: string): boolean
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const pluginId = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const secret = /^[a-f0-9]{64}$/u
const graphPath = /^\/api\/renderer\/graphs\/[a-f0-9]{64}\/$/u
const modulePath = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:js|mjs)$/u
const stylePath = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.css$/u
const MAX_GENERATIONS = 256
const mutationKeys = new Set([
  'transactionId',
  'transactionEpoch',
  'expectedRegistryEpoch',
  'afterRegistryEpoch',
  'operation',
  'previous',
  'candidate',
  'targetId',
  'affectedPluginIds',
  'managedServiceUICapabilities',
  'package',
  'developmentPackage',
  'authorizationDecision',
  'ownerDocumentBindings',
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('renderer-graph-invalid')
  return value as Record<string, unknown>
}

function graph(value: unknown, origin: string): ManagerRendererGraph {
  const item = record(value)
  const keys = ['leaseId', 'pluginId', 'moduleGeneration', 'baseUrl', 'entryUrl', 'initialStyleUrls']
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || typeof item.leaseId !== 'string' || !secret.test(item.leaseId)
    || typeof item.pluginId !== 'string' || !pluginId.test(item.pluginId)
    || typeof item.moduleGeneration !== 'string' || !identifier.test(item.moduleGeneration)
    || typeof item.baseUrl !== 'string' || typeof item.entryUrl !== 'string'
    || !Array.isArray(item.initialStyleUrls) || item.initialStyleUrls.length > 256
  ) throw new Error('renderer-graph-invalid')
  let base: URL
  try {
    base = new URL(item.baseUrl)
  } catch {
    throw new Error('renderer-graph-invalid')
  }
  if (
    base.origin !== origin || base.href !== item.baseUrl || base.search || base.hash
    || !graphPath.test(base.pathname)
  ) throw new Error('renderer-graph-invalid')
  const relative = (value: unknown, pattern: RegExp): boolean =>
    typeof value === 'string' && value.startsWith(item.baseUrl as string)
    && pattern.test(value.slice((item.baseUrl as string).length))
  if (!relative(item.entryUrl, modulePath) || item.initialStyleUrls.some(url => !relative(url, stylePath))) {
    throw new Error('renderer-graph-invalid')
  }
  if (new Set(item.initialStyleUrls).size !== item.initialStyleUrls.length) {
    throw new Error('renderer-graph-invalid')
  }
  return Object.freeze({
    leaseId: item.leaseId,
    pluginId: item.pluginId,
    moduleGeneration: item.moduleGeneration,
    baseUrl: item.baseUrl,
    entryUrl: item.entryUrl,
    initialStyleUrls: Object.freeze([...item.initialStyleUrls] as string[]),
  })
}

function candidateItems(value: unknown): ReadonlyMap<string, { enabled: boolean; moduleGeneration: string }> {
  const item = record(value)
  if (!Array.isArray(item.plugins) || item.plugins.length > 4096) throw new Error('renderer-graph-invalid')
  const result = new Map<string, { enabled: boolean; moduleGeneration: string }>()
  for (const raw of item.plugins) {
    const plugin = record(raw)
    if (
      typeof plugin.id !== 'string' || !pluginId.test(plugin.id) || result.has(plugin.id)
      || typeof plugin.enabled !== 'boolean' || typeof plugin.moduleGeneration !== 'string'
      || !identifier.test(plugin.moduleGeneration)
    ) throw new Error('renderer-graph-invalid')
    result.set(plugin.id, { enabled: plugin.enabled, moduleGeneration: plugin.moduleGeneration })
  }
  return result
}

function abortable<Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(new Error('renderer-graph-session-revoked'))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(new Error('renderer-graph-session-revoked'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

/**
 * Use the existing Host registry and native ESM import. Only owner-issued
 * same-origin graph descriptors are accepted; no source is evaluated.
 */
export function createManagerRendererGraphLoader(input: {
  readonly origin: string
  readonly registry: ManagerRendererResourceRegistry
  /** Exact graph descriptors already published by the owner's initial composition. */
  readonly initialGraphs: readonly ManagerRendererGraph[]
  /** Override only in isolated tests; production uses the browser's native ESM loader. */
  readonly importModule?: (url: string) => Promise<CordisXPluginModule>
}): ManagerRendererStageLoader {
  const url = new URL(input.origin)
  if (url.origin !== input.origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') {
    throw new Error('renderer-graph-origin-invalid')
  }
  const importModule = input.importModule ?? (async (entry: string) => await import(/* @vite-ignore */ entry))
  const active = new Map<string, ManagerRendererGraph>()
  const issued = new Set<string>()
  if (input.initialGraphs.length > MAX_GENERATIONS) throw new Error('renderer-graph-limit')
  for (const raw of input.initialGraphs) {
    const item = graph(raw, input.origin)
    if (active.has(item.pluginId) || issued.has(item.leaseId)) throw new Error('renderer-graph-invalid')
    active.set(item.pluginId, item)
    issued.add(item.leaseId)
  }
  let closed = false
  let outstanding: ManagerRendererLoadedStage | undefined

  const retire = (id: string): void => {
    if (input.registry.retire(id) !== true) throw new Error('renderer-graph-retirement-unconfirmed')
  }

  return {
    async load(projection, context) {
      if (closed || outstanding !== undefined || context.signal.aborted) throw new Error('renderer-graph-unavailable')
      const item = record(projection)
      if (
        Object.keys(item).some(key => key !== 'rendererId' && key !== 'graphs' && !mutationKeys.has(key))
        || item.rendererId !== context.rendererId || !Array.isArray(item.graphs) || item.graphs.length > 256
        || !Array.isArray(item.affectedPluginIds) || item.affectedPluginIds.length < 1
        || item.affectedPluginIds.some(id => typeof id !== 'string' || !pluginId.test(id))
        || new Set(item.affectedPluginIds).size !== item.affectedPluginIds.length
      ) throw new Error('renderer-graph-invalid')
      const beforeScope = record(item.previous)
      const afterScope = record(item.candidate)
      if (
        beforeScope.profileId !== context.profileId || afterScope.profileId !== context.profileId
        || beforeScope.runtimeGeneration !== context.generation || afterScope.runtimeGeneration !== context.generation
      ) throw new Error('renderer-graph-projection-stale')
      const previous = candidateItems(item.previous)
      const candidate = candidateItems(item.candidate)
      const affected = new Set(item.affectedPluginIds as string[])
      const projected = new Map<string, ManagerRendererGraph>()
      for (const raw of item.graphs) {
        const next = graph(raw, input.origin)
        const activation = candidate.get(next.pluginId)
        if (
          !affected.has(next.pluginId) || projected.has(next.pluginId) || issued.has(next.leaseId)
          || !activation?.enabled || activation.moduleGeneration !== next.moduleGeneration
        ) throw new Error('renderer-graph-projection-stale')
        projected.set(next.pluginId, next)
      }
      if (issued.size + projected.size > MAX_GENERATIONS) throw new Error('renderer-graph-limit')
      for (const id of affected) {
        const before = previous.get(id)
        const after = candidate.get(id)
        const activeGraph = active.get(id)
        if (
          activeGraph !== undefined && (!before?.enabled || before.moduleGeneration !== activeGraph.moduleGeneration)
        ) {
          throw new Error('renderer-graph-active-stale')
        }
        const targetReplacement = id === item.targetId
          && ['install', 'update', 'enable'].includes(String(item.operation))
        if (
          after?.enabled
          && (targetReplacement || !before?.enabled || before.moduleGeneration !== after.moduleGeneration)
          && !projected.has(id)
        ) throw new Error('renderer-graph-projection-unavailable')
        // An enabled prior graph not tracked by the initial owner projection
        // cannot safely be retired or rolled back by this session.
        if (before?.enabled && activeGraph === undefined) throw new Error('renderer-graph-active-unavailable')
      }
      const mutation = Object.fromEntries(
        Object.entries(item).filter(([key]) => mutationKeys.has(key)),
      ) as unknown as RendererPluginMutation
      const modules: Record<string, CordisXPluginModule> = Object.create(null) as Record<string, CordisXPluginModule>
      const staged: ManagerRendererGraph[] = []
      try {
        for (const next of projected.values()) {
          if (closed || context.signal.aborted) throw new Error('renderer-graph-session-revoked')
          const lease = input.registry.stage({
            id: next.leaseId,
            baseUrl: next.baseUrl,
            initialStyles: next.initialStyleUrls,
          })
          if (lease.id !== next.leaseId) throw new Error('renderer-graph-invalid')
          staged.push(next)
          issued.add(next.leaseId)
          await abortable(lease.ready, context.signal)
          const module = await abortable(importModule(next.entryUrl), context.signal)
          if (!module || typeof module !== 'object') throw new Error('renderer-graph-module-invalid')
          if (closed || context.signal.aborted) throw new Error('renderer-graph-session-revoked')
          modules[next.pluginId] = module
        }
      } catch (error) {
        for (const next of staged.reverse()) {
          try {
            retire(next.leaseId)
          } catch { /* a missing retirement fences the caller as failed */ }
        }
        throw error
      }
      let phase: 'staged' | 'published' | 'committed' | 'retired' = 'staged'
      const loaded: ManagerRendererLoadedStage = {
        mutation,
        modules,
        publish() {
          if (closed || context.signal.aborted || phase !== 'staged') throw new Error('renderer-graph-session-revoked')
          for (const next of staged) {
            if (input.registry.publish(next.leaseId) !== true) throw new Error('renderer-graph-publication-unconfirmed')
          }
          phase = 'published'
        },
        commit() {
          if (closed || context.signal.aborted || phase !== 'published') {
            throw new Error('renderer-graph-session-revoked')
          }
          for (const id of affected) {
            const old = active.get(id)
            const replacement = projected.get(id)
            const activation = candidate.get(id)
            if (old !== undefined && (replacement !== undefined || !activation?.enabled)) {
              retire(old.leaseId)
              active.delete(id)
            }
            if (replacement !== undefined) active.set(id, replacement)
          }
          phase = 'committed'
          outstanding = undefined
        },
        retire() {
          if (phase === 'retired') return
          if (phase === 'committed') throw new Error('renderer-graph-already-committed')
          for (const next of [...staged].reverse()) retire(next.leaseId)
          phase = 'retired'
          outstanding = undefined
        },
      }
      outstanding = loaded
      return loaded
    },
    dispose() {
      if (closed) return
      // Retire a staged generation before disabling the session.
      try {
        outstanding?.retire()
      } catch { /* continue retiring active leases */ }
      closed = true
      for (const item of active.values()) {
        try {
          retire(item.leaseId)
        } catch { /* owner must fence an unconfirmed cleanup */ }
      }
      active.clear()
    },
  }
}
