import type { WalletSpendIdentityV1, WalletSpendRecordV1, WalletSpendSourceV1 } from '@cordisx/protocol/wallet-spend/v1'

/** Derived exclusively from the verified original enrollment. No new wallet identity. */
export interface WalletSpendWalletV1 {
  readonly origin: string
  readonly instanceId: string
  readonly accountId: string
  readonly subject: string
  readonly publicKey: string
}
/** Runs inside the Economy authority process with its existing canonical SQLite store. */
export interface WalletSpendProviderSessionV1 {
  identity(): WalletSpendIdentityV1
  quote(terms: string, requestId: string): { readonly handle: object; readonly terms: string }
  reserve(handle: object): WalletSpendRecordV1
  quoteBinding(challenge: string): { readonly handle: object; readonly challenge: string }
  bindGameAccount(handle: object): string
  lookup(source: WalletSpendSourceV1, requestId: string): WalletSpendRecordV1 | null
  applyDecision(source: WalletSpendSourceV1, decision: string): readonly WalletSpendRecordV1[]
  catalog(storeId: string): string
  quotePurchase(input: {
    readonly storeId: string
    readonly itemId: string
    readonly quantity: number
    readonly expectedTotal: number
    readonly requestId: string
    readonly fulfillmentTarget?: { readonly namespace: string; readonly storeId: string }
  }): { readonly handle: object; readonly quote: string }
  purchase(handle: object): string
  quoteCancellation(
    input: Parameters<WalletSpendProviderSessionV1['quotePurchase']>[0],
  ): { readonly handle: object; readonly quote: string }
  cancelPurchase(handle: object): string
  order(storeId: string, requestId: string): string | null
  orders(storeId: string): string
  legacyReceipt(
    input: { readonly kind: 'grant' | 'migration' | 'purchase'; readonly requestId: string; readonly input: string },
  ): string | null
  /** Synchronous session retirement, checked in the same process before the final SQLite mutation. */
  close(): void
}
