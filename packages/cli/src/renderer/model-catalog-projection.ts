import type {
  CatalogConnectionSettings,
  CatalogEditableModel,
  CatalogManagementCode,
  CatalogManagementOperation,
  CatalogManagementRow,
  CatalogManagementSnapshot,
  CatalogManagementView,
  CatalogSafeDiagnostics,
} from '../model-catalog-management.js'

const codes = [
  'unsupported',
  'unavailable',
  'conflict',
  'scope-changed',
  'permission',
  'source-invalid',
  'persist-failed',
  'credential-unavailable',
  'authentication',
  'account',
  'rate-limit',
  'temporary',
  'protocol',
  'cancelled',
  'script-command-invalid',
  'script-output-invalid',
  'script-timeout',
  'script-cleanup-failed',
  'script-unsupported',
  'script-scope-invalid',
  'script-environment-missing',
  'script-exit-failed',
  'script-budget-exceeded',
]
export const safeManagementCode = (value: unknown): value is CatalogManagementCode =>
  typeof value === 'string' && codes.includes(value)
const operations = [
  'refresh',
  'setAutoPaused',
  'setOverlay',
  'resetOrder',
  'restoreBlocked',
  'convertToManual',
  'editManual',
  'editSupplement',
  'setSource',
  'setMode',
  'requestCredentialReplacement',
  'configureScript',
  'runScript',
  'cancelScript',
  'updateConnection',
]
const fail = (): never => {
  throw new Error('Invalid catalog projection')
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail()
const text = (value: unknown, max = 512): string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : fail()
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : fail()
const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail()
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fail()
const list = <T>(value: unknown, parse: (item: unknown) => T, max = 10_000): readonly T[] =>
  Array.isArray(value) && value.length <= max ? Object.freeze(value.map(parse)) : fail()
const optionalTime = (key: 'lastAttemptAt' | 'lastSuccessAt' | 'retryAt', value: unknown) =>
  value === undefined ? {} : { [key]: count(value) }

function editable(value: unknown): CatalogEditableModel {
  const item = record(value)
  return Object.freeze({
    id: text(item.id),
    ...(item.label === undefined ? {} : { label: text(item.label, 256) }),
    ...(item.protocolCapabilities === undefined
      ? {}
      : { protocolCapabilities: protocolCapabilities(item.protocolCapabilities) }),
  })
}

function row(value: unknown): CatalogManagementRow {
  const item = record(value)
  const id = text(item.id)
  return Object.freeze({
    id,
    label: item.label === id ? id : text(item.label, 256),
    provenance: list(
      item.provenance,
      value => choice(value, ['native', 'auto', 'manual', 'manual-supplement', 'script', 'script-supplement'] as const),
      6,
    ),
    notListed: bool(item.notListed),
    present: bool(item.present),
    selectable: bool(item.selectable),
    blocked: bool(item.blocked),
    pinned: bool(item.pinned),
    ...(item.protocolCapabilities === undefined
      ? {}
      : { protocolCapabilities: protocolCapabilities(item.protocolCapabilities) }),
    ...(item.reason === undefined ? {} : {
      reason: choice(item.reason, ['blocked', 'removed', 'unconfirmed', 'permission', 'pending-apply']),
    }),
  })
}

function diagnostics(value: unknown): CatalogSafeDiagnostics {
  const item = record(value)
  return Object.freeze({
    ...(safeManagementCode(item.code) ? { code: item.code } : {}),
    scopeConfirmed: bool(item.scopeConfirmed),
    targetState: choice(item.targetState, ['applied', 'pending-restart', 'conflict', 'unavailable']),
    ...optionalTime('lastAttemptAt', item.lastAttemptAt),
    ...optionalTime('lastSuccessAt', item.lastSuccessAt),
    ...optionalTime('retryAt', item.retryAt),
  })
}

function connection(value: unknown): CatalogConnectionSettings {
  const item = record(value)
  const strategy = record(item.strategy)
  const endpoint = text(item.endpoint, 2048)
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail()
  return Object.freeze({
    title: text(item.title, 128),
    endpoint,
    protocol: choice(item.protocol, ['responses', 'chat-completions']),
    discoveryEnabled: bool(item.discoveryEnabled),
    strategy: strategy.kind === 'manual'
      ? Object.freeze({ kind: 'manual', ids: list(strategy.ids, value => text(value)) })
      : Object.freeze({
        kind: choice(strategy.kind, ['auto']),
        adapter: text(strategy.adapter, 128),
        ttlMs: count(strategy.ttlMs),
        mode: choice(strategy.mode, ['only', 'augment']),
      }),
  })
}

function view(value: unknown): CatalogManagementView {
  const item = record(value)
  const rows = list(item.rows, row)
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail()
  return Object.freeze({
    bindingRef: text(item.bindingRef),
    providerId: text(item.providerId),
    title: text(item.title, 256),
    ...(item.scopeLabel === undefined ? {} : { scopeLabel: text(item.scopeLabel, 256) }),
    scopeRevision: text(item.scopeRevision),
    revision: text(item.revision),
    sourceKind: choice(item.sourceKind, ['native', 'auto', 'manual', 'script']),
    mode: choice(item.mode, ['only', 'augment', 'replace', 'supplement']),
    freshness: choice(item.freshness, ['unknown', 'fresh', 'stale']),
    activity: choice(item.activity, ['idle', 'scheduled', 'loading', 'applying']),
    outcome: choice(item.outcome, ['none', 'ok', 'empty', 'error', 'unsupported', 'cancelled']),
    autoPaused: bool(item.autoPaused),
    sourceCount: count(item.sourceCount),
    selectableCount: count(item.selectableCount),
    rows,
    supplement: list(item.supplement, editable),
    capabilities: list(item.capabilities, value => choice(value, operations) as CatalogManagementOperation, 32),
    diagnostics: diagnostics(item.diagnostics),
    ...(item.connection === undefined ? {} : { connection: connection(item.connection) }),
    ...(item.scriptState === undefined ? {} : { scriptState: scriptState(item.scriptState) }),
    ...(item.protocolCapabilities === undefined
      ? {}
      : { protocolCapabilities: protocolCapabilities(item.protocolCapabilities) }),
  })
}

function scriptState(value: unknown): NonNullable<CatalogManagementView['scriptState']> {
  const item = record(value)
  return Object.freeze({
    authorityRevision: text(item.authorityRevision),
    runGeneration: count(item.runGeneration),
    persistence: choice(item.persistence, ['session-only']),
    evidence: choice(item.evidence, ['script-declared']),
  })
}

function protocolCapabilities(value: unknown): NonNullable<CatalogManagementView['protocolCapabilities']> {
  const item = record(value)
  return Object.freeze({ responses: bool(item.responses) })
}

/** Positive field projection prevents accidental Host internals from reaching React state. */
export function parseManagementSnapshot(value: unknown): CatalogManagementSnapshot {
  const item = record(value)
  const views = list(item.views, view, 128)
  if (new Set(views.map(view => view.bindingRef)).size !== views.length) fail()
  return Object.freeze({
    epoch: text(item.epoch),
    sequence: count(item.sequence),
    views,
    canCreateConnection: item.canCreateConnection === true,
  })
}
