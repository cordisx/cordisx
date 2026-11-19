import { Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { feishuFailureDiagnostic } from './feishu-operation-error.js'

function discoveryFailure(error: unknown): Error {
  const diagnostic = feishuFailureDiagnostic('directory', error)
  return new Error(
    diagnostic.platformCode === 99991672 || diagnostic.platformCode === 99991679
      || diagnostic.platformCode === 1184001 || diagnostic.httpStatus === 403
      ? 'TENANT_DISCOVERY_PERMISSION_DENIED'
      : 'TENANT_DISCOVERY_FAILED',
  )
}

/** Authenticate even when the user supplies a tenant key and no directory lookup is needed. */
export async function validateChannelCredentials(input: {
  readonly adapterId: string
  readonly accountId: string
  readonly secret: string
}): Promise<void> {
  const silent = () => {}
  const client = new Client({
    appId: input.accountId,
    appSecret: input.secret,
    domain: input.adapterId === 'lark' ? Domain.Lark : Domain.Feishu,
    loggerLevel: LoggerLevel.fatal,
    logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
    cache: { get: async () => undefined, set: async () => false },
    source: 'cordisx-channel-credential-entry',
  })
  try {
    const token: unknown = await client.tokenManager.getTenantAccessToken()
    if (typeof token !== 'string' || !token.trim()) throw new Error('invalid token')
  } catch {
    throw new Error('CREDENTIAL_VALIDATION_FAILED')
  }
}

/** An optional tenant lookup uses only the newly entered credentials and never opens another transport. */
export async function discoverChannelTenant(input: {
  readonly adapterId: string
  readonly accountId: string
  readonly secret: string
}): Promise<string> {
  const silent = () => {}
  const client = new Client({
    appId: input.accountId,
    appSecret: input.secret,
    domain: input.adapterId === 'lark' ? Domain.Lark : Domain.Feishu,
    loggerLevel: LoggerLevel.fatal,
    logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
    // Disabling the SDK token cache also disables automatic authentication. Use its
    // normal exchange with an empty, call-owned cache so every new secret is checked.
    cache: { get: async () => undefined, set: async () => false },
    source: 'cordisx-channel-credential-entry',
  })
  try {
    const result = await client.tenant.v2.tenant.query()
    const tenant = result.data?.tenant?.tenant_key
    if (result.code !== 0) throw discoveryFailure(result)
    if (typeof tenant !== 'string' || !tenant.trim() || tenant.length > 512) {
      throw new Error('TENANT_DISCOVERY_FAILED')
    }
    return tenant
  } catch (error) {
    if (error instanceof Error && error.message === 'TENANT_DISCOVERY_PERMISSION_DENIED') throw error
    throw discoveryFailure(error)
  }
}
