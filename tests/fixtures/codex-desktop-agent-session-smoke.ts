import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentLiveSubscription } from '@cordisx/protocol/agents/v1'
import type { ApprovalAnswererHandle } from '@cordisx/protocol/approval/v1'
import type { SessionEvent, SessionSubscription, UserMessage } from '@cordisx/protocol/sessions/v1'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5, type CordisXPluginManifestV5 } from '../../packages/cli/src/contracts.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  schemaVersion: 5,
  id: 'codex-desktop-agent-session-smoke',
  name: 'Codex Desktop Agent Session Smoke',
  services: [],
  capabilities: [
    'agents.create',
    'agents.resume',
    'agents.get',
    'agents.message.submit',
    'agents.message.cancel',
    'agents.cancel',
    'agents.live.subscribe',
    'sessions.get',
    'sessions.read',
    'sessions.subscribe',
    'approvals.request',
    'approvals.answer',
  ].map(name => ({ name, required: true, scope: {} })),
} as const satisfies CordisXPluginManifestV5

export const inject = ['agents', 'sessions', 'approvals']

export interface DesktopAgentSessionSmokeConfig {
  readonly marker: string
}

export interface DesktopAgentSessionSmokeEntry {
  readonly time: number
  readonly kind: 'operation' | 'live' | 'session' | 'subscription-closed' | 'answerer'
  readonly name: string
  readonly value?: unknown
}

export interface DesktopAgentSessionSmokeSnapshot {
  readonly marker: string
  readonly busy: boolean
  readonly operationOrdinal: number
  readonly current?: string
  readonly last?: { readonly name: string; readonly ok: boolean; readonly value?: unknown; readonly error?: string }
  readonly sessionId?: string
  readonly agentGeneration?: number
  readonly sessionGeneration?: number
  readonly detailRef?: string
  readonly entries: readonly DesktopAgentSessionSmokeEntry[]
}

export interface DesktopAgentSessionSmokeController {
  invoke(name: string, input?: unknown): boolean
  snapshot(): DesktopAgentSessionSmokeSnapshot
  dispose(): Promise<void>
}

const plain = (value: unknown): unknown => {
  if (
    value === undefined || value === null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value !== 'object') return String(value)
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'handle' || typeof entry === 'function' || typeof entry === 'symbol') continue
    result[key] = plain(entry)
  }
  return result
}

const object = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
)

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value
}

const message = (
  id: string,
  text: string,
  owner: { readonly pluginId: string; readonly generation: number },
): UserMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
})

export function createCodexDesktopAgentSessionSmokeController(
  ctx: Context,
  config: DesktopAgentSessionSmokeConfig,
): DesktopAgentSessionSmokeController {
  const entries: DesktopAgentSessionSmokeEntry[] = []
  let handle: AgentHandle | undefined
  let agent: Agent | undefined
  let live: AgentLiveSubscription | undefined
  let sessionSubscription: SessionSubscription | undefined
  let answerer: ApprovalAnswererHandle | undefined
  let busy = false
  let ordinal = 0
  let current: string | undefined
  let last: DesktopAgentSessionSmokeSnapshot['last']

  const record = (kind: DesktopAgentSessionSmokeEntry['kind'], name: string, value?: unknown): void => {
    entries.push(
      Object.freeze({ time: Date.now(), kind, name, ...(value === undefined ? {} : { value: plain(value) }) }),
    )
  }

  const requireAgent = (): Agent => {
    if (agent === undefined) throw new Error('no live Agent handle')
    return agent
  }

  const requireHandle = (): AgentHandle => {
    if (handle === undefined) throw new Error('no live Agent owner handle')
    return handle
  }

  const acquire = (result: Awaited<ReturnType<Context['agents']['create']>>): unknown => {
    if (result.status === 'accepted') {
      handle = result.handle
      agent = result.handle.agent
    }
    return plain(result)
  }

  const operations: Readonly<Record<string, (input: unknown) => Promise<unknown>>> = {
    create: async input => {
      const data = object(input)
      return acquire(
        await ctx.agents.create({
          sessionId: requiredText(data.sessionId, 'sessionId'),
          mutationId: requiredText(data.mutationId, 'mutationId'),
          ...(typeof data.model === 'string' && data.model !== '' ? { options: { model: data.model } } : {}),
        }),
      )
    },
    resume: async input => {
      const data = object(input)
      const result = await ctx.agents.resume({
        sessionId: requiredText(data.sessionId, 'sessionId'),
        mutationId: requiredText(data.mutationId, 'mutationId'),
      })
      return acquire(result)
    },
    get: async input => {
      const found = await ctx.agents.get(requiredText(object(input).sessionId, 'sessionId'))
      return found === undefined ? { status: 'not-found' } : {
        status: 'found',
        id: found.id,
        generation: found.generation,
        sessionId: found.session.id,
        sessionGeneration: found.session.generation,
        ...(found.detail === undefined ? {} : { detail: found.detail }),
      }
    },
    observe: async () => {
      const currentAgent = requireAgent()
      answerer = await ctx.approvals.registerAnswerer(currentAgent, question => {
        record('answerer', question.toolName, question)
        return 'allowed-once'
      })
      const liveResult = await currentAgent.subscribe(event => record('live', event.type, event))
      if (liveResult.status !== 'subscribed') throw new Error(`live subscription unavailable: ${liveResult.status}`)
      live = liveResult.subscription
      const sessionResult = await currentAgent.session.subscribe({ afterSeq: -1, pageSize: 500 }, page => {
        for (const event of page.events) record('session', event.type, event)
      })
      if (sessionResult.status !== 'subscribed') {
        throw new Error(`Session subscription unavailable: ${sessionResult.status}`)
      }
      sessionSubscription = sessionResult.subscription
      void sessionSubscription.closed.then(closed => record('subscription-closed', closed.code, closed))
      return {
        answerer: { agentId: answerer.agentId, agentGeneration: answerer.agentGeneration },
        live: { agentId: live.agentId, agentGeneration: live.agentGeneration },
        session: {
          sessionId: sessionSubscription.sessionId,
          sessionGeneration: sessionSubscription.sessionGeneration,
          subscriptionGeneration: sessionSubscription.subscriptionGeneration,
          replayThrough: sessionSubscription.replayThrough,
        },
      }
    },
    approval: async input =>
      await ctx.approvals.request({
        agent: requireAgent(),
        toolName: requiredText(object(input).toolName, 'toolName'),
        reason: requiredText(object(input).reason, 'reason'),
      }),
    send: async input => {
      const data = object(input)
      const currentAgent = requireAgent()
      const value = message(
        requiredText(data.messageId, 'messageId'),
        requiredText(data.text, 'text'),
        requireHandle().owner,
      )
      const mode = data.mode
      if (mode === 'followup') return await currentAgent.followup(value)
      if (mode === 'steer') return await currentAgent.steer(value)
      if (mode === 'inject') return await currentAgent.inject(value)
      if (mode === 'send') {
        return await currentAgent.send(
          value,
          data.target === 'next-step' ? 'next-step' : 'next-turn',
          data.wakeup !== false,
        )
      }
      throw new Error('unsupported send mode')
    },
    discard: async input => await requireAgent().discard(requiredText(object(input).messageId, 'messageId')),
    cancel: async input =>
      await requireAgent().cancel(
        { kind: 'user' },
        {
          mutationId: requiredText(object(input).mutationId, 'mutationId'),
          keepInbox: object(input).keepInbox === true,
        },
      ),
    idle: async () => await requireAgent().whenIdle(),
    read: async () => {
      const session = requireAgent().session
      const snapshot = await session.snapshot()
      if (snapshot.status !== 'available') return snapshot
      const page = await session.read({ afterSeq: -1, snapshotSeq: snapshot.snapshot.snapshotSeq, limit: 500 })
      return { snapshot, page }
    },
    sessionGet: async input => {
      const found = await ctx.sessions.get(requiredText(object(input).sessionId, 'sessionId'))
      if (found === undefined) return { status: 'not-found' }
      const snapshot = await found.snapshot()
      return { status: 'found', sessionId: found.id, sessionGeneration: found.generation, snapshot }
    },
    disposeAgent: async input => {
      if (handle === undefined) throw new Error('no owner handle')
      const result = await handle.dispose({ mutationId: requiredText(object(input).mutationId, 'mutationId') })
      handle = undefined
      agent = undefined
      return result
    },
    closeObservers: async () => {
      const results = {
        answerer: answerer === undefined ? undefined : await answerer.dispose(),
        live: live === undefined ? undefined : await live.unsubscribe(),
        session: sessionSubscription === undefined ? undefined : await sessionSubscription.unsubscribe(),
      }
      answerer = undefined
      live = undefined
      sessionSubscription = undefined
      return results
    },
  }

  const snapshot = (): DesktopAgentSessionSmokeSnapshot =>
    Object.freeze({
      marker: config.marker,
      busy,
      operationOrdinal: ordinal,
      ...(current === undefined ? {} : { current }),
      ...(last === undefined ? {} : { last: plain(last) as DesktopAgentSessionSmokeSnapshot['last'] }),
      ...(agent === undefined ? {} : {
        sessionId: agent.id,
        agentGeneration: agent.generation,
        sessionGeneration: agent.session.generation,
        ...(agent.detail === undefined ? {} : { detailRef: agent.detail.ref }),
      }),
      entries: entries.map(entry => plain(entry) as DesktopAgentSessionSmokeEntry),
    })

  const dispose = async (): Promise<void> => {
    if (answerer !== undefined) await answerer.dispose().catch(() => undefined)
    if (live !== undefined) await live.unsubscribe().catch(() => undefined)
    if (sessionSubscription !== undefined) await sessionSubscription.unsubscribe().catch(() => undefined)
    if (handle !== undefined) await handle.dispose().catch(() => undefined)
    answerer = undefined
    live = undefined
    sessionSubscription = undefined
    handle = undefined
    agent = undefined
  }

  return Object.freeze({
    invoke(name: string, input?: unknown): boolean {
      const operation = operations[name]
      if (operation === undefined || busy) return false
      busy = true
      current = name
      const operationOrdinal = ++ordinal
      void operation(input).then(value => {
        last = Object.freeze({ name, ok: true, value: plain(value) })
        record('operation', name, { operationOrdinal, ok: true, value })
      }, error => {
        const message = error instanceof Error ? error.message : String(error)
        last = Object.freeze({ name, ok: false, error: message })
        record('operation', name, { operationOrdinal, ok: false, error: message })
      }).finally(() => {
        current = undefined
        busy = false
      })
      return true
    },
    snapshot,
    dispose,
  })
}

declare global {
  // Test-only public-contract controller, present solely in the isolated harness plugin generation.
  // eslint-disable-next-line no-var
  var __cordisxDesktopAgentSessionSmoke: DesktopAgentSessionSmokeController | undefined
}

export function apply(ctx: Context, config: DesktopAgentSessionSmokeConfig): void {
  const controller = createCodexDesktopAgentSessionSmokeController(ctx, config)
  globalThis.__cordisxDesktopAgentSessionSmoke = controller
  ctx.effect(() => async () => {
    if (globalThis.__cordisxDesktopAgentSessionSmoke === controller) delete globalThis.__cordisxDesktopAgentSessionSmoke
    await controller.dispose()
  }, 'Codex Desktop Agent Session smoke fixture')
}
