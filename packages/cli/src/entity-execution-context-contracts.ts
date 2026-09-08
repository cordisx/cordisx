export type * from '@cordisx/protocol/entity-execution-context/v1'
import type { EntityExecutionContexts } from '@cordisx/protocol/entity-execution-context/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    entityExecutionContexts?: EntityExecutionContexts
  }
}
