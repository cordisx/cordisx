import path from 'node:path'
import { type CodexConfigModelProviderProjection, codexConfigModelProviders } from '../codex-config-model-providers.js'
import type { ModelSelectorIconOverrides } from '../../model-selector-branding.js'
import { watchCatalogFiles } from './file-source.js'

/** Async source observation; selection/submission consume only the committed memory view. */
export function dynamicConfiguredCatalog(input: {
  readonly codexHome: string
  readonly catalogs?: Readonly<Record<string, string>>
  readonly selectorIcons?: ModelSelectorIconOverrides
  readonly load?: () => Promise<CodexConfigModelProviderProjection>
}) {
  let snapshot: CodexConfigModelProviderProjection = { providers: [], providerIds: new Set(), diagnostics: [] }
  let disposed = false
  let dirty = false
  let generation = 0
  let job: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const load = input.load ?? (() => codexConfigModelProviders(input.codexHome, input.catalogs, input.selectorIcons))
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch { /* Readers cannot roll back a source commit. */ }
    }
  }
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (job) {
      dirty = true
      return job
    }
    const epoch = ++generation
    job = Promise.resolve().then(async () => {
      try {
        const candidate = await load()
        if (disposed || generation !== epoch) return
        // A broken connection config cannot attest account/endpoint continuity.
        // Keep it display-only by publishing no selectable entries until recovered.
        if (candidate.sourceAvailable === false) {
          snapshot = candidate
        } else {
          const sameSource = candidate.sourceRevision !== undefined
            && candidate.sourceRevision === snapshot.sourceRevision
          const invalid = new Set(
            candidate.diagnostics.filter(item => item.code === 'catalog-unavailable').map(item => item.providerId),
          )
          const old = new Map(snapshot.providers.map(provider => [provider.providerId, provider]))
          snapshot = Object.freeze({
            ...candidate,
            providers: Object.freeze(
              candidate.providers.map(provider =>
                sameSource && invalid.has(provider.providerId) && old.has(provider.providerId)
                  ? Object.freeze({ ...provider, models: old.get(provider.providerId)!.models })
                  : provider
              ),
            ),
          })
        }
        notify()
      } catch {
        if (disposed || generation !== epoch) return
        // Unexpected source failure is not proof that the native binding stayed unchanged.
        snapshot = { providers: [], providerIds: new Set(), diagnostics: [], sourceAvailable: false }
        notify()
      } finally {
        job = undefined
        if (dirty && !disposed) {
          dirty = false
          void refresh()
        }
      }
    })
    return job
  }
  const watcher = watchCatalogFiles([
    path.join(input.codexHome, 'config.toml'),
    ...Object.values(input.catalogs ?? {}).map(file => path.resolve(input.codexHome, file)),
  ], () => {
    // An observed write invalidates the current read before scheduling its successor.
    generation++
    void refresh()
  })
  queueMicrotask(() => {
    if (!disposed) void refresh()
  })
  return {
    snapshot: () => snapshot,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      generation++
      watcher.dispose()
      listeners.clear()
    },
  }
}
