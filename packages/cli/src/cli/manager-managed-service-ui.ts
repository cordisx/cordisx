import { randomBytes } from 'node:crypto'
import {
  type ManagedServiceUIBridgeHandler,
  MAX_MANAGED_SERVICE_UI_REQUEST_BYTES,
  parseManagedServiceUIBindingRequest,
} from '../launcher/managed-service-ui-rpc.js'
import type { ManagedServiceUICapabilityMutation } from '../launcher/plugin-lifecycle-model.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

const secret = /^[a-f0-9]{64}$/u
const localId = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const readOperations = new Set(['get', 'snapshot', 'readCatalog', 'nativeProviders'])
const errorCodes = new Set([
  'service-not-declared',
  'binding-replaced',
  'stale-generation',
  'disposed',
  'owner-unavailable',
])
const prohibitedKey =
  /^(?:secret|secrets|password|credential|credentials|cookie|cookies|port|runtimeHandle|runtimeHandles|token|accessToken|refreshToken|apiKey|authorization|privateKey)$/iu

/** This capability is safe to place in one renderer's bundle, never another's. */
export interface ManagerManagedServiceUICapability {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly token: string
}

interface OwnerCapability extends ManagerManagedServiceUICapability {}
interface Alias {
  readonly public: ManagerManagedServiceUICapability
  readonly ownerToken: string
}
interface Session {
  readonly context: ManagerRendererChannelContext
  readonly fence: number
  readonly aliases: ReadonlyMap<string, Alias>
  readonly capabilities: readonly OwnerCapability[]
  readonly onAbort: () => void
}

function unavailable(): Error {
  return new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
}

function copyCapabilities(value: readonly ManagedServiceUICapabilityMutation[]): readonly OwnerCapability[] {
  if (!Array.isArray(value) || value.length > 256) throw unavailable()
  const plugins = new Set<string>()
  const tokens = new Set<string>()
  const copied = value.map(item => {
    if (
      !item || typeof item.pluginId !== 'string' || !localId.test(item.pluginId)
      || typeof item.pluginGeneration !== 'string' || !opaqueId.test(item.pluginGeneration)
      || typeof item.token !== 'string' || item.token.length < 32 || item.token.length > 512
      || plugins.has(item.pluginId) || tokens.has(item.token)
    ) throw unavailable()
    plugins.add(item.pluginId)
    tokens.add(item.token)
    return { pluginId: item.pluginId, pluginGeneration: item.pluginGeneration, token: item.token }
  })
  if (
    copied.some(item =>
      copied.some(owner => item.pluginId.includes(owner.token) || item.pluginGeneration.includes(owner.token))
    )
  ) throw unavailable()
  return copied
}

function sameCapabilities(left: readonly OwnerCapability[], right: readonly OwnerCapability[]): boolean {
  return left.length === right.length
    && left.every(a =>
      right.some(b => a.pluginId === b.pluginId && a.pluginGeneration === b.pluginGeneration && a.token === b.token)
    )
}

/**
 * Validate the complete JSON response before it crosses the owner boundary.
 * The real handler additionally sanitizes its source projections. This check
 * ensures even an unexpected handler response cannot disclose a route token.
 */
function checkedResponse(value: unknown, privateTokens: readonly string[]): unknown {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw unavailable()
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) throw unavailable()
  const parsed: unknown = JSON.parse(encoded)
  const pending: unknown[] = [parsed]
  let count = 0
  while (pending.length > 0) {
    if (++count > 50_000) throw unavailable()
    const current = pending.pop()
    if (typeof current === 'string') {
      if (privateTokens.some(token => current.includes(token))) throw unavailable()
    } else if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (prohibitedKey.test(key) || privateTokens.some(token => key.includes(token))) throw unavailable()
        pending.push(item)
      }
    }
  }
  return parsed
}

function validator(token: string, profileId: string, generation: string): ManagedServiceUIBridgeHandler {
  return {
    token,
    profileId,
    generation,
    async handle() {
      throw unavailable()
    },
    async disposeOwner() {
      throw unavailable()
    },
    async dispose() {
      throw unavailable()
    },
  }
}

/**
 * Owner-only bridge. `projectInitial` MUST receive the authenticated context
 * supplied by ManagerRendererSessions, not a context assembled by a browser.
 *
 * `readLifecycleFence` is an owner-provided monotonic epoch: it MUST return
 * undefined while a transaction or other route change is in progress, and
 * strictly advance before the new stable state can be observed. It MUST never
 * be reused, including after rollback. Until the real owner exposes that fence
 * this bridge must not be wired to production. A changed fence retires the
 * whole renderer rather than guessing how staged capabilities are projected.
 */
export function createManagerManagedServiceUIBridge(input: {
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly ownerGeneration: string
  readonly ownerCurrent: () => boolean
  readonly readLifecycleFence: () => number | undefined
  readonly runtime: {
    capabilities(): readonly ManagedServiceUICapabilityMutation[]
    readonly managedServiceUI: {
      handleBindingValue(value: string, signal?: AbortSignal): Promise<Record<string, unknown>>
    }
  }
}) {
  const sessions = new Map<string, Session>()
  const usedRenderers = new Set<string>()
  const usedAliases = new Set<string>()
  let disposed = false

  function fence(): number {
    try {
      const value = input.readLifecycleFence()
      if (disposed || !input.ownerCurrent() || !Number.isSafeInteger(value) || value! < 0) throw unavailable()
      return value!
    } catch {
      throw unavailable()
    }
  }

  function retire(id: string): void {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    session.context.signal.removeEventListener('abort', session.onAbort)
  }

  function validContext(context: ManagerRendererChannelContext): boolean {
    return !!context && context.profileId === input.profileId && context.ownerGeneration === input.ownerGeneration
      && typeof context.rendererId === 'string' && secret.test(context.rendererId)
      && !!context.signal && !context.signal.aborted
  }

  function assertCurrent(session: Session, context: ManagerRendererChannelContext): void {
    try {
      if (
        !validContext(context) || context.signal !== session.context.signal
        || sessions.get(context.rendererId) !== session || fence() !== session.fence
        || !sameCapabilities(session.capabilities, copyCapabilities(input.runtime.capabilities()))
        || fence() !== session.fence
      ) throw unavailable()
    } catch {
      retire(context.rendererId)
      throw unavailable()
    }
  }

  function projectInitial(context: ManagerRendererChannelContext): readonly ManagerManagedServiceUICapability[] {
    if (!validContext(context)) throw unavailable()
    const existing = sessions.get(context.rendererId)
    if (existing) {
      assertCurrent(existing, context)
      return [...existing.aliases.values()].map(alias => alias.public)
    }
    if (usedRenderers.has(context.rendererId) || usedRenderers.size >= 4_096 || sessions.size >= 16) {
      throw unavailable()
    }
    const currentFence = fence()
    let capabilities: readonly OwnerCapability[]
    try {
      capabilities = copyCapabilities(input.runtime.capabilities())
    } catch {
      throw unavailable()
    }
    if (usedAliases.size + capabilities.length > 16_384) throw unavailable()
    if (fence() !== currentFence || !validContext(context)) throw unavailable()
    const aliases = new Map<string, Alias>()
    for (const owner of capabilities) {
      let token: string
      do token = randomBytes(32).toString('hex')
      while (usedAliases.has(token) || capabilities.some(item => token.includes(item.token)))
      usedAliases.add(token)
      const projected = Object.freeze({ pluginId: owner.pluginId, pluginGeneration: owner.pluginGeneration, token })
      aliases.set(token, { public: projected, ownerToken: owner.token })
    }
    const session: Session = {
      context,
      fence: currentFence,
      aliases,
      capabilities,
      onAbort: () => retire(context.rendererId),
    }
    usedRenderers.add(context.rendererId)
    sessions.set(context.rendererId, session)
    context.signal.addEventListener('abort', session.onAbort, { once: true })
    assertCurrent(session, context)
    return [...aliases.values()].map(alias => alias.public)
  }

  const channel: ManagerRendererChannel = {
    prepare(payload, context) {
      try {
        const session = sessions.get(context.rendererId)
        if (!session) throw unavailable()
        assertCurrent(session, context)
        if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_MANAGED_SERVICE_UI_REQUEST_BYTES) {
          throw unavailable()
        }
        const request = object(JSON.parse(payload))
        const scope = object(request.scope)
        const alias = typeof request.token === 'string' ? session.aliases.get(request.token) : undefined
        if (
          !alias || request.version !== 1 || typeof request.requestId !== 'string' || !opaqueId.test(request.requestId)
          || typeof request.operation !== 'string'
          || !sameKeys(scope, ['profileId', 'runtimeGeneration', 'pluginGeneration'])
          || scope.profileId !== input.profileId || scope.runtimeGeneration !== input.runtimeGeneration
          || scope.pluginGeneration !== alias.public.pluginGeneration
        ) throw unavailable()
        const requestId = request.requestId
        if (!readOperations.has(request.operation)) {
          return {
            mode: 'read',
            async dispatch() {
              assertCurrent(session, context)
              return { requestId, ok: false, code: 'unsupported' }
            },
          }
        }
        const forwarded = { ...request, token: alias.ownerToken }
        const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
        const validation = validator(alias.ownerToken, input.profileId, input.runtimeGeneration)
        const parsed = parseManagedServiceUIBindingRequest(forwarded, validation, owner)
        if (!readOperations.has(parsed.operation)) throw unavailable()
        return {
          mode: 'read',
          async dispatch() {
            assertCurrent(session, context)
            let result: Record<string, unknown>
            try {
              result = await input.runtime.managedServiceUI.handleBindingValue(
                JSON.stringify(forwarded),
                context.signal,
              )
            } catch {
              throw unavailable()
            }
            assertCurrent(session, context)
            const privateTokens = session.capabilities.map(item => item.token)
            const response = object(checkedResponse(result, privateTokens))
            if (response.requestId !== requestId || typeof response.ok !== 'boolean') throw unavailable()
            if (response.ok === false) {
              return {
                requestId,
                ok: false,
                code: typeof response.code === 'string' && errorCodes.has(response.code)
                  ? response.code
                  : 'owner-unavailable',
              }
            }
            if (parsed.operation !== 'get') return { requestId, ok: true, value: response.value }
            const value = object(response.value)
            if (value.status === 'unavailable') {
              return {
                requestId,
                ok: true,
                value: { status: 'unavailable', code: 'disposed', message: 'binding-unavailable' },
              }
            }
            const service = object(value.service)
            const capabilities = object(service.capabilities)
            if (
              value.status !== 'available' || service.contract !== 'cordisx.managed-service/v1'
              || service.schemaVersion !== 1 || typeof service.$schema !== 'string'
              || typeof capabilities.readCatalog !== 'boolean'
            ) throw unavailable()
            // Reuse the native parser to check the returned binding's owner and scope.
            parseManagedServiceUIBindingRequest(
              { ...forwarded, operation: 'snapshot', binding: service.binding },
              validation,
              owner,
            )
            return {
              requestId,
              ok: true,
              value: {
                status: 'available',
                service: {
                  $schema: service.$schema,
                  contract: service.contract,
                  schemaVersion: 1,
                  binding: service.binding,
                  capabilities: { logout: false, readCatalog: capabilities.readCatalog, accountControl: false },
                },
              },
            }
          },
        }
      } catch {
        throw unavailable()
      }
    },
  }

  return {
    projectInitial,
    /** Abort one owner-issued projection if its bootstrap cannot complete. */
    retire(context: ManagerRendererChannelContext): void {
      const session = sessions.get(context.rendererId)
      if (session?.context.signal === context.signal) retire(context.rendererId)
    },
    /** Check the owner-built renderer source before any bytes reach a browser. */
    assertBundleSafe(context: ManagerRendererChannelContext, source: string): void {
      const session = sessions.get(context.rendererId)
      if (!session || typeof source !== 'string') throw unavailable()
      assertCurrent(session, context)
      if (session.capabilities.some(owner => source.includes(owner.token))) throw unavailable()
      assertCurrent(session, context)
    },
    channel,
    dispose(): void {
      disposed = true
      for (const id of sessions.keys()) retire(id)
      usedRenderers.clear()
      usedAliases.clear()
    },
  }
}
