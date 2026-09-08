import type { AgentLoopControlV1 } from '@cordisx/protocol/agent-loop-control/v1'
export type * from '@cordisx/protocol/agent-loop-control/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly agentLoopControl: AgentLoopControlV1
  }
}
