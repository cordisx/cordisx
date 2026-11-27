import { isRendererManagementRead } from '../management/renderer-operation-mode.js'
import { MANAGER_DOCUMENT_REQUEST_BYTES, MANAGER_RENDERER_BINDING_WIRE_BYTES } from './owner-document-limits.js'

/** Host-private channels. The owner must explicitly grant each one per renderer. */
export const INDEPENDENT_HOST_CHANNELS = {
  config: ['__cordisxConfigRequestV1', '__cordisxConfigReceiveV1'],
  'plugin-management': ['__cordisxPluginManagementRequestV1', '__cordisxPluginManagementReceiveV1'],
  'plugin-lifecycle': ['__cordisxPluginLifecycleRequestV1', '__cordisxPluginLifecycleReceiveV1'],
  'permission-policy': ['__cordisxPermissionPolicyRequestV1', '__cordisxPermissionPolicyReceiveV1'],
  'service-config': ['__cordisxServiceConfigRequestV1', '__cordisxServiceConfigReceiveV1'],
  'managed-service-ui': ['__cordisxManagedServiceUIRequestV1', '__cordisxManagedServiceUIReceiveV1'],
  'model-services': ['__cordisxModelServicesRequestV1', '__cordisxModelServicesReceiveV1'],
  'native-catalog': ['__cordisxNativeCatalogRequestV1', '__cordisxNativeCatalogReceiveV1'],
  'channel-actions': ['__cordisxChannelActionsRequestV1', '__cordisxChannelActionsReceiveV1'],
  'channel-credentials': ['__cordisxChannelCredentialRequestV1', '__cordisxChannelCredentialReceiveV1'],
  'desktop-package-config': ['__cordisxDesktopPackageConfigRequestV1', '__cordisxDesktopPackageConfigReceiveV1'],
  marketplace: ['__cordisxMarketplaceRequestV1', '__cordisxMarketplaceReceiveV1'],
  'owner-document': ['__cordisxOwnerDocumentRequestV1', '__cordisxOwnerDocumentReceiveV1'],
  provider: ['__cordisxProviderRequestV1', '__cordisxProviderReceiveV1'],
} as const

export type IndependentHostChannel = keyof typeof INDEPENDENT_HOST_CHANNELS
type Binding = (payload: string) => void
type BindingWindow = Window & Record<string, unknown>
interface Pending {
  readonly channel: IndependentHostChannel
  readonly requestId: string
  readonly receiverName: string
  readonly receiver: Binding
  readonly controller: AbortController
  readonly readOnly: boolean
  readonly resumeAfterOwnerRetirement: boolean
  dispatched: boolean
}
const MAX_IN_FLIGHT = 64
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024
const MAX_BUSY_READ_WAIT_MS = 3_000
// The manager web server enforces this limit on the complete JSON envelope,
// in bytes, before dispatching to the owner.
const MAX_WIRE_BYTES = 1_048_576

async function yieldObservation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('independent-host-session-revoked')
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, 100)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new Error('independent-host-session-revoked'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function requestId(payload: string, channel: IndependentHostChannel): string {
  if (payload.length > MAX_PAYLOAD_CHARS) throw new Error('independent-host-request-too-large')
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error('independent-host-request-invalid')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('independent-host-request-invalid')
  }
  const envelope = value as Record<string, unknown>
  const nested = envelope.request ?? envelope.privateRequest
  const nestedId = nested !== null && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>).requestId
    : undefined
  // Managed-service actions contain a separate domain request id inside the
  // transport envelope. Other channels require their two ids to agree.
  if (
    channel !== 'managed-service-ui' && envelope.requestId !== undefined && nestedId !== undefined
    && envelope.requestId !== nestedId
  ) {
    throw new Error('independent-host-request-invalid')
  }
  const id = envelope.requestId ?? nestedId
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(id)) {
    throw new Error('independent-host-request-invalid')
  }
  return id
}

/**
 * Transport only: the authenticated sidecar and owner still validate every
 * operation, capability, plugin identity, generation and renderer session.
 * This does not create or widen any Host service authority.
 */
export function installIndependentHostBindings(input: {
  readonly window: Window
  readonly sessionToken: string
  readonly channels: readonly IndependentHostChannel[]
  /** Owner channels that require a lifecycle participant wait for admission. */
  readonly rendererAdmission?: Promise<boolean>
  /** True only while a trusted navigation is leaving this document. */
  readonly isNavigating?: () => boolean
  readonly onSessionLost?: (reason?: 'result-unknown') => void
}): (() => void) & {
  canResume(): boolean
  canQuiesce(): boolean
  canRecoverAfterTransport(): boolean
  hasUncertainWrite(): boolean
} {
  if (!/^[a-f0-9]{64}$/u.test(input.sessionToken)) throw new Error('independent-host-session-invalid')
  const host = input.window as BindingWindow
  const granted = new Set(input.channels)
  if (granted.size !== input.channels.length) throw new Error('independent-host-channels-invalid')
  for (const channel of granted) {
    if (!Object.hasOwn(INDEPENDENT_HOST_CHANNELS, channel)) throw new Error('independent-host-channels-invalid')
    const [name] = INDEPENDENT_HOST_CHANNELS[channel]
    if (host[name] !== undefined) throw new Error('independent-host-binding-already-installed')
  }
  const pending = new Map<string, Pending>()
  const installed = new Map<string, Binding>()
  let closed = false
  let uncertainNavigationWrite = false
  const deliver = (key: string, payload: string) => {
    const request = pending.get(key)
    if (request === undefined) return
    pending.delete(key)
    if (host[request.receiverName] === request.receiver) {
      try {
        request.receiver(payload)
      } catch {
        // One renderer callback must not prevent retiring its other requests.
      }
    }
  }
  const failure = (key: string, reason: 'INDEPENDENT_HOST_RESULT_UNKNOWN' | 'INDEPENDENT_HOST_SESSION_REVOKED') => {
    const request = pending.get(key)
    if (request !== undefined) {
      const recoveryDuringNavigation = request.resumeAfterOwnerRetirement && input.isNavigating?.() === true
      const permissionRecovery = recoveryDuringNavigation && request.channel === 'permission-policy'
        && reason === 'INDEPENDENT_HOST_RESULT_UNKNOWN' && request.dispatched
      if (permissionRecovery) uncertainNavigationWrite = true
      const uncertain = reason === 'INDEPENDENT_HOST_RESULT_UNKNOWN' && request.dispatched && !request.readOnly
        && !recoveryDuringNavigation
      deliver(key, JSON.stringify({ requestId: request.requestId, ok: false, error: reason, code: reason }))
      if (uncertain && !closed) {
        dispose()
        input.onSessionLost?.('result-unknown')
      }
    }
  }
  const dispose = () => {
    if (closed) return
    closed = true
    for (const [name, binding] of installed) if (host[name] === binding) delete host[name]
    for (const [key, request] of pending) {
      request.controller.abort()
      // A dispatched operation may have committed even if the session vanished
      // before its response arrived. Never report a definite cancellation.
      failure(key, request.dispatched ? 'INDEPENDENT_HOST_RESULT_UNKNOWN' : 'INDEPENDENT_HOST_SESSION_REVOKED')
    }
  }
  for (const channel of granted) {
    const [name, receiverName] = INDEPENDENT_HOST_CHANNELS[channel]
    const binding: Binding = payload => {
      if (closed) throw new Error('independent-host-session-revoked')
      const id = requestId(payload, channel)
      const body = JSON.stringify({ channel, payload })
      if (
        channel === 'owner-document'
        && (new TextEncoder().encode(payload).byteLength > MANAGER_DOCUMENT_REQUEST_BYTES
          || new TextEncoder().encode(body).byteLength > MANAGER_RENDERER_BINDING_WIRE_BYTES)
      ) throw new Error('independent-host-request-too-large')
      if (new TextEncoder().encode(body).byteLength > MAX_WIRE_BYTES) {
        throw new Error('independent-host-request-too-large')
      }
      const key = `${channel}\u0000${id}`
      if (pending.has(key) || pending.size >= MAX_IN_FLIGHT) throw new Error('independent-host-request-limit')
      const receiver = host[receiverName]
      if (typeof receiver !== 'function') throw new Error('independent-host-receiver-unavailable')
      const controller = new AbortController()
      const operation = (JSON.parse(payload) as { operation?: unknown }).operation
      const observationWait = channel === 'managed-service-ui'
        && ['next', 'pull', 'closed', 'startupNext'].includes(String(operation))
      const retryBusyRead = channel === 'managed-service-ui'
          && ['snapshot', 'readCatalog', 'readAccounts'].includes(String(operation))
        || channel === 'owner-document' && operation === 'load'
      const request: Pending = {
        channel,
        requestId: id,
        receiverName,
        receiver: receiver as Binding,
        controller,
        // These operations can be read back from owner state. A replacement
        // may join only after the owner confirms retirement; no write is replayed.
        resumeAfterOwnerRetirement: channel === 'permission-policy'
          || channel === 'plugin-management' && operation !== null
            && typeof operation === 'object' && !Array.isArray(operation)
            && (operation as { kind?: unknown }).kind === 'migrate-legacy-sources',
        readOnly: (() => {
          const envelope = JSON.parse(payload) as { operation?: unknown }
          if (channel === 'model-services') return envelope.operation === 'read'
          if (channel === 'native-catalog') return envelope.operation === 'read'
          if (channel === 'service-config') return envelope.operation === 'list'
          if (channel === 'marketplace') return true
          if (channel === 'owner-document') return envelope.operation === 'load'
          if (channel === 'channel-actions') return (envelope as { action?: unknown }).action === 'snapshot'
          if (channel === 'managed-service-ui') {
            // Startup subscriptions are renderer-owned observations; the owner
            // confirms their cleanup before allowing the renderer to resume.
            return [
              'get',
              'snapshot',
              'readCatalog',
              'readAccounts',
              'nativeProviders',
              'subscribe',
              'next',
              'pull',
              'closed',
              'unsubscribe',
              'startupRead',
              'startupSubscribe',
              'startupNext',
              'startupClose',
            ].includes(String(envelope.operation))
          }
          if (channel !== 'plugin-management') return false
          const operation = envelope.operation as { kind?: unknown } | undefined
          return isRendererManagementRead(operation?.kind)
        })(),
        dispatched: false,
      }
      pending.set(key, request)
      void Promise.resolve().then(async () => {
        const requiresAdmission = channel === 'channel-actions' || channel === 'service-config'
          || channel === 'channel-credentials' || channel === 'desktop-package-config'
          || channel === 'native-catalog'
          || channel === 'permission-policy'
          || channel === 'owner-document' && !request.readOnly
          || channel === 'managed-service-ui' && operation === 'readAccounts'
          || (channel === 'model-services' || channel === 'plugin-management' || channel === 'managed-service-ui')
            && !request.readOnly
        if (requiresAdmission && input.rendererAdmission !== undefined) {
          if (!await input.rendererAdmission) throw new Error('independent-host-session-revoked')
        }
        if (controller.signal.aborted) throw new Error('independent-host-session-revoked')
        request.dispatched = true
        const retryDeadline = Date.now() + MAX_BUSY_READ_WAIT_MS
        for (;;) {
          const response = await input.window.fetch('/api/renderer/binding', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${input.sessionToken}` },
            body,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          })
          if (channel === 'permission-policy' && response.status === 503 && Date.now() < retryDeadline) {
            const value = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined
            if (value && Object.keys(value).length === 1 && value.error === 'PERMISSION_WRITE_NOT_DISPATCHED') {
              await yieldObservation(controller.signal)
              continue
            }
          }
          if (retryBusyRead && response.status === 503 && Date.now() < retryDeadline) {
            const value = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined
            if (value && Object.keys(value).length === 1 && value.error === 'RENDERER_BINDING_UNAVAILABLE') {
              await yieldObservation(controller.signal)
              continue
            }
          }
          // During an owner handoff, a document read may instead receive the
          // owner's explicit, recoverable unavailable result. Reads can be
          // retried safely; replacements must never be replayed here.
          if (channel === 'owner-document' && operation === 'load' && response.ok && Date.now() < retryDeadline) {
            const result = await response.clone().json().catch(() => undefined) as {
              requestId?: unknown
              ok?: unknown
              value?: { status?: unknown; code?: unknown; diagnostic?: unknown; recoverable?: unknown }
            } | undefined
            if (
              result?.requestId === id && result.ok === true && result.value?.status === 'unavailable'
              && result.value.code === 'host-unavailable' && result.value.recoverable === true
              && result.value.diagnostic === 'owner document request was rejected'
            ) {
              await yieldObservation(controller.signal)
              continue
            }
          }
          if (!observationWait || response.status !== 202) return response
          const status = await response.json() as { status?: unknown }
          if (status?.status !== 'pending' || Object.keys(status).length !== 1) {
            throw new Error('independent-host-response-invalid')
          }
          await yieldObservation(controller.signal)
        }
      }).then(async response => {
        if (response.status === 401 && !closed) {
          const uncertain = [...pending.values()].some(request => request.dispatched && !request.readOnly)
          dispose()
          input.onSessionLost?.(uncertain ? 'result-unknown' : undefined)
          return
        }
        if (!response.ok) return failure(key, 'INDEPENDENT_HOST_RESULT_UNKNOWN')
        const text = await response.text()
        if (text.length > MAX_PAYLOAD_CHARS) return failure(key, 'INDEPENDENT_HOST_RESULT_UNKNOWN')
        try {
          const result = JSON.parse(text) as { requestId?: unknown; ok?: unknown }
          if (result?.requestId !== id || typeof result.ok !== 'boolean') throw new Error('invalid response')
        } catch {
          return failure(key, 'INDEPENDENT_HOST_RESULT_UNKNOWN')
        }
        deliver(key, text)
      }).catch(() =>
        failure(key, request.dispatched ? 'INDEPENDENT_HOST_RESULT_UNKNOWN' : 'INDEPENDENT_HOST_SESSION_REVOKED')
      )
    }
    host[name] = binding
    installed.set(name, binding)
  }
  // A recovery attempt is not a quiescence receipt. An in-flight permission
  // write must still block lifecycle fences until the owner retires it.
  const safe = (forRecovery: boolean) =>
    !closed && (forRecovery || !uncertainNavigationWrite)
    && [...pending.values()].every(item =>
      item.readOnly || !item.dispatched || item.resumeAfterOwnerRetirement
        && (forRecovery || item.channel !== 'permission-policy')
    )
  return Object.assign(dispose, {
    canResume: () => safe(true),
    canQuiesce: () => safe(false),
    canRecoverAfterTransport: () =>
      !closed && !uncertainNavigationWrite && [...pending.values()].every(item => item.readOnly || !item.dispatched),
    hasUncertainWrite: () => uncertainNavigationWrite,
  })
}
