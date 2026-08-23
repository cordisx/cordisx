import { describe, expect, it } from 'vitest'
import {
  SURFACE_CONTRIBUTION_V2_SCHEMA,
  TRACE_SESSION_HEADER_ACTION,
} from '../src/entry.js'
import { manifest } from '../src/index.js'

describe('Agent Trace session header contribution', () => {
  it('matches the fixed catalog-v2 session.header.actions action family', () => {
    expect(TRACE_SESSION_HEADER_ACTION).toEqual({
      $schema: SURFACE_CONTRIBUTION_V2_SCHEMA,
      schemaVersion: 2,
      id: 'open-timeline',
      surface: 'session.header.actions',
      group: 'action',
      order: 10,
      item: {
        label: {
          namespace: 'agent-trace-showcase', key: 'action.open', fallback: 'Open Agent Trace Timeline',
        },
        ariaLabel: {
          namespace: 'agent-trace-showcase', key: 'action.open', fallback: 'Open Agent Trace Timeline',
        },
        icon: 'host:history',
        command: { id: 'open-timeline' },
      },
    })
    expect(Object.isFrozen(TRACE_SESSION_HEADER_ACTION)).toBe(true)
    expect(Object.isFrozen(TRACE_SESSION_HEADER_ACTION.item)).toBe(true)
  })

  it('contains no renderer, selector, free-DOM, or private identity escape hatch', () => {
    const serialized = JSON.stringify(TRACE_SESSION_HEADER_ACTION).toLocaleLowerCase()
    for (const forbidden of [
      'html', 'svg', 'css', 'selector', 'dom', 'node', 'mount', 'renderer',
      'sessionid', 'providerid', 'remotesessionid', 'platformsession', 'additionalcontext',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(TRACE_SESSION_HEADER_ACTION.item.icon.startsWith('host:')).toBe(true)
    expect('route' in TRACE_SESSION_HEADER_ACTION.item).toBe(false)
  })

  it('declares only the four optional public capabilities used by live demos', () => {
    expect(manifest.capabilities.map(capability => ({
      name: capability.name, required: capability.required, scope: capability.scope,
    }))).toEqual([
      { name: 'agent.events.read', required: false, scope: {} },
      { name: 'agent.messages.append', required: false, scope: {} },
      { name: 'agent.prompt.section', required: false, scope: {} },
      { name: 'agent.prompt.context', required: false, scope: {} },
    ])
  })
})
