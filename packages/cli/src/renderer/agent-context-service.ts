import { type Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentContextReadResultV1,
  AgentContextThresholdEventV1,
  AgentContextUnavailableV1,
  AgentContextV1,
  AgentContextWatchResultV1,
} from '@cordisx/protocol/agent-context/v1'
import type { AgentExactTurnControlV1, AgentTurnControlV1 } from '@cordisx/protocol/agent-turn-control/v1'
import type { PermissionBroker } from './platform.js'
import { generationFromContext, ownerFromContext, sourceFromContext } from './ownership.js'
import { generationVisibilityFromContext } from './generation-visibility.js'

/** Host-private current-connection bridge. Handles never cross the public service boundary. */
export interface AgentContextBridge {
  read(input: { readonly sessionId: string }): Promise<AgentContextReadResultV1>
  open(
    input: { readonly sessionId: string; readonly thresholdRatio: number },
  ): Promise<
    { readonly status: 'open'; readonly handle: string; readonly cursor: number } | {
      readonly status: 'unavailable'
      readonly code: AgentContextUnavailableV1
    }
  >
  next(
    input: { readonly handle: string; readonly cursor: number },
  ): Promise<
    { readonly status: 'events'; readonly events: readonly AgentContextThresholdEventV1[]; readonly cursor: number } | {
      readonly status: 'closed'
      readonly code: AgentContextUnavailableV1 | 'unsubscribed'
    }
  >
  close(input: { readonly handle: string }): Promise<void>
}
interface Input {
  readonly broker: PermissionBroker
  readonly bridge?: AgentContextBridge
  readonly live: () => boolean
}
const inputs = new WeakMap<object, Input>()
const original = Symbol.for('cordis.original')
function inputFor(service: object): Input {
  const candidate = (service as { [original]?: object })[original] ?? service
  const input = inputs.get(candidate)
  if (!input) throw new Error('Detached Agent context service')
  return input
}
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512
/** Ignore audit timestamps: unrelated reads emit broker changes as well as policy mutations. */
function permissionSignature(ctx: Context, broker: PermissionBroker): string | undefined {
  const owner = ownerFromContext(ctx), source = sourceFromContext(ctx)
  const entries = broker.snapshots().filter(entry =>
    entry.identity.id === owner && entry.identity.source === source
    && entry.capability === 'agent.events.read'
  )
  if (!entries.length || entries.some(entry => entry.policy === 'deny')) return undefined
  return JSON.stringify(
    entries.map(entry => [entry.policy, entry.scope, entry.fingerprint, entry.blockedReason, entry.authorizationOrigin])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )
}
export class CordisXAgentContextService extends Service implements AgentContextV1 {
  readonly contract = 'cordisx.agent-context/v1' as const
  constructor(ctx: Context, input: Input) {
    super(ctx, 'agentContext')
    inputs.set(this, input)
  }
  private async authorize(sessionId: string): Promise<boolean> {
    const source = sourceFromContext(this.ctx), generation = generationFromContext(this.ctx), input = inputFor(this)
    if (!source || !generation || !input.live()) return false
    const grant = await input.broker.authorize({ id: ownerFromContext(this.ctx), source }, 'agent.events.read', {
      agentSessionId: sessionId,
    }, generationVisibilityFromContext(this.ctx)?.view(this.ctx))
    return grant.ok && input.live()
  }
  async read(sessionId: string): Promise<AgentContextReadResultV1> {
    if (!validId(sessionId)) return { status: 'unavailable', code: 'invalid-request' }
    let active = true
    const input = inputFor(this)
    let signature: string | undefined
    let revoked = false
    const unsubscribe = input.broker.subscribe(() => {
      if (signature !== undefined && permissionSignature(this.ctx, input.broker) !== signature) revoked = true
    })
    const dispose = this.ctx.effect(() => () => {
      active = false
      unsubscribe()
    }, 'agentContext read')
    try {
      const allowed = await this.authorize(sessionId)
      if (!active) return { status: 'unavailable', code: 'generation-replaced' }
      if (!allowed) return { status: 'unavailable', code: 'denied' }
      signature = permissionSignature(this.ctx, input.broker)
      if (!signature || revoked) return { status: 'unavailable', code: 'denied' }
      if (!input.bridge) return { status: 'unavailable', code: 'unsupported' }
      const result = await input.bridge.read({ sessionId })
      if (!active || !input.live()) return { status: 'unavailable', code: 'generation-replaced' }
      if (revoked || permissionSignature(this.ctx, input.broker) !== signature) {
        return { status: 'unavailable', code: 'denied' }
      }
      if (result.status === 'available' && result.sample.sessionId !== sessionId) {
        return { status: 'unavailable', code: 'unavailable' }
      }
      return result
    } catch {
      return { status: 'unavailable', code: 'unavailable' }
    } finally {
      unsubscribe()
      dispose()
    }
  }
  async watch(
    request: { readonly sessionId: string; readonly thresholdRatio: number },
    observer: (event: AgentContextThresholdEventV1) => void | Promise<void>,
  ): Promise<AgentContextWatchResultV1> {
    if (!request || typeof request !== 'object') return { status: 'unavailable', code: 'invalid-request' }
    const { sessionId, thresholdRatio } = request
    if (
      !validId(sessionId) || !Number.isFinite(thresholdRatio) || thresholdRatio <= 0
      || thresholdRatio > .95 || typeof observer !== 'function'
    ) return { status: 'unavailable', code: 'invalid-request' }
    const input = inputFor(this), bridge = input.bridge
    let active = true, handle: string | undefined
    const closure: { code: AgentContextUnavailableV1 | 'unsubscribed' | 'observer-failed' } = {
      code: 'generation-replaced',
    }
    let signature: string | undefined
    let resolveClosed!: (value: { code: AgentContextUnavailableV1 | 'unsubscribed' | 'observer-failed' }) => void
    const closed = new Promise<{ code: AgentContextUnavailableV1 | 'unsubscribed' | 'observer-failed' }>(resolve => {
      resolveClosed = resolve
    })
    const close = async (code: AgentContextUnavailableV1 | 'unsubscribed' | 'observer-failed') => {
      if (!active) return
      active = false
      closure.code = code
      unsubscribe()
      if (handle !== undefined && bridge) {
        try {
          await bridge.close({ handle })
        } catch {}
      }
      resolveClosed({ code })
    }
    const unsubscribe = input.broker.subscribe(() => {
      if (signature !== undefined && permissionSignature(this.ctx, input.broker) !== signature) void close('denied')
    })
    const dispose = this.ctx.effect(() => () => {
      void close('generation-replaced')
    }, 'agentContext subscription')
    try {
      const allowed = await this.authorize(sessionId)
      if (!active) {
        dispose()
        return { status: 'unavailable', code: 'generation-replaced' }
      }
      if (!allowed) {
        dispose()
        return { status: 'unavailable', code: 'denied' }
      }
      signature = permissionSignature(this.ctx, input.broker)
      if (!signature) {
        dispose()
        return { status: 'unavailable', code: 'denied' }
      }
      if (!bridge) {
        dispose()
        return { status: 'unavailable', code: 'unsupported' }
      }
      const opened = await bridge.open({ sessionId, thresholdRatio })
      if (!active && opened.status !== 'open') {
        dispose()
        return { status: 'unavailable', code: closure.code === 'denied' ? 'denied' : 'generation-replaced' }
      }
      if (opened.status !== 'open') {
        dispose()
        return opened
      }
      handle = opened.handle
      if (!active || !input.live()) {
        try {
          await bridge.close({ handle })
        } catch {}
        dispose()
        return { status: 'unavailable', code: closure.code === 'denied' ? 'denied' : 'generation-replaced' }
      }
      void (async () => {
        let cursor = opened.cursor
        try {
          while (active) {
            const page = await bridge.next({ handle: opened.handle, cursor })
            if (!active) break
            if (!input.live()) {
              await close('generation-replaced')
              break
            }
            if (page.status === 'closed') {
              await close(page.code)
              break
            }
            cursor = page.cursor
            for (const event of page.events) {
              if (!active) break
              if (event.sample.sessionId !== sessionId || event.thresholdRatio !== thresholdRatio) {
                await close('unavailable')
                break
              }
              if (permissionSignature(this.ctx, input.broker) !== signature) {
                await close('denied')
                break
              }
              if (!active) break
              try {
                await observer(event)
              } catch {
                await close('observer-failed')
                break
              }
            }
          }
        } catch {
          await close('unavailable')
        }
        dispose()
      })()
      return {
        status: 'subscribed',
        subscription: {
          closed,
          unsubscribe: async () => {
            await close('unsubscribed')
            dispose()
          },
        },
      }
    } catch {
      dispose()
      return { status: 'unavailable', code: 'unavailable' }
    }
  }
}
export interface AgentExactTurnControlBridge {
  acquire(input: { sessionId: string; turnId: string; ownerAuthorization: string }): Promise<
    { status: 'available'; handle: string } | {
      status: 'unavailable'
      code: 'denied' | 'unsupported' | 'stale' | 'host-unavailable'
    }
  >
  cancel(input: { handle: string }): ReturnType<AgentExactTurnControlV1['cancel']>
}
interface TurnControlInput {
  readonly bridge: AgentExactTurnControlBridge
  readonly live: () => boolean
  /** Host business authority, not a plugin argument or an observation permission. */
  authorizeOwner(
    input: { owner: string; source: string; generation: string; sessionId: string; turnId: string },
  ): Promise<string | undefined>
}
const turnInputs = new WeakMap<object, TurnControlInput>()
/** No observation grant can establish exact-turn business authority. */
export class CordisXAgentTurnControlService extends Service implements AgentTurnControlV1 {
  readonly contract = 'cordisx.agent-turn-control/v1' as const
  constructor(ctx: Context, input?: TurnControlInput) {
    super(ctx, 'agentTurnControl')
    if (input) turnInputs.set(this, input)
  }
  async acquire(request: { sessionId: string; turnId: string }): ReturnType<AgentTurnControlV1['acquire']> {
    if (!request || typeof request !== 'object') return { status: 'unavailable', code: 'denied' }
    const { sessionId, turnId } = request
    if (!validId(sessionId) || !validId(turnId)) return { status: 'unavailable', code: 'denied' }
    const input = turnInputs.get((this as { [original]?: object })[original] ?? this)
    if (!input) return { status: 'unavailable', code: 'unsupported' }
    const source = sourceFromContext(this.ctx), generation = generationFromContext(this.ctx)
    if (!source || !generation || !input.live()) return { status: 'unavailable', code: 'denied' }
    let active = true
    const dispose = this.ctx.effect(() => () => {
      active = false
    }, 'agentTurnControl target')
    try {
      const proof = await input.authorizeOwner({
        owner: ownerFromContext(this.ctx),
        source,
        generation,
        sessionId,
        turnId,
      })
      if (!active || !input.live()) {
        dispose()
        return { status: 'unavailable', code: 'stale' }
      }
      if (!proof) {
        dispose()
        return { status: 'unavailable', code: 'denied' }
      }
      const result = await input.bridge.acquire({ sessionId, turnId, ownerAuthorization: proof })
      if (!active || !input.live()) {
        dispose()
        return { status: 'unavailable', code: 'stale' }
      }
      if (result.status !== 'available') {
        dispose()
        return result
      }
      const target = Object.freeze({
        contract: 'cordisx.agent-exact-turn-control/v1' as const,
        sessionId,
        turnId,
        cancel: async () => {
          if (!active || !input.live()) return { status: 'unavailable' as const, code: 'stale' as const }
          try {
            const outcome = await input.bridge.cancel({ handle: result.handle })
            return active && input.live() ? outcome : { status: 'unavailable' as const, code: 'stale' as const }
          } catch {
            return { status: 'unavailable' as const, code: 'host-unavailable' as const }
          }
        },
      }) as AgentExactTurnControlV1
      return { status: 'available', target }
    } catch {
      dispose()
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }
}
