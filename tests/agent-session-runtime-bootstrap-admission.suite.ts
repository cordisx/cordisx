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
  it.each([1, 2, 3])(
    'issues, captures, and submits one Shell v9/v4 bootstrap capability per new target for N=%i',
    async count => {
      const driver = new Driver()
      let commandActive = true
      const captured: string[] = []
      const origin = {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
        contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
        schemaVersion: 1 as const,
        originId: `bootstrap-origin-${count}`,
        binding: { bindingId: 'bootstrap-binding', ownerGeneration: 'bootstrap-owner-generation' },
        generation: 'bootstrap-plugin-generation',
        executionId: `bootstrap-execution-${count}`,
        commandId: 'composer.submit',
        scope: 'composer-submit' as const,
      }
      const targets = Array.from({ length: count }, (_, index) => ({
        participantId: ['leader', 'reviewer', 'integrator'][index]!,
        memberId: `member-${index + 1}`,
        runId: `run-${index + 1}`,
      }))
      const targetSessions = new Map(
        targets.map((target, index) => [target.runId, `cx-session.bootstrap-${count}-${index}`]),
      )
      const runtime = new CordisXAgentSessionRuntime({
        driver,
        authorize: async () => true,
        bootstrapAdmissionTargetActive: (_owner, candidate, target) =>
          commandActive && candidate.originId === origin.originId
          && targets.some(value =>
            value.participantId === target.participantId && value.memberId === target.memberId
            && value.runId === target.runId
          ),
        captureBootstrapAdmissionTarget: (_owner, candidate, target, sessionId, generation, messageId) => {
          if (
            !commandActive || candidate.originId !== origin.originId || targetSessions.get(target.runId) !== sessionId
          ) return undefined
          captured.push(
            `${target.participantId}:${target.memberId}:${target.runId}:${sessionId}:${generation}:${messageId}`,
          )
          return { active: () => commandActive, commit: () => {}, close: () => {} }
        },
      })
      const issued = await Promise.all(
        targets.map(target => runtime.issueAdmissionBootstrapTarget(owner, { origin, target })),
      )
      expect(issued.every(value => value.status === 'issued')).toBe(true)
      const handles = await Promise.all(targets.map(async (target, index) => {
        const created = await runtime.create(owner, { sessionId: targetSessions.get(target.runId)!, setup })
        if (created.status !== 'accepted') throw new Error(`bootstrap target ${index} was not acquired`)
        return created.handle
      }))
      const reservations = await Promise.all(issued.map(async (capability, index) => {
        if (capability.status !== 'issued') throw new Error('bootstrap target origin denied')
        return await runtime.reserveAdmissionBootstrapTarget(owner, {
          handle: handles[index]!,
          origin: capability.origin,
          message: { text: `bootstrap delivery ${index + 1}` },
        })
      }))
      expect(reservations.every(value => value.status === 'reserved')).toBe(true)
      expect(captured).toHaveLength(count)
      expect(driver.submitted).toEqual([])
      await Promise.all(reservations.map(async reservation => {
        if (reservation.status !== 'reserved') throw new Error('bootstrap reservation denied')
        await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
      }))
      expect(driver.submitted).toHaveLength(count)
      await runtime.dispose()
    },
  )

  it('fails closed for v4 cross-target, reuse, command completion, owner replacement, and connection replacement', async () => {
    const driver = new Driver()
    let commandActive = true
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: 'bootstrap-fences',
      binding: { bindingId: 'bootstrap-fence-binding', ownerGeneration: 'bootstrap-fence-owner' },
      generation: 'bootstrap-fence-generation',
      executionId: 'bootstrap-fence-execution',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
    }
    const leader = { participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' }
    const reviewer = { participantId: 'reviewer', memberId: 'member-reviewer', runId: 'run-reviewer' }
    const targetSessions = new Map([[leader.runId, 'cx-session.bootstrap-leader'], [
      reviewer.runId,
      'cx-session.bootstrap-reviewer',
    ]])
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      bootstrapAdmissionTargetActive: (_owner, candidate, target) =>
        commandActive && candidate.originId.startsWith('bootstrap-fences')
        && [leader, reviewer].some(value =>
          value.participantId === target.participantId && value.memberId === target.memberId
          && value.runId === target.runId
        ),
      captureBootstrapAdmissionTarget: (_owner, _candidate, target, sessionId) =>
        targetSessions.get(target.runId) === sessionId
          ? { active: () => commandActive, commit: () => {}, close: () => {} }
          : undefined,
    })
    const lead = await runtime.create(owner, { sessionId: targetSessions.get(leader.runId)!, setup })
    const review = await runtime.create(owner, { sessionId: targetSessions.get(reviewer.runId)!, setup })
    if (lead.status !== 'accepted' || review.status !== 'accepted') throw new Error('bootstrap targets unavailable')
    const reviewerIssued = await runtime.issueAdmissionBootstrapTarget(owner, { origin, target: reviewer })
    if (reviewerIssued.status !== 'issued') throw new Error('reviewer target origin denied')
    await expect(runtime.reserveAdmissionBootstrapTarget(owner, {
      handle: lead.handle,
      origin: reviewerIssued.origin,
      message: { text: 'cross target' },
    })).resolves.toMatchObject({ status: 'denied', code: 'target-mismatch' })
    await expect(
      runtime.reserveAdmissionBootstrapTarget({ pluginId: owner.pluginId, generation: owner.generation + 1 }, {
        handle: review.handle,
        origin: reviewerIssued.origin,
        message: { text: 'cross owner' },
      }),
    ).resolves.toMatchObject({ status: 'denied', code: 'not-owner' })

    const leaderIssued = await runtime.issueAdmissionBootstrapTarget(owner, { origin, target: leader })
    if (leaderIssued.status !== 'issued') throw new Error('leader target origin denied')
    const reserved = await runtime.reserveAdmissionBootstrapTarget(owner, {
      handle: lead.handle,
      origin: leaderIssued.origin,
      message: { text: 'command completion' },
    })
    if (reserved.status !== 'reserved') throw new Error('bootstrap reservation unavailable')
    await expect(runtime.issueAdmissionBootstrapTarget(owner, { origin, target: leader }))
      .resolves.toMatchObject({ status: 'denied', code: 'reused' })
    commandActive = false
    await expect(reserved.reservation.submit()).rejects.toThrow('unavailable')
    await expect(runtime.reserveAdmissionBootstrapTarget(owner, {
      handle: review.handle,
      origin: reviewerIssued.origin,
      message: { text: 'after command complete' },
    })).resolves.toMatchObject({ status: 'denied', code: 'command-complete' })

    commandActive = true
    const replacementIssued = await runtime.issueAdmissionBootstrapTarget(owner, {
      origin: { ...origin, originId: 'bootstrap-fences-replacement' },
      target: leader,
    })
    if (replacementIssued.status !== 'issued') throw new Error('replacement target origin denied')
    const replacement = await runtime.reserveAdmissionBootstrapTarget(owner, {
      handle: lead.handle,
      origin: replacementIssued.origin,
      message: { text: 'connection replacement' },
    })
    if (replacement.status !== 'reserved') throw new Error('replacement reservation unavailable')
    driver.replace()
    await expect(replacement.reservation.submit()).rejects.toThrow('unavailable')
    expect(driver.submitted).toEqual([])
    await runtime.dispose()

    const ownerDriver = new Driver()
    const ownerRuntime = new CordisXAgentSessionRuntime({
      driver: ownerDriver,
      authorize: async () => true,
      bootstrapAdmissionTargetActive: (_owner, candidate, target) =>
        candidate.originId === 'bootstrap-fences-owner-replacement'
        && target.participantId === leader.participantId && target.memberId === leader.memberId
        && target.runId === leader.runId,
      captureBootstrapAdmissionTarget: (_owner, _candidate, target, sessionId) =>
        target.runId === leader.runId && sessionId === 'cx-session.bootstrap-owner-replacement'
          ? { active: () => true, commit: () => {}, close: () => {} }
          : undefined,
    })
    const ownerCreated = await ownerRuntime.create(owner, {
      sessionId: 'cx-session.bootstrap-owner-replacement',
      setup,
    })
    if (ownerCreated.status !== 'accepted') throw new Error('owner replacement target unavailable')
    const ownerIssued = await ownerRuntime.issueAdmissionBootstrapTarget(owner, {
      origin: { ...origin, originId: 'bootstrap-fences-owner-replacement' },
      target: leader,
    })
    if (ownerIssued.status !== 'issued') throw new Error('owner replacement origin denied')
    const ownerReservation = await ownerRuntime.reserveAdmissionBootstrapTarget(owner, {
      handle: ownerCreated.handle,
      origin: ownerIssued.origin,
      message: { text: 'owner replacement' },
    })
    if (ownerReservation.status !== 'reserved') throw new Error('owner replacement reservation unavailable')
    ownerRuntime.fenceOwner(owner.pluginId, 'plugin-generation-replaced')
    await expect(ownerReservation.reservation.submit()).rejects.toThrow('unavailable')
    expect(ownerDriver.submitted).toEqual([])
    await ownerRuntime.dispose()
  })

  it.each([1, 2, 3])('issues, captures, and submits one same-binding Shell v9/v5 Room target for N=%i', async count => {
    const driver = new Driver()
    let commandActive = true
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: `bootstrap-room-origin-${count}`,
      binding: { bindingId: 'bootstrap-room-binding', ownerGeneration: 'bootstrap-room-owner-generation' },
      generation: 'bootstrap-room-plugin-generation',
      executionId: `bootstrap-room-execution-${count}`,
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
    }
    const targets = Array.from({ length: count }, (_, index) => ({
      roomId: 'room-existing',
      participantId: ['leader', 'reviewer', 'integrator'][index]!,
      memberId: `member-${index + 1}`,
      runId: `run-${index + 1}`,
    }))
    const targetSessions = new Map(
      targets.map((target, index) => [target.runId, `cx-session.bootstrap-room-${count}-${index}`]),
    )
    const captures: string[] = []
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      bootstrapAdmissionRoomTargetActive: (_owner, candidate, target) =>
        commandActive && candidate.originId === origin.originId
        && (target.roomId === 'room-existing' || target.roomId === 'room-foreign') && targets.some(value =>
          value.participantId === target.participantId
          && value.memberId === target.memberId && value.runId === target.runId
        ),
      captureBootstrapAdmissionRoomTarget: (_owner, candidate, target, receipt, sessionId, generation, messageId) => {
        if (
          !commandActive || candidate.originId !== origin.originId || targetSessions.get(target.runId) !== sessionId
          || receipt.target.roomId !== target.roomId || receipt.target.participantId !== target.participantId
          || receipt.target.memberId !== target.memberId || receipt.target.runId !== target.runId
        ) return undefined
        captures.push(
          `${target.roomId}:${target.participantId}:${target.memberId}:${target.runId}:${sessionId}:${generation}:${messageId}`,
        )
        return { active: () => commandActive, commit: () => {}, close: () => {} }
      },
    })
    const issued = await Promise.all(
      targets.map(target => runtime.issueAdmissionBootstrapRoomTarget(owner, { origin, target })),
    )
    expect(issued.every(value => value.status === 'issued')).toBe(true)
    const handles = await Promise.all(targets.map(async target => {
      const created = await runtime.create(owner, { sessionId: targetSessions.get(target.runId)!, setup })
      if (created.status !== 'accepted') throw new Error('bootstrap Room target was not acquired')
      return created.handle
    }))
    const reservations = await Promise.all(issued.map(async (capability, index) => {
      if (capability.status !== 'issued') throw new Error('bootstrap Room target origin denied')
      return await runtime.reserveAdmissionBootstrapRoomTarget(owner, {
        handle: handles[index]!,
        origin: capability.origin,
        message: { text: `bootstrap Room delivery ${index + 1}` },
      })
    }))
    expect(reservations.every(value => value.status === 'reserved')).toBe(true)
    expect(captures).toHaveLength(count)
    expect(driver.submitted).toEqual([])
    await Promise.all(reservations.map(async reservation => {
      if (reservation.status !== 'reserved') throw new Error('bootstrap Room reservation denied')
      await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
    }))
    expect(driver.submitted).toHaveLength(count)
    const first = issued[0]!
    if (first.status !== 'issued') throw new Error('bootstrap Room target origin denied')
    await expect(runtime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: handles[0]!,
      origin: first.origin,
      message: { text: 'reused bootstrap Room target' },
    })).resolves.toMatchObject({ status: 'denied', code: 'reused' })
    await expect(runtime.issueAdmissionBootstrapRoomTarget(owner, { origin, target: targets[0]! }))
      .resolves.toMatchObject({ status: 'denied', code: 'duplicate-target' })
    await expect(runtime.issueAdmissionBootstrapRoomTarget(owner, {
      origin,
      target: { ...targets[0]!, roomId: 'room-foreign' },
    })).resolves.toMatchObject({ status: 'denied', code: 'cross-room' })
    commandActive = false
    await expect(runtime.issueAdmissionBootstrapRoomTarget(owner, {
      origin: { ...origin, originId: `${origin.originId}-complete` },
      target: targets[0]!,
    })).resolves.toMatchObject({ status: 'denied', code: 'target-denied' })
    await runtime.dispose()
  })

  it('fails closed for v5 Room cross-target, revoke, command completion, owner generation, and connection replacement', async () => {
    const driver = new Driver()
    let commandActive = true
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
      contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
      schemaVersion: 1 as const,
      originId: 'bootstrap-room-fences',
      binding: { bindingId: 'bootstrap-room-fence-binding', ownerGeneration: 'bootstrap-room-fence-owner' },
      generation: 'bootstrap-room-fence-generation',
      executionId: 'bootstrap-room-fence-execution',
      commandId: 'composer.submit',
      scope: 'composer-submit' as const,
    }
    const leader = { roomId: 'room-fences', participantId: 'leader', memberId: 'member-leader', runId: 'run-leader' }
    const reviewer = {
      roomId: 'room-fences',
      participantId: 'reviewer',
      memberId: 'member-reviewer',
      runId: 'run-reviewer',
    }
    const sessions = new Map([[leader.runId, 'cx-session.bootstrap-room-leader'], [
      reviewer.runId,
      'cx-session.bootstrap-room-reviewer',
    ]])
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      bootstrapAdmissionRoomTargetActive: (_owner, candidate, target) =>
        commandActive && candidate.originId.startsWith('bootstrap-room-fences')
        && [leader, reviewer].some(value =>
          value.roomId === target.roomId && value.participantId === target.participantId
          && value.memberId === target.memberId && value.runId === target.runId
        ),
      captureBootstrapAdmissionRoomTarget: (_owner, _candidate, target, _receipt, sessionId) =>
        sessions.get(target.runId) === sessionId
          ? { active: () => commandActive, commit: () => {}, close: () => {} }
          : undefined,
    })
    const lead = await runtime.create(owner, { sessionId: sessions.get(leader.runId)!, setup })
    const review = await runtime.create(owner, { sessionId: sessions.get(reviewer.runId)!, setup })
    if (lead.status !== 'accepted' || review.status !== 'accepted') {
      throw new Error('bootstrap Room targets unavailable')
    }
    const reviewerIssued = await runtime.issueAdmissionBootstrapRoomTarget(owner, { origin, target: reviewer })
    if (reviewerIssued.status !== 'issued') throw new Error('reviewer bootstrap Room target denied')
    await expect(runtime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: lead.handle,
      origin: reviewerIssued.origin,
      message: { text: 'cross target' },
    })).resolves.toMatchObject({ status: 'denied', code: 'target-mismatch' })
    await expect(
      runtime.reserveAdmissionBootstrapRoomTarget({ pluginId: owner.pluginId, generation: owner.generation + 1 }, {
        handle: review.handle,
        origin: reviewerIssued.origin,
        message: { text: 'owner replacement' },
      }),
    ).resolves.toMatchObject({ status: 'denied', code: 'not-owner' })

    const leaderIssued = await runtime.issueAdmissionBootstrapRoomTarget(owner, { origin, target: leader })
    if (leaderIssued.status !== 'issued') throw new Error('leader bootstrap Room target denied')
    const revoked = await runtime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: lead.handle,
      origin: leaderIssued.origin,
      message: { text: 'revoke' },
    })
    if (revoked.status !== 'reserved') throw new Error('bootstrap Room revoke reservation unavailable')
    await revoked.reservation.revoke()
    await expect(revoked.reservation.submit()).rejects.toThrow('unavailable')

    const completionIssued = await runtime.issueAdmissionBootstrapRoomTarget(owner, {
      origin: { ...origin, originId: 'bootstrap-room-fences-complete' },
      target: leader,
    })
    if (completionIssued.status !== 'issued') throw new Error('completion bootstrap Room target denied')
    const completion = await runtime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: lead.handle,
      origin: completionIssued.origin,
      message: { text: 'command completion' },
    })
    if (completion.status !== 'reserved') throw new Error('bootstrap Room completion reservation unavailable')
    commandActive = false
    await expect(completion.reservation.submit()).rejects.toThrow('unavailable')

    commandActive = true
    const connectionIssued = await runtime.issueAdmissionBootstrapRoomTarget(owner, {
      origin: { ...origin, originId: 'bootstrap-room-fences-connection' },
      target: leader,
    })
    if (connectionIssued.status !== 'issued') throw new Error('connection bootstrap Room target denied')
    const connection = await runtime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: lead.handle,
      origin: connectionIssued.origin,
      message: { text: 'connection replacement' },
    })
    if (connection.status !== 'reserved') throw new Error('bootstrap Room connection reservation unavailable')
    driver.replace()
    await expect(connection.reservation.submit()).rejects.toThrow('unavailable')
    expect(driver.submitted).toEqual([])
    await runtime.dispose()

    const ownerDriver = new Driver()
    const ownerRuntime = new CordisXAgentSessionRuntime({
      driver: ownerDriver,
      authorize: async () => true,
      bootstrapAdmissionRoomTargetActive: (_owner, candidate, target) =>
        candidate.originId === 'bootstrap-room-fences-owner'
        && target.roomId === leader.roomId && target.runId === leader.runId,
      captureBootstrapAdmissionRoomTarget: (_owner, _candidate, target, _receipt, sessionId) =>
        target.runId === leader.runId
          && sessionId === 'cx-session.bootstrap-room-owner'
          ? { active: () => true, commit: () => {}, close: () => {} }
          : undefined,
    })
    const ownerCreated = await ownerRuntime.create(owner, { sessionId: 'cx-session.bootstrap-room-owner', setup })
    if (ownerCreated.status !== 'accepted') throw new Error('owner bootstrap Room target unavailable')
    const ownerIssued = await ownerRuntime.issueAdmissionBootstrapRoomTarget(owner, {
      origin: { ...origin, originId: 'bootstrap-room-fences-owner' },
      target: leader,
    })
    if (ownerIssued.status !== 'issued') throw new Error('owner bootstrap Room target denied')
    const ownerReservation = await ownerRuntime.reserveAdmissionBootstrapRoomTarget(owner, {
      handle: ownerCreated.handle,
      origin: ownerIssued.origin,
      message: { text: 'owner replacement' },
    })
    if (ownerReservation.status !== 'reserved') throw new Error('owner bootstrap Room reservation unavailable')
    ownerRuntime.fenceOwner(owner.pluginId, 'plugin-generation-replaced')
    await expect(ownerReservation.reservation.submit()).rejects.toThrow('unavailable')
    expect(ownerDriver.submitted).toEqual([])
    await ownerRuntime.dispose()
  })

  it.each([1, 2, 3])(
    'declares, reserves, submits, and Host-claims one v6 Room route continuation per fresh target for N=%i',
    async count => {
      const driver = new Driver()
      let commandActive = true
      const origin = {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
        contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
        schemaVersion: 1 as const,
        originId: `bootstrap-route-origin-${count}`,
        binding: { bindingId: 'bootstrap-route-old-binding', ownerGeneration: 'bootstrap-route-owner-generation' },
        generation: 'bootstrap-route-plugin-generation',
        executionId: `bootstrap-route-execution-${count}`,
        commandId: 'composer.submit',
        scope: 'composer-submit' as const,
      }
      const targets = Array.from({ length: count }, (_, index) => ({
        roomId: 'room-bootstrap-route',
        participantId: ['leader', 'reviewer', 'integrator'][index]!,
        memberId: `member-${index + 1}`,
        runId: `run-${index + 1}`,
        route: { routeId: 'room', param: 'roomId' as const, roomId: 'room-bootstrap-route' },
      }))
      const sessions = new Map(
        targets.map((target, index) => [target.runId, `cx-session.bootstrap-route-${count}-${index}`]),
      )
      const messages = new Map<string, string>()
      const runtime = new CordisXAgentSessionRuntime({
        driver,
        authorize: async () => true,
        bootstrapAdmissionRouteTargetActive: (_owner, candidate, target) =>
          commandActive && candidate.originId === origin.originId
          && targets.some(value =>
            value.roomId === target.roomId && value.participantId === target.participantId
            && value.memberId === target.memberId && value.runId === target.runId
            && value.route.routeId === target.route.routeId
          ),
        bootstrapAdmissionRouteClaimActive: (_owner, candidate) =>
          commandActive && candidate.originId === origin.originId,
        captureBootstrapAdmissionRouteTarget: (
          _owner,
          candidate,
          target,
          _continuation,
          sessionId,
          _generation,
          messageId,
        ) => {
          if (!commandActive || candidate.originId !== origin.originId || sessions.get(target.runId) !== sessionId) {
            return undefined
          }
          messages.set(target.runId, messageId)
          return { active: () => commandActive, commit: () => {}, close: () => {} }
        },
      })
      const declarations = await Promise.all(
        targets.map(target => runtime.declareAdmissionBootstrapRoute(owner, { origin, target })),
      )
      expect(declarations.every(value => value.status === 'declared')).toBe(true)
      const handles = await Promise.all(targets.map(async target => {
        const created = await runtime.create(owner, { sessionId: sessions.get(target.runId)!, setup })
        if (created.status !== 'accepted') throw new Error('fresh v6 target was not acquired')
        return created.handle
      }))
      const reservations = await Promise.all(declarations.map(async (declaration, index) => {
        if (declaration.status !== 'declared') throw new Error('v6 declaration denied')
        return await runtime.reserveAdmissionBootstrapRoute(owner, {
          handle: handles[index]!,
          continuation: declaration.continuation,
          message: { text: `fresh v6 delivery ${index + 1}` },
        })
      }))
      expect(reservations.every(value => value.status === 'reserved')).toBe(true)
      await Promise.all(reservations.map(async reservation => {
        if (reservation.status !== 'reserved') throw new Error('v6 reservation denied')
        await expect(reservation.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
      }))
      expect(driver.submitted).toHaveLength(count)
      for (const [index, declaration] of declarations.entries()) {
        if (declaration.status !== 'declared') throw new Error('v6 declaration denied')
        const target = targets[index]!
        const result = runtime.claimAdmissionBootstrapRoute(owner, {
          continuation: declaration.continuation,
          binding: {
            binding: {
              bindingId: `bootstrap-route-new-binding-${index}`,
              ownerGeneration: origin.binding.ownerGeneration,
            },
            generation: origin.generation,
            route: target.route,
          },
          source: { sessionId: sessions.get(target.runId)!, messageId: messages.get(target.runId)! },
        })
        expect(result).toMatchObject({
          status: 'claimed',
          code: 'claimed',
          receipt: { target, source: { sessionId: sessions.get(target.runId)! } },
        })
      }
      await runtime.dispose()
    },
  )
})
