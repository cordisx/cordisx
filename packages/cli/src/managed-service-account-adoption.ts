import type { ManagedServiceBindingV1, ManagedServiceCliProxyAccountsV1 } from '@cordisx/protocol/managed-service/v1'
import { managedServiceUIBindingEqual } from './launcher/managed-service-ui-binding.js'

export interface ManagedServiceAccountAdoption {
  readonly requestId: string
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly phase: 'prepare' | 'confirm' | 'cancel'
  readonly binding: ManagedServiceBindingV1
  readonly accounts?: ManagedServiceCliProxyAccountsV1
}

const localId = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const forbidden =
  /^(?:secret|secrets|password|credential|credentials|cookie|cookies|token|accessToken|refreshToken|apiKey|authorization|privateKey)$/iu

/** Validate an owner-issued account projection before it reaches one renderer. */
export function parseManagedServiceAccountAdoption(
  value: unknown,
  scope: { readonly profileId: string; readonly generation: string; readonly rendererId: string },
): ManagedServiceAccountAdoption {
  const invalid = (): never => {
    throw new Error('renderer-managed-account-unavailable')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  const phase = raw.phase
  const required = [
    'rendererId',
    'ownerGeneration',
    'requestId',
    'pluginId',
    'pluginGeneration',
    'serviceId',
    'phase',
    'binding',
  ]
  const keys = phase === 'cancel' ? required : [...required, 'accounts']
  if (
    Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
    || raw.rendererId !== scope.rendererId || raw.ownerGeneration !== scope.generation
    || typeof raw.requestId !== 'string' || !opaque.test(raw.requestId)
    || typeof raw.pluginId !== 'string' || !localId.test(raw.pluginId)
    || typeof raw.pluginGeneration !== 'string' || !opaque.test(raw.pluginGeneration)
    || typeof raw.serviceId !== 'string' || !localId.test(raw.serviceId)
    || phase !== 'prepare' && phase !== 'confirm' && phase !== 'cancel'
  ) return invalid()
  const binding = raw.binding as ManagedServiceBindingV1 | undefined
  if (
    !binding || typeof binding !== 'object' || typeof binding.bindingId !== 'string' || !opaque.test(binding.bindingId)
    || Object.keys(binding).sort().join(',') !== 'bindingId,identity,scope'
    || !binding.identity || binding.identity.pluginId !== raw.pluginId || binding.identity.serviceId !== raw.serviceId
    || Object.keys(binding.identity).some(key => !['pluginId', 'serviceId', 'source'].includes(key))
    || !binding.scope || binding.scope.profileId !== scope.profileId || binding.scope.generation !== scope.generation
    || Object.keys(binding.scope).sort().join(',') !== 'generation,profileId'
  ) return invalid()
  if (binding.identity.source !== undefined) {
    try {
      const source = new URL(binding.identity.source)
      if (source.protocol !== 'https:' || source.username || source.password) return invalid()
    } catch {
      return invalid()
    }
  }
  const accounts = raw.accounts as ManagedServiceCliProxyAccountsV1 | undefined
  if (phase !== 'cancel') {
    if (
      !accounts || typeof accounts !== 'object' || accounts.contract !== 'cordisx.managed-service-cli-proxy-accounts/v1'
      || accounts.$schema
        !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json'
      || accounts.schemaVersion !== 1 || !accounts.binding || !managedServiceUIBindingEqual(accounts.binding, binding)
      || Object.keys(accounts).sort().join(',')
        !== '$schema,accounts,binding,contract,observedAt,revision,schemaVersion,sequence,serviceGeneration'
      || typeof accounts.observedAt !== 'string' || !Number.isFinite(Date.parse(accounts.observedAt))
      || !Number.isSafeInteger(accounts.revision) || accounts.revision < 0
      || !Number.isSafeInteger(accounts.sequence) || accounts.sequence < 0
      || typeof accounts.serviceGeneration !== 'string' || !opaque.test(accounts.serviceGeneration)
      || !Array.isArray(accounts.accounts) || accounts.accounts.length > 128
    ) return invalid()
    let encoded: string
    try {
      encoded = JSON.stringify(accounts)
    } catch {
      return invalid()
    }
    if (new TextEncoder().encode(encoded).length > 230 * 1024) return invalid()
    const pending: unknown[] = [accounts]
    let count = 0
    while (pending.length) {
      if (++count > 20_000) return invalid()
      const item = pending.pop()
      if (!item || typeof item !== 'object') continue
      for (const [key, child] of Object.entries(item)) {
        if (forbidden.test(key)) return invalid()
        pending.push(child)
      }
    }
  }
  return {
    requestId: raw.requestId,
    pluginId: raw.pluginId,
    pluginGeneration: raw.pluginGeneration,
    serviceId: raw.serviceId,
    phase,
    binding,
    ...(accounts === undefined ? {} : { accounts }),
  }
}
