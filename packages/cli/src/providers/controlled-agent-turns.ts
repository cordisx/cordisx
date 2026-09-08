import { isDeepStrictEqual } from 'node:util'
import type {
  AgentLoopControlledTurnV1,
  AgentLoopControlResultV1,
  AgentLoopControlV1,
} from '@cordisx/protocol/agent-loop-control/v1'
import type { AgentLoopAuthorityScope, AgentLoopTaskLocator } from '../launcher/agent-loop-authority.js'

type State = 'running' | 'completed' | 'failed' | 'cancelled' | 'deadline-exceeded'
type Submit = Parameters<AgentLoopControlV1['submit']>[0]
interface StoredTurn {
  readonly status: 'accepted'
  readonly locator: AgentLoopTaskLocator
  readonly turn: string
  readonly deadline: number
  readonly controlledState: State
}
interface RecordEntry {
  readonly scope: AgentLoopAuthorityScope
  readonly target: AgentLoopControlledTurnV1
  readonly locator: AgentLoopTaskLocator
  state: State
  timer?: ReturnType<typeof setTimeout>
  stopping?: Promise<AgentLoopControlResultV1<{ readonly outcome: 'cancelled' | 'already-terminal' }>>
}
const fail = (
  code:
    | 'binding-unavailable'
    | 'provider-replaced'
    | 'invalid-request'
    | 'host-unavailable'
    | 'deadline-exceeded'
    | 'turn-unavailable'
    | 'reconciliation-required'
    | 'operation-conflict',
) => ({ status: 'unavailable' as const, code })
const accepted = <T>(value: T) => ({ status: 'accepted' as const, value })
const recordKey = (scope: AgentLoopAuthorityScope, id: string) => JSON.stringify([scope.profileId, scope.ownerKey, id])
const same = isDeepStrictEqual

/** Owns real provider deadlines independently of renderer polling or subscriptions. */
export class ControlledAgentTurns {
  private readonly records = new Map<string, RecordEntry>()
  constructor(
    private readonly host: {
      resolve(scope: AgentLoopAuthorityScope, target: Submit['binding']): AgentLoopTaskLocator | undefined
      submit(scope: AgentLoopAuthorityScope, input: Submit): Promise<unknown>
      stored(scope: AgentLoopAuthorityScope, id: string): unknown
      save(scope: AgentLoopAuthorityScope, id: string, state: State): Promise<void>
      terminal(
        locator: AgentLoopTaskLocator,
        turn: string,
      ): { state: 'completed' | 'failed'; observedAt: number } | undefined
      interrupt(locator: AgentLoopTaskLocator, turn: string): Promise<boolean>
    },
  ) {}
  async submit(
    scope: AgentLoopAuthorityScope,
    input: Submit,
  ): Promise<AgentLoopControlResultV1<AgentLoopControlledTurnV1>> {
    if (
      !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 600_000
      || !input.commandId || input.commandId.length > 512
    ) return fail('invalid-request')
    const locator = this.host.resolve(scope, input.binding)
    if (locator === undefined) return fail('binding-unavailable')
    const raw = await this.host.submit(scope, input) as Partial<StoredTurn> & { code?: string }
    if (raw.status !== 'accepted' || typeof raw.turn !== 'string' || raw.deadline !== input.deadline) {
      return fail(raw.code === 'operation-conflict' ? 'operation-conflict' : 'reconciliation-required')
    }
    const target: AgentLoopControlledTurnV1 = {
      contract: 'cordisx.agent-loop-controlled-turn/v1',
      binding: input.binding,
      turn: raw.turn,
      commandId: input.commandId,
      deadline: input.deadline,
    }
    const entry = this.restore(scope, target)
    if (entry === undefined) return fail('reconciliation-required')
    if (input.deadline <= Date.now()) {
      await this.stop(entry, true)
      return fail('deadline-exceeded')
    }
    return accepted(target)
  }
  private restore(scope: AgentLoopAuthorityScope, target: AgentLoopControlledTurnV1): RecordEntry | undefined {
    const locator = this.host.resolve(scope, target.binding)
    if (locator === undefined) return undefined
    const raw = this.host.stored(scope, target.commandId) as Partial<StoredTurn> | undefined
    if (
      target.contract !== 'cordisx.agent-loop-controlled-turn/v1' || raw?.status !== 'accepted'
      || raw.turn !== target.turn || raw.deadline !== target.deadline || raw.controlledState === undefined
      || !same(raw.locator, locator)
    ) return undefined
    const key = recordKey(scope, target.commandId)
    const prior = this.records.get(key)
    if (prior !== undefined) return same(prior.target, target) ? prior : undefined
    if (this.records.size >= 2048) return undefined
    const entry: RecordEntry = { scope, target: structuredClone(target), locator, state: raw.controlledState }
    this.records.set(key, entry)
    if (entry.state === 'running') {
      entry.timer = setTimeout(() => {
        void this.stop(entry, true).catch(() => {})
      }, Math.max(0, target.deadline - Date.now()))
    }
    return entry
  }
  async read(scope: AgentLoopAuthorityScope, target: AgentLoopControlledTurnV1) {
    const entry = this.restore(scope, target)
    if (entry === undefined) return fail('turn-unavailable')
    await this.observe(entry)
    if (entry.state === 'running' && target.deadline <= Date.now()) {
      const stopped = await this.stop(entry, true)
      if (stopped.status !== 'accepted') return stopped
    }
    return accepted({ state: entry.state })
  }
  async cancel(scope: AgentLoopAuthorityScope, target: AgentLoopControlledTurnV1) {
    const entry = this.restore(scope, target)
    return entry === undefined ? fail('turn-unavailable') : await this.stop(entry, false)
  }
  private async observe(entry: RecordEntry) {
    if (entry.state !== 'running') return
    const state = this.host.terminal(entry.locator, entry.target.turn)
    if (state !== undefined) {
      await this.setState(entry, state.observedAt <= entry.target.deadline ? state.state : 'deadline-exceeded')
    }
  }
  private async setState(entry: RecordEntry, state: State) {
    await this.host.save(entry.scope, entry.target.commandId, state)
    entry.state = state
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    delete entry.timer
  }
  private async stop(
    entry: RecordEntry,
    deadline: boolean,
  ): Promise<AgentLoopControlResultV1<{ readonly outcome: 'cancelled' | 'already-terminal' }>> {
    if (entry.stopping !== undefined) return await entry.stopping
    const action = async () => {
      await this.observe(entry)
      if (entry.state !== 'running') return accepted({ outcome: 'already-terminal' as const })
      const stopped = await this.host.interrupt(entry.locator, entry.target.turn)
      // A real completed event may have won while interrupt was in flight.
      await this.observe(entry)
      if (entry.state !== 'running') return accepted({ outcome: 'already-terminal' as const })
      if (!stopped) return fail('turn-unavailable')
      await this.setState(entry, deadline ? 'deadline-exceeded' : 'cancelled')
      return accepted({ outcome: 'cancelled' as const })
    }
    entry.stopping = action()
    try {
      return await entry.stopping
    } finally {
      delete entry.stopping
    }
  }
  async dispose(scope?: AgentLoopAuthorityScope): Promise<void> {
    const entries = [...this.records.values()].filter(entry =>
      scope === undefined
      || entry.scope.profileId === scope.profileId && entry.scope.ownerKey === scope.ownerKey
        && entry.scope.compositionGeneration === scope.compositionGeneration
    )
    await Promise.allSettled(entries.map(entry => this.stop(entry, false)))
    for (const entry of entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      this.records.delete(recordKey(entry.scope, entry.target.commandId))
    }
  }
}
