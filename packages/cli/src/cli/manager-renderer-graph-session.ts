import { randomBytes } from 'node:crypto'
import type { PluginGenerationGraphLease } from '../launcher/plugin-generation-artifact-server.js'
import { normalizePluginActivation } from '../launcher/plugin-activation.js'
import type { ManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import {
  createSessionPluginGraphProjection,
  type ProjectedGraphResponse,
  type ProjectedPluginGraph,
  type SessionPluginGraphProjection,
} from '../independent-manager/plugin-graph-projection.js'

interface PrivateGraph {
  readonly leaseId: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly baseUrl: string
  readonly entryUrl: string
  readonly initialStyleUrls: readonly string[]
}
interface Entry {
  readonly descriptor: PrivateGraph
  readonly projected: ProjectedPluginGraph
  readonly publicGraph: ManagerRendererGraph
}
interface Transaction {
  readonly id: string
  readonly affected: readonly string[]
  readonly candidate: ReadonlyMap<string, ActivationItem>
  readonly staged: readonly Entry[]
}
interface ActivationItem {
  readonly enabled: boolean
  readonly moduleGeneration: string
}

const secret = /^[a-f0-9]{64}$/u
const pluginId = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const modulePath = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:js|mjs)$/u
const stylePath = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.css$/u
const stageKeys = new Set([
  'rendererId',
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
  'privateGraphs',
])

function invalid(): Error {
  return new Error('MANAGER_RENDERER_GRAPH_INVALID')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

function privateGraph(value: unknown, managerOrigin: string): { descriptor: PrivateGraph; origin: string } {
  const item = object(value)
  const keys = ['leaseId', 'pluginId', 'moduleGeneration', 'baseUrl', 'entryUrl', 'initialStyleUrls']
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || typeof item.leaseId !== 'string' || !secret.test(item.leaseId)
    || typeof item.pluginId !== 'string' || !pluginId.test(item.pluginId)
    || typeof item.moduleGeneration !== 'string' || !identifier.test(item.moduleGeneration)
    || typeof item.baseUrl !== 'string' || item.baseUrl.length > 2_048
    || typeof item.entryUrl !== 'string' || item.entryUrl.length > 2_048
    || !Array.isArray(item.initialStyleUrls) || item.initialStyleUrls.length > 256
    || item.initialStyleUrls.some(value => typeof value !== 'string' || value.length > 2_048)
    || new Set(item.initialStyleUrls).size !== item.initialStyleUrls.length
  ) throw invalid()
  let base: URL
  try {
    base = new URL(item.baseUrl)
  } catch {
    throw invalid()
  }
  const match = /^\/cordisx-plugin-artifacts\/([a-f0-9]{64})\/([a-f0-9]{64})\/$/u.exec(base.pathname)
  if (
    base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.port === ''
    || base.username || base.password || base.search || base.hash || base.href !== item.baseUrl
    || base.origin === managerOrigin || !match || match[2] !== item.leaseId
  ) throw invalid()
  const relative = (value: unknown, pattern: RegExp) =>
    typeof value === 'string' && value.startsWith(item.baseUrl as string)
    && pattern.test(value.slice((item.baseUrl as string).length))
  if (!relative(item.entryUrl, modulePath) || item.initialStyleUrls.some(value => !relative(value, stylePath))) {
    throw invalid()
  }
  return {
    descriptor: {
      leaseId: item.leaseId,
      pluginId: item.pluginId,
      moduleGeneration: item.moduleGeneration,
      baseUrl: item.baseUrl,
      entryUrl: item.entryUrl,
      initialStyleUrls: [...item.initialStyleUrls] as string[],
    },
    origin: base.origin,
  }
}

function activation(
  value: unknown,
  scope: { profileId: string; generation: string },
  kind: 'active' | 'candidate',
) {
  const item = normalizePluginActivation(value)
  if (item.recordKind !== kind || item.profileId !== scope.profileId || item.runtimeGeneration !== scope.generation) {
    throw invalid()
  }
  const output = new Map<string, ActivationItem>()
  for (const plugin of item.plugins) {
    output.set(plugin.id, { enabled: plugin.enabled, moduleGeneration: plugin.moduleGeneration })
  }
  return { record: item, plugins: output }
}

/**
 * Session-private projection over owner-issued graph descriptors. Neither a
 * browser-supplied descriptor nor a URL is an authorization to call this API.
 */
export function createManagerRendererGraphSession(input: {
  readonly managerOrigin: string
  readonly profileId: string
  readonly generation: string
  readonly rendererId: string
  /** The HTTP handler must additionally check the current owner before and after I/O. */
  readonly isCurrent: () => boolean
  readonly forbiddenSecrets: readonly string[]
}) {
  let manager: URL
  try {
    manager = new URL(input.managerOrigin)
  } catch {
    throw invalid()
  }
  if (
    manager.origin !== input.managerOrigin || manager.protocol !== 'http:' || manager.hostname !== '127.0.0.1'
    || manager.port === '' || !identifier.test(input.profileId) || !identifier.test(input.generation)
    || !secret.test(input.rendererId) || typeof input.isCurrent !== 'function'
    || input.forbiddenSecrets.length > 16 || input.forbiddenSecrets.some(value => !secret.test(value))
  ) throw invalid()
  let projection: SessionPluginGraphProjection | undefined
  let upstreamOrigin: string | undefined
  let closed = false
  let started = false
  const secrets = new Set(input.forbiddenSecrets)
  const entries = new Map<string, Entry>()
  const aliases = new Set<string>()
  const active = new Map<string, Entry>()
  let transaction: Transaction | undefined
  let pending: { id: string; sequence: number; method: string; transactionId?: string } | undefined

  const live = () => {
    try {
      return !closed && input.isCurrent() === true
    } catch {
      return false
    }
  }
  const ensureLive = () => {
    if (!live()) throw new Error('MANAGER_RENDERER_GRAPH_UNAVAILABLE')
  }
  const safe = (value: unknown): void => {
    const text = JSON.stringify(value)
    if (text === undefined || text.includes('/cordisx-plugin-artifacts/')) throw invalid()
    for (const value of secrets) if (text.includes(value)) throw invalid()
  }
  const remove = (entry: Entry): void => {
    entry.projected.retire()
    entries.delete(entry.descriptor.leaseId)
  }
  const project = (value: unknown): Entry => {
    ensureLive()
    const parsed = privateGraph(value, input.managerOrigin)
    if (upstreamOrigin !== undefined && upstreamOrigin !== parsed.origin) throw invalid()
    const existing = entries.get(parsed.descriptor.leaseId)
    if (existing !== undefined) {
      if (JSON.stringify(existing.descriptor) !== JSON.stringify(parsed.descriptor)) throw invalid()
      return existing
    }
    upstreamOrigin ??= parsed.origin
    projection ??= createSessionPluginGraphProjection({
      managerOrigin: input.managerOrigin,
      artifactServer: { origin: upstreamOrigin },
    })
    const d = parsed.descriptor
    // Only adapt the owner descriptor to the existing verified graph proxy;
    // these expressions are never delivered to, or evaluated in, a renderer.
    const lease: PluginGenerationGraphLease = {
      ...d,
      importSource: [d.baseUrl, d.entryUrl, ...d.initialStyleUrls].map(value => JSON.stringify(value)).join(';'),
      publishSource: 'true',
      retireSource: 'true',
      retire: () => {},
    }
    const projected = projection.project(lease, live)
    const parts = new URL(d.baseUrl).pathname.split('/')
    secrets.add(d.leaseId)
    secrets.add(parts[2]!)
    let alias: string
    do alias = randomBytes(32).toString('hex')
    while (aliases.has(alias) || secrets.has(alias))
    aliases.add(alias)
    const publicGraph: ManagerRendererGraph = Object.freeze({
      leaseId: alias,
      pluginId: d.pluginId,
      moduleGeneration: d.moduleGeneration,
      baseUrl: projected.baseUrl,
      entryUrl: projected.entryUrl,
      initialStyleUrls: projected.initialStyleUrls,
    })
    safe(publicGraph)
    const entry = { descriptor: d, projected, publicGraph }
    entries.set(d.leaseId, entry)
    return entry
  }
  const close = (): void => {
    if (closed) return
    closed = true
    projection?.close()
    entries.clear()
    active.clear()
    transaction = undefined
    pending = undefined
  }
  return {
    get closed() {
      return closed
    },
    /** Bootstrap may project an authenticated initial snapshot once before commands. */
    projectInitial(value: unknown): readonly ManagerRendererGraph[] {
      ensureLive()
      if (started || !Array.isArray(value) || value.length > 256) throw invalid()
      started = true
      try {
        const output: ManagerRendererGraph[] = []
        for (const raw of value) {
          const entry = project(raw)
          if (active.has(entry.descriptor.pluginId)) throw invalid()
          active.set(entry.descriptor.pluginId, entry)
          output.push(entry.publicGraph)
        }
        safe(output)
        return output
      } catch {
        close()
        throw invalid()
      }
    },
    /** Project exactly the owner command returned by authenticated RPC. */
    projectCommand(value: unknown): unknown {
      ensureLive()
      try {
        const command = object(value)
        if (
          Object.keys(command).length !== 4 || Object.keys(command).some(key =>
            !['id', 'sequence', 'method', 'payload'].includes(key)
          )
          || typeof command.id !== 'string' || !secret.test(command.id)
          || !Number.isSafeInteger(command.sequence) || (command.sequence as number) < 1
          || typeof command.method !== 'string'
          || !['synchronize', 'prepare', 'stage', 'publish', 'complete', 'finalize', 'rollback'].includes(
            command.method,
          )
          || pending !== undefined
        ) throw invalid()
        started = true
        let payload = object(command.payload)
        let transactionId: string | undefined
        if (command.method === 'stage') {
          if (
            transaction !== undefined || Object.keys(payload).some(key => !stageKeys.has(key))
            || payload.rendererId !== input.rendererId || typeof payload.transactionId !== 'string'
            || !identifier.test(payload.transactionId) || !Array.isArray(payload.privateGraphs)
            || typeof payload.transactionEpoch !== 'string' || !identifier.test(payload.transactionEpoch)
            || !Number.isSafeInteger(payload.expectedRegistryEpoch) || Number(payload.expectedRegistryEpoch) < 0
            || payload.afterRegistryEpoch !== Number(payload.expectedRegistryEpoch) + 1
            || payload.privateGraphs.length > 256 || !Array.isArray(payload.affectedPluginIds)
            || payload.affectedPluginIds.length < 1 || payload.affectedPluginIds.length > 4_096
            || payload.affectedPluginIds.some(value => typeof value !== 'string' || !pluginId.test(value))
            || new Set(payload.affectedPluginIds).size !== payload.affectedPluginIds.length
            || typeof payload.targetId !== 'string' || !payload.affectedPluginIds.includes(payload.targetId)
            || !['install', 'update', 'enable', 'disable', 'uninstall'].includes(String(payload.operation))
          ) throw invalid()
          const previous = activation(payload.previous, input, 'active')
          const candidate = activation(payload.candidate, input, 'candidate')
          if (
            candidate.record.transactionId !== payload.transactionId
            || candidate.record.revision !== previous.record.revision + 1
            || candidate.record.lastGoodRevision !== previous.record.revision
          ) throw invalid()
          if (
            payload.package !== undefined && Object.keys(object(payload.package)).some(key =>
              !['manifest', 'digest', 'artifactIntegrity', 'identitySource', 'readme', 'readmes', 'documents'].includes(
                key,
              )
            )
          ) throw invalid()
          const affected = payload.affectedPluginIds as string[]
          const staged: Entry[] = []
          const byPlugin = new Map<string, Entry>()
          for (const raw of payload.privateGraphs) {
            const entry = project(raw)
            const next = candidate.plugins.get(entry.descriptor.pluginId)
            if (
              !affected.includes(entry.descriptor.pluginId) || byPlugin.has(entry.descriptor.pluginId)
              || !next?.enabled || next.moduleGeneration !== entry.descriptor.moduleGeneration
              || active.get(entry.descriptor.pluginId) === entry
            ) throw invalid()
            byPlugin.set(entry.descriptor.pluginId, entry)
            staged.push(entry)
          }
          for (const id of affected) {
            const before = previous.plugins.get(id)
            const after = candidate.plugins.get(id)
            const old = active.get(id)
            if (
              before?.enabled && (!old || old.descriptor.moduleGeneration !== before.moduleGeneration)
            ) throw invalid()
            const replacement = id === payload.targetId
              && ['install', 'update', 'enable'].includes(String(payload.operation))
            if (
              after?.enabled && (replacement || !before?.enabled || before.moduleGeneration !== after.moduleGeneration)
              && !byPlugin.has(id)
            ) throw invalid()
          }
          transactionId = payload.transactionId
          transaction = { id: transactionId, affected, candidate: candidate.plugins, staged }
          payload = {
            ...Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'privateGraphs')),
            graphs: staged.map(entry => entry.publicGraph),
          }
        } else if (['publish', 'complete', 'finalize', 'rollback'].includes(command.method)) {
          if (!transaction || payload.transactionId !== transaction.id) throw invalid()
          transactionId = transaction.id
        }
        const result = { id: command.id, sequence: command.sequence, method: command.method, payload }
        safe(result)
        pending = {
          id: command.id,
          sequence: command.sequence as number,
          method: command.method,
          ...(transactionId === undefined ? {} : { transactionId }),
        }
        return result
      } catch {
        close()
        throw invalid()
      }
    },
    /** Call only after the owner has confirmed this exact receipt. */
    acknowledge(value: unknown): void {
      ensureLive()
      try {
        const receipt = object(value)
        if (!pending || receipt.id !== pending.id || receipt.sequence !== pending.sequence || receipt.ok !== true) {
          throw invalid()
        }
        if (pending.method === 'finalize' || pending.method === 'rollback') {
          if (!transaction || pending.transactionId !== transaction.id) throw invalid()
          if (pending.method === 'rollback') {
            for (const entry of transaction.staged) remove(entry)
          } else {
            const replacements = new Map(transaction.staged.map(entry => [entry.descriptor.pluginId, entry]))
            for (const id of transaction.affected) {
              const old = active.get(id)
              const replacement = replacements.get(id)
              if (old && (replacement || !transaction.candidate.get(id)?.enabled)) {
                remove(old)
                active.delete(id)
              }
              if (replacement) active.set(id, replacement)
            }
          }
          transaction = undefined
        }
        pending = undefined
      } catch {
        close()
        throw invalid()
      }
    },
    async resolve(
      request: { readonly method: string; readonly target: string; readonly signal?: AbortSignal },
    ): Promise<ProjectedGraphResponse> {
      if (!live() || !projection) return { status: 404, headers: { 'cache-control': 'no-store' } }
      return await projection.resolve(request)
    },
    close,
  }
}
