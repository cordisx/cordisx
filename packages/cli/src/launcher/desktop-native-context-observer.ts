import { deriveNativeBudgetProvenance, type NativeThreadConfigReceipt } from './native-context-budget-provenance.js'
import { resolveNativeContextBudget } from './native-context-budget.js'
import { attachNativeContextObserver, type NativeContextObserver } from './native-context-observer.js'
import type { DesktopStaticCatalogLease } from './desktop-static-catalog.js'

export const desktopStaticCatalogEnvironment = (lease?: DesktopStaticCatalogLease): Record<string, string> =>
  lease
    ? {
      CORDISX_NATIVE_STATIC_CATALOG_PATH: lease.path,
      CORDISX_NATIVE_STATIC_CATALOG_SHA256: lease.sha256,
      CORDISX_NATIVE_STATIC_CATALOG_VERSION: lease.nativeVersion,
    }
    : {}

/** Accept receipts only from the authenticated native-control event stream. */
export function attachDesktopNativeContextObserver(
  subscribe: (listener: (method: string, params: unknown) => void) => () => void,
  observer: NativeContextObserver,
  catalog?: DesktopStaticCatalogLease,
): () => void {
  let generation = 1
  return attachNativeContextObserver(listener =>
    subscribe((method, value) => {
      if (method === 'cordisx/connection/closed') generation++
      if (method === 'cordisx/context/captured' && catalog && value && typeof value === 'object') {
        try {
          const thread = value as NativeThreadConfigReceipt
          const provenance = deriveNativeBudgetProvenance({
            nativeVersion: catalog.nativeVersion,
            serverId: thread.serverId,
            providerKind: 'openai-compatible',
            providerId: 'openai',
            catalogSha256: catalog.sha256,
            catalogBytes: catalog.bytes,
          }, thread)
          if (provenance.status === 'verified') {
            const budget = resolveNativeContextBudget(provenance.evidence)
            if (budget.status === 'resolved') {
              observer.track(provenance.evidence.sessionId, generation, budget, {
                model: provenance.evidence.model,
                providerId: 'openai',
              })
            }
          }
        } catch { /* An observation failure never changes a native effect. */ }
      }
      listener(method, value)
    }), observer)
}
