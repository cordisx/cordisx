import { createHash } from 'node:crypto'
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
  handle(value: unknown): Promise<HostServiceConfigMutationResult>
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
}): ChannelCredentialBridgeHandler {
  return {
    token: input.token,
    async handle(value) {
      const request = parse(value, input.token)
      const capture = input.store.beginCapture({
        profileId: input.profileId,
        connectionId: connectionId(request.account),
      })
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
      if (target === undefined) return rejected(request.mutation, 'Channel connection is unavailable.')
      target.secretRef = reference
      const result = await input.service.mutate({
        ...request.mutation,
        configuration: configuration as HostServiceConfigMutation['configuration'],
      })
      if (result.status !== 'applied') await input.store.remove(capture.captureId).catch(() => undefined)
      return result
    },
  }
}
