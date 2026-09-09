export type * from '@cordisx/protocol/entity-execution-context/v2'
import type { EntityExecutionContexts } from '@cordisx/protocol/entity-execution-context/v2'
declare module '@deepseek-ai/cordis' {
  interface Context {
    entityExecutionContexts?: EntityExecutionContexts
  }
}
