import { describe, expect, it, vi } from 'vitest'

import type { AgentCancelCause, AgentOptions, AgentSetup } from '@cordisx/protocol/agents/v1'

import type { ApprovalQuestion as ApprovalQuestionV2 } from '@cordisx/protocol/approval/v2'

import type { UserMessage } from '@cordisx/protocol/sessions/v1'

import type { ApprovalRequestRoutingQuestion, ApprovalRequestRoutingResult } from '@cordisx/protocol/approval/v3'

import { Context } from '@deepseek-ai/cordis'

import {
  CordisXAgentAdmissionBootstrapReservationService,
  CordisXAgentAdmissionBootstrapRoomReservationService,
  CordisXAgentAdmissionBootstrapRoomTargetService,
  CordisXAgentAdmissionBootstrapRouteDeclarationService,
  CordisXAgentAdmissionBootstrapRouteReservationService,
  CordisXAgentAdmissionBootstrapTargetService,
  CordisXAgentAdmissionTargetOriginService,
  CordisXAgentAdmissionTargetReservationService,
  CordisXAgentRegistryServiceV1,
  CordisXAgentSessionRuntime,
  CordisXApprovalServiceV1,
  type CordisXPrivateAgentDriver,
  CordisXSessionRegistryServiceV1,
} from '../packages/cli/src/renderer/agent-session-runtime.js'

import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
} from '../packages/cli/src/agent-session-migration-contracts.js'

import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

import {
  type AgentActiveRoute,
  AgentRouteSessionScopeAuthority,
} from '../packages/cli/src/renderer/agent-route-session-scope.js'

import { PlaygroundScenarioSessionScopeAuthority } from '../packages/cli/src/renderer/playground-scenario-session-scope.js'

class Driver implements CordisXPrivateAgentDriver {
  private readonly replacement = new Set<() => void>()
  private readonly approvals = new Set<
    (
      request: {
        readonly sessionId: string
        readonly toolName: string
        readonly callId?: string
        readonly reason?: string
      },
    ) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  >()
  readonly submitted: string[] = []
  async create(): Promise<{ readonly status: 'accepted' }> {
    return { status: 'accepted' }
  }
  async resume(): Promise<{ readonly status: 'accepted' }> {
    return { status: 'accepted' }
  }
  async submit(input: { readonly message: UserMessage }): Promise<'accepted'> {
    this.submitted.push(input.message.id)
    return 'accepted'
  }
  async discard(): Promise<'accepted'> {
    return 'accepted'
  }
  async cancel(_input: { readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted'> {
    return 'accepted'
  }
  onApprovalRequest(
    listener: (
      request: {
        readonly sessionId: string
        readonly toolName: string
        readonly callId?: string
        readonly reason?: string
      },
    ) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
  ): () => void {
    this.approvals.add(listener)
    return () => this.approvals.delete(listener)
  }
  async ask(
    request: {
      readonly sessionId: string
      readonly toolName: string
      readonly callId?: string
      readonly reason?: string
    },
  ): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    const listener = [...this.approvals][0]
    return listener === undefined ? 'unavailable' : await listener(request)
  }
  onReplacement(listener: () => void): () => void {
    this.replacement.add(listener)
    return () => this.replacement.delete(listener)
  }
  replace(): void {
    for (const listener of this.replacement) listener()
  }
  dispose(): void {
    this.replacement.clear()
    this.approvals.clear()
  }
}

const owner = { pluginId: 'registry:test', generation: 1 } as const

const message = (id: string): UserMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
})

const setup: AgentSetup = {
  definition: { agentId: 'lead', revision: 'revision-session-1' },
  definitions: [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'base', revision: 'revision-base-1' },
    name: 'Base',
    promptSections: [{ sectionId: 'base-introduction', kind: 'introduction', text: 'Base operating context.' }],
    inherit: {
      promptSections: 'none',
      rules: 'none',
      skills: 'none',
      tools: 'none',
      mcpServers: 'none',
      runtimeDefaults: 'none',
    },
  }, {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'lead', revision: 'revision-session-1' },
    name: 'Lead exact',
    extends: [{ agentId: 'base', revision: 'revision-base-1' }],
    promptSections: [{
      sectionId: 'lead-introduction',
      kind: 'introduction',
      text: 'Coordinates the exact Session room.',
    }],
    inherit: {
      promptSections: 'append',
      rules: 'merge',
      skills: 'merge',
      tools: 'merge',
      mcpServers: 'merge',
      runtimeDefaults: 'merge',
      avatar: 'inherit',
    },
  }],
}

describe('Agent/Session Host authority v1', () => {
  it('composes v6 claim liveness through the retained live command, before command completion or scenario activation', async () => {
    const driver = new Driver()
    let oldBindingActive = true
    let newBindingActive = true
    let runtime!: CordisXAgentSessionRuntime
    const lifecycle: string[] = []
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: 'bootstrap-route-composed-origin',
      binding: {
        bindingId: 'bootstrap-route-composed-old-binding',
        ownerGeneration: 'bootstrap-route-composed-owner-generation',
      },
      generation: 'bootstrap-route-composed-plugin-generation',
      executionId: 'bootstrap-route-composed-execution',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
    }
    const target = {
      roomId: 'room-bootstrap-route-composed',
      participantId: 'leader',
      memberId: 'member-leader',
      runId: 'run-leader',
      route: { routeId: 'room', param: 'roomId' as const, roomId: 'room-bootstrap-route-composed' },
    }
    const sourceSessionId = 'cx-session.bootstrap-route-composed-lead'
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-bootstrap-route-composed',
      connectionGeneration: () => 1,
      currentRoute: () => undefined,
      ownerForSession: sessionId =>
        sessionId === sourceSessionId || sessionId === 'cx-session.bootstrap-route-composed-reviewer'
          ? owner
          : undefined,
      routeOwner: agentOwner =>
        agentOwner.pluginId === owner.pluginId && agentOwner.generation === owner.generation
          ? { source: 'file:///fixtures/registry.ts', pluginId: 'registry' }
          : undefined,
      permissionRoute: () => ({
        routeId: 'room-session-detail',
        path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
      }),
      bootstrapRouteRegistered: (_owner, candidate) =>
        candidate.roomId === target.roomId && candidate.route.routeId === target.route.routeId
        && candidate.route.param === target.route.param && candidate.route.roomId === target.route.roomId,
      claimBootstrapRoute: (claimOwner, request) => {
        lifecycle.push('claim')
        return runtime.claimAdmissionBootstrapRoute(claimOwner, request)
      },
      authorize: async () => true,
      mountRoute: () => () => {},
      changed: () => {},
    })
    runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      bootstrapAdmissionRouteTargetActive: (claimOwner, candidate, declaredTarget) =>
        authority.bootstrapAdmissionRouteTargetActive(claimOwner, candidate, declaredTarget),
      bootstrapAdmissionRouteClaimActive: (claimOwner, candidate, declaredTarget) =>
        authority.bootstrapAdmissionRouteClaimActive(claimOwner, candidate, declaredTarget),
      captureBootstrapAdmissionRouteTarget: (
        claimOwner,
        candidate,
        declaredTarget,
        continuation,
        sessionId,
        generation,
        messageId,
      ) =>
        authority.captureBootstrapAdmissionRouteTarget(
          claimOwner,
          candidate,
          declaredTarget,
          continuation,
          sessionId,
          generation,
          messageId,
        ),
    })

    await authority.conversationSource.execute({
      owner,
      bindingId: origin.binding.bindingId,
      ownerGeneration: origin.binding.ownerGeneration,
      snapshotGeneration: 'bootstrap-route-composed-snapshot',
      routeId: 'chatroom:new-room',
      runs: [],
      active: () => oldBindingActive,
      bootstrapOrigin: origin,
    }, async () => {
      const declaration = await runtime.declareAdmissionBootstrapRoute(owner, { origin, target })
      expect(declaration.status).toBe('declared')
      if (declaration.status !== 'declared') throw new Error('bootstrap route target was not declared')
      const created = await runtime.create(owner, { sessionId: sourceSessionId, setup })
      expect(created.status).toBe('accepted')
      if (created.status !== 'accepted') throw new Error('bootstrap route Session was not created')
      const reservation = await runtime.reserveAdmissionBootstrapRoute(owner, {
        handle: created.handle,
        continuation: declaration.continuation,
        message: { text: 'fresh room source' },
      })
      expect(reservation.status).toBe('reserved')
      if (reservation.status !== 'reserved') throw new Error('bootstrap route reservation was not created')
      await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
      lifecycle.push('submitted')

      oldBindingActive = false
      authority.conversationSource.fenceBinding(origin.binding.bindingId, 'route-replaced')
      authority.conversationSource.claimBootstrapRoute({
        owner,
        binding: {
          binding: {
            bindingId: 'bootstrap-route-composed-new-binding',
            ownerGeneration: origin.binding.ownerGeneration,
          },
          generation: origin.generation,
          route: target.route,
        },
        active: () => newBindingActive,
      })
    })
    lifecycle.push('command-completed')

    const activated = await authority.client.activate({
      runId: 'scenario-bootstrap-route-composed',
      sourceMessageId: driver.submitted[0]!,
      sourceSessionId,
      targetSessionId: 'cx-session.bootstrap-route-composed-reviewer',
    })
    lifecycle.push('scenario-tick')
    expect(activated.status).toBe('available')
    expect(lifecycle).toEqual(['submitted', 'claim', 'command-completed', 'scenario-tick'])
    if (activated.status === 'available') activated.handle.close()
    newBindingActive = false
    await runtime.dispose()
    authority.dispose()
  })

  it('fails closed for v6 cross-Room, cross-target, premature, reused, and command-complete continuations', async () => {
    const driver = new Driver()
    let commandActive = true
    let capturedMessage: string | undefined
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: 'bootstrap-route-fences',
      binding: { bindingId: 'bootstrap-route-old', ownerGeneration: 'bootstrap-route-owner' },
      generation: 'bootstrap-route-generation',
      executionId: 'bootstrap-route-execution',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
    }
    const target = {
      roomId: 'room-fences',
      participantId: 'leader',
      memberId: 'member-leader',
      runId: 'run-leader',
      route: { routeId: 'room', param: 'roomId' as const, roomId: 'room-fences' },
    }
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      bootstrapAdmissionRouteTargetActive: (_owner, candidate) =>
        commandActive
        && [origin.originId, 'bootstrap-route-complete'].includes(candidate.originId),
      bootstrapAdmissionRouteClaimActive: (_owner, candidate) =>
        commandActive
        && [origin.originId, 'bootstrap-route-complete'].includes(candidate.originId),
      captureBootstrapAdmissionRouteTarget: (
        _owner,
        _candidate,
        current,
        _continuation,
        sessionId,
        _generation,
        messageId,
      ) => {
        if (current.runId !== target.runId || sessionId !== 'cx-session.bootstrap-route-fences') return undefined
        capturedMessage = messageId
        return { active: () => commandActive, commit: () => {}, close: () => {} }
      },
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.bootstrap-route-fences', setup })
    if (created.status !== 'accepted') throw new Error('v6 fence target unavailable')
    const declaration = await runtime.declareAdmissionBootstrapRoute(owner, { origin, target })
    if (declaration.status !== 'declared') throw new Error('v6 declaration denied')
    await expect(runtime.declareAdmissionBootstrapRoute(owner, { origin, target })).resolves.toMatchObject({
      status: 'denied',
      code: 'duplicate-target',
    })
    await expect(runtime.declareAdmissionBootstrapRoute(owner, {
      origin,
      target: { ...target, roomId: 'room-foreign', route: { ...target.route, roomId: 'room-foreign' } },
    })).resolves.toMatchObject({ status: 'denied', code: 'cross-room' })
    expect(runtime.claimAdmissionBootstrapRoute(owner, {
      continuation: declaration.continuation,
      binding: {
        binding: { bindingId: 'new-binding', ownerGeneration: origin.binding.ownerGeneration },
        generation: origin.generation,
        route: target.route,
      },
      source: { sessionId: 'cx-session.bootstrap-route-fences', messageId: 'cx-message.premature' },
    })).toMatchObject({ status: 'denied', code: 'not-submitted' })
    const reservation = await runtime.reserveAdmissionBootstrapRoute(owner, {
      handle: created.handle,
      continuation: declaration.continuation,
      message: { text: 'fenced route submission' },
    })
    if (reservation.status !== 'reserved') throw new Error('v6 reservation denied')
    await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    expect(runtime.claimAdmissionBootstrapRoute(owner, {
      continuation: declaration.continuation,
      binding: {
        binding: { bindingId: 'new-binding', ownerGeneration: origin.binding.ownerGeneration },
        generation: origin.generation,
        route: target.route,
      },
      source: { sessionId: 'cx-session.bootstrap-route-fences', messageId: 'cx-message.cross-target' },
    })).toMatchObject({ status: 'denied', code: 'source-mismatch' })
    expect(runtime.claimAdmissionBootstrapRoute(owner, {
      continuation: declaration.continuation,
      binding: {
        binding: { bindingId: 'new-binding', ownerGeneration: origin.binding.ownerGeneration },
        generation: origin.generation,
        route: target.route,
      },
      source: { sessionId: 'cx-session.bootstrap-route-fences', messageId: capturedMessage! },
    })).toMatchObject({ status: 'claimed' })
    expect(runtime.claimAdmissionBootstrapRoute(owner, {
      continuation: declaration.continuation,
      binding: {
        binding: { bindingId: 'new-binding-again', ownerGeneration: origin.binding.ownerGeneration },
        generation: origin.generation,
        route: target.route,
      },
      source: { sessionId: 'cx-session.bootstrap-route-fences', messageId: capturedMessage! },
    })).toMatchObject({ status: 'denied', code: 'reused' })

    const completed = await runtime.declareAdmissionBootstrapRoute(owner, {
      origin: { ...origin, originId: 'bootstrap-route-complete' },
      target,
    })
    if (completed.status !== 'declared') throw new Error('v6 completion declaration denied')
    const completedReservation = await runtime.reserveAdmissionBootstrapRoute(owner, {
      handle: created.handle,
      continuation: completed.continuation,
      message: { text: 'before command completes' },
    })
    if (completedReservation.status !== 'reserved') throw new Error('v6 completion reservation denied')
    await expect(completedReservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    commandActive = false
    expect(runtime.claimAdmissionBootstrapRoute(owner, {
      continuation: completed.continuation,
      binding: {
        binding: { bindingId: 'new-binding-after-complete', ownerGeneration: origin.binding.ownerGeneration },
        generation: origin.generation,
        route: target.route,
      },
      source: { sessionId: 'cx-session.bootstrap-route-fences', messageId: capturedMessage! },
    })).toMatchObject({ status: 'denied', code: 'command-complete' })
    await runtime.dispose()
  })
})
