import type { Context } from '@deepseek-ai/cordis'
import type { AgentToolBindingHandle, AgentToolHandler, AgentTools } from '@cordisx/protocol/agent-tools/v1'
import type { JsonValue } from '@cordisx/protocol/sessions/v1'
import type { AgentToolSetup } from '../plugin-agent-tool-contracts.js'
import type { BrowserOwnerDocumentBridge, OwnerDocumentPrincipalBinding } from './owner-documents.js'

interface Registration {
  readonly id: string
  readonly commandId: string
  readonly handler: AgentToolHandler
  readonly ready: Promise<unknown>
  readonly options: AgentToolClientOptions
  active: boolean
}
interface SessionBinding {
  readonly registration: Registration
  readonly handle: Omit<AgentToolBindingHandle, 'revoke'>
  revoked: boolean
}
export interface AgentToolClientOptions {
  readonly bridge: BrowserOwnerDocumentBridge
  readonly principal: OwnerDocumentPrincipalBinding | undefined
  readonly active: () => boolean
  readonly ownsSession: (sessionId: string) => boolean
}
const registrations = new Map<string, Registration>()
const bindings = new Map<string, SessionBinding>()
const recoveringSessions = new Set<string>()
const invocations = new Map<string, AbortController>()
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  freeze(copy)
  return copy
}
function live(registration: Registration, sessionId: string): boolean {
  return registration.active && registration.options.active() && registration.options.ownsSession(sessionId)
}
function call(registration: Registration, operation: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const principal = registration.options.principal
  if (principal === undefined) return Promise.reject(new Error('agent tool authority unavailable'))
  return registration.options.bridge.request(principal.token, { operation, registrationId: registration.id, ...input })
}

/** Host transport receiver, installed in the same renderer execution context as its plugin. */
export async function dispatchAgentTool(request: Record<string, unknown>): Promise<unknown> {
  const registration = registrations.get(String(request.registrationId))
  if (registration === undefined || !registration.active || !registration.options.active()) {
    throw new Error('agent tool handler unavailable')
  }
  if (request.action === 'validate') return live(registration, String(request.sessionId))
  const invocationId = String(request.invocationId)
  if (request.action === 'cancel') {
    invocations.get(invocationId)?.abort()
    return null
  }
  if (request.action !== 'invoke' || typeof request.binding !== 'object' || request.binding === null) {
    throw new Error('invalid agent tool invocation')
  }
  const binding = request.binding as { sessionId: string; scope: JsonValue }
  const current = bindings.get(binding.sessionId)
  if (
    current === undefined || current.revoked || current.registration !== registration
    || !live(registration, binding.sessionId) || Date.parse(current.handle.expiresAt) <= Date.now()
    || current.handle.bindingId !== request.bindingId || current.handle.expiresAt !== request.expiresAt
  ) throw new Error('agent tool binding is stale')
  const controller = new AbortController()
  invocations.set(invocationId, controller)
  try {
    return await registration.handler({
      input: immutable(request.input as JsonValue),
      binding: immutable(binding),
      signal: controller.signal,
    })
  } finally {
    invocations.delete(invocationId)
  }
}

declare global {
  var __cordisxDispatchAgentToolV1: typeof dispatchAgentTool | undefined
}
globalThis.__cordisxDispatchAgentToolV1 = dispatchAgentTool

/** Freshly checked by the native transport immediately before real execution. */
export async function getAgentToolSetup(sessionId: string): Promise<AgentToolSetup> {
  if (recoveringSessions.has(sessionId)) throw new Error('Agent tools require a fresh binding after recovery')
  const binding = bindings.get(sessionId)
  if (binding === undefined) return { skills: [], commands: [] }
  if (binding.revoked || !live(binding.registration, sessionId)) {
    throw new Error('agent tool setup unavailable; rebind required')
  }
  return immutable(
    await call(binding.registration, 'agent-tools-setup', { bindingId: binding.handle.bindingId }) as AgentToolSetup,
  )
}

/** The real plugin context supplies both owner identity and fiber disposal. */
export function installAgentTools(
  ctx: Context,
  options: AgentToolClientOptions,
): AgentTools & { dispose(): void; validateCommand(commandId: string): Promise<boolean> } {
  const owned = new Map<string, Registration>()
  let remove = (): void => {}
  const dispose = (): void => {
    remove()
    for (const registration of owned.values()) {
      registration.active = false
      registrations.delete(registration.id)
      for (const binding of bindings.values()) if (binding.registration === registration) binding.revoked = true
      void registration.ready.then(() => call(registration, 'agent-tools-unregister')).catch(() => undefined)
    }
    owned.clear()
  }
  ctx.effect(() => dispose)
  const service: AgentTools = {
    register(command, handler) {
      if (!options.active() || owned.has(command.id)) {
        throw new Error('agent tool registration unavailable or duplicate')
      }
      if (options.principal === undefined) throw new Error('agent tool authority unavailable')
      const registrationId = crypto.randomUUID()
      const ready = options.bridge.request(options.principal.token, {
        operation: 'agent-tools-register',
        registrationId,
        commandId: command.id,
      })
      // Bind awaits the actual registration rejection. Avoid an unhandled promise
      // when a consumer only registers and never starts a Session.
      void ready.catch(() => undefined)
      const registration: Registration = {
        id: registrationId,
        commandId: command.id,
        handler,
        options,
        ready,
        active: true,
      }
      owned.set(command.id, registration)
      registrations.set(registrationId, registration)
      return () => {
        registration.active = false
        registrations.delete(registrationId)
        owned.delete(command.id)
        for (const binding of bindings.values()) if (binding.registration === registration) binding.revoked = true
        void ready.then(() => call(registration, 'agent-tools-unregister')).catch(() => undefined)
      }
    },
    async bind(request) {
      const registration = owned.get(request.commandId)
      if (registration === undefined || !live(registration, request.sessionId)) {
        throw new Error('agent tool Session owner mismatch')
      }
      const prior = bindings.get(request.sessionId)
      if (prior !== undefined) {
        prior.revoked = true
        await call(prior.registration, 'agent-tools-revoke', { bindingId: prior.handle.bindingId })
      }
      await registration.ready
      const handle = await call(registration, 'agent-tools-bind', request) as Omit<AgentToolBindingHandle, 'revoke'>
      const binding: SessionBinding = { registration, handle, revoked: false }
      bindings.set(request.sessionId, binding)
      recoveringSessions.delete(request.sessionId)
      return Object.freeze({
        ...handle,
        async revoke() {
          binding.revoked = true
          await call(registration, 'agent-tools-revoke', { bindingId: handle.bindingId })
        },
      })
    },
  }
  remove = ctx.reflect.provide('agentTools', service)
  return Object.assign(service, {
    dispose,
    async validateCommand(commandId: string): Promise<boolean> {
      const registration = owned.get(commandId)
      if (registration === undefined || !registration.active || !options.active()) return false
      try {
        await registration.ready
        return registration.active && options.active()
      } catch {
        return false
      }
    },
  })
}

/** A validated native recovery grants owner eligibility, never execution authority. */
export async function beginAgentToolRecovery(sessionId: string): Promise<void> {
  recoveringSessions.add(sessionId)
  const binding = bindings.get(sessionId)
  if (binding !== undefined) {
    binding.revoked = true
    await call(binding.registration, 'agent-tools-revoke', { bindingId: binding.handle.bindingId })
  }
}
