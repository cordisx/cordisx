import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXAgentEvents,
  type CordisXAgents,
  type CordisXPageMountContext,
  type CordisXPluginManifestV1,
  type CordisXSystemPrompt,
} from 'cordisx/contracts'
import {
  STRUCTURED_SESSION_HEADER_ENTRY,
  TRACE_SESSION_HEADER_ACTION,
  type SessionHeaderEntryAdapter,
} from './entry.js'
import {
  FixtureTraceShowcaseStore,
  UnavailableTraceShowcaseStore,
} from './providers.js'
import { LiveTraceShowcaseStore } from './live-provider.js'
import type { TraceShowcaseStore } from './types.js'
import { mountTraceShowcase } from './view.js'

export const name = 'agent-trace-showcase'
export const inject = ['i18n', 'pages', 'routes', 'slots', 'agentEvents', 'agents', 'systemPrompt']

/** Live authority is optional, user-triggered, brokered, and generation-fenced. */
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'agent-trace-showcase',
  name: 'Agent Trace Showcase',
  capabilities: [
    {
      name: 'agent.events.read', required: false,
      reason: { namespace: 'agent-trace-showcase', key: 'permission.agent-events-read', fallback: 'Read the public Agent event ledger for the active session Timeline.' },
      scope: {},
    },
    {
      name: 'agent.messages.append', required: false,
      reason: { namespace: 'agent-trace-showcase', key: 'permission.messages-append', fallback: 'Run explicit followup, steer, inject, and append-only pre-step demonstrations.' },
      scope: {},
    },
    {
      name: 'agent.prompt.section', required: false,
      reason: { namespace: 'agent-trace-showcase', key: 'permission.prompt-section', fallback: 'Register an explicit source-attributed system prompt section demonstration.' },
      scope: {},
    },
    {
      name: 'agent.prompt.context', required: false,
      reason: { namespace: 'agent-trace-showcase', key: 'permission.prompt-context', fallback: 'Register an explicit source-attributed system prompt context demonstration.' },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

export interface AgentTraceShowcaseConfig {
  readonly mode?: 'fixture' | 'live' | 'unavailable'
  readonly sessionId?: string
  readonly permissionPolicy?: 'allow' | 'ask' | 'deny'
}

function configFrom(value: unknown): AgentTraceShowcaseConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const mode = input.mode === 'fixture' || input.mode === 'live' || input.mode === 'unavailable' ? input.mode : undefined
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : undefined
  const permissionPolicy = input.permissionPolicy === 'allow' || input.permissionPolicy === 'ask' || input.permissionPolicy === 'deny'
    ? input.permissionPolicy
    : undefined
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
  }
}

export function createTraceShowcaseStore(
  config: AgentTraceShowcaseConfig,
  agentEvents?: CordisXAgentEvents,
  agents?: CordisXAgents,
  systemPrompt?: CordisXSystemPrompt,
  routeSessionId?: string,
): TraceShowcaseStore {
  const sessionId = routeSessionId ?? config.sessionId
  if (config.mode === 'fixture' && config.sessionId !== undefined && sessionId === config.sessionId) {
    return new FixtureTraceShowcaseStore({
      sessionId,
      ...(config.permissionPolicy === undefined ? {} : { permissionPolicy: config.permissionPolicy }),
    })
  }
  if (config.mode === 'live' && sessionId !== undefined && agentEvents !== undefined && agents !== undefined && systemPrompt !== undefined) {
    return new LiveTraceShowcaseStore(agentEvents, agents, systemPrompt, sessionId)
  }
  return new UnavailableTraceShowcaseStore(sessionId)
}

function mountSessionTimeline(
  context: CordisXPageMountContext,
  config: AgentTraceShowcaseConfig,
  agentEvents: CordisXAgentEvents,
  agents: CordisXAgents,
  systemPrompt: CordisXSystemPrompt,
): () => void {
  const routeSessionId = context.params.sessionId
  if (typeof routeSessionId !== 'string' || routeSessionId.length === 0) {
    throw new Error('Agent Trace route requires a host-issued session id')
  }
  if (config.mode === 'fixture' && config.sessionId !== routeSessionId) {
    throw new Error(
      `Agent Trace provider session ${config.sessionId ?? '<unavailable>'} does not match route session ${routeSessionId}`,
    )
  }
  const store = createTraceShowcaseStore(config, agentEvents, agents, systemPrompt, routeSessionId)
  const unmount = mountTraceShowcase(context, store)
  return () => {
    unmount()
    store.dispose()
  }
}

export function installAgentTraceShowcase(
  ctx: Context,
  rawConfig: unknown,
  entry: SessionHeaderEntryAdapter = STRUCTURED_SESSION_HEADER_ENTRY,
): void {
  const config = configFrom(rawConfig)

  ctx.i18n.define({
    namespace: 'agent-trace-showcase',
    locale: 'en',
    default: true,
    messages: {
      'action.open': 'Open Agent Trace Timeline',
      'page.title': 'Agent Trace',
      'permission.agent-events-read': 'Read the public Agent event ledger for the active session Timeline.',
      'permission.messages-append': 'Run explicit followup, steer, inject, and append-only pre-step demonstrations.',
      'permission.prompt-section': 'Register an explicit source-attributed system prompt section demonstration.',
      'permission.prompt-context': 'Register an explicit source-attributed system prompt context demonstration.',
    },
  })
  ctx.i18n.define({
    namespace: 'agent-trace-showcase',
    locale: 'zh-CN',
    messages: {
      'action.open': '打开 Agent Trace 时间线',
      'page.title': 'Agent Trace',
      'permission.agent-events-read': '读取当前会话的公开 Agent 事件账本以呈现时间线。',
      'permission.messages-append': '运行明确触发的 followup、steer、inject 与只追加 pre-step 演示。',
      'permission.prompt-section': '注册带明确插件来源的 system prompt section 演示。',
      'permission.prompt-context': '注册带明确插件来源的 system prompt context 演示。',
    },
  })
  const message = (key: 'action.open' | 'page.title', fallback: string) => ({
    namespace: 'agent-trace-showcase', key, fallback,
  } as const)

  ctx.pages.register({
    id: 'session.timeline',
    title: message('page.title', 'Agent Trace'),
    icon: 'host:history',
    chrome: 'body-only',
    localeNamespace: 'agent-trace-showcase',
  }, context => mountSessionTimeline(context, config, ctx.agentEvents, ctx.agents, ctx.systemPrompt))
  ctx.routes.register({
    id: 'session.timeline',
    path: '/sessions/:sessionId/agent-trace',
    outlet: 'session.content',
    page: 'session.timeline',
    title: message('page.title', 'Agent Trace'),
  })

  ctx.effect(
    () => entry.register(ctx, TRACE_SESSION_HEADER_ACTION),
    'agent-trace-showcase: session header entry',
  )
}

export function apply(ctx: Context, config: unknown): void {
  installAgentTraceShowcase(ctx, config)
}

export type * from './types.js'
export {
  STRUCTURED_SESSION_HEADER_ENTRY,
  TRACE_SESSION_HEADER_ACTION,
  type SessionHeaderActionContributionV3,
  type SessionHeaderEntryAdapter,
} from './entry.js'
