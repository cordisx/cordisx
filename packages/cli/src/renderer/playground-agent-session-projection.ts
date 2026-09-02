import type { SessionEvent } from '@cordisx/protocol/sessions/v1'

/** Development-shell-only view of the one Host Agent/Session authority. */
export interface PlaygroundAgentSessionTask {
  readonly sessionId: string
  readonly agentGeneration: number
  readonly owner: string
  readonly events: readonly SessionEvent[]
}

export interface PlaygroundAgentSessionProjectionSnapshot {
  readonly tasks: readonly PlaygroundAgentSessionTask[]
}

export interface PlaygroundAgentSessionProjection {
  snapshot(): PlaygroundAgentSessionProjectionSnapshot
  create(text: string): Promise<void>
  submit(sessionId: string, text: string): Promise<void>
}
