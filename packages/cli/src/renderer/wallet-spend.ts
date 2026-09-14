import type { WalletSpendResultV1, WalletSpendV1 } from '@cordisx/protocol/wallet-spend/v1'
import type { BrowserOwnerDocumentBridge, OwnerDocumentPrincipalBinding } from './owner-documents.js'

/** Public methods marshal data only. Approval and credentials never enter this realm. */
export function createWalletSpendClient(options: {
  readonly bridge: BrowserOwnerDocumentBridge | undefined
  readonly principal: OwnerDocumentPrincipalBinding | undefined
  readonly active: () => boolean
}): WalletSpendV1 {
  const clientId = crypto.randomUUID(), lifetime = new AbortController()
  let disposed = false
  const live = () => !disposed && options.active()
  const call = async <T>(operation: string, input: object = {}): Promise<WalletSpendResultV1<T>> => {
    if (!live()) return { status: 'unavailable', code: 'stale-generation' }
    if (!options.bridge || !options.principal) return { status: 'unavailable', code: 'host-unavailable' }
    const operationId = crypto.randomUUID(), { signal: supplied, ...data } = input as Record<string, unknown>
    const signal = supplied instanceof AbortSignal ? AbortSignal.any([lifetime.signal, supplied]) : lifetime.signal
    if (signal.aborted) return { status: 'unavailable', code: 'aborted' }
    // Snapshot before dispatch: caller mutation cannot change a pending native confirmation.
    let snapshot: Record<string, unknown>
    try {
      snapshot = structuredClone(data)
    } catch {
      return { status: 'unavailable', code: 'invalid-request' }
    }
    const mutating = ['reserve', 'bind', 'purchase', 'cancel-purchase', 'apply'].includes(operation)
    const cancel = () => {
      void options.bridge!.request(options.principal!.token, {
        operation: 'wallet-spend-abort',
        clientId,
        operationId,
      }).catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    let stop: (() => void) | undefined
    const interrupted = new Promise<WalletSpendResultV1<T>>(resolve => {
      stop = () => resolve({ status: 'unavailable', code: mutating ? 'outcome-unknown' : 'aborted' })
      signal.addEventListener('abort', stop, { once: true })
    })
    try {
      const attempt = options.bridge.request(options.principal.token, {
        operation: 'wallet-spend-' + operation,
        clientId,
        operationId,
        input: snapshot,
      }, 125_000).then(value => {
        if (!live()) return { status: 'unavailable', code: mutating ? 'outcome-unknown' : 'stale-generation' } as const
        return structuredClone(value) as WalletSpendResultV1<T>
      }).catch(() => ({ status: 'unavailable', code: mutating ? 'outcome-unknown' : 'host-unavailable' }) as const)
      if (signal.aborted) {
        cancel()
        stop?.()
      }
      return await Promise.race([attempt, interrupted])
    } finally {
      signal.removeEventListener('abort', cancel)
      if (stop) signal.removeEventListener('abort', stop)
    }
  }
  return Object.freeze(
    {
      contract: 'cordisx.wallet-spend/v1',
      identity: () => call('identity'),
      authorizeSource: input => call('authorize-source', input),
      bindGameAccount: input => call('bind', input),
      reserve: input => call('reserve', input),
      lookup: input => call('lookup', input),
      applyDecision: input => call('apply', input),
      catalog: input => call('catalog', input),
      purchase: input => call('purchase', input),
      cancelPurchase: input => call('cancel-purchase', input),
      order: input => call('order', input),
      orders: input => call('orders', input),
      legacyReceipt: input => call('legacy-receipt', input),
      dispose() {
        if (disposed) return
        disposed = true
        lifetime.abort()
        if (options.bridge && options.principal) {
          void options.bridge.request(options.principal.token, {
            operation: 'wallet-spend-dispose',
            clientId,
          }).catch(() => {})
        }
      },
    } satisfies WalletSpendV1,
  )
}
