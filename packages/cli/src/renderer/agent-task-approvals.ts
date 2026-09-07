import { AgentTaskApprovalCleanupError } from '../agent-task-record.js'
import type { AgentTaskApprovalBinding, AgentTaskApprovalHandlers } from '@cordisx/protocol/agent-task-binding/v1'
import type { AgentTaskApprovalInstaller } from './agent-tasks.js'
import type { CordisXAgentSessionRuntime } from './agent-session-runtime.js'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'

interface Installation {
  readonly controller: AbortController
  readonly handles: { dispose(): Promise<unknown> }[]
  close(): Promise<void>
}
interface Registration {
  readonly handlers: AgentTaskApprovalHandlers
  readonly installations: Set<Installation>
  active: boolean
}

/** Only approval callbacks are exposed; no plugin callback runs during first-turn preparation. */
export class HostAgentTaskApprovalRegistry {
  private readonly registrations = new Map<string, Registration>()
  constructor(
    private readonly runtime: CordisXAgentSessionRuntime,
    private readonly owner: PluginOwnerIdentity,
    private readonly active: () => boolean,
    private readonly declared: (commandId: string) => boolean,
  ) {}

  register(command: { commandId: string }, handlers: AgentTaskApprovalHandlers): () => void {
    if (
      !this.active() || typeof command?.commandId !== 'string' || !command.commandId.length
      || !this.declared(command.commandId) || this.registrations.has(command.commandId)
      || typeof handlers?.resolveRequest !== 'function'
      || typeof handlers.answerAuthority !== 'function'
      || (handlers.answerLegacy !== undefined && typeof handlers.answerLegacy !== 'function')
    ) {
      throw new Error('Task approval registration unavailable or duplicate')
    }
    const registration: Registration = {
      handlers: Object.freeze({ ...handlers }),
      installations: new Set(),
      active: true,
    }
    this.registrations.set(command.commandId, registration)
    return () => {
      registration.active = false
      if (this.registrations.get(command.commandId) === registration) this.registrations.delete(command.commandId)
      for (const installation of registration.installations) void installation.close().catch(() => undefined)
    }
  }

  capture(commandId: string): AgentTaskApprovalInstaller | undefined {
    const registration = this.registrations.get(commandId)
    if (registration === undefined) return undefined
    const live = (): boolean =>
      this.declared(commandId) && this.active() && registration.active
      && this.registrations.get(commandId) === registration
    return {
      active: live,
      install: async (agent, request, record) => {
        if (!live() || !await this.runtime.authorizeTask(this.owner, 'approval', agent.id)) {
          throw new Error('Task approval registration replaced')
        }
        const controller = new AbortController()
        const handles: Installation['handles'] = []
        const installation: Installation = {
          controller,
          handles,
          close: async () => {
            controller.abort()
            registration.installations.delete(installation)
            const results = await Promise.allSettled(handles.splice(0).map(handle => handle.dispose()))
            if (results.some(result => result.status === 'rejected')) throw new AgentTaskApprovalCleanupError()
          },
        }
        registration.installations.add(installation)
        const current = (): boolean => live() && !controller.signal.aborted
        const binding: AgentTaskApprovalBinding = structuredClone({
          operationId: record.operationId,
          toolScope: request.tool.scope,
        })
        const freeze = (value: unknown): void => {
          if (value === null || typeof value !== 'object') return
          Object.values(value).forEach(freeze)
          Object.freeze(value)
        }
        freeze(binding)
        const invoke = async <Value>(
          fn: (signal: AbortSignal) => Value | Promise<Value>,
          source?: AbortSignal,
        ): Promise<Value> => {
          if (!current() || source?.aborted) throw new Error('Task approval binding unavailable')
          const signal = source === undefined ? controller.signal : AbortSignal.any([source, controller.signal])
          const value = await fn(signal)
          if (!current() || signal.aborted) throw new Error('Task approval binding replaced')
          return value
        }
        const retain = async (handle: { dispose(): Promise<unknown> }): Promise<void> => {
          if (!current() || !await this.runtime.authorizeTask(this.owner, 'approval', agent.id)) {
            await handle.dispose()
            throw new Error('Task approval installation replaced')
          }
          handles.push(handle)
        }
        try {
          await retain(
            await this.runtime.registerAuthorityAnswerer(
              this.owner,
              { agent, definition: request.definition },
              (question, source?: AbortSignal) =>
                invoke(signal => registration.handlers.answerAuthority(question, binding, signal), source),
            ),
          )
          if (registration.handlers.answerLegacy !== undefined) {
            await retain(
              await this.runtime.registerAnswerer(
                this.owner,
                agent,
                (question, source?: AbortSignal) =>
                  invoke(signal => registration.handlers.answerLegacy!(question, binding, signal), source),
              ),
            )
          }
          const resolver = await this.runtime.registerRequestResolver(
            this.owner,
            { agent, definition: request.definition },
            (question, signal) =>
              invoke(combined => registration.handlers.resolveRequest(question, binding, combined), signal),
          )
          if (resolver.status !== 'registered') throw new Error('Task approval resolver unavailable')
          await retain(resolver.handle)
          return installation.close
        } catch (error) {
          await installation.close()
          throw error
        }
      },
    }
  }

  dispose(): void {
    for (const registration of this.registrations.values()) {
      registration.active = false
      for (const installation of registration.installations) void installation.close().catch(() => undefined)
    }
    this.registrations.clear()
  }
}
