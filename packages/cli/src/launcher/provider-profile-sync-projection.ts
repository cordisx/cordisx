import type { TomlTable, TomlValue } from 'smol-toml'
import {
  type ProviderSyncDiagnostic,
  type ProviderSyncProfileProjection,
  type ProviderSyncProviderProjection,
  type ProviderSyncTargetProfileRef,
  targetProfileRefKey,
} from './provider-profile-sync-contracts.js'
import type {
  ProviderSyncBindingLedgerEntry,
  ProviderSyncFieldGroups,
  ProviderSyncLedger,
} from './provider-profile-sync-ledger.js'

const ADAPTER_VERSION = 'codex-provider-profile/v1'
const PARSER_REF = 'smol-toml@1.8.0+cordisx-table-editor/v1'

export interface CodexProviderTargetSnapshot {
  readonly raw: string
  readonly revision: string
  readonly config: TomlTable
  readonly tables: ReadonlyMap<string, { readonly providerId: string; readonly start: number; readonly end: number }>
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? value as TomlTable
    : undefined
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, item]) => `${JSON.stringify(key)}:${stable(item)}`,
    ).join(',')
  }}`
}

function targetGroups(config: TomlTable, providerId: string): ProviderSyncFieldGroups {
  const provider = table(table(config.model_providers)?.[providerId])
  if (provider === undefined) return Object.freeze({})
  const display: Record<string, string | boolean> = Object.create(null)
  const routing: Record<string, string | boolean> = Object.create(null)
  if (typeof provider.name === 'string' || typeof provider.name === 'boolean') display.name = provider.name
  for (const key of ['base_url', 'wire_api', 'env_key', 'requires_openai_auth'] as const) {
    const value = provider[key]
    if (typeof value === 'string' || typeof value === 'boolean') routing[key] = value
  }
  if (typeof provider.experimental_bearer_token === 'string') routing.auth_kind = 'inline-private'
  else if (typeof provider.env_key === 'string') routing.auth_kind = 'environment'
  else if (provider.requires_openai_auth === false) routing.auth_kind = 'none'
  else routing.auth_kind = 'native'
  return Object.freeze({
    ...(Object.keys(display).length === 0 ? {} : { display: Object.freeze(display) }),
    routing: Object.freeze(routing),
  })
}

function activeBindingMap(
  ledger: ProviderSyncLedger,
  target: ProviderSyncTargetProfileRef,
): ReadonlyMap<string, ProviderSyncBindingLedgerEntry> {
  return new Map(
    ledger.bindings.flatMap(binding =>
      targetProfileRefKey(binding.targetProfileRef) === targetProfileRefKey(target) && binding.state !== 'tombstoned'
        ? [[binding.bindingId, binding] as const]
        : []
    ),
  )
}

export function projectCodexProviderProfile(input: {
  readonly target: ProviderSyncTargetProfileRef
  readonly snapshot?: CodexProviderTargetSnapshot
  readonly ledger: ProviderSyncLedger
  readonly diagnostics: readonly ProviderSyncDiagnostic[]
  readonly runtime?: ProviderSyncProfileProjection['runtime']
}): ProviderSyncProfileProjection {
  const { target, snapshot, ledger, diagnostics } = input
  const bindings = activeBindingMap(ledger, target)
  const bindingByLocalId = new Map([...bindings.values()].map(binding => [binding.localProviderId, binding]))
  const providersTable = table(snapshot?.config.model_providers)
  const activeProvider = typeof snapshot?.config.model_provider === 'string'
    ? snapshot.config.model_provider
    : undefined
  const activeModel = typeof snapshot?.config.model === 'string' ? snapshot.config.model : undefined
  const providers: ProviderSyncProviderProjection[] = []
  for (const [localProviderId, value] of Object.entries(providersTable ?? {})) {
    const provider = table(value)
    if (provider === undefined || localProviderId === 'openai') continue
    const binding = bindingByLocalId.get(localProviderId)
    const groups: ProviderSyncFieldGroups = snapshot === undefined
      ? Object.freeze({})
      : targetGroups(snapshot.config, localProviderId)
    const routingMatches = binding !== undefined && stable(groups.routing) === stable(binding.lastApplied.routing)
    const skippedGroups = diagnostics.flatMap(item =>
      item.localProviderId === localProviderId && item.fieldGroup !== undefined ? [item.fieldGroup] : []
    )
    const credentialKind = groups.routing?.auth_kind
    providers.push(Object.freeze({
      localProviderId,
      owner: binding?.state === 'managed' ? 'cordisx' : 'native',
      ...(binding === undefined ? {} : { bindingId: binding.bindingId, connectionId: binding.connectionId }),
      title: typeof provider.name === 'string' ? provider.name : localProviderId,
      ...(typeof provider.base_url === 'string' ? { endpoint: provider.base_url } : {}),
      ...(provider.wire_api === 'responses' || provider.wire_api === 'chat-completions'
        ? { protocol: provider.wire_api }
        : {}),
      credential: Object.freeze({
        kind: credentialKind === 'environment' || credentialKind === 'inline-private' || credentialKind === 'native'
          ? credentialKind
          : 'unknown',
        referenceAvailable: typeof provider.env_key === 'string'
          || typeof provider.experimental_bearer_token === 'string',
      }),
      models: Object.freeze(
        binding !== undefined && routingMatches
          ? { ...binding.models, evidence: 'binding-ledger' as const }
          : activeProvider === localProviderId && activeModel !== undefined
          ? { ids: Object.freeze([activeModel]), completeness: 'partial' as const, evidence: 'active-model' as const }
          : { ids: Object.freeze([]), completeness: 'unknown' as const, evidence: 'none' as const },
      ),
      sync: Object.freeze({
        applied: binding?.state === 'managed' && routingMatches,
        skippedGroups: Object.freeze([...new Set(skippedGroups)]),
      }),
      ...(binding?.overlay === undefined ? {} : { overlay: binding.overlay }),
    }))
  }
  const syncStatus = diagnostics.some(item => item.code === 'recovery-required')
    ? 'recovery-required'
    : diagnostics.some(item => item.severity === 'error')
    ? 'failed'
    : diagnostics.some(item => item.severity === 'warning')
    ? 'warning'
    : bindings.size === 0
    ? 'not-managed'
    : 'in-sync'
  return Object.freeze({
    targetProfileRef: target,
    context: Object.freeze({ adapterVersion: ADAPTER_VERSION, parserRef: PARSER_REF }),
    persisted: Object.freeze(
      snapshot === undefined
        ? { status: 'missing' as const }
        : { status: 'ok' as const, revision: snapshot.revision },
    ),
    resolved: Object.freeze({ status: 'unsupported' as const }),
    runtime: input.runtime ?? Object.freeze({ status: 'unverified' as const }),
    sync: Object.freeze({ status: syncStatus }),
    providers: Object.freeze(providers),
    diagnostics: Object.freeze([...diagnostics]),
  })
}
