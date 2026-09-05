import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'
import { describe, expect, it } from 'vitest'
import {
  type SessionHeaderEntryAdapter,
  SURFACE_CONTRIBUTION_V3_SCHEMA,
  TRACE_SESSION_HEADER_ACTION,
} from '../src/entry.js'
import {
  installAgentTraceShowcase,
  manifest,
  TRACE_SESSION_PAGE_METADATA,
  TRACE_SESSION_ROUTE_DEFINITION,
} from '../src/index.js'

describe('Agent Trace session header contribution', () => {
  it('matches the fixed catalog-v3 session.header.actions route-toggle family', () => {
    expect(TRACE_SESSION_HEADER_ACTION).toEqual({
      $schema: SURFACE_CONTRIBUTION_V3_SCHEMA,
      schemaVersion: 3,
      id: 'open-timeline',
      surface: 'session.header.actions',
      group: 'action',
      order: 10,
      item: {
        label: {
          namespace: 'agent-trace-showcase',
          key: 'action.open',
          fallback: 'Open Agent Trace Timeline',
        },
        ariaLabel: {
          namespace: 'agent-trace-showcase',
          key: 'action.open',
          fallback: 'Open Agent Trace Timeline',
        },
        icon: 'host:history',
        route: { id: 'session.timeline' },
        routeBehavior: 'toggle',
      },
    })
    expect(Object.isFrozen(TRACE_SESSION_HEADER_ACTION)).toBe(true)
    expect(Object.isFrozen(TRACE_SESSION_HEADER_ACTION.item)).toBe(true)
  })

  it('contains no renderer, selector, free-DOM, or private identity escape hatch', () => {
    const serialized = JSON.stringify(TRACE_SESSION_HEADER_ACTION).toLocaleLowerCase()
    for (
      const forbidden of [
        'html',
        'svg',
        'css',
        'selector',
        'dom',
        'node',
        'mount',
        'renderer',
        'sessionid',
        'providerid',
        'remotesessionid',
        'platformsession',
        'additionalcontext',
      ]
    ) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(TRACE_SESSION_HEADER_ACTION.item.icon.startsWith('host:')).toBe(true)
    expect('command' in TRACE_SESSION_HEADER_ACTION.item).toBe(false)
  })

  it('publishes localized route-v2 and page-v3 metadata without translating canonical identity', () => {
    expect(TRACE_SESSION_ROUTE_DEFINITION).toEqual({
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'session.timeline',
      path: '/sessions/:sessionId/agent-trace',
      outlet: 'session.content',
      page: 'session.timeline',
      title: {
        namespace: 'agent-trace-showcase',
        key: 'route.timeline.title',
        fallback: 'Open Agent Trace',
      },
      description: {
        namespace: 'agent-trace-showcase',
        key: 'route.timeline.description',
        fallback: 'Use the conversation header action to open the Agent Trace Timeline for the active session.',
      },
    })
    expect(TRACE_SESSION_PAGE_METADATA).toEqual({
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'session.timeline',
      title: {
        namespace: 'agent-trace-showcase',
        key: 'page.timeline.title',
        fallback: 'Agent Trace Timeline',
      },
      description: {
        namespace: 'agent-trace-showcase',
        key: 'page.timeline.description',
        fallback: 'Inspect input, model, tool, delivery, and prompt-contribution events for the active Agent session.',
      },
      icon: 'host:history',
      chrome: 'body-only',
    })
    expect(Object.isFrozen(TRACE_SESSION_ROUTE_DEFINITION)).toBe(true)
    expect(Object.isFrozen(TRACE_SESSION_PAGE_METADATA)).toBe(true)
    expect(TRACE_SESSION_ROUTE_DEFINITION.title.key).not.toBe(TRACE_SESSION_PAGE_METADATA.title.key)
    expect(TRACE_SESSION_ROUTE_DEFINITION.description.key).not.toBe(TRACE_SESSION_PAGE_METADATA.description.key)
  })

  it('registers independent English and Chinese route and page copy', () => {
    const catalogs: { locale: string; messages: Record<string, string> }[] = []
    const pages: unknown[] = []
    const routes: unknown[] = []
    const context = {
      i18n: { define: (catalog: { locale: string; messages: Record<string, string> }) => catalogs.push(catalog) },
      pages: { register: (metadata: unknown) => pages.push(metadata) },
      routes: { register: (definition: unknown) => routes.push(definition) },
      agentEvents: {},
      agentHistory: {},
      agents: {},
      systemPrompt: {},
      effect: (setup: () => unknown) => setup(),
    } as unknown as Context
    const entry = { register: () => () => undefined } as SessionHeaderEntryAdapter

    installAgentTraceShowcase(context, { mode: 'fixture' }, entry)

    expect(pages).toEqual([TRACE_SESSION_PAGE_METADATA])
    expect(routes).toEqual([TRACE_SESSION_ROUTE_DEFINITION])
    expect(catalogs).toHaveLength(2)
    const english = catalogs.find(catalog => catalog.locale === 'en')!.messages
    const chinese = catalogs.find(catalog => catalog.locale === 'zh-CN')!.messages
    expect(english).toMatchObject({
      'route.timeline.title': 'Open Agent Trace',
      'route.timeline.description':
        'Use the conversation header action to open the Agent Trace Timeline for the active session.',
      'page.timeline.title': 'Agent Trace Timeline',
      'page.timeline.description':
        'Inspect input, model, tool, delivery, and prompt-contribution events for the active Agent session.',
    })
    expect(chinese).toMatchObject({
      'route.timeline.title': '打开 Agent Trace',
      'route.timeline.description': '使用会话标题栏入口打开当前会话的 Agent Trace 时间线。',
      'page.timeline.title': 'Agent Trace 时间线',
      'page.timeline.description': '查看当前 Agent 会话中的输入、模型、工具、投递与提示词贡献事件。',
    })
    expect(english['route.timeline.description']).not.toBe(english['page.timeline.description'])
    expect(chinese['route.timeline.description']).not.toBe(chinese['page.timeline.description'])
  })

  it('declares only the five optional public capabilities used by live and historical modes', () => {
    expect(manifest.capabilities.map(capability => ({
      name: capability.name,
      required: capability.required,
      scope: capability.scope,
    }))).toEqual([
      { name: 'agent.events.read', required: false, scope: {} },
      { name: 'agent.history.read', required: false, scope: {} },
      { name: 'agent.messages.append', required: false, scope: {} },
      { name: 'agent.prompt.section', required: false, scope: {} },
      { name: 'agent.prompt.context', required: false, scope: {} },
    ])
  })
})
