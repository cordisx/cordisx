import { isDeepStrictEqual } from 'node:util'
import type {
  ManagedServiceBindingV1,
  ManagedServiceCliProxyAccountsResultV1,
} from '@cordisx/protocol/managed-service/v1'
import { ManagedServiceSchemaRegistry } from '../launcher/managed-service-schema.js'

const accountsSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json'
const unavailableCodes = new Set([
  'owner-unavailable',
  'stale-generation',
  'binding-replaced',
  'service-kind-mismatch',
  'management-disabled',
  'disposed',
])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
  }
  return value as Record<string, unknown>
}

/** Validate the renderer-safe account projection before it leaves the owner. */
export class ManagerManagedServiceAccounts {
  private readonly schemas = new ManagedServiceSchemaRegistry()

  async project(value: unknown, binding: ManagedServiceBindingV1): Promise<ManagedServiceCliProxyAccountsResultV1> {
    const result = object(value)
    if (result.status === 'unavailable') {
      if (
        Object.keys(result).sort().join(',') !== 'code,status'
        || typeof result.code !== 'string' || !unavailableCodes.has(result.code)
      ) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      return result as unknown as ManagedServiceCliProxyAccountsResultV1
    }
    if (result.status !== 'available' || Object.keys(result).sort().join(',') !== 'accounts,status') {
      throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
    }
    const accounts = object(result.accounts)
    await this.schemas.validate(accountsSchema, accounts, 'managed service accounts')
    if (!isDeepStrictEqual(accounts.binding, binding)) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
    return result as unknown as ManagedServiceCliProxyAccountsResultV1
  }
}
