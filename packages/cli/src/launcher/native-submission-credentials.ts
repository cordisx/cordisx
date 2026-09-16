import type {
  NativeProviderCredentialBroker as ManagedCredentialBroker,
  NativeProviderCredentialPreparation,
} from './native-provider-credential-broker.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import type { NativeProviderCredentialBroker, NativeProviderCredentialLease } from './native-submission-controller.js'

export interface NativeSubmissionCredentialAdapterOptions {
  readonly credentials: ManagedCredentialBroker
  readonly resolveEndpoint: (
    providerId: string,
  ) => NativeManagedGatewayConnectionSession | Promise<NativeManagedGatewayConnectionSession>
}

function endpointBaseUrl(providerId: string, session: NativeManagedGatewayConnectionSession): string {
  const { origin, apiPath } = session.value.endpoint
  let parsedOrigin: URL
  let parsedBaseUrl: URL
  try {
    parsedOrigin = new URL(origin)
    parsedBaseUrl = new URL(apiPath, `${origin}/`)
  } catch {
    throw new Error(`native managed provider ${providerId} has an invalid gateway endpoint`)
  }
  const loopback = parsedOrigin.hostname === '127.0.0.1'
    || parsedOrigin.hostname === 'localhost'
    || parsedOrigin.hostname === '[::1]'
  const exactOrigin = parsedOrigin.origin === origin && parsedOrigin.href === `${origin}/`
  const allowedTransport = parsedOrigin.protocol === 'https:'
    || (parsedOrigin.protocol === 'http:' && loopback)
  const exactPath = parsedBaseUrl.origin === origin
    && parsedBaseUrl.pathname === apiPath
    && parsedBaseUrl.search === ''
    && parsedBaseUrl.hash === ''
  if (!exactOrigin || !allowedTransport || !exactPath) {
    throw new Error(`native managed provider ${providerId} has an invalid gateway endpoint`)
  }
  return parsedBaseUrl.href
}

function auth(
  preparation: NativeProviderCredentialPreparation,
): NativeProviderCredentialLease['auth'] {
  if (preparation.scheme === 'none') return Object.freeze({ scheme: 'none' as const })
  return Object.freeze({
    scheme: 'bearer-command' as const,
    command: preparation.auth.command,
    args: Object.freeze([...preparation.auth.args]),
    cwd: preparation.auth.cwd,
    timeoutMs: preparation.auth.timeout_ms,
    refreshIntervalMs: preparation.auth.refresh_interval_ms,
  })
}

/** Joins C's durable auth lease with an independently revalidated Host-only endpoint. */
export function nativeSubmissionCredentialBroker(
  options: NativeSubmissionCredentialAdapterOptions,
): NativeProviderCredentialBroker {
  return Object.freeze({
    async prepare(providerId: string): Promise<NativeProviderCredentialLease> {
      const preparation = await options.credentials.prepare(providerId)
      let session: NativeManagedGatewayConnectionSession | undefined
      try {
        session = await options.resolveEndpoint(providerId)
        const connection = session.value
        if (
          connection.service.generation !== preparation.serviceGeneration
          || connection.endpoint.auth.scheme !== preparation.scheme
        ) throw new Error('native provider credential and endpoint snapshots differ')
        return Object.freeze({
          serviceGeneration: preparation.serviceGeneration,
          endpoint: Object.freeze({
            baseUrl: endpointBaseUrl(providerId, session),
            wireApi: 'responses' as const,
          }),
          auth: auth(preparation),
          dispose: () => preparation.dispose(),
        })
      } catch {
        preparation.dispose()
        throw new Error('native provider credential endpoint unavailable')
      } finally {
        session?.dispose()
      }
    },
  })
}
