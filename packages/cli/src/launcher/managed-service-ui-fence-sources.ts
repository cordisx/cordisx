import type { ManagedServiceNodeSourceBinding } from './managed-service-ui-source.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'

export interface ManagedServiceUISourceSnapshot {
  readonly source: object
  readonly webEntry: object | undefined
  readonly snapshot: unknown
  readonly readCatalog: unknown
  readonly identity: string
}

/** Capture synchronous source identity so a reentrant listener sees replacement immediately. */
export function captureManagedServiceUISources(
  sources: readonly ManagedServiceNodeSourceBinding[],
): readonly ManagedServiceUISourceSnapshot[] {
  if (sources.length > 4_096) throw new Error('managed service source limit exceeded')
  return sources.map(item => {
    const binding = item.source.binding
    const identity = JSON.stringify([
      item.pluginId,
      item.pluginGeneration,
      item.serviceId,
      item.loginTimeoutMs ?? null,
      binding.bindingId,
      binding.identity.source ?? null,
      binding.identity.pluginId,
      binding.identity.serviceId,
      binding.scope.profileId,
      binding.scope.generation,
      item.webEntry?.serviceGeneration ?? null,
    ])
    if (identity.length > 16_384) throw new Error('managed service source identity exceeds limit')
    return {
      source: item.source,
      webEntry: item.webEntry,
      snapshot: item.source.snapshot,
      readCatalog: item.source.readCatalog,
      identity,
    }
  })
}

export function sameManagedServiceUISources(
  previous: readonly ManagedServiceUISourceSnapshot[],
  captured: readonly ManagedServiceUISourceSnapshot[],
): boolean {
  return previous.length === captured.length
    && previous.every((item, index) =>
      item.source === captured[index]?.source && item.webEntry === captured[index]?.webEntry
      && item.snapshot === captured[index]?.snapshot && item.readCatalog === captured[index]?.readCatalog
      && item.identity === captured[index]?.identity
    )
}

/** Observe each active lease, failing closed if any source cannot be observed. */
export function observeManagedServiceUISources(
  activations: readonly ManagedServiceNodeActivation[],
  onChange: () => void,
): { readonly available: boolean; readonly stop: () => void } {
  const stops: (() => void)[] = []
  let available = true
  for (const activation of activations) {
    try {
      const stop = activation.subscribeSources?.(onChange)
      if (typeof stop === 'function') stops.push(stop)
      else available = false
    } catch {
      available = false
    }
  }
  return {
    available,
    stop: () => {
      let failed = false
      for (const stop of stops) {
        try {
          stop()
        } catch {
          failed = true
        }
      }
      if (failed) throw new Error('managed service source observation cleanup failed')
    },
  }
}
