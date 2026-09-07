import type { UsageV1 } from '@cordisx/protocol/usage/v1'
export type * from '@cordisx/protocol/usage/v1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usage: UsageV1
  }
}
