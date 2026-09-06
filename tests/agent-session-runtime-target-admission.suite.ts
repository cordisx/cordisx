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
  it('keeps adopted driver approval bindings fail-closed while never-registered bindings retain v1', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true, declares: () => true })
    const routed = await runtime.create(owner, { sessionId: 'cx-session.driver-routed', setup })
    const legacy = await runtime.create(owner, { sessionId: 'cx-session.driver-legacy', setup })
    if (routed.status !== 'accepted' || legacy.status !== 'accepted') throw new Error('agents unavailable')
    const malformed = await runtime.registerRequestResolver(owner, {
      agent: routed.handle.agent,
      definition: setup.definition,
    }, question => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
      contract: 'cordisx.approval-request-routing-result/v1',
      schemaVersion: 1,
      routingId: `${question.routingId}-wrong`,
      registration: question.registration,
      status: 'unavailable',
      code: 'mapping-unavailable',
    }))
    if (malformed.status !== 'registered') throw new Error('resolver unavailable')
    await expect(driver.ask({ sessionId: routed.sessionId, toolName: 'shell', reason: 'route me' })).resolves.toBe(
      'unavailable',
    )
    await expect(malformed.handle.dispose()).resolves.toMatchObject({ code: 'disposed' })
    await expect(driver.ask({ sessionId: routed.sessionId, toolName: 'shell', reason: 'still route required' }))
      .resolves.toBe('unavailable')
    expect(await routed.handle.agent.session.snapshot()).toMatchObject({
      status: 'available',
      snapshot: { snapshotSeq: -1 },
    })

    await expect(driver.ask({ sessionId: legacy.sessionId, toolName: 'shell' })).resolves.toBe('unavailable')
    expect(await legacy.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 1, limit: 10 })).toMatchObject({
      status: 'available',
      page: { events: [{ type: 'approval/asked' }, { type: 'approval/decided' }] },
    })

    const first = await runtime.registerRequestResolver(owner, {
      agent: routed.handle.agent,
      definition: setup.definition,
    }, () => {
      throw new Error('stale')
    })
    const second = await runtime.registerRequestResolver(owner, {
      agent: routed.handle.agent,
      definition: setup.definition,
    }, question => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
      contract: 'cordisx.approval-request-routing-result/v1',
      schemaVersion: 1,
      routingId: question.routingId,
      registration: question.registration,
      status: 'unavailable',
      code: 'authority-unavailable',
    }))
    if (first.status !== 'registered' || second.status !== 'registered') throw new Error('replacement unavailable')
    await expect(first.handle.closed).resolves.toMatchObject({ code: 'requester-replaced' })
    await first.handle.dispose()
    driver.replace()
    await expect(second.handle.closed).resolves.toMatchObject({ code: 'connection-replaced' })
    await runtime.dispose()
  })

  it('registers a declared dynamic answerer before route activation and authorizes only at exact invocation', async () => {
    const driver = new Driver()
    let active: AgentActiveRoute | undefined
    const decisions: string[] = []
    const routes = new AgentRouteSessionScopeAuthority({
      activeRoute: () => active,
      routes: candidate =>
        candidate.pluginId === owner.pluginId && candidate.generation === owner.generation
          ? [{ id: 'room-session-detail', path: '/main/chatroom/:roomId/session/:sessionId', schemaVersion: 2 }]
          : [],
      decide: async plan => {
        decisions.push(`${plan.capability}:${plan.scope.sessionIds[0]}`)
        return { authorized: true }
      },
      connectionGeneration: () => 1,
    })
    routes.install(owner, [
      {
        manifestVersion: 6,
        name: 'approvals.request',
        required: false,
        scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
      },
      {
        manifestVersion: 6,
        name: 'approvals.answer',
        required: false,
        scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
      },
    ])
    routes.validateInstalledRoutes(owner)
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async (candidate, capability, sessionId) =>
        capability === 'agents.create'
        || await routes.authorize(candidate, capability, sessionId),
      declares: (candidate, capability) => routes.declares(candidate, capability),
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.reviewer' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const answerer = vi.fn(async () => 'allowed-once' as const)
    const handle = await runtime.registerAnswerer(owner, created.handle.agent, answerer)
    expect(decisions).toEqual([])
    await expect(runtime.registerAnswerer(owner, created.handle.agent, answerer)).rejects.toThrow('already registered')
    await expect(runtime.registerAnswerer({ pluginId: 'other:plugin', generation: 1 }, created.handle.agent, answerer))
      .rejects.toThrow('unavailable')

    await expect(runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' }))
      .resolves.toMatchObject({ outcome: 'unavailable' })
    active = {
      owner,
      routeId: 'room-session-detail',
      instanceId: 'route-lead',
      params: { sessionId: 'cx-session.lead' },
    }
    await expect(runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' }))
      .resolves.toMatchObject({ outcome: 'unavailable' })
    expect(answerer).not.toHaveBeenCalled()

    active = {
      owner,
      routeId: 'room-session-detail',
      instanceId: 'route-reviewer',
      params: { sessionId: 'cx-session.reviewer' },
    }
    await expect(runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' }))
      .resolves.toMatchObject({ outcome: 'allowed-once' })
    expect(answerer).toHaveBeenCalledTimes(1)
    expect(decisions).toEqual([
      'approvals.request:cx-session.reviewer',
      'approvals.answer:cx-session.reviewer',
    ])

    active = undefined
    routes.reconcileRoutes()
    await expect(runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' }))
      .resolves.toMatchObject({ outcome: 'unavailable' })
    expect(answerer).toHaveBeenCalledTimes(1)
    driver.replace()
    await expect(handle.dispose()).resolves.toEqual({ status: 'closed', code: 'agent-replaced' })
    await expect(handle.dispose()).resolves.toEqual({ status: 'closed', code: 'agent-replaced' })
    await runtime.dispose()
  })

  it('preserves static answer scopes and reports the first owner fence on answerer disposal', async () => {
    const routeScopes = new AgentRouteSessionScopeAuthority({
      activeRoute: () => undefined,
      routes: () => [],
      decide: async () => ({ authorized: true }),
      connectionGeneration: () => 1,
    })
    routeScopes.install(owner, [
      {
        manifestVersion: 5,
        name: 'approvals.request',
        required: false,
        scope: { sessionIds: ['cx-session.static-answer'] },
      },
      {
        manifestVersion: 5,
        name: 'approvals.answer',
        required: false,
        scope: { sessionIds: ['cx-session.static-answer'] },
      },
    ])
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async (candidate, capability, sessionId) =>
        capability === 'agents.create'
        || await routeScopes.authorize(candidate, capability, sessionId),
      declares: (candidate, capability) => routeScopes.declares(candidate, capability),
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.static-answer' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const handle = await runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once')
    await expect(runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' }))
      .resolves.toMatchObject({ outcome: 'allowed-once' })
    runtime.fenceOwner(owner.pluginId, 'plugin-generation-replaced')
    await expect(handle.dispose()).resolves.toEqual({ status: 'closed', code: 'plugin-generation-replaced' })
    await runtime.dispose()
  })

  it('never invokes an answerer fenced while invocation authorization is pending', async () => {
    const driver = new Driver()
    let releaseAnswer!: (value: boolean) => void
    let answerAuthorizationStarted!: () => void
    const started = new Promise<void>(resolve => {
      answerAuthorizationStarted = resolve
    })
    const answerAuthorization = new Promise<boolean>(resolve => {
      releaseAnswer = resolve
    })
    const answerer = vi.fn(async () => 'allowed-once' as const)
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      declares: (_candidate, capability) => capability === 'approvals.answer',
      authorize: async (_candidate, capability) => {
        if (capability === 'approvals.answer') {
          answerAuthorizationStarted()
          return await answerAuthorization
        }
        return true
      },
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.pending-answer' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const handle = await runtime.registerAnswerer(owner, created.handle.agent, answerer)
    const request = runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'workspace.publish' })
    await started
    driver.replace()
    releaseAnswer(true)
    await expect(request).resolves.toMatchObject({ outcome: 'unavailable' })
    expect(answerer).not.toHaveBeenCalled()
    await expect(handle.dispose()).resolves.toEqual({ status: 'closed', code: 'agent-replaced' })
    await runtime.dispose()
  })

  it('rejects answerer registration when the exact owner has no declaration', async () => {
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      declares: () => false,
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.undeclared-answerer' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await expect(runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once'))
      .rejects.toThrow('unavailable')
    await runtime.dispose()
  })

  it('resolves a legacy TaskBinding through its owner authority and idempotently resumes the exact SessionId', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const binding = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json' as const,
      contract: 'cordisx.agent-loop-task-binding/v4' as const,
      schemaVersion: 4 as const,
      task: 'legacy-task-not-a-session-id',
      binding: { bindingId: 'legacy-binding', generation: 7 },
      definition: { agentId: 'lead', revision: 'rev-1' },
      state: 'active' as const,
    }
    let resolutions = 0
    runtime.installLegacyBindingResolver(owner.pluginId, async candidate => {
      resolutions += 1
      return candidate.binding.generation === 7
        ? { status: 'resolved', sessionId: 'native-session-exact' }
        : { status: 'unavailable', code: 'binding-unresolved' }
    })
    const request = {
      $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
      contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
      schemaVersion: 1 as const,
      mutationId: 'room-run:migrate:1',
      binding,
    }
    const acquired = await runtime.acquireLegacyTaskBinding(owner, request)
    expect(acquired).toMatchObject({
      status: 'accepted',
      sessionId: 'native-session-exact',
      identitySource: 'agent-loop-authority',
      acquire: { status: 'accepted', disposition: 'resumed', sessionId: 'native-session-exact' },
    })
    const replayed = await runtime.acquireLegacyTaskBinding(owner, request)
    expect(replayed).toMatchObject({
      status: 'accepted',
      acquire: { disposition: 'replayed', sessionId: 'native-session-exact' },
    })
    expect(replayed.status === 'accepted' && replayed.acquire.handle).toBe(
      acquired.status === 'accepted' && acquired.acquire.handle,
    )
    expect(resolutions).toBe(1)
    expect(await runtime.acquireLegacyTaskBinding(owner, { ...request, binding: { ...binding, task: 'other-task' } }))
      .toMatchObject({ status: 'conflict', code: 'mutation-conflict' })
    driver.replace()
    expect(await runtime.acquireLegacyTaskBinding(owner, request)).toMatchObject({
      status: 'unavailable',
      code: 'connection-replaced',
    })
    expect(resolutions).toBe(1)
  })

  it('fails closed for stale, closed, or no-longer-owned legacy bindings', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const closed = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json' as const,
      contract: 'cordisx.agent-loop-task-binding/v4' as const,
      schemaVersion: 4 as const,
      task: 'legacy-task',
      binding: { bindingId: 'legacy-binding', generation: 1 },
      definition: { agentId: 'lead', revision: 'rev-1' },
      state: 'closed' as const,
    }
    expect(
      await runtime.acquireLegacyTaskBinding(owner, {
        $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
        contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
        schemaVersion: 1,
        mutationId: 'closed',
        binding: closed,
      }),
    ).toMatchObject({ status: 'unavailable', code: 'binding-closed' })
    const active = { ...closed, state: 'active' as const }
    expect(
      await runtime.acquireLegacyTaskBinding(owner, {
        $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
        contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
        schemaVersion: 1,
        mutationId: 'missing-owner',
        binding: active,
      }),
    ).toMatchObject({ status: 'unavailable', code: 'plugin-generation-replaced' })
  })

  it('captures a v2 reservation before submitting its newly admitted Session message', async () => {
    const driver = new Driver()
    const order: string[] = []
    driver.submit = async input => {
      order.push(`driver:${input.message.id}`)
      return 'accepted'
    }
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      captureAdmission: (_owner, _origin, sessionId, generation, messageId) => {
        order.push(`capture:${sessionId}:${generation}:${messageId}`)
        return {
          active: () => true,
          commit: () => {
            order.push('commit')
          },
          close: () => {
            order.push('close')
          },
        }
      },
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.created-during-command', setup })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const result = await runtime.reserveAdmission(owner, {
      handle: created.handle,
      message: { text: 'scenario input' },
      origin: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
        contract: 'cordisx.agent-command-origin/v1',
        schemaVersion: 1,
        originId: 'origin-1',
        binding: { bindingId: 'binding-1', ownerGeneration: 'generation-1' },
        generation: 'generation-1',
        executionId: 'execution-1',
        commandId: 'composer.submit',
        scope: 'composer-submit',
        room: { roomId: 'room-1', participantId: 'lead', memberId: 'lead', runId: 'run-1' },
      },
    })
    expect(result.status).toBe('reserved')
    if (result.status !== 'reserved') throw new Error('reservation denied')
    await expect(result.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    expect(order[0]).toMatch(/^capture:cx-session\.created-during-command:/)
    expect(order[1]).toMatch(/^driver:cx-message\./)
    expect(order).toContain('commit')
    await expect(result.reservation.submit()).rejects.toThrow('unavailable')
    await runtime.dispose()
  })

  it('fences a reserved admission on revoke or connection replacement without submitting', async () => {
    const driver = new Driver()
    let captures = 0
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      captureAdmission: () => {
        captures += 1
        return { active: () => true, commit: () => {}, close: () => {} }
      },
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.reservation-fence', setup })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1',
      schemaVersion: 1 as const,
      originId: 'origin-fence',
      binding: { bindingId: 'binding-fence', ownerGeneration: 'generation-fence' },
      generation: 'generation-fence',
      executionId: 'execution-fence',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
      room: { roomId: 'room-fence', participantId: 'lead', memberId: 'lead', runId: 'run-fence' },
    }
    const reserved = await runtime.reserveAdmission(owner, {
      handle: created.handle,
      origin,
      message: { text: 'fenced' },
    })
    if (reserved.status !== 'reserved') throw new Error('reservation unavailable')
    await reserved.reservation.revoke()
    await expect(reserved.reservation.submit()).rejects.toThrow('unavailable')
    expect(driver.submitted).toEqual([])
    expect(captures).toBe(1)
    const replacement = await runtime.reserveAdmission(owner, {
      handle: created.handle,
      origin: { ...origin, originId: 'origin-replacement' },
      message: { text: 'replacement' },
    })
    if (replacement.status !== 'reserved') throw new Error('reservation unavailable')
    driver.replace()
    await expect(replacement.reservation.submit()).rejects.toThrow('unavailable')
    expect(driver.submitted).toEqual([])
  })

  it('fails closed after command completion and rejects owner substitution or origin reuse', async () => {
    const driver = new Driver()
    let commandActive = true
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      captureAdmission: () => ({ active: () => commandActive, commit: () => {}, close: () => {} }),
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.command-complete', setup })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1',
      schemaVersion: 1 as const,
      originId: 'origin-command-complete',
      binding: { bindingId: 'binding-command-complete', ownerGeneration: 'generation-command-complete' },
      generation: 'generation-command-complete',
      executionId: 'execution-command-complete',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
      room: { roomId: 'room-command-complete', participantId: 'lead', memberId: 'lead', runId: 'run-lead' },
    }
    const reserved = await runtime.reserveAdmission(owner, {
      handle: created.handle,
      origin,
      message: { text: 'single target' },
    })
    if (reserved.status !== 'reserved') throw new Error('reservation unavailable')
    commandActive = false
    await expect(reserved.reservation.submit()).rejects.toThrow('unavailable')
    expect(driver.submitted).toEqual([])
    await expect(runtime.reserveAdmission(owner, { handle: created.handle, origin, message: { text: 'reused' } }))
      .resolves.toMatchObject({ status: 'denied', code: 'reused' })
    await expect(runtime.reserveAdmission({ pluginId: owner.pluginId, generation: owner.generation + 1 }, {
      handle: created.handle,
      origin: { ...origin, originId: 'origin-owner-substitution' },
      message: { text: 'cross owner' },
    })).resolves.toMatchObject({ status: 'denied', code: 'not-owner' })
    await runtime.dispose()
  })

  it.each([1, 2, 3])('issues and submits one v3 capability per exact delivery for N=%i', async count => {
    const driver = new Driver()
    const captures: string[] = []
    let commandActive = true
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: `origin-targets-${count}`,
      binding: { bindingId: 'binding-targets', ownerGeneration: 'generation-targets' },
      generation: 'generation-targets',
      executionId: `execution-targets-${count}`,
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
      room: { roomId: 'room-targets', participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' },
    }
    const targets = Array.from({ length: count }, (_, index) => ({
      participantId: ['leader', 'reviewer', 'integrator'][index]!,
      memberId: `member-${index + 1}`,
      runId: `run-${index + 1}`,
    }))
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      admissionTargetActive: (_owner, candidate, target) =>
        commandActive && candidate.originId === origin.originId
        && targets.some(value =>
          value.participantId === target.participantId && value.memberId === target.memberId
          && value.runId === target.runId
        ),
      captureAdmissionTarget: (_owner, candidate, target, sessionId, generation, messageId) => {
        if (!commandActive || candidate.originId !== origin.originId) return undefined
        captures.push(
          `${target.participantId}:${target.memberId}:${target.runId}:${sessionId}:${generation}:${messageId}`,
        )
        return { active: () => commandActive, commit: () => {}, close: () => {} }
      },
    })
    const handles = await Promise.all(targets.map(async (target, index) => {
      const created = await runtime.create(owner, { sessionId: `cx-session.target-${count}-${index}`, setup })
      if (created.status !== 'accepted') throw new Error('agent unavailable')
      return created.handle
    }))
    const capabilities = await Promise.all(
      targets.map(target => runtime.issueAdmissionTargetOrigin(owner, { origin, target })),
    )
    expect(capabilities.every(value => value.status === 'issued')).toBe(true)
    const reservations = await Promise.all(capabilities.map(async (capability, index) => {
      if (capability.status !== 'issued') throw new Error('target origin denied')
      return await runtime.reserveAdmissionTarget(owner, {
        handle: handles[index]!,
        origin: capability.origin,
        message: { text: `delivery-${index + 1}` },
      })
    }))
    expect(reservations.every(value => value.status === 'reserved')).toBe(true)
    await Promise.all(reservations.map(async reservation => {
      if (reservation.status !== 'reserved') throw new Error('target reservation denied')
      await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    }))
    expect(captures).toHaveLength(count)
    expect(driver.submitted).toHaveLength(count)
    const first = capabilities[0]
    if (first.status !== 'issued') throw new Error('target origin denied')
    await expect(
      runtime.reserveAdmissionTarget(owner, {
        handle: handles[1] ?? handles[0]!,
        origin: first.origin,
        message: { text: 'reused' },
      }),
    )
      .resolves.toMatchObject({ status: 'denied', code: 'reused' })
    await expect(runtime.issueAdmissionTargetOrigin(owner, { origin, target: targets[0]! }))
      .resolves.toMatchObject({ status: 'denied', code: 'reused' })
    commandActive = false
    const afterComplete = await runtime.issueAdmissionTargetOrigin(owner, {
      origin: { ...origin, originId: `${origin.originId}-completed` },
      target: targets[0]!,
    })
    expect(afterComplete).toMatchObject({ status: 'denied', code: 'target-denied' })
    await runtime.dispose()
  })

  it('rejects v3 cross-target, owner substitution, and command-complete reservations without driver fallback', async () => {
    const driver = new Driver()
    let commandActive = true
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: 'origin-cross-target',
      binding: { bindingId: 'binding-cross-target', ownerGeneration: 'generation-cross-target' },
      generation: 'generation-cross-target',
      executionId: 'execution-cross-target',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
      room: { roomId: 'room-cross-target', participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' },
    }
    const leader = { participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' }
    const reviewer = { participantId: 'reviewer', memberId: 'member-reviewer', runId: 'run-reviewer' }
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      admissionTargetActive: (_owner, candidate, target) =>
        commandActive && candidate.originId === origin.originId
        && [leader, reviewer].some(value =>
          value.participantId === target.participantId && value.memberId === target.memberId
          && value.runId === target.runId
        ),
      captureAdmissionTarget: (_owner, _candidate, target) =>
        target.participantId === 'leader'
          ? { active: () => commandActive, commit: () => {}, close: () => {} }
          : undefined,
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.cross-target', setup })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const issued = await runtime.issueAdmissionTargetOrigin(owner, { origin, target: reviewer })
    if (issued.status !== 'issued') throw new Error('target origin denied')
    await expect(
      runtime.reserveAdmissionTarget(owner, {
        handle: created.handle,
        origin: issued.origin,
        message: { text: 'reviewer' },
      }),
    )
      .resolves.toMatchObject({ status: 'denied', code: 'target-mismatch' })
    await expect(runtime.reserveAdmissionTarget({ pluginId: owner.pluginId, generation: owner.generation + 1 }, {
      handle: created.handle,
      origin: issued.origin,
      message: { text: 'owner substitution' },
    })).resolves.toMatchObject({ status: 'denied', code: 'not-owner' })
    commandActive = false
    await expect(
      runtime.reserveAdmissionTarget(owner, {
        handle: created.handle,
        origin: issued.origin,
        message: { text: 'after complete' },
      }),
    )
      .resolves.toMatchObject({ status: 'denied', code: 'command-complete' })
    expect(driver.submitted).toEqual([])
    await runtime.dispose()
  })
})
