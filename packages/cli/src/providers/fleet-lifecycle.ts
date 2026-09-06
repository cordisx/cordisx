import { randomUUID } from 'node:crypto'
import type { CordisXTaskReadInput } from '../contracts.js'
import type { ProviderLifecycleSignal } from './contracts.js'

export interface ChannelTaskLifecycleEvent {
  readonly contract: 'cordisx.platform-task-lifecycle-event/v1'
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly providerGeneration: string
  readonly session: CordisXTaskReadInput['session']
  readonly turnId: string
  readonly operationId?: string
  readonly type: ProviderLifecycleSignal['type'] | 'turn.cancelled'
  readonly provenance: 'observed' | 'snapshot-reconciled'
  readonly output?: readonly { readonly type: 'text'; readonly text: string }[]
  readonly failure?: { readonly code: string; readonly retryable: boolean }
  readonly approval?: ProviderLifecycleSignal['approval']
  readonly cancellation?: { readonly operationId: string }
  readonly observedAt: string
}

export interface ChannelTaskLifecycleRange {
  readonly contract: 'cordisx.platform-task-lifecycle-range/v1'
  readonly schemaVersion: 1
  readonly session: CordisXTaskReadInput['session']
  readonly afterSequence: number
  readonly nextAfterSequence: number
  readonly events: readonly ChannelTaskLifecycleEvent[]
}

export function lifecycleKey(session: CordisXTaskReadInput['session']): string {
  return `${session.providerId}\u0000${session.remoteSessionId}`
}

export function appendFleetLifecycle(
  lifecycle: Map<string, ChannelTaskLifecycleEvent[]>,
  listeners: ReadonlySet<(event: ChannelTaskLifecycleEvent) => void>,
  input: Omit<ChannelTaskLifecycleEvent, 'contract' | 'schemaVersion' | 'eventId' | 'sequence'>,
): boolean {
  const key = lifecycleKey(input.session)
  const current = lifecycle.get(key) ?? []
  if (input.type === 'turn.completed' || input.type === 'turn.failed' || input.type === 'turn.cancelled') {
    if (
      current.some(event =>
        event.turnId === input.turnId
        && (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled')
      )
    ) return false
  } else if (input.type === 'approval.required' || input.type === 'approval.resolved') {
    if (
      current.some(event =>
        event.turnId === input.turnId && event.type === input.type
        && event.approval?.approvalId === input.approval?.approvalId
      )
    ) return false
  } else if (current.some(event => event.turnId === input.turnId && event.type === input.type)) return false
  const event: ChannelTaskLifecycleEvent = {
    contract: 'cordisx.platform-task-lifecycle-event/v1',
    schemaVersion: 1,
    eventId: `lifecycle:${randomUUID()}`,
    sequence: current.length + 1,
    ...input,
  }
  lifecycle.set(key, [...current, event])
  for (const listener of listeners) listener(structuredClone(event))
  return true
}
