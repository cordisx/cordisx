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
  it('retains the resolved AgentSetup presentation only for the current owned Agent generation', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'cx-session.identity', setup })
    expect(created).toMatchObject({ status: 'accepted' })
    expect(runtime.definitionPresentation(setup.definition)).toEqual({
      identity: setup.definition,
      name: 'Lead exact',
      introduction: 'Base operating context.\n\nCoordinates the exact Session room.',
    })
    expect(runtime.definitionPresentation({ agentId: 'base', revision: 'revision-base-1' })).toEqual({
      identity: { agentId: 'base', revision: 'revision-base-1' },
      name: 'Base',
      introduction: 'Base operating context.',
    })
    driver.replace()
    expect(runtime.definitionPresentation(setup.definition)).toBeUndefined()
    expect(runtime.definitionPresentation({ agentId: 'base', revision: 'revision-base-1' })).toBeUndefined()
    await runtime.dispose()
  })

  it('keeps every Cordis service method bound to the Host runtime through the service proxy', async () => {
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      admissionTargetActive: () => true,
      captureAdmissionTarget: () => ({ active: () => true, commit: () => {}, close: () => {} }),
      bootstrapAdmissionTargetActive: () => true,
      captureBootstrapAdmissionTarget: () => ({ active: () => true, commit: () => {}, close: () => {} }),
      bootstrapAdmissionRoomTargetActive: () => true,
      captureBootstrapAdmissionRoomTarget: () => ({ active: () => true, commit: () => {}, close: () => {} }),
    })
    const ctx = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'proxy-test',
      [CORDISX_PLUGIN_SOURCE]: 'file:///fixtures/proxy-test.ts',
      [CORDISX_PLUGIN_GENERATION]: 'proxy-generation',
    })
    const agents = ctx.plugin(CordisXAgentRegistryServiceV1, runtime)
    await agents
    const sessions = ctx.plugin(CordisXSessionRegistryServiceV1, runtime)
    await sessions
    const approvals = ctx.plugin(CordisXApprovalServiceV1, runtime)
    await approvals
    const admissionOrigins = ctx.plugin(CordisXAgentAdmissionTargetOriginService, runtime)
    await admissionOrigins
    const admissionReservations = ctx.plugin(CordisXAgentAdmissionTargetReservationService, runtime)
    await admissionReservations
    const bootstrapTargets = ctx.plugin(CordisXAgentAdmissionBootstrapTargetService, runtime)
    await bootstrapTargets
    const bootstrapReservations = ctx.plugin(CordisXAgentAdmissionBootstrapReservationService, runtime)
    await bootstrapReservations
    const bootstrapRoomTargets = ctx.plugin(CordisXAgentAdmissionBootstrapRoomTargetService, runtime)
    await bootstrapRoomTargets
    const bootstrapRoomReservations = ctx.plugin(CordisXAgentAdmissionBootstrapRoomReservationService, runtime)
    await bootstrapRoomReservations
    const bootstrapRouteDeclarations = ctx.plugin(CordisXAgentAdmissionBootstrapRouteDeclarationService, runtime)
    await bootstrapRouteDeclarations
    const bootstrapRouteReservations = ctx.plugin(CordisXAgentAdmissionBootstrapRouteReservationService, runtime)
    await bootstrapRouteReservations

    const { acquireLegacyTaskBinding, create, get, resume } = ctx.agents
    const { get: getSession } = ctx.sessions
    const { registerAnswerer, registerAuthorityAnswerer, registerRequestResolver, request } = ctx.approvals
    const { issue } = ctx.agentAdmissionOrigins
    const { reserve } = ctx.agentAdmissionReservations
    const { issue: issueBootstrapTarget } = ctx.agentAdmissionBootstrapTargets
    const { reserve: reserveBootstrapTarget } = ctx.agentAdmissionBootstrapReservations
    const { issue: issueBootstrapRoomTarget } = ctx.agentAdmissionBootstrapRoomTargets
    const { reserve: reserveBootstrapRoomTarget } = ctx.agentAdmissionBootstrapRoomReservations
    const created = await create({ setup })
    expect(created).toMatchObject({ status: 'accepted', sessionIdSource: 'host' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    expect(created.sessionId).toMatch(/^cx-session\.[A-Za-z0-9-]+$/u)
    const v3Origin = await issue({
      origin: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
        contract: 'cordisx.agent-command-origin/v1',
        schemaVersion: 1,
        originId: 'proxy-target-origin',
        binding: { bindingId: 'proxy-binding', ownerGeneration: 'proxy-generation' },
        generation: 'proxy-generation',
        executionId: 'proxy-execution',
        commandId: 'proxy-send',
        scope: 'composer-submit',
        room: { roomId: 'proxy-room', participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' },
      },
      target: { participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' },
    })
    expect(v3Origin.status).toBe('issued')
    if (v3Origin.status !== 'issued') throw new Error('target origin denied')
    const v3Reservation = await reserve({
      handle: created.handle,
      origin: v3Origin.origin,
      message: { text: 'proxy delivery' },
    })
    expect(v3Reservation.status).toBe('reserved')
    if (v3Reservation.status !== 'reserved') throw new Error('target reservation denied')
    await expect(v3Reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    const v4Origin = await issueBootstrapTarget({
      origin: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
        contract: 'cordisx.agent-bootstrap-command-origin/v1',
        schemaVersion: 1,
        originId: 'proxy-bootstrap-origin',
        binding: { bindingId: 'proxy-binding', ownerGeneration: 'proxy-generation' },
        generation: 'proxy-generation',
        executionId: 'proxy-bootstrap-execution',
        commandId: 'proxy-send',
        scope: 'composer-submit',
      },
      target: { participantId: 'reviewer', memberId: 'member-reviewer', runId: 'run-reviewer' },
    })
    expect(v4Origin.status).toBe('issued')
    if (v4Origin.status !== 'issued') throw new Error('bootstrap target origin denied')
    const v4Reservation = await reserveBootstrapTarget({
      handle: created.handle,
      origin: v4Origin.origin,
      message: { text: 'bootstrap delivery' },
    })
    expect(v4Reservation.status).toBe('reserved')
    if (v4Reservation.status !== 'reserved') throw new Error('bootstrap target reservation denied')
    await expect(v4Reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    const v5Origin = await issueBootstrapRoomTarget({
      origin: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
        contract: 'cordisx.agent-bootstrap-command-origin/v1',
        schemaVersion: 1,
        originId: 'proxy-bootstrap-room-origin',
        binding: { bindingId: 'proxy-binding', ownerGeneration: 'proxy-generation' },
        generation: 'proxy-generation',
        executionId: 'proxy-bootstrap-room-execution',
        commandId: 'proxy-send',
        scope: 'composer-submit',
      },
      target: { roomId: 'proxy-room', participantId: 'reviewer', memberId: 'member-reviewer', runId: 'run-reviewer' },
    })
    expect(v5Origin).toMatchObject({
      status: 'issued',
      receipt: { target: { roomId: 'proxy-room', runId: 'run-reviewer' } },
    })
    if (v5Origin.status !== 'issued') throw new Error('bootstrap Room target origin denied')
    const v5Reservation = await reserveBootstrapRoomTarget({
      handle: created.handle,
      origin: v5Origin.origin,
      message: { text: 'bootstrap Room delivery' },
    })
    expect(v5Reservation.status).toBe('reserved')
    if (v5Reservation.status !== 'reserved') throw new Error('bootstrap Room target reservation denied')
    await expect(v5Reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    expect(await get(created.sessionId)).toMatchObject({
      id: created.sessionId,
      generation: created.handle.agent.generation,
    })
    expect(await getSession(created.sessionId)).toMatchObject({ id: created.sessionId })
    await registerAnswerer(created.handle.agent, async () => 'allowed-once')
    const decision = await request({ agent: created.handle.agent, toolName: 'shell' })
    expect(decision).toMatchObject({ outcome: 'allowed-once' })
    expect(decision.id).toMatch(/^cx-approval\.[A-Za-z0-9-]+$/u)
    await registerAuthorityAnswerer(
      { agent: created.handle.agent, definition: setup.definition },
      async () => 'rejected',
    )
    const decisionV2 = await request({
      requester: { agent: created.handle.agent, definition: setup.definition },
      authority: { agent: created.handle.agent, definition: setup.definition },
      toolName: 'shell-v2',
      reason: { kind: 'plain-text', text: 'Exact authority proxy request.' },
    })
    expect(decisionV2).toMatchObject({ contract: 'cordisx.approval-decision/v2', outcome: 'rejected' })
    const routed = await registerRequestResolver(
      { agent: created.handle.agent, definition: setup.definition },
      question => ({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
        contract: 'cordisx.approval-request-routing-result/v1',
        schemaVersion: 1,
        routingId: question.routingId,
        registration: question.registration,
        status: 'unavailable',
        code: 'mapping-unavailable',
      }),
    )
    expect(routed.status).toBe('registered')
    if (routed.status === 'registered') {
      await expect(routed.handle.dispose()).resolves.toMatchObject({ status: 'closed', code: 'disposed' })
    }
    expect(await created.handle.dispose()).toMatchObject({ status: 'accepted' })
    expect(await resume({ sessionId: created.sessionId })).toMatchObject({ status: 'accepted', disposition: 'resumed' })
    expect(
      await acquireLegacyTaskBinding({
        $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
        contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
        schemaVersion: 1,
        mutationId: 'proxy-legacy-closed',
        binding: {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
          contract: 'cordisx.agent-loop-task-binding/v4',
          schemaVersion: 4,
          task: 'proxy-legacy-task',
          binding: { bindingId: 'proxy-legacy-binding', generation: 1 },
          definition: { agentId: 'lead', revision: 'revision-one' },
          state: 'closed',
        },
      }),
    ).toMatchObject({ status: 'unavailable', code: 'binding-closed' })

    await bootstrapRoomReservations.dispose()
    await bootstrapRoomTargets.dispose()
    await bootstrapReservations.dispose()
    await bootstrapTargets.dispose()
    await admissionReservations.dispose()
    await admissionOrigins.dispose()
    await approvals.dispose()
    await sessions.dispose()
    await agents.dispose()
    await runtime.dispose()
  })

  it('creates an owner handle, admits a MessageId once, and replays one Session truth', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true, now: () => 10 })
    const created = await runtime.create(owner, {
      sessionId: 'session-1',
      mutationId: 'create-1',
      options: {} satisfies AgentOptions,
    })
    expect(created).toMatchObject({ status: 'accepted', disposition: 'created', sessionId: 'session-1' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    expect(await created.handle.agent.followup(message('message-1'))).toMatchObject({
      status: 'accepted',
      messageId: 'message-1',
    })
    expect(await created.handle.agent.followup(message('message-1'))).toMatchObject({
      status: 'accepted',
      messageId: 'message-1',
    })
    expect(driver.submitted).toEqual(['message-1'])

    const snapshot = await created.handle.agent.session.snapshot()
    expect(snapshot).toMatchObject({ status: 'available', snapshot: { snapshotSeq: 1 } })
    const read = await created.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 1, limit: 10 })
    expect(read).toMatchObject({
      status: 'available',
      page: { events: [{ type: 'agent/inbox/spliced' }, { type: 'user/message' }] },
    })
  })

  it('commits the originating Shell capture only after the driver accepts a submission', async () => {
    const lifecycle: string[] = []
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      captureSubmission: (_owner, sessionId, messageId) => {
        lifecycle.push(`capture:${sessionId}:${messageId}`)
        return {
          commit: () => {
            lifecycle.push('commit')
          },
          close: () => {
            lifecycle.push('close')
          },
        }
      },
    })
    const created = await runtime.create(owner, { sessionId: 'session-captured-source' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')

    await expect(created.handle.agent.followup(message('message-captured-source')))
      .resolves.toMatchObject({ status: 'accepted' })
    await expect(created.handle.agent.followup(message('message-captured-source')))
      .resolves.toMatchObject({ status: 'accepted' })

    expect(lifecycle).toEqual(['capture:session-captured-source:message-captured-source', 'commit'])
  })

  it('installs the live fence before replay and closes on connection replacement', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-2' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await created.handle.agent.followup(message('message-2'))
    const pages: string[] = []
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, page => {
      pages.push(`${page.phase}:${page.events.map(event => event.seq).join(',')}`)
    })
    expect(subscribed.status).toBe('subscribed')
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    expect(pages).toEqual(['replay:0,1'])
    driver.replace()
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'connection-replaced' })
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'connection-replaced' })
    expect(await created.handle.agent.whenIdle()).toEqual({ status: 'unavailable', code: 'agent-replaced' })
  })

  it('keeps one atomic replay watermark on every live page emitted by a subscription', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-watermark' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await created.handle.agent.followup(message('message-before-replay'))
    const pages: Array<{ readonly phase: string; readonly replayThrough: number; readonly events: readonly number[] }> =
      []
    let appendedDuringReplay = false
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, async page => {
      pages.push({ phase: page.phase, replayThrough: page.replayThrough, events: page.events.map(event => event.seq) })
      if (page.phase === 'replay' && !appendedDuringReplay) {
        appendedDuringReplay = true
        await created.handle.agent.followup(message('message-during-replay'))
      }
    })
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(subscribed.subscription.replayThrough).toBe(1)
    expect(pages).toEqual([
      { phase: 'replay', replayThrough: 1, events: [0, 1] },
      { phase: 'live', replayThrough: 1, events: [2] },
      { phase: 'live', replayThrough: 1, events: [3] },
    ])
  })

  it('uses first-terminal route fencing and never starts an observer after closure', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-closed' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const pages: string[] = []
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, page => {
      pages.push(page.phase)
    })
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    runtime.fenceSession('session-closed', 'route-replaced')
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'route-replaced' })
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'route-replaced' })
    expect(pages).toEqual([])
  })

  it('fails a throwing observer closed rather than leaking a rejected subscription', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-observer-failure' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, () => {
      throw new Error('observer failed')
    })
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    await created.handle.agent.followup(message('message-observer-failure'))
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'observer-failed' })
  })

  it('fences an old owner handle and its Session subscription after permission revocation', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-revoked' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, () => {})
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    runtime.fenceOwner(owner.pluginId, 'permission-revoked')
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'permission-revoked' })
    expect(await created.handle.agent.followup(message('after-revoke'))).toMatchObject({
      status: 'unavailable',
      code: 'agent-replaced',
    })
    expect(await created.handle.dispose()).toMatchObject({ status: 'unavailable', code: 'agent-replaced' })
  })

  it('records asked and exactly one decided approval fact in the same Session', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-3' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once')
    const decision = await runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'shell' })
    expect(decision.outcome).toBe('allowed-once')
    const page = await created.handle.agent.session.read({ afterSeq: -1, limit: 10 })
    expect(page).toMatchObject({
      status: 'available',
      page: { events: [{ type: 'approval/asked' }, { type: 'approval/decided' }] },
    })
  })

  it('binds approval v2 to exact requester and authority Agents in one requester Session ledger', async () => {
    const driver = new Driver()
    const authorization: string[] = []
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async (_candidate, capability, sessionId) => {
        authorization.push(`${capability}:${sessionId ?? ''}`)
        return true
      },
      declares: (_candidate, capability) => capability === 'approvals.answer',
      now: () => 25,
    })
    const reviewerIdentity = { agentId: 'reviewer', revision: 'revision-reviewer-2' }
    const leadIdentity = { agentId: 'lead', revision: 'revision-lead-2' }
    const definition = (identity: typeof reviewerIdentity, name: string): AgentSetup => ({
      definition: identity,
      definitions: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
        contract: 'cordisx.agent-definition/v1',
        schemaVersion: 1,
        identity,
        name,
        promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: `${name} prompt` }],
        inherit: {
          promptSections: 'none',
          rules: 'none',
          skills: 'none',
          tools: 'none',
          mcpServers: 'none',
          runtimeDefaults: 'none',
        },
      }],
    })
    const reviewer = await runtime.create(owner, {
      sessionId: 'cx-session.reviewer-v2',
      setup: definition(reviewerIdentity, 'Reviewer'),
    })
    const lead = await runtime.create(owner, {
      sessionId: 'cx-session.lead-v2',
      setup: definition(leadIdentity, 'Lead'),
    })
    if (reviewer.status !== 'accepted' || lead.status !== 'accepted') throw new Error('agents unavailable')
    const answer = vi.fn(async question => {
      expect(question).toMatchObject({
        contract: 'cordisx.approval-question/v2',
        schemaVersion: 2,
        requester: { agentId: reviewer.sessionId, sessionId: reviewer.sessionId, definition: reviewerIdentity },
        authority: { agentId: lead.sessionId, sessionId: lead.sessionId, definition: leadIdentity },
        reason: { kind: 'plain-text', text: 'Reviewer needs Lead to approve publishing.' },
      })
      return 'rejected' as const
    })
    const handle = await runtime.registerAuthorityAnswerer(owner, {
      agent: lead.handle.agent,
      definition: leadIdentity,
    }, answer)
    const decision = await runtime.requestApprovalV2(owner, {
      requester: { agent: reviewer.handle.agent, definition: reviewerIdentity },
      authority: { agent: lead.handle.agent, definition: leadIdentity },
      toolName: 'workspace.publish',
      callId: 'tool-call-v2',
      reason: { kind: 'plain-text', text: 'Reviewer needs Lead to approve publishing.' },
    })
    expect(decision).toMatchObject({
      contract: 'cordisx.approval-decision/v2',
      schemaVersion: 2,
      outcome: 'rejected',
      requester: { definition: reviewerIdentity },
      authority: { definition: leadIdentity },
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(authorization).toContain('approvals.request:cx-session.reviewer-v2')
    expect(authorization).toContain('approvals.answer:cx-session.lead-v2')
    const read = await reviewer.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 2, limit: 10 })
    expect(read).toMatchObject({
      status: 'available',
      page: {
        events: [
          {
            seq: 0,
            type: 'approval/authority-bound',
            ignorable: true,
            data: { requester: reviewerIdentity, authority: leadIdentity, reason: { kind: 'plain-text' } },
          },
          { seq: 1, type: 'approval/asked', data: { reason: 'Reviewer needs Lead to approve publishing.' } },
          { seq: 2, type: 'approval/decided', data: { outcome: 'rejected' } },
        ],
      },
    })
    expect(
      (read.status === 'available' ? read.page.events : []).map(event =>
        event.data && 'id' in event.data
          ? event.data.id
          : 'approvalId' in event.data
          ? event.data.approvalId
          : undefined
      ),
    )
      .toEqual([decision.id, decision.id, decision.id])
    driver.replace()
    await expect(handle.dispose()).resolves.toEqual({ status: 'closed', code: 'connection-replaced' })
    await expect(runtime.requestApprovalV2(owner, {
      requester: { agent: reviewer.handle.agent, definition: reviewerIdentity },
      authority: { agent: lead.handle.agent, definition: leadIdentity },
      toolName: 'workspace.publish',
      reason: { kind: 'plain-text', text: 'stale' },
    })).rejects.toThrow('unavailable')
    await runtime.dispose()
  })

  it('rejects approval v2 identity substitution before writing durable facts', async () => {
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      declares: () => true,
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.approval-v2-identity', setup })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await expect(runtime.registerAuthorityAnswerer(owner, {
      agent: created.handle.agent,
      definition: { ...setup.definition, revision: 'wrong-revision' },
    }, async () => 'allowed-once')).rejects.toThrow('unavailable')
    await expect(runtime.requestApprovalV2(owner, {
      requester: { agent: created.handle.agent, definition: setup.definition },
      authority: { agent: created.handle.agent, definition: { ...setup.definition, agentId: 'other-agent' } },
      toolName: 'workspace.publish',
      reason: { kind: 'plain-text', text: 'No inferred authority.' },
    })).rejects.toThrow('unavailable')
    const snapshot = await created.handle.agent.session.snapshot()
    expect(snapshot).toMatchObject({ status: 'available', snapshot: { snapshotSeq: -1 } })
    await runtime.dispose()
  })

  it('routes a driver approval through v3 before the single v2 requester ledger is appended', async () => {
    const driver = new Driver()
    let routeAuthorized = false
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async (_owner, capability) =>
        capability === 'agents.create' || capability === 'agents.resume' || routeAuthorized,
      declares: () => true,
      now: () => 31,
    })
    const makeSetup = (agentId: string, revision: string, name: string): AgentSetup => ({
      definition: { agentId, revision },
      definitions: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
        contract: 'cordisx.agent-definition/v1',
        schemaVersion: 1,
        identity: { agentId, revision },
        name,
        promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: `${name} prompt` }],
        inherit: {
          promptSections: 'none',
          rules: 'none',
          skills: 'none',
          tools: 'none',
          mcpServers: 'none',
          runtimeDefaults: 'none',
        },
      }],
    })
    const reviewerSetup = makeSetup('reviewer', 'reviewer-driver-v3', 'Reviewer')
    const leadSetup = makeSetup('lead', 'lead-driver-v3', 'Lead')
    const reviewer = await runtime.create(owner, { sessionId: 'cx-session.driver-reviewer', setup: reviewerSetup })
    const lead = await runtime.create(owner, { sessionId: 'cx-session.driver-lead', setup: leadSetup })
    if (reviewer.status !== 'accepted' || lead.status !== 'accepted') throw new Error('agents unavailable')
    let answer!: (outcome: 'allowed-once') => void
    const decision = new Promise<'allowed-once'>(resolve => {
      answer = resolve
    })
    let liveQuestion: ApprovalQuestionV2 | undefined
    const answerer = vi.fn(async (question: ApprovalQuestionV2) => {
      liveQuestion = question
      return await decision
    })
    await runtime.registerAuthorityAnswerer(
      owner,
      { agent: lead.handle.agent, definition: leadSetup.definition },
      answerer,
    )
    const resolver = vi.fn((question: ApprovalRequestRoutingQuestion): ApprovalRequestRoutingResult => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
      contract: 'cordisx.approval-request-routing-result/v1',
      schemaVersion: 1,
      routingId: question.routingId,
      registration: question.registration,
      status: 'accepted',
      code: 'routed',
      requester: question.requester,
      authority: {
        agentId: lead.sessionId,
        sessionId: lead.sessionId,
        agentGeneration: lead.agentGeneration,
        definition: leadSetup.definition,
      },
    }))
    const registered = await runtime.registerRequestResolver(owner, {
      agent: reviewer.handle.agent,
      definition: reviewerSetup.definition,
    }, resolver)
    expect(registered).toMatchObject({
      status: 'registered',
      handle: {
        registration: { owner, requester: { agentId: reviewer.sessionId, definition: reviewerSetup.definition } },
      },
    })

    // Dynamic host-route permission is intentionally unavailable until the
    // later exact Session route is activated; registration itself must not
    // require that route or create a lease.
    await expect(
      driver.ask({ sessionId: reviewer.sessionId, toolName: 'workspace.publish', reason: 'before route activation' }),
    ).resolves.toBe('unavailable')
    routeAuthorized = true

    const pending = driver.ask({
      sessionId: reviewer.sessionId,
      toolName: 'workspace.publish',
      callId: 'driver-call-v3',
      reason: 'Reviewer requests exact Lead approval.',
    })
    await vi.waitFor(() => expect(answerer).toHaveBeenCalledTimes(1))
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: 'cordisx.approval-request-routing-question/v1',
        requester: expect.objectContaining({ agentId: reviewer.sessionId }),
        toolName: 'workspace.publish',
        callId: 'driver-call-v3',
        reason: { kind: 'plain-text', text: 'Reviewer requests exact Lead approval.' },
      }),
      expect.any(AbortSignal),
    )
    const inFlight = await reviewer.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 1, limit: 10 })
    expect(inFlight).toMatchObject({
      status: 'available',
      page: {
        events: [
          {
            seq: 0,
            type: 'approval/authority-bound',
            ignorable: true,
            data: { requester: reviewerSetup.definition, authority: leadSetup.definition },
          },
          { seq: 1, type: 'approval/asked', data: { reason: 'Reviewer requests exact Lead approval.' } },
        ],
      },
    })
    if (inFlight.status !== 'available' || liveQuestion === undefined) throw new Error('pending approval unavailable')
    const asked = inFlight.page.events.find(event => event.type === 'approval/asked')
    if (asked?.type !== 'approval/asked') throw new Error('asked fact unavailable')
    expect(liveQuestion).toMatchObject({
      requester: { definition: reviewerSetup.definition },
      authority: { definition: leadSetup.definition },
      reason: { text: asked.data.reason },
    })
    answer('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
    const completed = await reviewer.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 2, limit: 10 })
    expect(completed).toMatchObject({
      status: 'available',
      page: {
        events: [
          { type: 'approval/authority-bound' },
          { type: 'approval/asked' },
          { type: 'approval/decided', data: { outcome: 'allowed-once' } },
        ],
      },
    })
    await runtime.dispose()
  })
})
