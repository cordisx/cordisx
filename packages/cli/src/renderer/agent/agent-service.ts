import { Context, Service } from '@deepseek-ai/cordis'
import type { Disposable } from '@deepseek-ai/cordis'
import type {
  CordisXAgent,
  CordisXAgentDeliveryHandle,
  CordisXAgentMessageInput,
  CordisXAgents,
  CordisXAgentTarget,
  CordisXPreStepHandler,
  CordisXPromptContribution,
  CordisXSystemPrompt,
} from '../../agent-contracts.js'
import type { CordisXPluginIdentity } from '../../platform-contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../service.js'
import { generationFromContext } from '../ownership.js'
import type { PluginConsoleAspect } from '../plugin-console.js'

import { CordisXHostAgentRuntime, freeze, validId } from './agent-runtime.js'

export const runtimes = new WeakMap<object, CordisXHostAgentRuntime>()

export const consoles = new WeakMap<object, PluginConsoleAspect>()

export const CORDIS_ORIGINAL = Symbol.for('cordis.original')

export function runtimeFor(service: object): CordisXHostAgentRuntime {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const runtime = runtimes.get(candidate)
      if (runtime !== undefined) return runtime
    }
  }
  throw new Error('CordisX Agent service is detached from its HostRuntime')
}

export function consoleFor(service: object): PluginConsoleAspect | undefined {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const console = consoles.get(candidate)
      if (console !== undefined) return console
    }
  }
  return undefined
}

export function caller(ctx: Context): CordisXPluginIdentity {
  const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  if (scoped[CORDISX_PLUGIN_ID] === undefined || scoped[CORDISX_PLUGIN_SOURCE] === undefined) {
    throw new Error('Agent capabilities require a plugin context')
  }
  return { id: scoped[CORDISX_PLUGIN_ID], source: scoped[CORDISX_PLUGIN_SOURCE] }
}

export class CordisXAgentService extends Service implements CordisXAgents {
  constructor(
    ctx: Context,
    input: CordisXHostAgentRuntime | {
      readonly runtime: CordisXHostAgentRuntime
      readonly console: PluginConsoleAspect
    },
  ) {
    super(ctx, 'agents')
    const runtime = input instanceof CordisXHostAgentRuntime ? input : input.runtime
    runtimes.set(this, runtime)
    if (!(input instanceof CordisXHostAgentRuntime)) consoles.set(this, input.console)
  }

  get(sessionId: string): CordisXAgent {
    if (!validId(sessionId)) throw new Error('sessionId must be a non-empty opaque id')
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const moduleGeneration = generationFromContext(this.ctx) ?? runtimeFor(this).generation
    const runtime = runtimeFor(this)
    const send = (
      message: CordisXAgentMessageInput,
      target: CordisXAgentTarget,
      wakeup: boolean,
    ): CordisXAgentDeliveryHandle => {
      const trace = token === undefined || console === undefined
        ? undefined
        : console.beginPending(token, 'agents.messages.append', { target, wakeup, message }, { sessionId })
      const handle = runtime.send(identity, sessionId, message, target, wakeup, moduleGeneration, trace)
      this.ctx.effect(
        () => () => runtime.releaseOwner(identity, 'owner-disposed', moduleGeneration),
        `agents.delivery(${JSON.stringify(handle.deliveryId)})`,
      )
      return handle
    }
    return Object.freeze({
      send,
      followup: (message: CordisXAgentMessageInput) => send(message, 'next-turn', true),
      steer: (message: CordisXAgentMessageInput) => send(message, 'next-step', true),
      inject: (message: CordisXAgentMessageInput) => send(message, 'next-step', false),
      clearPending: () =>
        token === undefined || console === undefined
          ? runtime.clearPending(identity, sessionId, moduleGeneration)
          : console.runSync(token, 'agents.clearPending', { sessionId }, () =>
            runtime.clearPending(identity, sessionId, moduleGeneration)),
    })
  }

  preStep(handler: CordisXPreStepHandler): Disposable<void> {
    if (typeof handler !== 'function') throw new Error('preStep handler must be a function')
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const moduleGeneration = generationFromContext(this.ctx) ?? runtimeFor(this).generation
    const scoped = token === undefined || console === undefined
      ? handler
      : console.wrapCallback(token, 'agents.preStep', handler)
    const register = (): Disposable<void> =>
      this.ctx.effect(
        () => runtimeFor(this).registerPreStep(identity, scoped, moduleGeneration),
        'agents.preStep',
      ) as Disposable<void>
    return token === undefined || console === undefined
      ? register()
      : console.runSync(token, 'agents.preStep.register', {}, register)
  }
}

export class CordisXSystemPromptService extends Service implements CordisXSystemPrompt {
  constructor(
    ctx: Context,
    input: CordisXHostAgentRuntime | {
      readonly runtime: CordisXHostAgentRuntime
      readonly console: PluginConsoleAspect
    },
  ) {
    super(ctx, 'systemPrompt')
    const runtime = input instanceof CordisXHostAgentRuntime ? input : input.runtime
    runtimes.set(this, runtime)
    if (!(input instanceof CordisXHostAgentRuntime)) consoles.set(this, input.console)
  }

  section(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('section', contribution)
  }

  context(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('context', contribution)
  }

  private register(kind: 'section' | 'context', contribution: CordisXPromptContribution): Disposable<void> {
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const moduleGeneration = generationFromContext(this.ctx) ?? runtimeFor(this).generation
    const register = (): Disposable<void> =>
      this.ctx.effect(
        () => runtimeFor(this).registerPrompt(identity, kind, contribution, moduleGeneration),
        `systemPrompt.${kind}(${JSON.stringify(contribution.id)})`,
      ) as Disposable<void>
    return token === undefined || console === undefined
      ? register()
      : console.runSync(token, `systemPrompt.${kind}.register`, contribution, register)
  }
}
