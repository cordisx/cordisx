import { describe, expect, it } from 'vitest'
import type { AgentRuntimeRouteScope } from '../packages/cli/src/renderer/platform.js'
import { PlaygroundScenarioSessionScopeAuthority } from '../packages/cli/src/renderer/playground-scenario-session-scope.js'

const plugin = { source: 'file:///plugins/chatroom.ts', pluginId: 'chatroom' } as const
const owner = { pluginId: `${plugin.source}:${plugin.pluginId}`, generation: 7 } as const

function route(sessionId = 'cx-session.lead', instance = 'main:route-lead'): AgentRuntimeRouteScope {
  return Object.freeze({
    kind: 'host-route', active: true, owner: plugin,
    routeId: 'room-session-detail', routeInstanceId: instance,
    path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
    params: Object.freeze({ sessionId }),
  })
}

function harness(input: { readonly owner?: typeof owner | undefined; readonly authorize?: boolean } = {}) {
  let visible: AgentRuntimeRouteScope | undefined = route()
  let authority!: PlaygroundScenarioSessionScopeAuthority
  const authorizations: { capability: string; sessionId: string; effective?: AgentRuntimeRouteScope }[] = []
  let changes = 0
  authority = new PlaygroundScenarioSessionScopeAuthority({
    hostGeneration: 'playground-generation-one',
    currentRoute: () => visible,
    ownerForSession: sessionId => sessionId === 'cx-session.reviewer' ? input.owner ?? owner : undefined,
    authorize: async (_owner, capability, sessionId) => {
      authorizations.push({ capability, sessionId, effective: authority.effectiveRoute() })
      return input.authorize !== false
    },
    mountRoute: () => () => {},
    changed: () => { changes += 1 },
  })
  return { authority, authorizations, changes: () => changes, setVisible: (value: AgentRuntimeRouteScope | undefined) => { visible = value } }
}

describe('Playground scenario exact Session scope authority', () => {
  it('projects only the admitted target Session through the same owner and route until run cleanup', async () => {
    const value = harness()
    const activated = await value.authority.client.activate({
      runId: 'playground-scenario.run-one', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })
    expect(activated.status).toBe('available')
    if (activated.status !== 'available') throw new Error(activated.message)
    expect(value.authorizations).toMatchObject([{
      capability: 'approvals.request', sessionId: 'cx-session.reviewer',
      effective: {
        owner: plugin, routeId: 'room-session-detail',
        path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
        params: { sessionId: 'cx-session.reviewer' },
      },
    }])
    expect(activated.handle.active()).toBe(true)
    expect(value.authority.effectiveRoute()?.params.sessionId).toBe('cx-session.reviewer')
    activated.handle.close()
    activated.handle.close()
    await expect(activated.handle.closed).resolves.toEqual({ code: 'completed' })
    expect(activated.handle.active()).toBe(false)
    expect(value.authority.effectiveRoute()?.params.sessionId).toBe('cx-session.lead')
    expect(value.changes()).toBe(2)
  })

  it('fails closed for missing source route, target Session, cross-owner target, and concurrent run', async () => {
    const missing = harness()
    expect(await missing.authority.client.activate({
      runId: 'run-missing-source', sourceSessionId: 'cx-session.other', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'source-route-unavailable' })
    expect(await missing.authority.client.activate({
      runId: 'run-missing-target', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.unknown',
    })).toMatchObject({ status: 'unavailable', code: 'session-unavailable' })
    expect(await missing.authority.client.activate({
      runId: 'run-source-target', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.lead',
    })).toMatchObject({ status: 'unavailable', code: 'invalid-request' })

    const foreign = harness({ owner: { pluginId: 'file:///plugins/other.ts:other', generation: 1 } as typeof owner })
    expect(await foreign.authority.client.activate({
      runId: 'run-foreign', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'owner-mismatch' })

    const current = harness()
    const first = await current.authority.client.activate({
      runId: 'run-current', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })
    expect(first.status).toBe('available')
    expect(await current.authority.client.activate({
      runId: 'run-other', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'activation-conflict' })
    if (first.status === 'available') first.handle.close()

    const denied = harness({ authorize: false })
    expect(await denied.authority.client.activate({
      runId: 'run-denied', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'authorization-unavailable' })
    expect(denied.authority.effectiveRoute()?.params.sessionId).toBe('cx-session.lead')
  })

  it('settles first-terminal when the visible route changes while authorization is pending', async () => {
    let release!: (value: boolean) => void
    const decision = new Promise<boolean>(resolve => { release = resolve })
    let visible: AgentRuntimeRouteScope | undefined = route()
    let authority!: PlaygroundScenarioSessionScopeAuthority
    authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-one', currentRoute: () => visible,
      ownerForSession: () => owner, authorize: async () => await decision, changed: () => {},
      mountRoute: () => () => {},
    })
    const pending = authority.client.activate({
      runId: 'run-pending', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })
    const handle = authority.effectiveRoute()
    expect(handle?.params.sessionId).toBe('cx-session.reviewer')
    visible = route('cx-session.other', 'main:route-other')
    authority.reconcileVisibleRoute()
    release(true)
    expect(await pending).toMatchObject({ status: 'unavailable', code: 'stale' })
    expect(authority.effectiveRoute()?.params.sessionId).toBe('cx-session.other')
  })

  it('fences replacement and disposal without changing an already settled terminal', async () => {
    const value = harness()
    const activated = await value.authority.client.activate({
      runId: 'run-fenced', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })
    if (activated.status !== 'available') throw new Error(activated.message)
    value.authority.fenceSession('cx-session.reviewer', 'plugin-generation-replaced')
    value.authority.dispose()
    await expect(activated.handle.closed).resolves.toEqual({ code: 'plugin-generation-replaced' })
    expect(activated.handle.active()).toBe(false)
    expect(await value.authority.client.activate({
      runId: 'run-after-dispose', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'disposed' })
  })
})
