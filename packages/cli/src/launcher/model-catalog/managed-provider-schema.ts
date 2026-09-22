import {
  boundedString,
  CatalogError,
  type CatalogStrategy,
  type CatalogSupplement,
  object,
  parseCatalogStrategy,
} from './contracts.js'
import { parseSupplement } from './supplement.js'
import { builtinDiscoveryRegistry } from './builtin-registry.js'

export interface ManagedProviderSettings {
  readonly title: string
  readonly endpoint: string
  readonly protocol: 'responses' | 'chat-completions'
  readonly discoveryEnabled: boolean
  readonly strategy: CatalogStrategy
  readonly supplement: CatalogSupplement['models']
}

export function managedProviderSettings(value: unknown): ManagedProviderSettings {
  const input = object(value)
  if (
    !input
    || Object.keys(input).some(key =>
      !['title', 'endpoint', 'protocol', 'discoveryEnabled', 'strategy', 'supplement'].includes(key)
    ) || !boundedString(input.title, 128) || !boundedString(input.endpoint, 2048)
    || !['responses', 'chat-completions'].includes(String(input.protocol))
    || typeof input.discoveryEnabled !== 'boolean'
  ) throw new CatalogError('source-invalid')
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw new CatalogError('source-invalid')
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || /[\\?#]/u.test(input.endpoint) || endpoint.href !== input.endpoint && endpoint.href !== `${input.endpoint}/`
  ) throw new CatalogError('source-invalid')
  const strategy = parseCatalogStrategy(input.strategy)
  // This owner does not execute scripts, read native secrets, or accept arbitrary local file references.
  if (strategy.kind !== 'auto' && !(strategy.kind === 'manual' && 'ids' in strategy)) {
    throw new CatalogError('unsupported')
  }
  if (strategy.kind === 'auto') {
    builtinDiscoveryRegistry().resolve(
      { endpoint: input.endpoint, providerName: input.title },
      strategy.adapter,
    )
  }
  const supplement = parseSupplement({
    scopeRevision: 'validation',
    authorityRevision: 'validation',
    models: input.supplement,
  })
  return Object.freeze({
    title: input.title,
    endpoint: input.endpoint,
    protocol: input.protocol as ManagedProviderSettings['protocol'],
    discoveryEnabled: input.discoveryEnabled,
    strategy,
    supplement: supplement.models,
  })
}

export const opaqueProviderId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)

export interface ManagedProviderView {
  readonly id: string
  readonly revision: string
  readonly scopeRevision: string
  readonly credentialRevision: string
  readonly credentialState: 'set'
  readonly settings: ManagedProviderSettings
}

/** Stored only in the dedicated Host Keychain namespace; never a renderer/plugin descriptor. */
export interface ManagedProviderRecord extends Omit<ManagedProviderView, 'credentialState'> {
  readonly credentialRef: string
  readonly secret: string
  readonly settings: ManagedProviderSettings
}

export function parseManagedProviderRecord(value: unknown): ManagedProviderRecord {
  const input = object(value)
  if (
    !input
    || Object.keys(input).some(key =>
      !['id', 'revision', 'scopeRevision', 'credentialRevision', 'credentialRef', 'settings', 'secret'].includes(key)
    )
    || ![input.id, input.revision, input.scopeRevision, input.credentialRevision, input.credentialRef].every(
      opaqueProviderId,
    )
    || !boundedString(input.secret, 8192) || /\s/u.test(input.secret)
  ) throw new CatalogError('source-invalid')
  return Object.freeze({
    id: input.id as string,
    revision: input.revision as string,
    scopeRevision: input.scopeRevision as string,
    credentialRevision: input.credentialRevision as string,
    credentialRef: input.credentialRef as string,
    secret: input.secret,
    settings: managedProviderSettings(input.settings),
  })
}

export function managedProviderView(record: Omit<ManagedProviderRecord, 'secret'>): ManagedProviderView {
  return Object.freeze({
    id: record.id,
    revision: record.revision,
    scopeRevision: record.scopeRevision,
    credentialRevision: record.credentialRevision,
    credentialState: 'set',
    settings: record.settings,
  })
}
