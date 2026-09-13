import type { HttpClientV3, HttpSessionScopeV2 } from '@cordisx/protocol/plugin-http/v3'
import type { HttpClientV1, HttpConnectionV1, HttpRequestV1, HttpResultV1 } from '@cordisx/protocol/plugin-http/v1'
import type { BrowserOwnerDocumentBridge, OwnerDocumentPrincipalBinding } from './owner-documents.js'
import { captureHttpConsent } from './plugin-http-consent.js'

export function createPluginHttpClient(options: {
  readonly bridge: BrowserOwnerDocumentBridge | undefined
  readonly principal: OwnerDocumentPrincipalBinding | undefined
  readonly active: () => boolean
  readonly development?: () => boolean
  readonly consent?: typeof captureHttpConsent
  readonly configuredOrigins?: () => readonly string[]
  readonly authorizeWork?: () => Promise<boolean>
  readonly diagnostic?: (
    code: 'renderer-connection-not-owned' | 'launcher-connection-unavailable',
    message: string,
  ) => void
}): HttpClientV3 {
  let disposed = false
  const lifetime = new AbortController()
  // Private bridge metadata: plugins never receive renderer/target lifetime identity.
  const clientId = crypto.randomUUID()
  const diagnostics = new Set<string>()
  const diagnostic = (code: 'renderer-connection-not-owned' | 'launcher-connection-unavailable') => {
    if (diagnostics.has(code)) return
    diagnostics.add(code)
    try {
      options.diagnostic?.(
        code,
        code === 'renderer-connection-not-owned'
          ? 'HTTP connection unavailable before launcher dispatch: client does not own this handle'
          : 'HTTP connection unavailable: launcher rejected this handle',
      )
    } catch { /* Passive diagnostics cannot change transport behavior. */ }
  }
  const notOwned = () => {
    diagnostic('renderer-connection-not-owned')
    return { status: 'unavailable' as const, code: 'connection-unavailable' as const }
  }
  const live = () => !disposed && options.active()
  const connections = new Map<string, HttpConnectionV1>()
  const call = async <T>(operation: string, input: Record<string, unknown> = {}): Promise<HttpResultV1<T>> => {
    if (!live()) return { status: 'unavailable', code: 'stale-generation' }
    if (options.bridge === undefined || options.principal === undefined) {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
    try {
      const result = await options.bridge.request(
        options.principal.token,
        { operation, ...input, clientId },
        35_000,
      ) as HttpResultV1<T>
      if (!live()) return { status: 'unavailable', code: 'stale-generation' }
      if (result.status === 'unavailable' && result.code === 'connection-unavailable') {
        diagnostic('launcher-connection-unavailable')
      }
      return structuredClone(result)
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }
  const managedCall = <T>(operation: string, input: Record<string, unknown>, authorize?: () => Promise<boolean>) => {
    const managedDeadline = Date.now() + 15_000
    let timeout: ReturnType<typeof setTimeout>
    const expired = new Promise<HttpResultV1<T>>(resolve => {
      timeout = setTimeout(() => resolve({ status: 'unavailable', code: 'deadline-exceeded' }), 15_000)
    })
    const request = Promise.resolve().then(async (): Promise<HttpResultV1<T>> => {
      if (authorize && !await authorize()) return { status: 'unavailable', code: 'denied' }
      if (Date.now() >= managedDeadline) return { status: 'unavailable', code: 'deadline-exceeded' }
      const result = await call<T>(operation, { ...input, managedDeadline })
      if (Date.now() >= managedDeadline) {
        if (operation === 'plugin-http-connect-account' && result.status === 'accepted') {
          const connection = (result.value as { connection?: HttpConnectionV1 }).connection
          if (connection && options.bridge && options.principal) {
            void options.bridge.request(options.principal.token, {
              operation: 'plugin-http-revoke',
              connection,
              clientId,
            }).catch(
              () => {},
            )
          }
        }
        return { status: 'unavailable', code: 'deadline-exceeded' }
      }
      return result
    })
    return Promise.race([request, expired]).finally(() => clearTimeout(timeout))
  }
  const owns = (connection: HttpConnectionV1) => {
    const stored = connections.get(connection?.id)
    return stored !== undefined && stored.origin === connection.origin && stored.credential === connection.credential
      && stored.contract === connection.contract
  }
  return Object.freeze({
    contract: 'cordisx.http-client/v3' as const,
    async connectAccount(input: Parameters<HttpClientV3['connectAccount']>[0]) {
      if (input.previousConnection && !owns(input.previousConnection)) {
        return notOwned()
      }
      const result = await managedCall<
        { connection: HttpConnectionV1; response: import('@cordisx/protocol/plugin-http/v1').HttpResponseV1 }
      >(
        'plugin-http-connect-account',
        { input },
      )
      if (result.status === 'accepted') {
        connections.set(result.value.connection.id, Object.freeze({ ...result.value.connection }))
      }
      return result
    },
    async submitWorkUsage(input: Parameters<HttpClientV3['submitWorkUsage']>[0]) {
      return await managedCall<import('@cordisx/protocol/plugin-http/v1').HttpResponseV1>(
        'plugin-http-submit-work',
        { input },
        async () => !!await options.authorizeWork?.(),
      )
    },
    async retain(connection: HttpConnectionV1, scope: Omit<HttpSessionScopeV2, 'origin'>) {
      if (!owns(connection)) return notOwned()
      return await call<null>('plugin-http-retain', { connection, scope: { ...scope, origin: connection.origin } })
    },
    async resume(scope: HttpSessionScopeV2) {
      const result = await call<HttpConnectionV1 | null>('plugin-http-resume', { scope })
      if (result.status === 'accepted' && result.value !== null) {
        connections.set(result.value.id, Object.freeze({ ...result.value }))
      }
      return result
    },
    async forget(scope: HttpSessionScopeV2) {
      return await call<null>('plugin-http-forget', { scope })
    },
    async authorize(input: { readonly origin: string; readonly credential: 'none' | 'bearer' }) {
      if (!live() || options.principal === undefined || options.bridge === undefined) {
        return { status: 'unavailable' as const, code: 'host-unavailable' as const }
      }
      let origin: string
      try {
        const url = new URL(input.origin)
        if (
          !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || url.pathname !== '/' || (input.origin !== url.origin && input.origin !== `${url.origin}/`)
          || !['none', 'bearer'].includes(input.credential)
        ) throw new Error()
        if (
          input.credential === 'bearer' && url.protocol !== 'https:'
          && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ) throw new Error()
        origin = url.origin
      } catch {
        return { status: 'unavailable' as const, code: 'invalid-request' as const }
      }
      let configured = false
      if (input.credential === 'none') {
        try {
          configured = options.configuredOrigins?.().includes(origin) === true
        } catch {
          configured = false
        }
      }
      const consent = configured || (input.credential === 'none' && options.development?.() === true)
        ? { approved: true as const }
        : await (options.consent ?? captureHttpConsent)({
          pluginId: options.principal.pluginId,
          origin,
          credential: input.credential,
          signal: lifetime.signal,
        })
      if (!consent.approved) return { status: 'unavailable' as const, code: 'denied' as const }
      const result = await call<HttpConnectionV1>('plugin-http-authorize', {
        origin,
        credential: input.credential,
        ...(consent.secret === undefined ? {} : { secret: consent.secret }),
      })
      if (result.status === 'accepted') connections.set(result.value.id, Object.freeze({ ...result.value }))
      return result
    },
    async request(input: HttpRequestV1) {
      if (!owns(input.connection)) return notOwned()
      if (input.signal?.aborted) return { status: 'unavailable' as const, code: 'aborted' as const }
      if (
        input.body !== undefined
        && (typeof input.body !== 'string' || new TextEncoder().encode(input.body).byteLength > 1_048_576)
      ) {
        return { status: 'unavailable' as const, code: 'invalid-request' as const }
      }
      const operationId = crypto.randomUUID()
      const { signal, ...request } = input
      const abort = () => {
        void call('plugin-http-abort', { connection: input.connection, operationId })
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await call<import('@cordisx/protocol/plugin-http/v1').HttpResponseV1>('plugin-http-request', {
          ...request,
          operationId,
        })
        return signal?.aborted ? { status: 'unavailable' as const, code: 'aborted' as const } : result
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
    async exchange(input: Parameters<HttpClientV1['exchange']>[0]) {
      if (!owns(input.connection)) return notOwned()
      if (input.signal?.aborted) return { status: 'unavailable' as const, code: 'aborted' as const }
      if (input.body !== undefined && new TextEncoder().encode(input.body).byteLength > 1_048_576) {
        return { status: 'unavailable' as const, code: 'invalid-request' as const }
      }
      const { signal, ...request } = input
      const operationId = crypto.randomUUID()
      const abort = () => {
        void call('plugin-http-abort', { connection: input.connection, operationId })
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await call<
          {
            readonly connection: HttpConnectionV1
            readonly response: import('@cordisx/protocol/plugin-http/v1').HttpResponseV1
          }
        >(
          'plugin-http-exchange',
          { ...request, operationId },
        )
        if (result.status === 'accepted') {
          if (signal?.aborted) {
            await call('plugin-http-revoke', { connection: result.value.connection })
            return { status: 'unavailable' as const, code: 'aborted' as const }
          }
          connections.set(result.value.connection.id, Object.freeze({ ...result.value.connection }))
        }
        return result
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
    async revoke(connection: HttpConnectionV1) {
      if (!owns(connection)) return notOwned()
      const result = await call<null>('plugin-http-revoke', { connection })
      connections.delete(connection.id)
      return result
    },
    dispose() {
      if (disposed) return
      // Lifecycle cleanup must still reach the launcher after principalLive becomes false.
      if (options.bridge !== undefined && options.principal !== undefined) {
        void options.bridge.request(options.principal.token, { operation: 'plugin-http-dispose', clientId }).catch(
          () => {},
        )
      }
      disposed = true
      lifetime.abort()
      connections.clear()
    },
  })
}
