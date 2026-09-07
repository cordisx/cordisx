import type { Context } from '@deepseek-ai/cordis'
import type { UsageV1 } from '@cordisx/protocol/usage/v1'
export type * from '@cordisx/protocol/usage/v1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usage: UsageV1
  }
}

// Preserve the module anchor in declarations without importing a second runtime.
export type CordisXUsageContext = Context
