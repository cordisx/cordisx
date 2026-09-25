import type {
  CatalogManagementChannel,
  CatalogManagementCommand,
  CatalogManagementCursor,
  CatalogManagementSnapshot,
  CatalogManagementView,
} from '../../packages/cli/src/model-catalog-management.js'
import { ModelCatalogClient } from '../../packages/cli/src/renderer/model-catalog-client.js'

const supportedCompatibility = { compatibility: 'supported' as const }

export function catalogView(patch: Partial<CatalogManagementView> = {}): CatalogManagementView {
  return {
    bindingRef: 'binding-a',
    providerId: 'provider-a',
    title: 'Provider A',
    scopeLabel: 'Work connection',
    scopeRevision: 'scope-1',
    revision: '1',
    sourceKind: 'auto',
    mode: 'augment',
    freshness: 'fresh',
    activity: 'idle',
    outcome: 'ok',
    autoPaused: false,
    providerFavorite: false,
    sourceCount: 2,
    selectableCount: 2,
    rows: ['Model-A', 'model-a'].map(id => ({
      id,
      label: id,
      provenance: ['auto'],
      notListed: false,
      present: true,
      compatibility: 'supported',
      selectable: true,
      blocked: false,
      pinned: false,
      ...supportedCompatibility,
    })),
    supplement: [],
    sourceCapabilities: [
      'refresh',
      'setAutoPaused',
      'convertToManual',
      'editSupplement',
      'requestCredentialReplacement',
      'updateConnection',
      'setMode',
      'configureScript',
      'runScript',
    ],
    preferenceCapabilities: ['setProviderFavorite', 'setOverlay', 'resetOrder', 'restoreBlocked'],
    capabilities: [
      'refresh',
      'setAutoPaused',
      'setProviderFavorite',
      'setOverlay',
      'resetOrder',
      'restoreBlocked',
      'convertToManual',
      'editSupplement',
      'requestCredentialReplacement',
      'updateConnection',
      'setMode',
      'configureScript',
      'runScript',
    ],
    diagnostics: { scopeConfirmed: true, targetState: 'applied', lastSuccessAt: 1790000000000 },
    connection: {
      title: 'Provider A',
      endpoint: 'https://api.example.test',
      protocol: 'chat-completions',
      discoveryEnabled: true,
      strategy: { kind: 'auto', adapter: 'detect', ttlMs: 3_600_000, mode: 'augment' },
    },
    ...patch,
  }
}

export function catalogFixture(views: readonly CatalogManagementView[] = [catalogView()]) {
  let state: CatalogManagementSnapshot = { epoch: 'epoch-a', sequence: 1, views, canCreateConnection: true }
  const listeners = new Set<(cursor: CatalogManagementCursor) => void>()
  const commands: CatalogManagementCommand[] = []
  const publish = (next: CatalogManagementSnapshot) => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const channel: CatalogManagementChannel = {
    catalogManagementRead: async () => state,
    catalogManagementSubscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    catalogManagementCommand: async command => {
      commands.push(command)
      if (command.operation !== 'createConnection') {
        const view = state.views.find(view => view.bindingRef === command.bindingRef)
        if (!view || command.expectedRevision !== view.revision || command.scopeRevision !== view.scopeRevision) {
          return { status: 'conflict', code: 'conflict' }
        }
        const next: CatalogManagementView = {
          ...view,
          revision: String(Number(view.revision) + 1),
          ...(command.operation === 'setAutoPaused' ? { autoPaused: command.paused } : {}),
          ...(command.operation === 'setProviderFavorite' ? { providerFavorite: command.favorite } : {}),
          ...(command.operation === 'configureScript'
            ? {
              sourceKind: command.mode === 'replace' ? 'script' as const : view.sourceKind,
              mode: command.mode,
              scriptState: {
                authorityRevision: 'script-authority',
                runGeneration: 0,
                persistence: 'session-only' as const,
                evidence: 'script-declared' as const,
              },
            }
            : {}),
          ...(command.operation === 'runScript'
            ? {
              activity: 'loading' as const,
              sourceCapabilities: [
                ...view.sourceCapabilities.filter(value => value !== 'runScript'),
                'cancelScript' as const,
              ],
              capabilities: [...view.capabilities.filter(value => value !== 'runScript'), 'cancelScript' as const],
            }
            : {}),
          ...(command.operation === 'cancelScript'
            ? {
              activity: 'idle' as const,
              outcome: 'cancelled' as const,
              sourceCapabilities: [
                ...view.sourceCapabilities.filter(value => value !== 'cancelScript'),
                'runScript' as const,
              ],
              capabilities: [...view.capabilities.filter(value => value !== 'cancelScript'), 'runScript' as const],
            }
            : {}),
          ...(command.operation === 'setOverlay'
            ? {
              rows: view.rows.map(row =>
                row.id !== command.modelId
                  ? row
                  : {
                    ...row,
                    ...(command.blocked === undefined
                      ? {}
                      : { blocked: command.blocked, selectable: row.present && !command.blocked }),
                    ...(command.pinned === undefined ? {} : { pinned: command.pinned }),
                  }
              ),
            }
            : {}),
          ...(command.operation === 'editSupplement' ? { supplement: command.models } : {}),
        }
        publish({ ...state, sequence: state.sequence + 1, views: state.views.map(item => item === view ? next : item) })
      }
      return { status: 'applied' }
    },
  }
  const client = new ModelCatalogClient(channel)
  return { client, channel, commands, publish, snapshot: () => state, listeners }
}
