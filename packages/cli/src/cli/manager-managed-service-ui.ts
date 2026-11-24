import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type ManagedServiceUIBindingRequest,
  type ManagedServiceUIBridgeHandler,
  MAX_MANAGED_SERVICE_UI_REQUEST_BYTES,
  parseManagedServiceUIBindingRequest,
} from '../launcher/managed-service-ui-rpc.js'
import type { ManagedServiceUICapabilityMutation } from '../launcher/plugin-lifecycle-model.js'
import type { StartupUIRequest } from '../launcher/startup-ui-rpc.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { ManagerStartupObservation } from './manager-startup-observation.js'
import { ManagerManagedServiceUIGate } from './manager-managed-service-ui-gate.js'
import { ManagerManagedServiceAccounts } from './manager-managed-service-accounts.js'
import { ManagerManagedServiceWebEntry } from './manager-managed-service-web-entry.js'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'
import { canonicalManagedConsoleBrowserOrigins } from '../launcher/managed-console-browser-gateway.js'
import { createManagerManagedServiceAccountRoute } from './manager-managed-service-account-route.js'
import {
  ManagerManagedServiceObservation,
  type ManagerManagedServiceObservationRequest,
} from './manager-managed-service-observation.js'

const secret = /^[a-f0-9]{64}$/u
const localId = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const readOperations = new Set(['get', 'snapshot', 'readCatalog', 'nativeProviders'])
const startupOperations = new Set(['startupRead', 'startupSubscribe', 'startupNext', 'startupClose'])
const observationOperations = new Set(['subscribe', 'next', 'pull', 'closed', 'unsubscribe'])
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
  readonly startup?: true
}

interface OwnerCapability extends ManagerManagedServiceUICapability {}
interface Alias {
  readonly public: ManagerManagedServiceUICapability
  readonly ownerToken: string
}
interface Session {
  readonly context: ManagerRendererChannelContext
  fence: number
  readonly aliases: ReadonlyMap<string, Alias>
  readonly capabilities: readonly OwnerCapability[]
  readonly startup: ManagerStartupObservation
  readonly observation: ManagerManagedServiceObservation
  readonly webEntry?: ManagerManagedServiceWebEntry
  readonly authenticationRequests: Set<string>
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

type AuthenticationRequest = Extract<ManagedServiceUIBindingRequest, { readonly operation: 'authenticate' | 'logout' }>
const authenticationErrorCodes = new Set([
  'stale-generation',
  'binding-replaced',
  'service-unavailable',
  'permission-denied',
  'not-authenticated',
  'already-authenticated',
  'authenticating',
  'authentication-failed',
  'user-cancelled',
  'timeout',
  'stale-revision',
  'cancelled',
  'unavailable',
  'unsupported',
  'not-ready',
])

/** Keep the receipt bound to the requested service and redact backend error text. */
function projectAuthenticationResult(value: unknown, request: AuthenticationRequest): Record<string, unknown> {
  const result = object(value)
  const base = ['$schema', 'contract', 'schemaVersion', 'requestId', 'binding', 'status']
  const action = request.operation === 'authenticate' ? 'login' : 'logout'
  const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-'
    + action + '-result.v1.schema.json'
  if (
    result.$schema !== schema || result.contract !== 'cordisx.managed-service-' + action + '-result/v1'
    || result.schemaVersion !== 1 || result.requestId !== request.request.requestId
    || !isDeepStrictEqual(result.binding, request.binding)
  ) throw unavailable()
  if (result.status === 'accepted') {
    if (
      !sameKeys(result, [...base, 'stateAt', 'sequence'])
      || result.stateAt !== (action === 'login' ? 'authenticated' : 'logged-out')
      || !Number.isSafeInteger(result.sequence) || (result.sequence as number) <= request.request.expectedSequence
    ) throw unavailable()
    return result
  }
  const error = object(result.error)
  if (
    !['denied', 'failed', 'unavailable'].includes(String(result.status))
    || !sameKeys(result, [...base, 'error']) || !sameKeys(error, ['code', 'message'])
    || typeof error.code !== 'string' || !authenticationErrorCodes.has(error.code) || typeof error.message !== 'string'
  ) throw unavailable()
  return { ...result, error: { code: error.code, message: 'Managed service ' + action + ' could not be completed.' } }
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
    return {
      pluginId: item.pluginId,
      pluginGeneration: item.pluginGeneration,
      token: item.token,
      ...(item.startup === true ? { startup: true as const } : {}),
    }
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
      right.some(b =>
        a.pluginId === b.pluginId && a.pluginGeneration === b.pluginGeneration && a.token === b.token
        && a.startup === b.startup
      )
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
  /** Enabled only when the production owner wraps writes in its Manager/lifecycle reservation. */
  readonly allowAuthentication?: boolean
  /** Enabled only when the same reservation covers logout and service revocation. */
  readonly allowLogout?: boolean
  /** Read-only accounts require an admitted Manager and owner-bound validation. */
  readonly allowAccountReads?: boolean
  /** Enabled only with owner-side service, Manager and UI-read reservations. */
  readonly allowAccountToggle?: boolean
  /** Owner-created, isolated browser gateway for this Manager generation. */
  readonly browserConsoleOrigins?: readonly string[]
  readonly runtime: {
    capabilities(): readonly ManagedServiceUICapabilityMutation[]
    waitForInitialManagedServiceUI?(signal: AbortSignal): Promise<void>
    reserveManagedServiceUIContinuity?(): { finish(): number | undefined; cancel(): boolean }
    readonly managedServiceUI: {
      handleBindingValue(value: string, signal?: AbortSignal): Promise<Record<string, unknown>>
      prepareAccountToggle?(value: string): Promise<unknown>
    }
  }
}) {
  const browserConsoleOrigins = input.browserConsoleOrigins === undefined
    ? undefined
    : canonicalManagedConsoleBrowserOrigins(input.browserConsoleOrigins)
  const sessions = new Map<string, Session>()
  const usedRenderers = new Set<string>()
  const usedAliases = new Set<string>()
  const usedObservationIds = new Set<string>()
  const retirements = new Map<string, Promise<boolean>>()
  const gate = new ManagerManagedServiceUIGate()
  const accountReads = input.allowAccountReads ? new ManagerManagedServiceAccounts() : undefined
  if (input.allowAccountToggle && (!accountReads || !input.runtime.managedServiceUI.prepareAccountToggle)) {
    throw unavailable()
  }
  const lifetime = new AbortController()
  let disposed = false

  async function waitForInitialReadiness(signal: AbortSignal): Promise<void> {
    const current = () => {
      try {
        return !disposed && gate.open && !signal.aborted && input.ownerCurrent()
      } catch {
        return false
      }
    }
    if (!current()) throw unavailable()
    try {
      await input.runtime.waitForInitialManagedServiceUI?.(AbortSignal.any([signal, lifetime.signal]))
    } catch {
      throw unavailable()
    }
    if (!current() || lifetime.signal.aborted) throw unavailable()
  }

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
    retirements.set(
      id,
      Promise.all([session.startup.retire(), session.observation.retire(), session.webEntry?.retire() ?? true])
        .then(results => results.every(Boolean)).catch(() => false),
    )
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

  // A previously dispatched observation may complete while a transition is
  // fenced. Its result stays private until continuity is confirmed below.
  function assertObservationCurrent(session: Session, context: ManagerRendererChannelContext): void {
    if (!gate.parked) return assertCurrent(session, context)
    try {
      if (
        !validContext(context) || context.signal !== session.context.signal
        || sessions.get(context.rendererId) !== session || !input.ownerCurrent()
      ) throw unavailable()
    } catch {
      retire(context.rendererId)
      throw unavailable()
    }
  }

  /** Check an existing renderer without issuing capabilities during a reserved handoff. */
  function assertStatusCurrent(context: ManagerRendererChannelContext): void {
    const session = sessions.get(context.rendererId)
    if (!session) throw unavailable()
    if (gate.open) return assertCurrent(session, context)
    if (!gate.parkedCurrent) throw unavailable()
    assertObservationCurrent(session, context)
    if (!gate.parkedCurrent) throw unavailable()
  }

  function sanitize(session: Session, value: unknown, requestId: string): Record<string, unknown> {
    const response = object(checkedResponse(value, session.capabilities.map(item => item.token)))
    if (response.requestId !== requestId || typeof response.ok !== 'boolean') throw unavailable()
    if (response.ok === false) {
      return {
        requestId,
        ok: false,
        code: typeof response.code === 'string' && errorCodes.has(response.code) ? response.code : 'owner-unavailable',
      }
    }
    return { requestId, ok: true, value: response.value }
  }

  function projectInitial(context: ManagerRendererChannelContext): readonly ManagerManagedServiceUICapability[] {
    if (!gate.open || !validContext(context)) throw unavailable()
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
      const projected = Object.freeze({
        pluginId: owner.pluginId,
        pluginGeneration: owner.pluginGeneration,
        token,
        ...(owner.startup === true ? { startup: true as const } : {}),
      })
      aliases.set(token, { public: projected, ownerToken: owner.token })
    }
    let session!: Session
    const allocateId = () => {
      if (usedObservationIds.size >= 16_384) throw unavailable()
      let id: string
      do id = randomBytes(32).toString('hex')
      while (usedObservationIds.has(id) || usedAliases.has(id) || capabilities.some(item => item.token === id))
      usedObservationIds.add(id)
      return id
    }
    const observationInput = {
      context,
      runtimeGeneration: input.runtimeGeneration,
      allocateId,
      assertCurrent: (parkable = false) =>
        parkable ? assertObservationCurrent(session, context) : assertCurrent(session, context),
      invoke: async (value: string, signal?: AbortSignal) =>
        await input.runtime.managedServiceUI.handleBindingValue(value, signal),
      sanitize: (value: unknown, requestId: string) => sanitize(session, value, requestId),
    }
    const startup = new ManagerStartupObservation(observationInput)
    const observation = new ManagerManagedServiceObservation(observationInput)
    const webEntry = browserConsoleOrigins === undefined ? undefined : new ManagerManagedServiceWebEntry({
      context,
      runtimeGeneration: input.runtimeGeneration,
      consoleOrigins: browserConsoleOrigins,
      allocateId,
      assertCurrent: () => assertCurrent(session, context),
      onUncertain: () => retire(context.rendererId),
      invoke: observationInput.invoke,
      sanitize: observationInput.sanitize,
    })
    session = {
      context,
      fence: currentFence,
      aliases,
      capabilities,
      startup,
      observation,
      ...(webEntry === undefined ? {} : { webEntry }),
      authenticationRequests: new Set(),
      onAbort: () => retire(context.rendererId),
    }
    usedRenderers.add(context.rendererId)
    sessions.set(context.rendererId, session)
    context.signal.addEventListener('abort', session.onAbort, { once: true })
    assertCurrent(session, context)
    return [...aliases.values()].map(alias => alias.public)
  }

  const rawChannel: ManagerRendererChannel = {
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
        if (startupOperations.has(request.operation) && alias.public.startup) {
          const forwarded = { ...request, token: alias.ownerToken }
          const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
          const validation = validator(alias.ownerToken, input.profileId, input.runtimeGeneration)
          const parsed = parseManagedServiceUIBindingRequest(forwarded, validation, owner)
          if (!startupOperations.has(parsed.operation)) throw unavailable()
          return session.startup.prepare(parsed as StartupUIRequest, alias)
        }
        if (observationOperations.has(request.operation)) {
          const forwarded = { ...request, token: alias.ownerToken }
          const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
          const validation = validator(alias.ownerToken, input.profileId, input.runtimeGeneration)
          const parsed = parseManagedServiceUIBindingRequest(forwarded, validation, owner)
          if (!observationOperations.has(parsed.operation)) throw unavailable()
          return session.observation.prepare(parsed as ManagerManagedServiceObservationRequest, alias)
        }
        if (session.webEntry && ['readWebEntry', 'cancelWebEntry', 'consoleBrowser'].includes(request.operation)) {
          if (context.admitted !== true) throw unavailable()
          const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
          const parsed = parseManagedServiceUIBindingRequest(
            { ...request, token: alias.ownerToken },
            validator(alias.ownerToken, input.profileId, input.runtimeGeneration),
            owner,
          )
          if (parsed.operation === 'readWebEntry' || parsed.operation === 'cancelWebEntry') {
            return session.webEntry.prepareWeb(alias, parsed)
          }
          if (parsed.operation === 'consoleBrowser') return session.webEntry.prepareBrowser(alias, parsed)
          throw unavailable()
        }
        if (request.operation === 'toggleAccount' && input.allowAccountToggle && accountReads) {
          if (context.admitted !== true) throw unavailable()
          const forwarded = { ...request, token: alias.ownerToken }
          const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
          const parsed = parseManagedServiceUIBindingRequest(
            forwarded,
            validator(alias.ownerToken, input.profileId, input.runtimeGeneration),
            owner,
          )
          if (parsed.operation !== 'toggleAccount') throw unavailable()
          return createManagerManagedServiceAccountRoute({
            context,
            owner,
            ownerToken: alias.ownerToken,
            requestId,
            scope,
            forwarded,
            parsed,
            accounts: accountReads,
            runtime: input.runtime.managedServiceUI,
            sanitize: (value, id) => sanitize(session, value, id),
            assertCurrent: () => assertCurrent(session, context),
          })
        }
        if (
          request.operation === 'authenticate' && input.allowAuthentication
          || request.operation === 'logout' && input.allowLogout
        ) {
          if (context.admitted !== true) throw unavailable()
          const forwarded = { ...request, token: alias.ownerToken }
          const owner = { pluginId: alias.public.pluginId, pluginGeneration: alias.public.pluginGeneration }
          const validation = validator(alias.ownerToken, input.profileId, input.runtimeGeneration)
          const parsed = parseManagedServiceUIBindingRequest(forwarded, validation, owner)
          if (parsed.operation !== 'authenticate' && parsed.operation !== 'logout') throw unavailable()
          const action = parsed.operation === 'authenticate' ? 'login' : 'logout'
          return {
            mode: 'write',
            managedServiceAuthentication: {
              pluginId: alias.public.pluginId,
              pluginGeneration: alias.public.pluginGeneration,
              serviceId: parsed.serviceId,
              expectedSequence: parsed.request.expectedSequence,
              action,
            },
            async dispatch() {
              assertCurrent(session, context)
              if (session.authenticationRequests.has(requestId) || session.authenticationRequests.size >= 4_096) {
                throw unavailable()
              }
              session.authenticationRequests.add(requestId)
              if (action === 'logout') {
                const checkId = 'check-' + randomBytes(16).toString('hex')
                const check = sanitize(
                  session,
                  await input.runtime.managedServiceUI.handleBindingValue(
                    JSON.stringify({
                      version: 1,
                      token: alias.ownerToken,
                      requestId: checkId,
                      operation: 'snapshot',
                      scope,
                      serviceId: parsed.serviceId,
                      binding: parsed.binding,
                    }),
                    context.signal,
                  ),
                  checkId,
                )
                assertCurrent(session, context)
                const snapshot = object(check.value)
                const projection = object(snapshot.projection)
                const capabilities = object(projection.capabilities)
                if (
                  check.ok !== true || snapshot.status !== 'available'
                  || !isDeepStrictEqual(projection.binding, parsed.binding)
                  || !Number.isSafeInteger(projection.sequence) || (projection.sequence as number) < 0
                  || typeof capabilities.logout !== 'boolean'
                ) throw unavailable()
                if (!capabilities.logout || projection.sequence !== parsed.request.expectedSequence) {
                  return {
                    requestId,
                    ok: true,
                    value: {
                      $schema:
                        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-result.v1.schema.json',
                      contract: 'cordisx.managed-service-logout-result/v1',
                      schemaVersion: 1,
                      requestId: parsed.request.requestId,
                      binding: parsed.binding,
                      status: 'denied',
                      error: {
                        code: capabilities.logout ? 'stale-revision' : 'unsupported',
                        message: 'Managed service logout is unavailable for this request.',
                      },
                    },
                  }
                }
              }
              const response = sanitize(
                session,
                await input.runtime.managedServiceUI.handleBindingValue(JSON.stringify(forwarded), context.signal),
                requestId,
              )
              assertCurrent(session, context)
              if (response.ok !== true) throw unavailable()
              const result = projectAuthenticationResult(response.value, parsed)
              // A failed action can have changed the external service before
              // the backend reported an error; do not present it as retryable.
              if (result.status === 'failed' || result.status === 'unavailable') throw unavailable()
              const confirmationId = 'confirm-' + randomBytes(16).toString('hex')
              const confirmation = sanitize(
                session,
                await input.runtime.managedServiceUI.handleBindingValue(
                  JSON.stringify({
                    version: 1,
                    token: alias.ownerToken,
                    requestId: confirmationId,
                    operation: 'snapshot',
                    scope,
                    serviceId: parsed.serviceId,
                    binding: parsed.binding,
                  }),
                  context.signal,
                ),
                confirmationId,
              )
              assertCurrent(session, context)
              const snapshot = object(confirmation.value)
              const projection = object(snapshot.projection)
              const auth = object(projection.auth)
              if (
                confirmation.ok !== true || snapshot.status !== 'available'
                || !isDeepStrictEqual(projection.binding, parsed.binding)
                || !Number.isSafeInteger(projection.sequence) || (projection.sequence as number) < 0
                || result.status === 'accepted'
                  && ((projection.sequence as number) < (result.sequence as number)
                    || auth.state !== (action === 'login' ? 'authenticated' : 'logged-out'))
              ) throw unavailable()
              return { requestId, ok: true, value: result }
            },
          }
        }
        const accountRead = request.operation === 'readAccounts' && accountReads !== undefined
          && context.admitted === true
        if (!readOperations.has(request.operation) && !accountRead) {
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
        if (!readOperations.has(parsed.operation) && !(accountRead && parsed.operation === 'readAccounts')) {
          throw unavailable()
        }
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
            const response = sanitize(session, result, requestId)
            if (response.ok === false) return response
            if (parsed.operation === 'readAccounts' && accountReads) {
              const projected = await accountReads.project(response.value, parsed.binding)
              assertCurrent(session, context)
              if (projected.status === 'available') {
                const confirmationId = 'accounts-' + randomBytes(16).toString('hex')
                const confirmation = sanitize(
                  session,
                  await input.runtime.managedServiceUI.handleBindingValue(
                    JSON.stringify({ ...forwarded, requestId: confirmationId, operation: 'snapshot' }),
                    context.signal,
                  ),
                  confirmationId,
                )
                assertCurrent(session, context)
                const snapshot = object(confirmation.value)
                const projection = object(snapshot.projection)
                if (
                  confirmation.ok !== true || snapshot.status !== 'available'
                  || !isDeepStrictEqual(projection.binding, parsed.binding)
                  || projection.serviceGeneration !== projected.accounts.serviceGeneration
                ) throw unavailable()
              }
              return { requestId, ok: true, value: projected }
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
              || typeof capabilities.readCatalog !== 'boolean' || typeof capabilities.logout !== 'boolean'
              || capabilities.readAccounts !== undefined && typeof capabilities.readAccounts !== 'boolean'
              || capabilities.accountTogglePlan !== undefined && typeof capabilities.accountTogglePlan !== 'boolean'
            ) throw unavailable()
            // Reuse the native parser to check the returned binding's owner and scope.
            parseManagedServiceUIBindingRequest(
              { ...forwarded, operation: 'snapshot', binding: service.binding },
              validation,
              owner,
            )
            const webEntry = context.admitted === true && session.webEntry
              ? session.webEntry.project(
                alias,
                parsed.serviceId,
                service.binding as ManagedServiceBindingV1,
                service.webEntry,
                service.authenticatedConsole,
              )
              : {}
            let logout = false
            if (input.allowLogout && capabilities.logout) {
              const checkId = 'capability-' + randomBytes(16).toString('hex')
              const check = sanitize(
                session,
                await input.runtime.managedServiceUI.handleBindingValue(
                  JSON.stringify({
                    ...forwarded,
                    requestId: checkId,
                    operation: 'snapshot',
                    binding: service.binding,
                  }),
                  context.signal,
                ),
                checkId,
              )
              assertCurrent(session, context)
              if (check.ok === true) {
                const snapshot = object(check.value)
                if (snapshot.status === 'available') {
                  const projection = object(snapshot.projection)
                  const projectedCapabilities = object(projection.capabilities)
                  if (
                    !isDeepStrictEqual(projection.binding, service.binding)
                    || typeof projectedCapabilities.logout !== 'boolean'
                  ) throw unavailable()
                  logout = projectedCapabilities.logout
                } else if (snapshot.status !== 'unavailable') throw unavailable()
              }
            }
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
                  ...webEntry,
                  ...(input.allowAuthentication && service.authenticationTimeoutMs !== undefined
                      && Number.isSafeInteger(service.authenticationTimeoutMs)
                      && (service.authenticationTimeoutMs as number) >= 100
                      && (service.authenticationTimeoutMs as number) <= 300_000
                    ? { authenticationTimeoutMs: service.authenticationTimeoutMs }
                    : {}),
                  capabilities: {
                    logout,
                    readCatalog: capabilities.readCatalog,
                    ...(input.allowAccountReads && capabilities.readAccounts === true ? { readAccounts: true } : {}),
                    ...(input.allowAccountToggle && capabilities.accountTogglePlan === true
                        && capabilities.readAccounts === true
                      ? { toggleAccount: true, observeAccounts: true }
                      : {}),
                    accountControl: false,
                  },
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

  const channel: ManagerRendererChannel = {
    prepare(payload, context) {
      if (!gate.open) throw unavailable()
      const prepared = rawChannel.prepare(payload, context)
      return {
        ...prepared,
        async dispatch() {
          if (prepared.longLivedRead) {
            if (!gate.open) throw unavailable()
            const result = await prepared.dispatch().then(
              value => ({ ok: true as const, value }),
              error => ({ ok: false as const, error }),
            )
            const finish = await gate.beginWhenOpen(context.signal)
            try {
              const session = sessions.get(context.rendererId)
              if (!session) throw unavailable()
              assertCurrent(session, context)
              if (!result.ok) throw result.error
              return result.value
            } finally {
              finish()
            }
          }
          const finish = gate.begin()
          try {
            return await prepared.dispatch()
          } finally {
            finish()
          }
        },
      }
    },
  }

  /** Stop and drain service UI reads while one owner action is in progress. */
  async function reserveAccountAction(isCurrent: () => boolean) {
    if (!input.allowAccountToggle || !gate.open) throw unavailable()
    const cohort = [...sessions.values()]
    const initialFence = fence()
    const capabilities = copyCapabilities(input.runtime.capabilities())
    const current = () => {
      try {
        return isCurrent() && !disposed && input.ownerCurrent() && fence() === initialFence
          && sameCapabilities(capabilities, copyCapabilities(input.runtime.capabilities()))
          && sessions.size === cohort.length && cohort.every(session =>
            sessions.get(session.context.rendererId) === session && !session.context.signal.aborted
          )
      } catch {
        return false
      }
    }
    try {
      return await gate.reserve(current)
    } catch {
      if (!gate.open) { for (const session of cohort) retire(session.context.rendererId) }
      throw unavailable()
    }
  }

  /**
   * Owner-only: freeze and drain this bridge before asking the runtime for its
   * continuity evidence. The enclosing lifecycle still owns all other fences.
   */
  async function reserveTransition(timeoutMs?: number): Promise<{
    isCurrent(): boolean
    resume(): boolean
    cancel(): boolean
    fence(): void
  }> {
    if (!gate.open || !input.runtime.reserveManagedServiceUIContinuity) throw unavailable()
    const cohort = [...sessions.values()]
    const initialFence = fence()
    const capabilities = copyCapabilities(input.runtime.capabilities())
    for (const session of cohort) assertCurrent(session, session.context)
    const current = () => {
      try {
        return !disposed && input.ownerCurrent() && sessions.size === cohort.length
          && cohort.every(session =>
            sessions.get(session.context.rendererId) === session && !session.context.signal.aborted
          )
      } catch {
        return false
      }
    }
    let lease: Awaited<ReturnType<ManagerManagedServiceUIGate['reserve']>>
    try {
      lease = await gate.reserve(current, timeoutMs)
    } catch {
      if (!gate.open) { for (const session of cohort) retire(session.context.rendererId) }
      throw unavailable()
    }
    let continuity: ReturnType<NonNullable<typeof input.runtime.reserveManagedServiceUIContinuity>>
    try {
      if (
        !lease.isCurrent() || fence() !== initialFence
        || !sameCapabilities(capabilities, copyCapabilities(input.runtime.capabilities())) || fence() !== initialFence
      ) throw unavailable()
      continuity = input.runtime.reserveManagedServiceUIContinuity()
    } catch {
      lease.fence()
      for (const session of cohort) retire(session.context.rendererId)
      throw unavailable()
    }
    let ended = false
    const fail = () => {
      if (ended) return
      ended = true
      try {
        continuity.cancel()
      } catch { /* Failed continuity remains fenced. */ }
      lease.fence()
      for (const session of cohort) retire(session.context.rendererId)
    }
    const stable = (expected: number): boolean => {
      try {
        return lease.isCurrent() && fence() === expected
          && sameCapabilities(capabilities, copyCapabilities(input.runtime.capabilities())) && fence() === expected
      } catch {
        return false
      }
    }
    return {
      isCurrent: () => !ended && lease.isCurrent(),
      resume: () => {
        if (ended || !lease.isCurrent()) {
          fail()
          return false
        }
        let next: number | undefined
        try {
          next = continuity.finish()
        } catch { /* The result is unavailable. */ }
        if (next === undefined || !stable(next)) {
          fail()
          return false
        }
        for (const session of cohort) session.fence = next
        if (!lease.release()) {
          fail()
          return false
        }
        ended = true
        return true
      },
      cancel: () => {
        if (ended || !lease.isCurrent()) {
          fail()
          return false
        }
        let canceled = false
        try {
          canceled = continuity.cancel()
        } catch { /* The result is unavailable. */ }
        if (!canceled || !stable(initialFence) || !lease.release()) {
          fail()
          return false
        }
        ended = true
        return true
      },
      fence: fail,
    }
  }

  return {
    waitForInitialReadiness,
    projectInitial,
    assertStatusCurrent,
    reserveTransition,
    reserveAccountAction,
    /** Abort one owner-issued projection if its bootstrap cannot complete. */
    retire(context: ManagerRendererChannelContext): void {
      const session = sessions.get(context.rendererId)
      if (session?.context.signal === context.signal) retire(context.rendererId)
    },
    waitForRetirement(rendererId: string): Promise<boolean> {
      return retirements.get(rendererId) ?? Promise.resolve(true)
    },
    /** Check the owner-built renderer source before any bytes reach a browser. */
    assertBundleSafe(context: ManagerRendererChannelContext, source: string): void {
      const session = sessions.get(context.rendererId)
      if (!gate.open || !session || typeof source !== 'string') throw unavailable()
      assertCurrent(session, context)
      if (session.capabilities.some(owner => source.includes(owner.token))) throw unavailable()
      assertCurrent(session, context)
    },
    channel,
    dispose(): void {
      disposed = true
      lifetime.abort()
      gate.close()
      for (const id of sessions.keys()) retire(id)
      usedRenderers.clear()
      usedAliases.clear()
      usedObservationIds.clear()
    },
  }
}
