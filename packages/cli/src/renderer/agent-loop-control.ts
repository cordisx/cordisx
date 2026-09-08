import type { AgentLoopControlResultV1, AgentLoopControlV1 } from '@cordisx/protocol/agent-loop-control/v1'
import type { AgentLoopTaskBinding, BoundAgentLoopClient } from '@cordisx/protocol/agent-loop/v4'
import type { CordisXAgentLoopV4Scope } from './provider-binding.js'

export interface ControlledLoopTransport {
  controlAgentLoop?(
    input: {
      readonly scope: CordisXAgentLoopV4Scope
      readonly action: 'submit' | 'cancel' | 'read' | 'dispose'
      readonly value?: unknown
    },
  ): Promise<unknown>
}
export function createAgentLoopControl(input: {
  readonly transport: ControlledLoopTransport | undefined
  readonly scope: CordisXAgentLoopV4Scope
  readonly createClient: BoundAgentLoopClient
  readonly active: () => boolean
  readonly authorize: (
    capability: 'turns.submit' | 'turns.control' | 'tasks.content.read',
    binding?: AgentLoopTaskBinding,
  ) => Promise<boolean>
}): AgentLoopControlV1 {
  let disposed = false
  const live = () => !disposed && input.active()
  const call = async <T>(
    action: 'submit' | 'cancel' | 'read',
    value: unknown,
  ): Promise<AgentLoopControlResultV1<T>> => {
    if (!live() || input.transport?.controlAgentLoop === undefined) {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
    try {
      const result = await input.transport.controlAgentLoop({
        scope: input.scope,
        action,
        value,
      }) as AgentLoopControlResultV1<T>
      return live() ? structuredClone(result) : { status: 'unavailable', code: 'host-unavailable' }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }
  return Object.freeze({
    contract: 'cordisx.agent-loop-control/v1',
    create: (command: Parameters<AgentLoopControlV1['create']>[0]) => input.createClient.createOrBind(command),
    async submit(value: Parameters<AgentLoopControlV1['submit']>[0]) {
      if (
        !await input.authorize('turns.submit', value.binding) || !await input.authorize('turns.control', value.binding)
      ) {
        return { status: 'unavailable' as const, code: 'denied' as const }
      }
      return await call<import('@cordisx/protocol/agent-loop-control/v1').AgentLoopControlledTurnV1>('submit', value)
    },
    async cancel(value: Parameters<AgentLoopControlV1['cancel']>[0]) {
      if (!await input.authorize('turns.control', value.target.binding)) {
        return { status: 'unavailable' as const, code: 'denied' as const }
      }
      return await call<{ readonly outcome: 'cancelled' | 'already-terminal' }>('cancel', value)
    },
    async read(value: Parameters<AgentLoopControlV1['read']>[0]) {
      if (!await input.authorize('tasks.content.read', value.binding)) {
        return { status: 'unavailable' as const, code: 'denied' as const }
      }
      return await call<{ readonly state: 'running' | 'completed' | 'failed' | 'cancelled' | 'deadline-exceeded' }>(
        'read',
        value,
      )
    },
    dispose() {
      if (disposed) return
      disposed = true
      input.createClient.dispose()
      void input.transport?.controlAgentLoop?.({ scope: input.scope, action: 'dispose' }).catch(() => {})
    },
  })
}
