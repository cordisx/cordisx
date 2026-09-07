export type {
  AgentToolBinding,
  AgentToolBindingHandle,
  AgentToolHandler,
  AgentToolResourcesV1,
  AgentTools,
} from '@cordisx/protocol/agent-tools/v1'
import type { AgentTools } from '@cordisx/protocol/agent-tools/v1'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTools: AgentTools
  }
}

/** Host-private execution context; no credential values may be projected. */
export interface AgentToolSetup {
  readonly skills: readonly { readonly id: string; readonly path: string; readonly content: string }[]
  readonly commands: readonly {
    readonly id: string
    readonly argv: readonly string[]
    readonly bindingPath: string
    readonly expiresAt: string
  }[]
}
