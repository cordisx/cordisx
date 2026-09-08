import type { AgentLoopControlledTurnV1, AgentLoopControlV1 } from '@cordisx/protocol/agent-loop-control/v1'
import type { CordisXPlatformResult, CordisXTaskReadInput } from '../contracts.js'
import type {
  AgentLoopAuthority,
  AgentLoopAuthorityScope,
  AgentLoopProviderFence,
} from '../launcher/agent-loop-authority.js'
import type { ProviderConnection } from './contracts.js'
import { ControlledAgentTurns } from './controlled-agent-turns.js'
import type { ChannelTaskLifecycleRange } from './fleet-lifecycle.js'

type Submit = Parameters<AgentLoopControlV1['submit']>[0]
export interface FleetControlInput {
  readonly scope: AgentLoopAuthorityScope
  readonly action: 'submit' | 'cancel' | 'read' | 'dispose'
  readonly value?: unknown
}
interface Host {
  authority(): AgentLoopAuthority | undefined
  generationFor(providerId: string): string
  withProvider<Value>(
    providerId: string,
    operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
    generation?: string,
  ): Promise<CordisXPlatformResult<Value>>
  transaction(
    input: { readonly scope: AgentLoopAuthorityScope; readonly command: unknown; readonly operationId: string },
    provider: AgentLoopProviderFence,
    execute: (digest: string) => Promise<unknown>,
  ): Promise<unknown>
  readLifecycle(session: CordisXTaskReadInput['session'], after: number): ChannelTaskLifecycleRange
}

/** Adapts durable controlled turns to the Fleet's exact provider generations. */
export class FleetControlledAgentTurns {
  private readonly turns = new ControlledAgentTurns({
    resolve: (scope, binding) => this.host.authority()?.resolveBinding(scope, binding),
    submit: (scope, input) => this.submit(scope, input),
    stored: (scope, id) => this.host.authority()?.committedResult(scope, id),
    save: async (scope, id, state) => {
      const authority = this.host.authority()
      if (authority === undefined) throw new Error('authority unavailable')
      await authority.setControlledTurnState(scope, id, state)
    },
    terminal: (locator, turn) => {
      const event = this.host.readLifecycle({
        providerId: locator.providerId,
        remoteSessionId: locator.remoteSessionId,
      }, -1)
        .events.find(event =>
          event.providerGeneration === locator.providerGeneration && event.turnId === turn
          && (event.type === 'turn.completed' || event.type === 'turn.failed')
        )
      return event === undefined ? undefined : {
        state: event.type === 'turn.completed' ? 'completed' as const : 'failed' as const,
        observedAt: Date.parse(event.observedAt),
      }
    },
    interrupt: async (locator, turn) => {
      const result = await this.host.withProvider(locator.providerId, adapter =>
        adapter.controlTurn({
          action: 'interrupt',
          session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
          turnId: turn,
        }), locator.providerGeneration)
      return result.ok
    },
  })
  constructor(private readonly host: Host) {}

  private async submit(scope: AgentLoopAuthorityScope, input: Submit): Promise<unknown> {
    const locator = this.host.authority()?.resolveBinding(scope, input.binding)
    if (locator === undefined || this.host.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    if (input.content.some(part => part.kind !== 'text')) return { status: 'unavailable', code: 'unsupported' }
    const message = input.content.map(part => part.kind === 'text' ? part.text : '').join('\n')
    if (!message.trim() || message.length > 65_536) return { status: 'unavailable', code: 'invalid-request' }
    return await this.host.transaction(
      { scope, operationId: input.commandId, command: { type: 'controlled-submit', ...input } },
      locator,
      async commandDigest => {
        const sent = await this.host.withProvider(locator.providerId, adapter =>
          adapter.submitTurn({
            session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
            message,
            operationId: input.commandId,
            operationDigest: commandDigest,
          }), locator.providerGeneration)
        return !sent.ok ? { status: 'unavailable', code: 'host-unavailable' } : {
          status: 'accepted',
          locator,
          turn: sent.value.turnId,
          deadline: input.deadline,
          controlledState: 'running',
        }
      },
    )
  }

  async handle(input: FleetControlInput): Promise<unknown> {
    if (input.action === 'dispose') {
      await this.turns.dispose(input.scope)
      return { status: 'accepted', value: null }
    }
    if (input.action === 'submit') return await this.turns.submit(input.scope, input.value as Submit)
    if (input.action === 'read') return await this.turns.read(input.scope, input.value as AgentLoopControlledTurnV1)
    const request = input.value as Parameters<AgentLoopControlV1['cancel']>[0]
    const target = request.target
    const locator = this.host.authority()?.resolveBinding(input.scope, target.binding)
    if (locator === undefined) return { status: 'unavailable', code: 'turn-unavailable' }
    return await this.host.transaction(
      { scope: input.scope, operationId: request.commandId, command: { type: 'controlled-cancel', ...request } },
      locator,
      async () => await this.turns.cancel(input.scope, target),
    )
  }

  async dispose(scope?: AgentLoopAuthorityScope): Promise<void> {
    await this.turns.dispose(scope)
  }
}
