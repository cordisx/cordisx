import type { ManagedServiceNativeActivation } from './managed-service-plugin-lifecycle.js'
import type { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import { nativeModelProviderCatalog, type NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import { nativeProviderConfig } from './native-provider-config.js'
import type { NativeProviderCredentialLease } from './native-submission-controller.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import type { HeadlessManagedCatalogBinding } from './headless-managed-catalog-bindings.js'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const providerId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value)
const modelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const STATIC_REVISION = 'cordisx-static-provider/v1'

function connectionRoute(session: NativeManagedGatewayConnectionSession, id: string) {
  const aliases = session.value.models.aliases.filter(alias => alias.gatewayModelId === id)
  if (!aliases.length) return undefined
  const windows = aliases.map(alias => (alias as { contextWindow?: unknown }).contextWindow)
  const contextWindow = windows.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    ? (windows as number[]).reduce((left, right) => Math.min(left, right))
    : undefined
  let reasoning = parseModelReasoningCapabilities(aliases[0]!.reasoningCapabilities)
  for (const alias of aliases.slice(1)) {
    const current = parseModelReasoningCapabilities(alias.reasoningCapabilities)
    if (!reasoning || !current) {
      reasoning = undefined
      break
    }
    const efforts = reasoning.efforts.filter(value => current.efforts.includes(value))
    const defaultEffort = reasoning.defaultEffort !== undefined && reasoning.defaultEffort === current.defaultEffort
        && efforts.includes(reasoning.defaultEffort)
      ? reasoning.defaultEffort
      : undefined
    reasoning = efforts.length ? { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) } : undefined
  }
  return {
    gatewayModelId: id,
    aliases: aliases.map(alias => alias.alias).sort(),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(reasoning === undefined ? {} : { reasoningCapabilities: reasoning }),
  }
}

export interface HeadlessManagedSnapshot {
  readonly providerId: string
  readonly pluginId: string
  readonly serviceId: string
  readonly serviceGeneration: string
  readonly catalogGeneration: string
  readonly routes: readonly {
    readonly gatewayModelId: string
    readonly aliases: readonly string[]
    readonly contextWindow?: number
    readonly reasoningCapabilities?: import('../model-reasoning-capabilities.js').ModelReasoningCapabilities
  }[]
}

interface ActiveLease {
  readonly providerId: string
  readonly snapshot: HeadlessManagedSnapshot
  readonly credential: NativeProviderCredentialLease
  model?: string
}

/** Owned by one service profile. No secrets or endpoint data leave this authority. */
export function createHeadlessManagedProviders(input: {
  readonly activation: ManagedServiceNativeActivation
  readonly managed?: ManagedCatalogComposition
  /** IDs already owned by the user's native or statically configured services. */
  readonly reservedProviderIds: ReadonlySet<string>
  readonly readThreadCatalog: (threadId: string) => Promise<HeadlessManagedCatalogBinding | undefined>
  readonly recordThreadCatalog: (threadId: string, binding: HeadlessManagedCatalogBinding) => Promise<void>
  readonly refreshProviderScope?: () => Promise<boolean>
  readonly verifyManagedCatalogRevision?: (providerId: string, revision: string) => Promise<boolean>
  readonly verifyNativeProviderScope?: (providerId: string, cwd: string | undefined) => Promise<boolean>
  readonly report: (code: string) => void
}) {
  const known = new Set<string>()
  const active = new Map<string, ActiveLease>()
  const uncertain = new Map<NativeProviderCredentialLease, string | undefined>()
  let closed = false
  const pluginCatalog = nativeModelProviderCatalog(input.activation)

  const owners = (id: string) => ({
    plugin: input.activation.nativeProviderIds.includes(id),
    managed: input.managed?.owns(id) === true,
  })
  const collision = (id: string) => {
    if (id === 'openai' || !input.reservedProviderIds.has(id)) return false
    const current = owners(id)
    return current.plugin || current.managed || known.has(id) || input.activation.startup.hasProvider(id)
  }
  const claimed = (id: string) => {
    if (input.reservedProviderIds.has(id)) return false
    const current = owners(id)
    return current.plugin || current.managed || known.has(id) || input.activation.startup.hasProvider(id)
  }
  const resolve = async (id: string): Promise<NativeManagedGatewayConnectionSession> => {
    if (closed || !providerId(id) || input.reservedProviderIds.has(id)) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    const current = owners(id)
    if (current.plugin === current.managed) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    return current.managed ? await input.managed!.nativeConnection(id) : input.activation.prepareNativeConnection(id)
  }
  const credentials = createNativeProviderCredentialBroker({ resolve })
  const adapter = nativeSubmissionCredentialBroker({ credentials, resolveEndpoint: resolve })

  const catalog = async (): Promise<readonly NativeModelProviderCatalogEntry[]> => {
    if (closed || input.refreshProviderScope && !await input.refreshProviderScope()) return []
    const candidates = [...input.managed?.catalog() ?? [], ...await pluginCatalog()]
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.providerId, (counts.get(entry.providerId) ?? 0) + 1)
    return candidates.filter(entry => {
      known.add(entry.providerId)
      const admitted = providerId(entry.providerId) && !input.reservedProviderIds.has(entry.providerId)
        && counts.get(entry.providerId) === 1
      if (!admitted) input.report('HEADLESS_MANAGED_PROVIDER_COLLISION')
      return admitted
    })
  }
  const snapshot = async (id: string): Promise<HeadlessManagedSnapshot> => {
    if (!claimed(id)) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    const admitted = (await catalog()).find(provider => provider.providerId === id)
    if (!admitted) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    const session = await resolve(id)
    try {
      const routes = admitted.models.map(model => {
        const window = (model as { readonly contextWindow?: unknown }).contextWindow
        return {
          gatewayModelId: model.id,
          aliases: [...model.aliases].sort(),
          ...(typeof window === 'number' && Number.isSafeInteger(window) && window > 0
            ? { contextWindow: window }
            : {}),
          ...(model.reasoningCapabilities === undefined ? {} : { reasoningCapabilities: model.reasoningCapabilities }),
        }
      })
      const owner = owners(id)
      const unavailable = owner.managed
        ? !routes.length || !await input.managed!.validateSelection(id, routes[0]!.gatewayModelId)
          || JSON.stringify(input.managed!.catalog().find(provider => provider.providerId === id))
            !== JSON.stringify(admitted)
        : !routes.length
          || routes.some(route =>
            JSON.stringify(connectionRoute(session, route.gatewayModelId)) !== JSON.stringify(route)
          )
      if (unavailable) {
        throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
      }
      return {
        providerId: id,
        pluginId: session.value.service.pluginId,
        serviceId: session.value.service.serviceId,
        serviceGeneration: session.value.service.generation,
        catalogGeneration: session.value.models.generation,
        routes,
      }
    } finally {
      session.dispose()
    }
  }
  const matches = (a: HeadlessManagedSnapshot, b: HeadlessManagedSnapshot) =>
    a.providerId === b.providerId && a.pluginId === b.pluginId && a.serviceId === b.serviceId
    && a.serviceGeneration === b.serviceGeneration
    && a.catalogGeneration === b.catalogGeneration && JSON.stringify(a.routes) === JSON.stringify(b.routes)
  const contains = (value: HeadlessManagedSnapshot, model: string) =>
    value.routes.some(route => route.gatewayModelId === model)
  const dispose = (threadId: string) => {
    active.get(threadId)?.credential.dispose()
    active.delete(threadId)
    for (const [credential, unknownThread] of uncertain) {
      if (unknownThread !== threadId) continue
      credential.dispose()
      uncertain.delete(credential)
    }
  }
  const prepare = async (id: string, model?: string) => {
    if (uncertain.size >= 128) throw new Error('MANAGED_PROVIDER_RECONCILIATION_REQUIRED')
    const before = await snapshot(id)
    if (model !== undefined && !contains(before, model)) throw new Error('MANAGED_MODEL_UNAVAILABLE')
    const credential = await adapter.prepare(id)
    try {
      const after = await snapshot(id)
      if (credential.serviceGeneration !== before.serviceGeneration || !matches(before, after)) {
        throw new Error('MANAGED_PROVIDER_CHANGED')
      }
      return { credential, snapshot: before }
    } catch (error) {
      credential.dispose()
      throw error
    }
  }

  const request = async (
    method: NativeBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    next: (params: Readonly<Record<string, unknown>>) => Promise<unknown>,
    readThread: (threadId: string) => Promise<unknown>,
  ): Promise<unknown> => {
    if (closed) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    const scopeValid = !input.refreshProviderScope || await input.refreshProviderScope()
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    let provider = typeof params.modelProvider === 'string' ? params.modelProvider : undefined
    let persisted: Record<string, unknown> = {}
    if (threadId && ['thread/resume', 'thread/fork', 'turn/start', 'thread/settings/update'].includes(method)) {
      persisted = object(object(await readThread(threadId)).thread)
      if (persisted.id !== threadId) throw new Error('MANAGED_THREAD_UNAVAILABLE')
      const existing = typeof persisted.modelProvider === 'string' ? persisted.modelProvider : undefined
      if (provider && existing && provider !== existing && (claimed(existing) || claimed(provider))) {
        throw new Error('MANAGED_PROVIDER_MISMATCH')
      }
      provider ??= existing ?? active.get(threadId)?.providerId
    }
    const evidence = threadId && provider !== 'openai'
        && ['thread/resume', 'thread/fork', 'turn/start', 'thread/settings/update'].includes(method)
      ? await input.readThreadCatalog(threadId)
      : undefined
    if (evidence && provider && evidence.providerId !== provider) throw new Error('MANAGED_PROVIDER_MISMATCH')
    provider ??= evidence?.providerId
    if (
      !scopeValid && provider && (claimed(provider) || collision(provider)
        || evidence && evidence.revision !== STATIC_REVISION)
    ) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    if (provider && threadId && collision(provider)) {
      if (evidence?.providerId !== provider || evidence.revision !== STATIC_REVISION) {
        throw new Error('MANAGED_PROVIDER_COLLISION')
      }
      if (method === 'thread/fork') {
        const result = await next(params)
        const created = object(object(result).thread).id
        if (typeof created === 'string') {
          try {
            await input.recordThreadCatalog(created, { providerId: provider, revision: STATIC_REVISION })
          } catch {
            // The fork exists. Avoid retrying it, and fail closed on any later collision.
            input.report('HEADLESS_STATIC_CATALOG_EVIDENCE_UNAVAILABLE')
          }
        }
        return result
      }
      return await next(params)
    }
    if (
      provider && evidence && evidence.providerId === provider && evidence.revision !== STATIC_REVISION
      && !claimed(provider)
    ) throw new Error('MANAGED_PROVIDER_UNAVAILABLE')
    if (!provider || !claimed(provider)) {
      const result = await next(params)
      const actual = object(result)
      const selected = provider ?? (typeof actual.modelProvider === 'string' ? actual.modelProvider : undefined)
      if (method === 'thread/start' && selected && collision(selected)) {
        const created = object(actual.thread).id
        if (typeof created === 'string') {
          try {
            await input.recordThreadCatalog(created, { providerId: selected, revision: STATIC_REVISION })
          } catch {
            // Static work already exists; preserve its success and refuse any future ambiguous collision.
            input.report('HEADLESS_STATIC_CATALOG_EVIDENCE_UNAVAILABLE')
          }
        }
      }
      return result
    }
    if (input.verifyNativeProviderScope) {
      const paths = new Set<string | undefined>()
      if (threadId) {
        if (typeof persisted.cwd !== 'string' || !persisted.cwd) throw new Error('MANAGED_PROVIDER_SCOPE_UNAVAILABLE')
        paths.add(persisted.cwd)
      }
      if (typeof params.cwd === 'string') paths.add(params.cwd)
      else if (!threadId) paths.add(undefined)
      for (const cwd of paths) {
        if (!await input.verifyNativeProviderScope(provider, cwd)) throw new Error('MANAGED_PROVIDER_SCOPE_UNAVAILABLE')
      }
    }
    if (method === 'turn/start' || method === 'thread/settings/update') {
      const lease = threadId ? active.get(threadId) : undefined
      if (!lease || lease.providerId !== provider || !matches(lease.snapshot, await snapshot(provider))) {
        throw new Error('MANAGED_PROVIDER_CHANGED')
      }
      if (
        input.verifyManagedCatalogRevision && (!evidence || evidence.providerId !== provider
          || !await input.verifyManagedCatalogRevision(provider, evidence.revision))
      ) {
        throw new Error('MANAGED_CATALOG_RECONCILIATION_REQUIRED')
      }
      const selected = modelId(params.model) ? params.model : lease.model
      if (!selected || !contains(lease.snapshot, selected)) throw new Error('MANAGED_MODEL_UNAVAILABLE')
      const result = await next(params)
      if (method === 'thread/settings/update' && modelId(params.model)) lease.model = params.model
      return result
    }
    if (method !== 'thread/start' && method !== 'thread/resume' && method !== 'thread/fork') return await next(params)
    const declared = await catalog()
    const defaultModel = declared.find(entry => entry.providerId === provider)?.defaultModelId
    const selected = modelId(params.model) ? params.model : method === 'thread/start'
      ? defaultModel
      : modelId(persisted.model)
      ? persisted.model
      : threadId
      ? active.get(threadId)?.model
      : undefined
    if (method === 'thread/start' && !selected) throw new Error('MANAGED_MODEL_UNAVAILABLE')
    const prepared = await prepare(provider, selected)
    let dispatched = false
    try {
      if (
        params.config !== undefined
        && (params.config === null || typeof params.config !== 'object' || Array.isArray(params.config))
      ) {
        throw new Error('MANAGED_PROVIDER_CONFIG_CONFLICT')
      }
      const config = object(params.config)
      const key = `model_providers.${provider}`
      if (
        Object.hasOwn(config, key) || Object.hasOwn(object(config.model_providers), provider)
        || config.model_provider !== undefined && config.model_provider !== provider
        || config.model !== undefined && selected !== undefined && config.model !== selected
      ) {
        throw new Error('MANAGED_PROVIDER_CONFIG_CONFLICT')
      }
      const updated = {
        ...params,
        modelProvider: provider,
        ...(selected === undefined ? {} : { model: selected }),
        config: { ...config, [key]: nativeProviderConfig(prepared.credential) },
      }
      dispatched = true
      const result = await next(updated)
      const resultValue = object(result), resultThreadId = object(resultValue.thread).id
      const resultModel = modelId(resultValue.model) ? resultValue.model : selected
      if (
        typeof resultThreadId !== 'string' || method === 'thread/resume' && resultThreadId !== threadId
        || !resultModel || !contains(prepared.snapshot, resultModel)
      ) {
        uncertain.set(prepared.credential, undefined)
        throw new Error('MANAGED_PROVIDER_RECONCILIATION_REQUIRED')
      }
      dispose(resultThreadId)
      active.set(resultThreadId, {
        providerId: provider,
        snapshot: prepared.snapshot,
        credential: prepared.credential,
        model: resultModel,
      })
      return result
    } catch (error) {
      // A lost native response may follow a successful resume/start. Keep the credential
      // alive until shutdown rather than breaking a possibly running task.
      if (dispatched) {
        const data = object(object(error).rpcData)
        const unknownThread = data.type === 'managedCatalogReconciliationRequired' && typeof data.threadId === 'string'
            && data.threadId.length > 0 && data.threadId.length <= 512
          ? data.threadId
          : undefined
        uncertain.set(prepared.credential, unknownThread)
      } else prepared.credential.dispose()
      throw error
    }
  }
  return {
    claimed,
    catalog,
    snapshot,
    request,
    forget: dispose,
    async close() {
      if (closed) return
      closed = true
      for (const id of [...active.keys()]) dispose(id)
      for (const lease of uncertain.keys()) lease.dispose()
      uncertain.clear()
      await credentials.close()
    },
  }
}
