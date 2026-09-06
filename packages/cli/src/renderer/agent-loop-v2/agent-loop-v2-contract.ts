import type { Disposable } from '@deepseek-ai/cordis'
import type { BoundAgentLoopClient as BoundAgentLoopClientV1 } from '@cordisx/protocol/agent-loop/v1'
import type { BoundAgentLoopClient as BoundAgentLoopClientV3 } from '@cordisx/protocol/agent-loop/v3'
import type { BoundAgentLoopClient as BoundAgentLoopClientV4 } from '@cordisx/protocol/agent-loop/v4'
import type {
  AgentLoopAuthorizationOutcome,
  AgentLoopCreateOrBindResult,
  AgentLoopEvent,
  AgentLoopSendResult,
  AgentLoopSubscription,
  AgentLoopTaskBinding,
  AgentLoopTaskDetailsUrl,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v2'
import type { CompatibleBoundAgentLoopClient } from '../../agent-loop-contracts.js'
import type { CordisXResolvedAgentDefinition, HostTask } from '../agent-loop.js'
import { validateAgentLoopTaskDetailsUrl } from '../host-ui/AgentTaskDetailsNavigator.js'

export type CreateCommand = Parameters<BoundAgentLoopClient['createOrBind']>[0]

export type SendCommand = Parameters<BoundAgentLoopClient['send']>[0]

export type Command = CreateCommand | SendCommand

export type RefusedAuthorization = Exclude<AgentLoopAuthorizationOutcome, { state: 'allowed' }>

export type AllowedCreateAuthorization = Extract<AgentLoopCreateOrBindResult, { status: 'accepted' }>['authorization']

export type AllowedSendAuthorization = Extract<AgentLoopSendResult, { status: 'accepted' }>['authorization']

export type EventPayload = AgentLoopEvent extends infer Event
  ? Event extends AgentLoopEvent
    ? Omit<Event, '$schema' | 'contract' | 'schemaVersion' | 'eventId' | 'binding' | 'sequence' | 'occurredAt'>
  : never
  : never

export interface RecordState {
  readonly ownerKey: string
  readonly definition: CordisXResolvedAgentDefinition
  readonly task: HostTask
  readonly detailsUrl: AgentLoopTaskDetailsUrl
  binding: AgentLoopTaskBinding
  readonly events: AgentLoopEvent[]
  readonly listeners: Set<() => void>
  readonly subscriptions: Set<AgentLoopSubscription>
  readonly turnOperations: Map<string, string>
  lifecycleCursor: number
  polling: boolean
  poll: ReturnType<typeof setTimeout> | undefined
  promptDisposers: readonly Disposable<void>[]
}

export interface LedgerEntry<
  Result extends AgentLoopCreateOrBindResult | AgentLoopSendResult = AgentLoopCreateOrBindResult | AgentLoopSendResult,
> {
  readonly ownerKey: string
  readonly fingerprint: string
  readonly firstObservedAt: string
  readonly result: Promise<Result>
  settledResult?: Result
  task?: HostTask
  definition?: CordisXResolvedAgentDefinition
  providerId?: string
  bindingGeneration?: number
  closedAt?: string
}

export interface CordisXAgentLoopBrokerV2Persistence {
  /** Stable Host-private provider affinity for this ledger snapshot. */
  readonly providerKey: string
  read(): string | undefined
  write(value: string): void
}

export interface PersistedLedgerEntry {
  readonly key: string
  readonly ownerKey: string
  readonly fingerprint: string
  readonly firstObservedAt: string
  readonly result: AgentLoopCreateOrBindResult | AgentLoopSendResult
  readonly task?: HostTask
  readonly definition?: CordisXResolvedAgentDefinition
  readonly providerId?: string
  readonly bindingGeneration?: number
  readonly closedAt?: string
}

export interface PersistedBrokerState {
  readonly version: 1
  readonly providerKey: string
  readonly nextBinding: number
  readonly taskGenerations: readonly (readonly [string, number])[]
  readonly ledger: readonly PersistedLedgerEntry[]
}

export function clone<Value>(value: Value): Value {
  const output = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
  return freeze(output)
}

export function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

export function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    )
  }
  return JSON.stringify(canonical(value))
}

export function sameDefinition(
  left: AgentLoopTaskBinding['definition'],
  right: AgentLoopTaskBinding['definition'],
): boolean {
  return left.agentId === right.agentId && left.revision === right.revision
}

export function canonicalAgentLoopTaskDetailsUrl(
  value: AgentLoopTaskDetailsUrl | undefined,
): AgentLoopTaskDetailsUrl | undefined {
  if (value === undefined) return undefined
  try {
    return validateAgentLoopTaskDetailsUrl(value)
  } catch {
    return undefined
  }
}

export function combineAgentLoopClients(
  v1: BoundAgentLoopClientV1,
  v2: BoundAgentLoopClient,
  v3: BoundAgentLoopClientV3,
  v4: BoundAgentLoopClientV4,
): CompatibleBoundAgentLoopClient {
  let disposed = false
  const client = {
    $schema: v4.$schema,
    contract: v4.contract,
    schemaVersion: v4.schemaVersion,
    durableLedger: v4.durableLedger,
    createOrBind: (
      command:
        | Parameters<BoundAgentLoopClientV1['createOrBind']>[0]
        | CreateCommand
        | Parameters<BoundAgentLoopClientV3['createOrBind']>[0]
        | Parameters<BoundAgentLoopClientV4['createOrBind']>[0],
    ) =>
      command.schemaVersion === 4
        ? v4.createOrBind(command)
        : command.schemaVersion === 3
        ? v3.createOrBind(command)
        : command.schemaVersion === 2
        ? v2.createOrBind(command)
        : v1.createOrBind(command),
    send: (
      command:
        | Parameters<BoundAgentLoopClientV1['send']>[0]
        | SendCommand
        | Parameters<BoundAgentLoopClientV3['send']>[0]
        | Parameters<BoundAgentLoopClientV4['send']>[0],
    ) =>
      command.schemaVersion === 4
        ? v4.send(command)
        : command.schemaVersion === 3
        ? v3.send(command)
        : command.schemaVersion === 2
        ? v2.send(command)
        : v1.send(command),
    subscribe: (
      binding:
        | Parameters<BoundAgentLoopClientV1['subscribe']>[0]
        | AgentLoopTaskBinding
        | Parameters<BoundAgentLoopClientV3['subscribe']>[0]
        | Parameters<BoundAgentLoopClientV4['subscribe']>[0],
      afterSequence: number,
    ) =>
      binding.schemaVersion === 4
        ? v4.subscribe(binding, afterSequence)
        : binding.schemaVersion === 3
        ? v3.subscribe(binding, afterSequence)
        : binding.schemaVersion === 2
        ? v2.subscribe(binding, afterSequence)
        : v1.subscribe(binding, afterSequence),
    decideApproval: (
      command:
        | Parameters<BoundAgentLoopClientV3['decideApproval']>[0]
        | Parameters<BoundAgentLoopClientV4['decideApproval']>[0],
    ) => command.schemaVersion === 4 ? v4.decideApproval(command) : v3.decideApproval(command),
    requestMemberSelfIntroduction: (
      command:
        | Parameters<BoundAgentLoopClientV3['requestMemberSelfIntroduction']>[0]
        | Parameters<BoundAgentLoopClientV4['requestMemberSelfIntroduction']>[0],
    ) =>
      command.schemaVersion === 4
        ? v4.requestMemberSelfIntroduction(command)
        : v3.requestMemberSelfIntroduction(command),
    cancelMemberSelfIntroduction: (
      command:
        | Parameters<BoundAgentLoopClientV3['cancelMemberSelfIntroduction']>[0]
        | Parameters<BoundAgentLoopClientV4['cancelMemberSelfIntroduction']>[0],
    ) =>
      command.schemaVersion === 4 ? v4.cancelMemberSelfIntroduction(command) : v3.cancelMemberSelfIntroduction(command),
    dispose: () => {
      if (disposed) return
      disposed = true
      v1.dispose()
      v2.dispose()
      v3.dispose()
      v4.dispose()
    },
  }
  return Object.freeze(client) as unknown as CompatibleBoundAgentLoopClient
}
