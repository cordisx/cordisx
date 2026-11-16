import { createHash, randomBytes } from 'node:crypto'
import { ChannelCredentialDraftBroker, type ChannelCredentialDraftResult } from './channel-credential-drafts.js'
import type {
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
  HostServiceConfigNarrowApi,
} from './service-config.js'
import { LauncherSecretStore } from './secret-store.js'

export const CHANNEL_CREDENTIAL_BINDING = '__cordisxChannelCredentialRequestV1'
export const CHANNEL_CREDENTIAL_RECEIVER = '__cordisxChannelCredentialReceiveV1'
export const MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES = 128 * 1024

interface CredentialRequest {
  readonly requestId: string
  readonly account: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
  readonly secret: string
  readonly mutation: HostServiceConfigMutation
}

export interface ChannelCredentialBridgeHandler {
  readonly token: string
  handle(value: unknown, documentId?: string): Promise<HostServiceConfigMutationResult | ChannelCredentialDraftResult>
  retireDocument?(documentId: string): Promise<void>
  dispose?(): Promise<void>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

function rejected(mutation: HostServiceConfigMutation, message: string): HostServiceConfigMutationResult {
  return {
    contract: 'cordisx.service-config-result/v1',
    schemaVersion: 1,
    identity: mutation.identity,
    scope: mutation.scope,
    revision: mutation.expectedRevision,
    status: 'rejected',
    error: { code: 'secret-ref-failed', message },
  }
}

function connectionId(account: CredentialRequest['account']): string {
  const raw = `${account.adapterId}\0${account.accountId}\0${account.tenantId}`
  const prefix =
    `${account.adapterId}-${account.accountId}-${account.tenantId}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 64) || 'channel'
  return `${prefix}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

function parse(value: unknown, token: string): CredentialRequest {
  const input = record(value, 'channel credential request')
  if (
    input.version !== 1 || input.token !== token || typeof input.requestId !== 'string'
    || !/^[A-Za-z0-9-]{1,96}$/.test(input.requestId)
  ) throw new Error('channel credential request is unauthorized')
  const account = record(input.account, 'channel credential account')
  if (
    !['adapterId', 'accountId', 'tenantId'].every(key =>
      typeof account[key] === 'string' && (account[key] as string).length > 0
    )
  ) throw new Error('channel credential account is invalid')
  if (typeof input.secret !== 'string' || input.secret.length === 0 || input.secret.length > 16 * 1024) {
    throw new Error('channel credential is invalid')
  }
  return {
    requestId: input.requestId,
    account: {
      adapterId: account.adapterId as string,
      accountId: account.accountId as string,
      tenantId: account.tenantId as string,
    },
    secret: input.secret,
    mutation: input.mutation as HostServiceConfigMutation,
  }
}

/** Host-private one-shot credential capture and service-config mutation. */
export function createChannelCredentialBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly store: LauncherSecretStore
  readonly service: HostServiceConfigNarrowApi
  readonly projection?: () => Promise<unknown>
}): ChannelCredentialBridgeHandler {
  const drafts = new ChannelCredentialDraftBroker(input)
  const retired = new Set<string>()
  const legacyCaptures = new Map<string, string>()
  let disposed = false
  let legacyTail: Promise<void> = Promise.resolve()
  const serialLegacy = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = legacyTail.then(operation)
    legacyTail = result.then(() => undefined, () => undefined)
    return result
  }
  const live = (documentId: string) => !disposed && !retired.has(documentId)
  const cleanup = async (captureId: string): Promise<boolean> => {
    const result = await input.store.remove(captureId)
    if (result.state !== 'unset') return false
    legacyCaptures.delete(captureId)
    input.store.forget(captureId)
    return true
  }
  const cleanupDocument = async (documentId?: string) => {
    const results = await Promise.allSettled(
      [...legacyCaptures].filter(([, owner]) => documentId === undefined || owner === documentId)
        .map(([captureId]) => cleanup(captureId)),
    )
    if (results.some(result => result.status === 'rejected' || !result.value)) {
      throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
    }
  }
  return {
    token: input.token,
    retireDocument: async documentId => {
      retired.add(documentId)
      const results = await Promise.allSettled([
        drafts.retireDocument(documentId),
        serialLegacy(() => cleanupDocument(documentId)),
      ])
      if (results.some(result => result.status === 'rejected')) throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
    },
    dispose: async () => {
      disposed = true
      const results = await Promise.allSettled([drafts.dispose(), serialLegacy(() => cleanupDocument())])
      if (results.some(result => result.status === 'rejected')) throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
    },
    async handle(value, documentId = 'legacy') {
      const envelope = record(value, 'channel credential request')
      if (envelope.version === 2) {
        if (
          envelope.token !== input.token || typeof envelope.requestId !== 'string'
          || !/^[A-Za-z0-9-]{1,96}$/u.test(envelope.requestId)
        ) throw new Error('unauthorized channel credential request')
        return await drafts.handle(envelope, documentId)
      }
      const request = parse(value, input.token)
      return await serialLegacy(async () => {
        if (!live(documentId)) return rejected(request.mutation, 'The originating document is no longer active.')
        const capture = input.store.beginCapture({
          profileId: input.profileId,
          connectionId: `${connectionId(request.account).slice(0, 63)}-${randomBytes(12).toString('hex')}`,
        })
        legacyCaptures.set(capture.captureId, documentId)
        let committed = false
        try {
          const captured = await input.store.capture({ captureId: capture.captureId, secret: request.secret })
          const reference = captured.state === 'set' ? input.store.referenceFor(capture.captureId) : undefined
          if (reference === undefined) return rejected(request.mutation, 'Host credential capture is unavailable.')
          const configuration = structuredClone(request.mutation.configuration) as {
            connections?: Array<Record<string, unknown>>
          }
          const target = configuration.connections?.find(connection => {
            const ref = connection.ref as Record<string, unknown> | undefined
            return ref?.adapterId === request.account.adapterId && ref.accountId === request.account.accountId
              && ref.tenantId === request.account.tenantId
          })
          if (target === undefined || !live(documentId)) {
            return rejected(request.mutation, 'Channel connection is unavailable.')
          }
          target.secretRef = reference
          const result = await input.service.mutate({
            ...request.mutation,
            configuration: configuration as HostServiceConfigMutation['configuration'],
          })
          committed = result.status === 'applied'
          return result
        } finally {
          if (committed) {
            legacyCaptures.delete(capture.captureId)
            input.store.forget(capture.captureId)
          } else if (!await cleanup(capture.captureId)) throw new Error('CREDENTIAL_CLEANUP_UNAVAILABLE')
        }
      })
    },
  }
}
