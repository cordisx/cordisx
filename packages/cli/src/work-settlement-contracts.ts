import type { LocalWorkSettlementV1 } from '@cordisx/protocol/local-work-settlement/v1'
export type * from '@cordisx/protocol/local-work-settlement/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly workSettlement: LocalWorkSettlementV1
  }
}
