import type { RestrictedContentV1 } from '@cordisx/protocol/restricted-content/v1'
export type * from '@cordisx/protocol/restricted-content/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly restrictedContent: RestrictedContentV1
  }
}
