import type { AgentContextV1 } from '@cordisx/protocol/agent-context/v1'
import type { AgentTurnControlV1 } from '@cordisx/protocol/agent-turn-control/v1'
import type { Context } from '@deepseek-ai/cordis'
export type * from '@cordisx/protocol/agent-context/v1'
export type * from '@cordisx/protocol/agent-turn-control/v1'
export type CordisXContextServices = Pick<Context, 'agentContext' | 'agentTurnControl'>
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentContext: AgentContextV1
    agentTurnControl: AgentTurnControlV1
  }
}
