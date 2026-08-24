import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXAgentHistory,
  type CordisXAgentEvents,
  type CordisXAgents,
  type CordisXPageMetadataV3,
  type CordisXPageMountContext,
  type CordisXPluginManifestV1,
  type CordisXRouteDefinitionV2,
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
import { HistoricalTraceShowcaseStore } from './history-provider.js'
import type { TraceShowcaseStore } from './types.js'
import { mountTraceShowcase } from './view.js'

export const name = 'agent-trace-showcase'
export const inject = ['i18n', 'pages', 'routes', 'slots', 'agentEvents', 'agentHistory', 'agents', 'systemPrompt']

function metadataText(key: string, fallback: string) {
  return Object.freeze({ namespace: 'agent-trace-showcase', key, fallback } as const)
}

export const TRACE_SESSION_PAGE_METADATA = Object.freeze({
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'session.timeline',
  title: metadataText('page.timeline.title', 'Agent Trace Timeline'),
  description: metadataText(
    'page.timeline.description',
    'Inspect input, model, tool, delivery, and prompt-contribution events for the active Agent session.',
  ),
  icon: 'host:history',
  chrome: 'body-only',
} satisfies CordisXPageMetadataV3)

export const TRACE_SESSION_ROUTE_DEFINITION = Object.freeze({
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'session.timeline',
  path: '/sessions/:sessionId/agent-trace',
  outlet: 'session.content',
  page: 'session.timeline',
  title: metadataText('route.timeline.title', 'Open Agent Trace'),
  description: metadataText(
    'route.timeline.description',
    'Use the conversation header action to open the Agent Trace Timeline for the active session.',
  ),
} satisfies CordisXRouteDefinitionV2<'session.content'>)

export interface Config {
  readonly mode: 'live' | 'historical' | 'fixture'
  readonly historyPageSize: number
  readonly timelineWindowSize: number
}

export const Config = Schema.object({
  mode: Schema.union([
    Schema.const('live'),
    Schema.const('historical'),
    Schema.const('fixture'),
  ]).default('live')
    .extra('extra', { label: { en: 'Data mode', 'zh-CN': '数据模式' } })
    .extra('description', {
      en: 'Choose live public ledger data, Host-imported history merged with live observations, or deterministic fixture data.',
      'zh-CN': '选择实时公开账本、与实时观察合并的 Host 历史导入，或确定性的 fixture 数据。',
    }),
  historyPageSize: Schema.natural().default(100).min(25).max(500).step(25)
    .extra('extra', { label: { en: 'History page size', 'zh-CN': '历史分页大小' } })
    .extra('description', {
      en: 'Historical records requested per Host-brokered page. Applies only in historical mode; maximum 500.',
      'zh-CN': '每次通过 Host 受控接口读取的历史记录数；仅用于 historical 模式，最大 500。',
    }),
  timelineWindowSize: Schema.natural().default(500).min(50).max(500).step(50)
    .extra('extra', { label: { en: 'Timeline window size', 'zh-CN': '时间线窗口大小' } })
    .extra('description', {
      en: 'Maximum merged records retained in the current Timeline window. The Host ceiling remains 500.',
      'zh-CN': '当前时间线保留的合并记录上限；Host 硬上限仍为 500。',
    }),
}).extra('description', {
  en: 'Agent Trace Timeline data-source and bounded-window preferences.',
  'zh-CN': 'Agent Trace 时间线的数据来源与有界窗口偏好。',
})

/** Provider replacement owns subscriptions and tail timers, so config is applied by a fresh Cordis fiber. */
export const configApplies = 'restart' as const

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
      name: 'agent.history.read', required: false,
      reason: { namespace: 'agent-trace-showcase', key: 'permission.agent-history-read', fallback: 'Read the Host-redacted historical projection for the active Agent session.' },
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

export type AgentTraceShowcaseConfig = Config

function configFrom(value: unknown): AgentTraceShowcaseConfig {
  return Config(value === null || typeof value !== 'object' || Array.isArray(value) ? {} : value)
}

export function createTraceShowcaseStore(
  config: AgentTraceShowcaseConfig,
  agentEvents?: CordisXAgentEvents,
  agents?: CordisXAgents,
  systemPrompt?: CordisXSystemPrompt,
  routeSessionId?: string,
  agentHistory?: CordisXAgentHistory,
): TraceShowcaseStore {
  const sessionId = routeSessionId
  if (config.mode === 'fixture' && sessionId !== undefined) {
    return new FixtureTraceShowcaseStore({
      sessionId,
      windowSize: config.timelineWindowSize,
    })
  }
  if (config.mode === 'live' && sessionId !== undefined && agentEvents !== undefined && agents !== undefined && systemPrompt !== undefined) {
    return new LiveTraceShowcaseStore(agentEvents, agents, systemPrompt, sessionId, config.timelineWindowSize)
  }
  if (config.mode === 'historical' && sessionId !== undefined && agentEvents !== undefined
    && agents !== undefined && systemPrompt !== undefined && agentHistory !== undefined) {
    const live = new LiveTraceShowcaseStore(agentEvents, agents, systemPrompt, sessionId, config.timelineWindowSize)
    return new HistoricalTraceShowcaseStore(agentHistory, live, sessionId, {
      pageSize: config.historyPageSize,
      windowSize: config.timelineWindowSize,
    })
  }
  return new UnavailableTraceShowcaseStore(sessionId, config.timelineWindowSize)
}

function mountSessionTimeline(
  context: CordisXPageMountContext,
  config: AgentTraceShowcaseConfig,
  agentEvents: CordisXAgentEvents,
  agents: CordisXAgents,
  systemPrompt: CordisXSystemPrompt,
  agentHistory: CordisXAgentHistory,
): () => void {
  const routeSessionId = context.params.sessionId
  if (typeof routeSessionId !== 'string' || routeSessionId.length === 0) {
    throw new Error('Agent Trace route requires a host-issued session id')
  }
  const store = createTraceShowcaseStore(config, agentEvents, agents, systemPrompt, routeSessionId, agentHistory)
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
      'route.timeline.title': 'Open Agent Trace',
      'route.timeline.description': 'Use the conversation header action to open the Agent Trace Timeline for the active session.',
      'page.timeline.title': 'Agent Trace Timeline',
      'page.timeline.description': 'Inspect input, model, tool, delivery, and prompt-contribution events for the active Agent session.',
      'permission.agent-events-read': 'Read the public Agent event ledger for the active session Timeline.',
      'permission.agent-history-read': 'Read the Host-redacted historical projection for the active Agent session.',
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
      'route.timeline.title': '打开 Agent Trace',
      'route.timeline.description': '使用会话标题栏入口打开当前会话的 Agent Trace 时间线。',
      'page.timeline.title': 'Agent Trace 时间线',
      'page.timeline.description': '查看当前 Agent 会话中的输入、模型、工具、投递与提示词贡献事件。',
      'permission.agent-events-read': '读取当前会话的公开 Agent 事件账本以呈现时间线。',
      'permission.agent-history-read': '读取 Host 脱敏后的当前 Agent 会话历史投影。',
      'permission.messages-append': '运行明确触发的 followup、steer、inject 与只追加 pre-step 演示。',
      'permission.prompt-section': '注册带明确插件来源的 system prompt section 演示。',
      'permission.prompt-context': '注册带明确插件来源的 system prompt context 演示。',
    },
  })

  ctx.pages.register(
    TRACE_SESSION_PAGE_METADATA,
    context => mountSessionTimeline(context, config, ctx.agentEvents, ctx.agents, ctx.systemPrompt, ctx.agentHistory),
  )
  ctx.routes.register(TRACE_SESSION_ROUTE_DEFINITION)

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
