import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPageMountContext,
  type CordisXPluginManifestV1,
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
import type { TraceShowcaseStore } from './types.js'
import { mountTraceShowcase } from './view.js'

export const name = 'agent-trace-showcase'
export const inject = ['i18n', 'commands', 'pages', 'routes', 'slots']

/**
 * Fixture builds request no live capabilities. The merged Agent capabilities
 * are added only with the compatible host types/Permission Broker head.
 */
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'agent-trace-showcase',
  name: 'Agent Trace Showcase',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export interface AgentTraceShowcaseConfig {
  readonly mode?: 'fixture' | 'unavailable'
  readonly sessionId?: string
  readonly permissionPolicy?: 'allow' | 'ask' | 'deny'
}

function configFrom(value: unknown): AgentTraceShowcaseConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const mode = input.mode === 'fixture' || input.mode === 'unavailable' ? input.mode : undefined
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

export function createTraceShowcaseStore(config: AgentTraceShowcaseConfig): TraceShowcaseStore {
  if (config.mode === 'fixture' && config.sessionId !== undefined) {
    return new FixtureTraceShowcaseStore({
      sessionId: config.sessionId,
      ...(config.permissionPolicy === undefined ? {} : { permissionPolicy: config.permissionPolicy }),
    })
  }
  return new UnavailableTraceShowcaseStore(config.sessionId)
}

function mountSessionTimeline(
  context: CordisXPageMountContext,
  store: TraceShowcaseStore,
): () => void {
  const routeSessionId = context.params.sessionId
  const providerSessionId = store.getSnapshot().sessionId
  if (routeSessionId === undefined || providerSessionId !== routeSessionId) {
    throw new Error(
      `Agent Trace provider session ${providerSessionId ?? '<unavailable>'} does not match route session ${routeSessionId ?? '<missing>'}`,
    )
  }
  return mountTraceShowcase(context, store)
}

export function installAgentTraceShowcase(
  ctx: Context,
  rawConfig: unknown,
  entry: SessionHeaderEntryAdapter = STRUCTURED_SESSION_HEADER_ENTRY,
): void {
  const config = configFrom(rawConfig)
  const store = createTraceShowcaseStore(config)
  ctx.effect(() => () => store.dispose(), 'agent-trace-showcase: provider lifecycle')

  ctx.i18n.define({
    namespace: 'agent-trace-showcase',
    locale: 'en',
    default: true,
    messages: {
      'action.open': 'Open Agent Trace Timeline',
      'command.open': 'Open the current session Agent Trace Timeline',
      'page.title': 'Agent Trace',
    },
  })
  ctx.i18n.define({
    namespace: 'agent-trace-showcase',
    locale: 'zh-CN',
    messages: {
      'action.open': '打开 Agent Trace 时间线',
      'command.open': '打开当前会话的 Agent Trace 时间线',
      'page.title': 'Agent Trace',
    },
  })
  const message = (key: 'action.open' | 'command.open' | 'page.title', fallback: string) => ({
    namespace: 'agent-trace-showcase', key, fallback,
  } as const)

  ctx.commands.register({
    id: 'open-timeline',
    title: message('command.open', 'Open the current session Agent Trace Timeline'),
    icon: 'host:history',
  }, async (commandContext) => {
    const sessionId = commandContext.hostContext?.identity.agent?.sessionKey
    if (sessionId === undefined) throw new Error('host-issued current Agent session identity is unavailable')
    const providerSessionId = store.getSnapshot().sessionId
    if (providerSessionId !== sessionId) {
      throw new Error(
        `Agent Trace provider session ${providerSessionId ?? '<unavailable>'} does not match invoked session ${sessionId}`,
      )
    }
    await ctx.routes.navigate({ id: 'session.timeline', params: { sessionId } })
  })

  ctx.pages.register({
    id: 'session.timeline',
    title: message('page.title', 'Agent Trace'),
    icon: 'host:history',
    localeNamespace: 'agent-trace-showcase',
  }, context => mountSessionTimeline(context, store))
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
  type SessionHeaderActionContributionV2,
  type SessionHeaderEntryAdapter,
} from './entry.js'
