import { randomUUID } from 'node:crypto'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import type { NativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeProviderConfig, type NativeProviderCredentialLease } from './native-submission-controller.js'

export type TerminalProviderRequest =
  | { readonly kind: 'list' }
  | { readonly kind: 'prepare'; readonly providerId: string; readonly model: string }
  | { readonly kind: 'renew' | 'release'; readonly leaseId: string }
export type TerminalProviderResult =
  | {
    readonly kind: 'list'
    readonly providers: readonly {
      readonly providerId: string
      readonly title: string
      readonly managed: boolean
      readonly models: readonly { readonly id: string; readonly label: string }[]
    }[]
  }
  | {
    readonly kind: 'prepared'
    readonly leaseId: string
    readonly providerId: string
    readonly model: string
    readonly provider: Readonly<Record<string, unknown>>
  }
  | { readonly kind: 'renewed' | 'released' }

export function parseTerminalProviderRequest(value: unknown): TerminalProviderRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal provider request')
  const item = value as Record<string, unknown>
  const text = (key: string) =>
    typeof item[key] === 'string' && (item[key] as string).length > 0
    && (item[key] as string).length <= 512 && !/[\u0000-\u001f\u007f]/u.test(item[key] as string)
  const keys = item.kind === 'list'
    ? ['kind']
    : item.kind === 'prepare'
    ? ['kind', 'providerId', 'model']
    : ['kind', 'leaseId']
  if (Object.keys(item).some(key => !keys.includes(key))) throw new Error('Invalid terminal provider request fields')
  if (item.kind === 'list') return { kind: 'list' }
  if (item.kind === 'prepare' && text('providerId') && text('model')) return item as unknown as TerminalProviderRequest
  if ((item.kind === 'renew' || item.kind === 'release') && text('leaseId')) {
    return item as unknown as TerminalProviderRequest
  }
  throw new Error('Invalid terminal provider selection')
}

/** Launch-scoped leases reuse the live Host; credentials never leave its existing broker. */
export function createTerminalProviderAuthority(options: {
  readonly catalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
  readonly owns: (providerId: string) => boolean
  readonly resolve: (
    providerId: string,
  ) => NativeManagedGatewayConnectionSession | Promise<NativeManagedGatewayConnectionSession>
  readonly credentials: NativeProviderCredentialBroker
  readonly now?: () => number
}) {
  const now = options.now ?? Date.now
  const ttlMs = 60_000
  const leases = new Map<string, {
    providerId: string
    model: string
    credential: NativeProviderCredentialLease
    expires: number
  }>()
  let closed = false
  const broker = nativeSubmissionCredentialBroker({
    credentials: options.credentials,
    resolveEndpoint: options.resolve,
  })
  const release = (id: string) => {
    const lease = leases.get(id)
    leases.delete(id)
    lease?.credential.dispose()
  }
  const sweep = () => {
    for (const [id, lease] of leases) if (lease.expires <= now()) release(id)
  }
  const timer = setInterval(sweep, 5_000)
  timer.unref()
  const validate = async (providerId: string, model: string, generation?: string) => {
    if (closed || !options.owns(providerId)) throw new Error('Terminal provider is unavailable in this Host')
    const catalog = await options.catalog()
    if (
      !catalog.some(provider => provider.providerId === providerId && provider.models.some(item => item.id === model))
    ) {
      throw new Error('Unknown or unavailable terminal model; use cordisx cli --list')
    }
    const connection = await options.resolve(providerId)
    try {
      if (
        !connection.value.models.aliases.some(item => item.gatewayModelId === model)
        || generation !== undefined && connection.value.service.generation !== generation
      ) {
        throw new Error('Terminal provider generation or model changed; start a new CLI session')
      }
    } finally {
      connection.dispose()
    }
    if (closed) throw new Error('Terminal provider authority retired')
  }
  return {
    async request(raw: TerminalProviderRequest): Promise<TerminalProviderResult> {
      const request = parseTerminalProviderRequest(raw)
      if (closed) throw new Error('Terminal provider authority retired')
      sweep()
      if (request.kind === 'list') {
        const catalog = await options.catalog()
        return {
          kind: 'list',
          providers: catalog.map(provider => ({
            providerId: provider.providerId,
            title: provider.title ?? provider.providerId,
            managed: options.owns(provider.providerId),
            models: provider.models.map(model => ({ id: model.id, label: model.label })),
          })),
        }
      }
      if (request.kind === 'prepare') {
        if (leases.size >= 64) throw new Error('Too many terminal provider sessions')
        await validate(request.providerId, request.model)
        const credential = await broker.prepare(request.providerId)
        try {
          await validate(request.providerId, request.model, credential.serviceGeneration)
          if (leases.size >= 64) throw new Error('Too many terminal provider sessions')
          const provider = nativeProviderConfig(credential)
          const leaseId = randomUUID()
          leases.set(leaseId, { ...request, credential, expires: now() + ttlMs })
          return { kind: 'prepared', leaseId, providerId: request.providerId, model: request.model, provider }
        } catch (error) {
          credential.dispose()
          throw error
        }
      }
      if (request.kind === 'release') {
        release(request.leaseId)
        return { kind: 'released' }
      }
      const lease = leases.get(request.leaseId)
      if (!lease) throw new Error('Terminal provider lease expired')
      try {
        await validate(lease.providerId, lease.model, lease.credential.serviceGeneration)
        if (leases.get(request.leaseId) !== lease) throw new Error('Terminal provider lease retired')
        lease.expires = now() + ttlMs
        return { kind: 'renewed' }
      } catch (error) {
        release(request.leaseId)
        throw error
      }
    },
    close() {
      closed = true
      clearInterval(timer)
      for (const id of leases.keys()) release(id)
    },
  }
}
