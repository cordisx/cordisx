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
    connectionGeneration: () => 1,
    currentRoute: () => visible,
    ownerForSession: sessionId => sessionId === 'cx-session.lead' ? owner
      : sessionId === 'cx-session.reviewer' ? input.owner ?? owner : undefined,
    routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
    permissionRoute: () => ({ routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }),
    authorize: async (_owner, capability, sessionId) => {
      authorizations.push({ capability, sessionId, effective: authority.effectiveRoute() })
      return input.authorize !== false
    },
    mountRoute: () => () => {},
    changed: () => { changes += 1 },
  })
  const capture = async (messageId: string): Promise<void> => {
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: `binding-${messageId}`, ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-one', roomId: 'room-one', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-lead', sessionId: 'cx-session.lead' }], active: () => true,
    }, async () => { authority.captureSubmission(owner, 'cx-session.lead', messageId)?.commit() })
  }
  return { authority, authorizations, capture, changes: () => changes, setVisible: (value: AgentRuntimeRouteScope | undefined) => { visible = value } }
}

describe('Playground scenario exact Session scope authority', () => {
  it('captures the exact Shell Room authority before an async command loses foreground route lookup', async () => {
    let shellActive = true
    let mounted: AgentRuntimeRouteScope | undefined
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-captured', connectionGeneration: () => 4,
      currentRoute: () => undefined,
      ownerForSession: sessionId => ['cx-session.lead', 'cx-session.reviewer'].includes(sessionId) ? owner : undefined,
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: (_owner, capability) => capability === 'approvals.request'
        ? { routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }
        : undefined,
      authorize: async () => true,
      mountRoute: value => { mounted = value; return () => { mounted = undefined } },
      changed: () => {},
    })
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: 'binding-room-one', ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-one', roomId: 'room-one', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-lead', sessionId: 'cx-session.lead' }], active: () => shellActive,
    }, async () => {
      const capture = authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.origin')
      expect(capture).toBeDefined()
      await Promise.resolve()
      capture?.commit()
    })
    expect(authority.effectiveRoute()).toBeUndefined()
    const activated = await authority.client.activate({
      runId: 'playground-scenario.captured', sourceMessageId: 'cx-message.origin',
      sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })
    expect(activated.status).toBe('available')
    expect(mounted).toMatchObject({
      owner: plugin, routeId: 'room-session-detail',
      path: '/main/chatroom/:roomId/run/:runId/session/:sessionId', params: { sessionId: 'cx-session.reviewer' },
    })
    if (activated.status !== 'available') throw new Error(activated.message)
    shellActive = false
    expect(activated.handle.active()).toBe(false)
    authority.conversationSource.fenceBinding('binding-room-one', 'route-replaced')
    await expect(activated.handle.closed).resolves.toEqual({ code: 'route-replaced' })
    expect(mounted).toBeUndefined()
  })

  it('activates a single newly admitted Session scope only after its v2 command capture commits', async () => {
    let mounted: AgentRuntimeRouteScope | undefined
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-v2', connectionGeneration: () => 2,
      currentRoute: () => undefined,
      ownerForSession: sessionId => ['cx-session.lead', 'cx-session.created-in-command', 'cx-session.delegated'].includes(sessionId) ? owner : undefined,
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: () => ({ routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }),
      authorize: async () => true,
      mountRoute: route => { mounted = route; return () => { mounted = undefined } },
      changed: () => {},
    })
    const origin = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1', schemaVersion: 1 as const,
      originId: 'origin-single-target', binding: { bindingId: 'binding-single-target', ownerGeneration: 'owner-generation-one' },
      generation: 'plugin-generation-one', executionId: 'execution-single-target', commandId: 'chatroom.message.submit', scope: 'composer-submit' as const,
      room: { roomId: 'room-one', participantId: 'lead', memberId: 'member-lead', runId: 'room-run-lead' },
    }
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: origin.binding.bindingId, ownerGeneration: origin.binding.ownerGeneration,
      snapshotGeneration: 'snapshot-single-target', roomId: origin.room.roomId, routeId: 'chatroom:room',
      runs: [{ runId: origin.room.runId, sessionId: 'cx-session.lead', participantId: origin.room.participantId, memberId: origin.room.memberId }], active: () => true, admissionOrigin: origin,
    }, async () => {
      const capture = authority.captureAdmission(owner, origin, 'cx-session.created-in-command', 1, 'cx-message.created-in-command')
      expect(capture?.active()).toBe(true)
      capture?.commit()
    })
    const activated = await authority.client.activate({
      runId: 'scenario-single-target', sourceMessageId: 'cx-message.created-in-command',
      sourceSessionId: 'cx-session.created-in-command', targetSessionId: 'cx-session.delegated',
    })
    expect(activated.status).toBe('available')
    expect(mounted?.params.sessionId).toBe('cx-session.delegated')
    if (activated.status === 'available') activated.handle.close()
    await expect(activated.status === 'available' ? activated.handle.closed : Promise.resolve()).resolves.toMatchObject({ code: 'completed' })
    authority.dispose()
  })

  it('captures a fresh Shell v9 bootstrap target before the handler has created a Room or Session', async () => {
    let mounted: AgentRuntimeRouteScope | undefined
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-v9', connectionGeneration: () => 3,
      currentRoute: () => undefined,
      ownerForSession: sessionId => ['cx-session.created-in-command', 'cx-session.delegated'].includes(sessionId) ? owner : undefined,
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: () => ({ routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }),
      authorize: async () => true,
      mountRoute: route => { mounted = route; return () => { mounted = undefined } },
      changed: () => {},
    })
    const origin = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const, schemaVersion: 1 as const,
      originId: 'bootstrap-origin-fresh', binding: { bindingId: 'binding-bootstrap-fresh', ownerGeneration: 'owner-generation-one' },
      generation: 'plugin-generation-one', executionId: 'execution-bootstrap-fresh', commandId: 'chatroom.message.submit', scope: 'composer-submit' as const,
    }
    const target = { participantId: 'lead', memberId: 'member-lead', runId: 'room-run-lead' }
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: origin.binding.bindingId, ownerGeneration: origin.binding.ownerGeneration,
      snapshotGeneration: 'snapshot-bootstrap-fresh', routeId: 'chatroom:room',
      runs: [], active: () => true, bootstrapOrigin: origin,
    }, async () => {
      expect(authority.bootstrapAdmissionTargetActive(owner, origin, target)).toBe(true)
      const capture = authority.captureBootstrapAdmissionTarget(owner, origin, target, 'cx-session.created-in-command', 1, 'cx-message.bootstrap-fresh')
      expect(capture?.active()).toBe(true)
      capture?.commit()
    })
    const activated = await authority.client.activate({
      runId: 'scenario-bootstrap-fresh', sourceMessageId: 'cx-message.bootstrap-fresh',
      sourceSessionId: 'cx-session.created-in-command', targetSessionId: 'cx-session.delegated',
    })
    expect(activated.status).toBe('available')
    expect(mounted?.params.sessionId).toBe('cx-session.delegated')
    if (activated.status === 'available') activated.handle.close()
    authority.dispose()
  })

  it('moves a submitted fresh v6 bootstrap source to its exact new Room binding before scenario activation', async () => {
    let oldBindingActive = true
    let newBindingActive = true
    let mounted: AgentRuntimeRouteScope | undefined
    let claim: { readonly sessionId: string; readonly messageId: string; readonly bindingId: string } | undefined
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-v6', connectionGeneration: () => 6,
      currentRoute: () => undefined,
      ownerForSession: sessionId => ['cx-session.v6-lead', 'cx-session.v6-reviewer'].includes(sessionId) ? owner : undefined,
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: () => ({ routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }),
      bootstrapRouteRegistered: (_owner, target) => target.route.routeId === 'room' && target.route.param === 'roomId'
        && target.route.roomId === 'room-v6',
      // The command remains retained through the old binding's route replacement.
      bootstrapRouteClaimActive: () => true,
      claimBootstrapRoute: (_owner, request) => {
        claim = { sessionId: request.source.sessionId, messageId: request.source.messageId, bindingId: request.binding.binding.bindingId }
        return { status: 'claimed', code: 'claimed', receipt: {} } as never
      },
      authorize: async () => true,
      mountRoute: route => { mounted = route; return () => { mounted = undefined } },
      changed: () => {},
    })
    const origin = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const, schemaVersion: 1 as const,
      originId: 'bootstrap-route-origin', binding: { bindingId: 'bootstrap-route-old-binding', ownerGeneration: 'bootstrap-route-owner' },
      generation: 'bootstrap-route-generation', executionId: 'bootstrap-route-execution', commandId: 'chatroom.submit', scope: 'composer-submit' as const,
    }
    const target = {
      roomId: 'room-v6', participantId: 'leader', memberId: 'member-leader', runId: 'run-leader',
      route: { routeId: 'room', param: 'roomId' as const, roomId: 'room-v6' },
    }
    const continuation = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json' as const,
      contract: 'cordisx.agent-admission-bootstrap-route-continuation/v6' as const, schemaVersion: 6 as const, token: 'bootstrap-route-continuation',
    } as never
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: origin.binding.bindingId, ownerGeneration: origin.binding.ownerGeneration,
      snapshotGeneration: 'snapshot-bootstrap-v6', routeId: 'chatroom:new-room', runs: [], active: () => oldBindingActive, bootstrapOrigin: origin,
    }, async () => {
      expect(authority.bootstrapAdmissionRouteTargetActive(owner, origin, target)).toBe(true)
      const capture = authority.captureBootstrapAdmissionRouteTarget(
        owner, origin, target, continuation, 'cx-session.v6-lead', 1, 'cx-message.v6-fresh',
      )
      expect(capture?.active()).toBe(true)
      capture?.commit()
      oldBindingActive = false
      authority.conversationSource.fenceBinding(origin.binding.bindingId, 'route-replaced')
      authority.conversationSource.claimBootstrapRoute({
        owner,
        binding: {
          binding: { bindingId: 'bootstrap-route-new-binding', ownerGeneration: origin.binding.ownerGeneration },
          generation: origin.generation, route: target.route,
        },
        active: () => newBindingActive,
      })
    })
    expect(claim).toEqual({ sessionId: 'cx-session.v6-lead', messageId: 'cx-message.v6-fresh', bindingId: 'bootstrap-route-new-binding' })
    const activated = await authority.client.activate({
      runId: 'scenario-v6-route-rebind', sourceMessageId: 'cx-message.v6-fresh',
      sourceSessionId: 'cx-session.v6-lead', targetSessionId: 'cx-session.v6-reviewer',
    })
    expect(activated.status).toBe('available')
    expect(mounted?.params.sessionId).toBe('cx-session.v6-reviewer')
    newBindingActive = false
    authority.conversationSource.fenceBinding('bootstrap-route-new-binding', 'route-replaced')
    if (activated.status === 'available') await expect(activated.handle.closed).resolves.toEqual({ code: 'route-replaced' })
    expect(await authority.client.activate({
      runId: 'scenario-v6-route-reuse', sourceMessageId: 'cx-message.v6-fresh',
      sourceSessionId: 'cx-session.v6-lead', targetSessionId: 'cx-session.v6-reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'source-route-unavailable' })
    authority.dispose()
  })

  it('fails closed when origin capture is missing, crossed, stale, or navigated away before activation', async () => {
    let shellActive = true
    let sourceOwner = owner
    let connectionGeneration = 1
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-captured', connectionGeneration: () => connectionGeneration,
      currentRoute: () => undefined,
      ownerForSession: sessionId => ['cx-session.lead', 'cx-session.reviewer'].includes(sessionId) ? sourceOwner : undefined,
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: () => ({ routeId: 'room-session-detail', path: '/room/:sessionId' }),
      authorize: async () => true, mountRoute: () => () => {}, changed: () => {},
    })
    expect(await authority.client.activate({
      runId: 'run-no-origin', sourceMessageId: 'cx-message.no-origin',
      sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'source-route-unavailable' })
    await authority.conversationSource.execute({
      owner: 'file:///plugins/other.ts:other', bindingId: 'binding-other', ownerGeneration: 'generation-other',
      snapshotGeneration: 'snapshot-other', roomId: 'room-other', routeId: 'other:room',
      runs: [{ runId: 'room-run-other', sessionId: 'cx-session.lead' }], active: () => true,
    }, async () => {
      expect(authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.crossed')).toBeUndefined()
    })
    let capture: ReturnType<typeof authority.captureSubmission>
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: 'binding-room-one', ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-one', roomId: 'room-one', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-lead', sessionId: 'cx-session.lead' }], active: () => shellActive,
    }, async () => { capture = authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.stale'); capture?.commit() })
    sourceOwner = { ...owner, generation: owner.generation + 1 }
    expect(await authority.client.activate({
      runId: 'run-stale', sourceMessageId: 'cx-message.stale',
      sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'stale' })

    sourceOwner = owner
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: 'binding-room-connection', ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-connection', roomId: 'room-one', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-connection', sessionId: 'cx-session.lead' }], active: () => shellActive,
    }, async () => { capture = authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.connection'); capture?.commit() })
    connectionGeneration += 1
    expect(await authority.client.activate({
      runId: 'run-connection', sourceMessageId: 'cx-message.connection',
      sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'stale' })

    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: 'binding-room-two', ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-two', roomId: 'room-two', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-two', sessionId: 'cx-session.lead' }], active: () => shellActive,
    }, async () => { capture = authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.navigation'); capture?.commit() })
    shellActive = false
    authority.conversationSource.fenceBinding('binding-room-two', 'route-replaced')
    expect(await authority.client.activate({
      runId: 'run-navigation', sourceMessageId: 'cx-message.navigation',
      sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
    })).toMatchObject({ status: 'unavailable', code: 'source-route-unavailable' })
  })

  it('projects only the admitted target Session through the same owner and route until run cleanup', async () => {
    const value = harness()
    await value.capture('cx-message.run-one')
    const activated = await value.authority.client.activate({
      runId: 'playground-scenario.run-one', sourceMessageId: 'cx-message.run-one', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
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
      sourceMessageId: 'cx-message.missing-source',
    })).toMatchObject({ status: 'unavailable', code: 'source-route-unavailable' })
    await missing.capture('cx-message.missing-target')
    expect(await missing.authority.client.activate({
      runId: 'run-missing-target', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.unknown',
      sourceMessageId: 'cx-message.missing-target',
    })).toMatchObject({ status: 'unavailable', code: 'session-unavailable' })
    expect(await missing.authority.client.activate({
      runId: 'run-source-target', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.lead',
      sourceMessageId: 'cx-message.source-target',
    })).toMatchObject({ status: 'unavailable', code: 'invalid-request' })

    const foreign = harness({ owner: { pluginId: 'file:///plugins/other.ts:other', generation: 1 } as typeof owner })
    await foreign.capture('cx-message.foreign')
    expect(await foreign.authority.client.activate({
      runId: 'run-foreign', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.foreign',
    })).toMatchObject({ status: 'unavailable', code: 'owner-mismatch' })

    const current = harness()
    await current.capture('cx-message.current')
    const first = await current.authority.client.activate({
      runId: 'run-current', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.current',
    })
    expect(first.status).toBe('available')
    expect(await current.authority.client.activate({
      runId: 'run-other', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.other',
    })).toMatchObject({ status: 'unavailable', code: 'activation-conflict' })
    if (first.status === 'available') first.handle.close()

    const denied = harness({ authorize: false })
    await denied.capture('cx-message.denied')
    expect(await denied.authority.client.activate({
      runId: 'run-denied', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.denied',
    })).toMatchObject({ status: 'unavailable', code: 'authorization-unavailable' })
    expect(denied.authority.effectiveRoute()?.params.sessionId).toBe('cx-session.lead')
  })

  it('settles first-terminal when the visible route changes while authorization is pending', async () => {
    let release!: (value: boolean) => void
    const decision = new Promise<boolean>(resolve => { release = resolve })
    let visible: AgentRuntimeRouteScope | undefined = route()
    let authority!: PlaygroundScenarioSessionScopeAuthority
    authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-one', connectionGeneration: () => 1, currentRoute: () => visible,
      ownerForSession: () => owner, authorize: async () => await decision, changed: () => {},
      routeOwner: agentOwner => agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation ? plugin : undefined,
      permissionRoute: () => ({ routeId: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }),
      mountRoute: () => () => {},
    })
    await authority.conversationSource.execute({
      owner: owner.pluginId, bindingId: 'binding-pending', ownerGeneration: 'owner-generation-one',
      snapshotGeneration: 'snapshot-generation-one', roomId: 'room-one', routeId: 'chatroom:room',
      runs: [{ runId: 'room-run-lead', sessionId: 'cx-session.lead' }], active: () => visible?.params.sessionId === 'cx-session.lead',
    }, async () => { authority.captureSubmission(owner, 'cx-session.lead', 'cx-message.pending')?.commit() })
    const pending = authority.client.activate({
      runId: 'run-pending', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.pending',
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
    await value.capture('cx-message.fenced')
    const activated = await value.authority.client.activate({
      runId: 'run-fenced', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.fenced',
    })
    if (activated.status !== 'available') throw new Error(activated.message)
    value.authority.fenceSession('cx-session.reviewer', 'plugin-generation-replaced')
    value.authority.dispose()
    await expect(activated.handle.closed).resolves.toEqual({ code: 'plugin-generation-replaced' })
    expect(activated.handle.active()).toBe(false)
    expect(await value.authority.client.activate({
      runId: 'run-after-dispose', sourceSessionId: 'cx-session.lead', targetSessionId: 'cx-session.reviewer',
      sourceMessageId: 'cx-message.after-dispose',
    })).toMatchObject({ status: 'unavailable', code: 'disposed' })
  })
})
