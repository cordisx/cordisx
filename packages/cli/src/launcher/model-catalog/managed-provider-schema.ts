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
  /** Metadata for the exact manual membership; independent of automatic supplements. */
  readonly models?: CatalogSupplement['models']
}

export function managedProviderSettings(value: unknown): ManagedProviderSettings {
  const input = object(value)
  if (
    !input
    || Object.keys(input).some(key =>
      !['title', 'endpoint', 'protocol', 'discoveryEnabled', 'strategy', 'supplement', 'models'].includes(key)
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
  const models = input.models === undefined ? undefined : parseSupplement({
    scopeRevision: 'validation',
    authorityRevision: 'validation',
    models: input.models,
  }).models
  if (
    models !== undefined && (strategy.kind !== 'manual' || !('ids' in strategy)
      || !Array.isArray(input.models) || input.models.length !== models.length || models.length !== strategy.ids.length
      || models.some(model => !strategy.ids.includes(model.id)))
  ) throw new CatalogError('source-invalid')
  return Object.freeze({
    title: input.title,
    endpoint: input.endpoint,
    protocol: input.protocol as ManagedProviderSettings['protocol'],
    discoveryEnabled: input.discoveryEnabled,
    strategy,
    supplement: supplement.models,
    ...(models === undefined ? {} : { models }),
  })
}

export const opaqueProviderId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)

export interface ManagedProviderView {
  readonly id: string
  readonly revision: string
  readonly scopeRevision: string
  readonly credentialRevision: string
  readonly credentialState: 'set' | 'unset'
  readonly settings: ManagedProviderSettings
}

/** Stored only in the Host-private profile configuration; never a renderer/plugin descriptor. */
export interface ManagedProviderRecord extends Omit<ManagedProviderView, 'credentialState'> {
  readonly credentialRef: string
  readonly environmentReference?: string
  readonly secret?: string
  /** Private idempotency marker for an imported clipboard connection. */
  readonly importTransferId?: string
  readonly importDigest?: string
  readonly settings: ManagedProviderSettings
}

export function parseManagedProviderRecord(value: unknown): ManagedProviderRecord {
  const input = object(value)
  if (
    !input
    || Object.keys(input).some(key =>
      ![
        'id',
        'revision',
        'scopeRevision',
        'credentialRevision',
        'credentialRef',
        'environmentReference',
        'settings',
        'secret',
        'importTransferId',
        'importDigest',
      ].includes(key)
    )
    || ![input.id, input.revision, input.scopeRevision, input.credentialRevision, input.credentialRef].every(
      opaqueProviderId,
    )
    || input.environmentReference !== undefined
      && (typeof input.environmentReference !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(input.environmentReference))
    || input.secret !== undefined && (!boundedString(input.secret, 8192) || /\s/u.test(input.secret))
    || (input.importTransferId === undefined) !== (input.importDigest === undefined)
    || input.importTransferId !== undefined
      && (typeof input.importTransferId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          input.importTransferId,
        )
        || typeof input.importDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(input.importDigest))
  ) throw new CatalogError('source-invalid')
  return Object.freeze({
    id: input.id as string,
    revision: input.revision as string,
    scopeRevision: input.scopeRevision as string,
    credentialRevision: input.credentialRevision as string,
    credentialRef: input.credentialRef as string,
    ...(input.environmentReference === undefined ? {} : { environmentReference: input.environmentReference as string }),
    ...(input.secret === undefined ? {} : { secret: input.secret as string }),
    ...(input.importTransferId === undefined ? {} : {
      importTransferId: input.importTransferId as string,
      importDigest: input.importDigest as string,
    }),
    settings: managedProviderSettings(input.settings),
  })
}

export function managedProviderView(
  record: ManagedProviderRecord,
  credentialAvailable = record.secret !== undefined,
): ManagedProviderView {
  return Object.freeze({
    id: record.id,
    revision: record.revision,
    scopeRevision: record.scopeRevision,
    credentialRevision: record.credentialRevision,
    credentialState: credentialAvailable ? 'set' : 'unset',
    settings: record.settings,
  })
}

/** Metadata cannot grant membership to IDs outside the manual source. */
export function managedManualModels(settings: ManagedProviderSettings) {
  if (settings.strategy.kind !== 'manual' || !('ids' in settings.strategy)) return []
  const metadata = new Map((settings.models ?? []).map(model => [model.id, model]))
  return settings.strategy.ids.map(id => ({ id, ...metadata.get(id) }))
}
