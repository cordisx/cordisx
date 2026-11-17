import type {
  AgentContextReadResultV1,
  AgentContextThresholdEventV1,
  AgentContextUnavailableV1,
} from '@cordisx/protocol/agent-context/v1'

/**
 * Host-private, authenticated current-connection transport. Renderer services
 * broker plugin identity and exact-Session permission before using this seam.
 * A handle is opaque, connection/generation/session-bound, and never exposed to a plugin.
 */
export interface AgentContextBridge {
  read(input: { readonly sessionId: string }): Promise<AgentContextReadResultV1>
  open(input: { readonly sessionId: string; readonly thresholdRatio: number }): Promise<
    | { readonly status: 'open'; readonly handle: string; readonly cursor: number }
    | { readonly status: 'unavailable'; readonly code: AgentContextUnavailableV1 }
  >
  /** A bounded long-poll returns actual queued events, never synthesized samples. */
  next(input: { readonly handle: string; readonly cursor: number }): Promise<
    | { readonly status: 'events'; readonly events: readonly AgentContextThresholdEventV1[]; readonly cursor: number }
    | { readonly status: 'closed'; readonly code: AgentContextUnavailableV1 | 'unsubscribed' }
  >
  close(input: { readonly handle: string }): Promise<void>
}
