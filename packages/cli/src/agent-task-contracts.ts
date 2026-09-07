export type * from '@cordisx/protocol/agent-task/v1'
import type { AgentTasks } from '@cordisx/protocol/agent-task/v1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTasks?: AgentTasks
  }
}
