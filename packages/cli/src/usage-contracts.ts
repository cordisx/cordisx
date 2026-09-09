import type { Context } from '@deepseek-ai/cordis'
import type { UsageV2 } from '@cordisx/protocol/usage/v2'
export type * from '@cordisx/protocol/usage/v1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usage: UsageV2
  }
}

// Preserve the module anchor in declarations without importing a second runtime.
export type CordisXUsageContext = Context

export type * from '@cordisx/protocol/usage/v2'
