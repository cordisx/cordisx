import type { WalletSpendV1 } from '@cordisx/protocol/wallet-spend/v1'
export type * from '@cordisx/protocol/wallet-spend/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly walletSpend: WalletSpendV1
  }
}
