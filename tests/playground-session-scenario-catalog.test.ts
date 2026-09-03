import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { ApprovalOutcome, UserMessage } from '@cordisx/protocol/sessions/v1'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import { PlaygroundAgentSessionStore } from '../packages/cli/src/playground/agent-session-store.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import {
  parsePlaygroundSessionScenarioCatalog,
  type PlaygroundSessionScenarioCatalogV1,
} from '../packages/cli/src/playground/session-scenario-catalog.js'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { DeterministicAgentSessionTransport } from '../packages/cli/src/renderer/deterministic-agent-session-transport.js'
import { AgentRouteSessionScopeAuthority } from '../packages/cli/src/renderer/agent-route-session-scope.js'
import {
  PlaygroundScenarioSessionScopeAuthority,
  type PlaygroundScenarioSessionScopeClient,
} from '../packages/cli/src/renderer/playground-scenario-session-scope.js'
import { projectPlaygroundAgentSessions } from '../packages/cli/src/renderer/playground-agent-session-projection.js'
import type {
  PlaygroundRoomSimulationBinding,
  PlaygroundRoomSimulationForwardingClient,
} from '../packages/cli/src/renderer/playground-room-simulation-bridge.js'

const owner = { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 } as const
const binding: PlaygroundRoomSimulationBinding = Object.freeze({
  contract: 'cordisx.playground-room-simulation-binding/v1', sessionId: 'cx-session.lead',
  roomId: 'room-one', runId: 'lead-run', memberId: 'lead-member', bindingId: 'binding-one',
  ownerGeneration: 'owner-one', generation: 'room-generation-one',
})

function setup(agentId: string, name: string): AgentSetup {
  return {
    definition: { agentId, revision: 'scenario-v1' },
    definitions: [{
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
      contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
      identity: { agentId, revision: 'scenario-v1' }, name,
      inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
      promptSections: [],
    }],
  }
}

function message(id: string, text: string): UserMessage {
  return {
    id, role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation, correlation: { namespace: 'chatroom.room-run', id: 'room-one/lead-run' } },
  }
}

function catalog(enabled = true): PlaygroundSessionScenarioCatalogV1 {
  const parsed = parsePlaygroundSessionScenarioCatalog({
    version: 1, revision: 'catalog-september-1', enabled,
    scenarios: {
      '0': { entryAgentId: 'chatroom.generalist', steps: [{ type: 'assistant-reply', text: 'Plain declared reply.', stream: false }] },
      '1': { entryAgentId: 'chatroom.generalist', steps: [{ type: 'assistant-reply', text: 'Streaming declared reply.', stream: true }] },
      '2': { entryAgentId: 'chatroom.generalist', steps: [
        { type: 'tool-call', call: 'inspect', name: 'workspace.inspect', arguments: { scope: 'current' } },
        { type: 'tool-result', call: 'inspect', content: 'Inspection complete.' },
      ] },
      '3': { entryAgentId: 'chatroom.generalist', steps: [{
        type: 'approval-request', request: 'publish', toolName: 'workspace.publish', reason: 'Publish deterministic fixture?',
        branches: {
          'allowed-once': [{ type: 'assistant-reply', text: 'Approval accepted.' }],
          rejected: [{ type: 'failure', code: 'approval-rejected', message: 'Approval was rejected.' }],
        },
      }] },
      '4': { entryAgentId: 'chatroom.generalist', steps: [
        { type: 'room-delegation', as: 'reviewer', memberId: 'reviewer-member', targetAgentId: 'chatroom.reviewer', task: 'Review the declared flow.' },
        { type: 'assistant-reply', actor: 'reviewer', text: 'Reviewer completed.' },
      ] },
      '01234': { entryAgentId: 'chatroom.generalist', label: 'Full deterministic smoke', steps: [
        { type: 'assistant-reply', text: 'Scenario accepted.', stream: true },
        { type: 'room-delegation', as: 'reviewer', memberId: 'reviewer-member', targetAgentId: 'chatroom.reviewer', task: 'Review the declared full smoke.' },
        { type: 'tool-call', actor: 'reviewer', call: 'inspect', name: 'workspace.inspect', arguments: { scope: 'current' } },
        { type: 'tool-result', actor: 'reviewer', call: 'inspect', content: 'Inspection complete.' },
        { type: 'assistant-reply', actor: 'reviewer', text: 'Reviewer found no issues.' },
        { type: 'followup', text: 'Incorporate the Reviewer result.' },
        { type: 'approval-request', request: 'publish', toolName: 'workspace.publish', reason: 'Publish the final summary?', branches: {
          'allowed-once': [{ type: 'assistant-reply', text: 'Approval accepted.' }],
        } },
        { type: 'final-summary', text: 'Lead summary: full smoke completed.', stream: false },
      ] },
      fail: { entryAgentId: 'chatroom.generalist', steps: [
        { type: 'assistant-reply', text: 'Starting failure scenario.' },
        { type: 'failure', code: 'declared-stop', message: 'Declared failure at the second step.' },
      ] },
      cancel: { entryAgentId: 'chatroom.generalist', steps: [
        { type: 'cancel', reason: 'Declared cancellation.' },
      ] },
    },
  })
  if (parsed === undefined) throw new Error('Scenario catalog fixture did not parse')
  return parsed
}

function delegatedApprovalCatalog(): PlaygroundSessionScenarioCatalogV1 {
  const parsed = parsePlaygroundSessionScenarioCatalog({
    version: 1, revision: 'delegated-approval-v1', enabled: true,
    scenarios: Object.fromEntries(['delegated', 'delegated-rejected'].map(code => [code, {
      entryAgentId: 'chatroom.generalist', steps: [
        { type: 'room-delegation', as: 'reviewer', memberId: 'reviewer-member', targetAgentId: 'chatroom.reviewer', task: 'Approve the reviewed task.' },
        { type: 'activate-session-scope', actor: 'reviewer' },
        { type: 'approval-request', actor: 'reviewer', request: 'publish', toolName: 'workspace.publish', branches: {
          'allowed-once': [{ type: 'assistant-reply', actor: 'reviewer', text: 'Reviewer approval succeeded.' }],
          rejected: [{ type: 'failure', actor: 'reviewer', code: 'reviewer-rejected', message: 'Reviewer rejected approval.' }],
        } },
      ],
    }])),
  })
  if (parsed === undefined) throw new Error('Scoped catalog fixture did not parse')
  return parsed
}

function bridgeFor(
  runtime: () => CordisXAgentSessionRuntime,
  observations: { delegations: number; operationIds: string[] },
): PlaygroundRoomSimulationForwardingClient {
  const unavailable = { status: 'unavailable' as const, code: 'unsupported', message: 'not used' }
  return {
    status: () => ({ installed: true, revision: 1, ownerState: 'available', ownerGeneration: binding.ownerGeneration }),
    resolveSession: async sessionId => sessionId === binding.sessionId
      ? { status: 'available', ownerGeneration: binding.ownerGeneration, value: binding }
      : unavailable,
    inspect: async () => ({ status: 'available', ownerGeneration: binding.ownerGeneration, value: {
      binding, lifecycle: 'active', revision: 1, delegationTargets: [{ memberId: 'reviewer-member', label: 'Reviewer' }],
    } }),
    delegateTask: async (_binding, operationId, request) => {
      observations.delegations += 1
      observations.operationIds.push(operationId)
      let reviewer = await runtime().get(owner, 'cx-session.reviewer')
      if (reviewer === undefined) {
        const created = await runtime().create(owner, { sessionId: 'cx-session.reviewer', setup: setup('chatroom.reviewer', 'Reviewer') })
        if (created.status !== 'accepted') throw new Error('Reviewer Session create failed')
        reviewer = created.handle.agent
      }
      const admitted = await reviewer.followup(message(`cx-message.delegated.${observations.delegations}`, request.task))
      if (admitted.status !== 'accepted') throw new Error('Reviewer task admission failed')
      return { status: 'available', ownerGeneration: binding.ownerGeneration, value: {
        operationId, phase: 'accepted', binding, messageId: admitted.messageId,
      } }
    },
    injectMessage: async () => unavailable,
    emitAgentReply: async () => unavailable,
    emitAgentApprovalRequest: async () => unavailable,
    requestPermission: async () => unavailable,
    decidePermission: async () => unavailable,
    snapshot: async () => ({ status: 'available', ownerGeneration: binding.ownerGeneration, value: { binding, revision: 1, events: [] } }),
    subscribe: () => () => {},
  }
}

async function readAll(runtime: CordisXAgentSessionRuntime, sessionId: string) {
  const agent = await runtime.get(owner, sessionId)
  if (agent === undefined) throw new Error(`Session ${sessionId} is unavailable`)
  const read = await agent.session.read({ afterSeq: -1, limit: 500 })
  if (read.status !== 'available') throw new Error(`Session ${sessionId} could not be read`)
  return read.page.events
}

describe('Host Playground Session scenario catalog', () => {
  it('strictly parses a versioned multi-code catalog and injects it only through the explicit Playground composition', async () => {
    expect(Object.keys(catalog().scenarios)).toEqual(['0', '1', '2', '3', '4', '01234', 'fail', 'cancel'])
    expect(() => parsePlaygroundSessionScenarioCatalog({ version: 1, revision: 'r1', enabled: true, scenarios: {
      'bad code': { entryAgentId: 'lead', steps: [{ type: 'assistant-reply', text: 'no' }] },
    } })).toThrow('code "bad code" is invalid')
    expect(() => parsePlaygroundSessionScenarioCatalog({ version: 1, revision: 'r1', enabled: true, scenarios: {
      '1': { entryAgentId: 'lead', steps: [{ type: 'unknown' }] },
    } })).toThrow('.type is unsupported')
    expect(() => parsePlaygroundSessionScenarioCatalog({ version: 1, revision: 'r1', enabled: true, scenarios: {
      '1': { entryAgentId: 'lead', steps: [{ type: 'activate-session-scope' }] },
    } })).toThrow('.actor is required')

    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-session-scenario-config-'))
    const configPath = path.join(root, 'cordisx.config.json')
    try {
      await writeFile(configPath, JSON.stringify({ version: 1, playground: { sessionScenarios: catalog() }, plugins: [] }))
      const session = await createPlaygroundSession(configPath)
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('playgroundSessionScenarios')
      expect(composition.source).toContain('catalog-september-1')
      expect(composition.source).toContain('Full deterministic smoke')
      const [app, taskPage] = await Promise.all([
        readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
        readFile(path.resolve('packages/cli/src/playground/client/components/MockAgentTaskPage.tsx'), 'utf8'),
      ])
      expect(app).toContain("secondary: `${en ? 'Scenario' : '场景'} ${task.scenario.code}")
      expect(taskPage).toContain('data-scenario-code={task.scenario.code}')
      expect(taskPage).toContain('data-scenario-step={task.scenario.stepIndex}')
      await session.close()
      const source = JSON.parse(await readFile(configPath, 'utf8')) as { playground: { sessionScenarios: unknown } }
      expect(source.playground.sessionScenarios).toBeDefined()
    } finally { await rm(root, { recursive: true, force: true }) }

    await expect(buildRendererCompositionSource({ version: 1, rootDir: process.cwd(), codex: { debugPort: 9229 }, providers: [], plugins: [] }, {
      playgroundSessionScenarios: catalog(),
    })).rejects.toThrow('only in the explicit UI Playground')
  })

  it('executes an enabled composite flow across Lead and delegated Reviewer Sessions with real facts', async () => {
    const observations = { delegations: 0, operationIds: [] as string[] }
    let runtime!: CordisXAgentSessionRuntime
    const driver = new DeterministicAgentSessionTransport({ scenarioCatalog: catalog(), roomBridge: bridgeFor(() => runtime, observations), delegationTimeoutMs: 1_000 })
    runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: binding.sessionId!, setup: setup('chatroom.generalist', 'Lead') })
    if (created.status !== 'accepted') throw new Error('Lead Session create failed')
    await runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once')
    expect(await created.handle.agent.followup(message('cx-message.scenario.01234', '01234'))).toMatchObject({ status: 'accepted' })
    expect(await created.handle.agent.whenIdle()).toEqual({ status: 'idle' })

    const lead = await readAll(runtime, binding.sessionId!)
    const reviewer = await readAll(runtime, 'cx-session.reviewer')
    expect(lead.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(lead.filter(event => event.type === 'assistant/message').map(event => event.type === 'assistant/message' ? event.data.message.content[0] : undefined))
      .toMatchObject([{ text: 'Scenario accepted.' }, { text: 'Approval accepted.' }, { text: 'Lead summary: full smoke completed.' }])
    expect(lead.find(event => event.type === 'tool/call' && event.data.name === 'playground.room.delegate')).toBeDefined()
    expect(lead.find(event => event.type === 'tool/result' && event.data.meta !== undefined)).toBeDefined()
    expect(lead.find(event => event.type === 'approval/asked')).toMatchObject({ data: { toolName: 'workspace.publish' } })
    expect(lead.find(event => event.type === 'approval/decided')).toMatchObject({ data: { outcome: 'allowed-once' } })
    expect(lead.find(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(inserted => inserted.source.kind === 'plugin' && inserted.source.form === 'instructions'))).toBeDefined()
    expect(lead.find(event => event.type === 'playground/scenario' && event.data.phase === 'completed')).toMatchObject({
      ignorable: true, data: { code: '01234', sourceMessageId: 'cx-message.scenario.01234', catalogRevision: 'catalog-september-1' },
    })
    expect(reviewer.find(event => event.type === 'tool/call')).toMatchObject({ data: { name: 'workspace.inspect' } })
    expect(reviewer.find(event => event.type === 'tool/result')).toMatchObject({ data: { message: { content: [{ content: [{ text: 'Inspection complete.' }] }] } } })
    expect(reviewer.find(event => event.type === 'assistant/message')).toMatchObject({ data: { message: { content: [{ text: 'Reviewer found no issues.' }] } } })
    expect(observations.delegations).toBe(1)
    expect(observations.operationIds[0]).toMatch(/^playground-scenario\.[a-f0-9]{36}\.delegate\.2\.reviewer$/u)

    const projected = projectPlaygroundAgentSessions(runtime.playgroundProjection())!.tasks
    expect(projected.find(task => task.sessionId === binding.sessionId)?.scenario).toMatchObject({ code: '01234', phase: 'completed' })
    expect(projected.find(task => task.sessionId === 'cx-session.reviewer')?.scenario).toMatchObject({ code: '01234', actor: 'reviewer' })
    await runtime.dispose()
  })

  it('activates the delegated Reviewer exact route scope before approval and completes the allowed branch', async () => {
    const scopedCatalog = delegatedApprovalCatalog()
    const observations = { delegations: 0, operationIds: [] as string[] }
    let runtime!: CordisXAgentSessionRuntime
    let scopeAuthority!: PlaygroundScenarioSessionScopeAuthority
    const routeScopes = new AgentRouteSessionScopeAuthority({
      activeRoute: () => {
        const route = scopeAuthority.effectiveRoute()
        return route === undefined ? undefined : {
          owner: `${route.owner.source}:${route.owner.pluginId}`, routeId: route.routeId,
          instanceId: route.routeInstanceId, params: route.params,
        }
      },
      routes: pluginId => pluginId === owner.pluginId
        ? [{ id: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }]
        : [],
      decide: async plan => ({ authorized: plan.scope.sessionIds.length === 1 }),
      connectionGeneration: () => 1,
    })
    routeScopes.install(owner.pluginId, [
      { name: 'approvals.request', required: false, scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
      { name: 'approvals.answer', required: false, scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
    ])
    let approvalOutcome: ApprovalOutcome = 'allowed-once'
    scopeAuthority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'playground-generation-one',
      currentRoute: () => ({
        kind: 'host-route', active: true, owner: { source: 'file:///fixtures/chatroom.ts', pluginId: 'chatroom' },
        routeId: 'room-session-detail', routeInstanceId: 'main:lead-route',
        path: '/main/chatroom/:roomId/run/:runId/session/:sessionId', params: { sessionId: binding.sessionId! },
      }),
      ownerForSession: sessionId => runtime?.ownerForSession(sessionId),
      authorize: async (agentOwner, capability, sessionId) => {
        const authorized = await routeScopes.authorize(agentOwner, capability, sessionId)
        if (authorized && capability === 'approvals.request') {
          const agent = await runtime.get(agentOwner, sessionId)
          if (agent !== undefined) await runtime.registerAnswerer(agentOwner, agent, async () => approvalOutcome)
        }
        return authorized
      },
      mountRoute: () => () => {},
      changed: () => routeScopes.reconcileRoutes(),
    })
    const driver = new DeterministicAgentSessionTransport({
      scenarioCatalog: scopedCatalog, roomBridge: bridgeFor(() => runtime, observations),
      scenarioSessionScope: scopeAuthority.client, delegationTimeoutMs: 1_000,
    })
    runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async (agentOwner, capability, sessionId) => capability === 'approvals.request' || capability === 'approvals.answer'
        ? await routeScopes.authorize(agentOwner, capability, sessionId)
        : true,
    })
    const lead = await runtime.create(owner, { sessionId: binding.sessionId!, setup: setup('chatroom.generalist', 'Lead') })
    if (lead.status !== 'accepted') throw new Error('Lead Session create failed')
    await lead.handle.agent.followup(message('cx-message.delegated-approval', 'delegated'))
    await lead.handle.agent.whenIdle()

    const reviewer = await readAll(runtime, 'cx-session.reviewer')
    expect(reviewer.find(event => event.type === 'approval/asked')).toMatchObject({ data: { toolName: 'workspace.publish' } })
    expect(reviewer.find(event => event.type === 'approval/decided')).toMatchObject({ data: { outcome: 'allowed-once' } })
    expect(reviewer.find(event => event.type === 'assistant/message')).toMatchObject({
      data: { message: { content: [{ text: 'Reviewer approval succeeded.' }] } },
    })
    expect(reviewer.find(event => event.type === 'playground/scenario' && event.data.stepType === 'activate-session-scope'))
      .toMatchObject({ data: { actor: 'reviewer', phase: 'step-started' } })
    expect(scopeAuthority.effectiveRoute()?.params.sessionId).toBe(binding.sessionId)

    approvalOutcome = 'rejected'
    await lead.handle.agent.followup(message('cx-message.delegated-rejected', 'delegated-rejected'))
    await lead.handle.agent.whenIdle()
    const rejectedReviewer = await readAll(runtime, 'cx-session.reviewer')
    expect(rejectedReviewer.findLast(event => event.type === 'approval/decided')).toMatchObject({ data: { outcome: 'rejected' } })
    const rejectedLead = await readAll(runtime, binding.sessionId!)
    expect(rejectedLead.findLast(event => event.type === 'playground/scenario')).toMatchObject({
      data: { code: 'delegated-rejected', phase: 'failed', error: { code: 'reviewer-rejected' } },
    })
    await runtime.dispose()
    scopeAuthority.dispose()
  })

  it('passes through disabled, unknown, production, and wrong-entry messages as ordinary deterministic inputs', async () => {
    for (const scenarioCatalog of [catalog(false), catalog()]) {
      const driver = new DeterministicAgentSessionTransport({ scenarioCatalog })
      const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
      const created = await runtime.create(owner, {
        sessionId: `cx-session.pass-${scenarioCatalog.enabled}`,
        setup: setup(scenarioCatalog.enabled ? 'chatroom.reviewer' : 'chatroom.generalist', 'Ordinary'),
      })
      if (created.status !== 'accepted') throw new Error('Pass-through Session create failed')
      await created.handle.agent.followup(message(`cx-message.pass-${scenarioCatalog.enabled}`, scenarioCatalog.enabled ? 'unknown-code' : '01234'))
      await created.handle.agent.whenIdle()
      const events = await readAll(runtime, created.sessionId)
      expect(events.some(event => event.type === 'playground/scenario')).toBe(false)
      expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
        data: { message: { content: [{ text: expect.stringContaining('Playground Agent/Session fixture reply:') }] } },
      })
      await runtime.dispose()
    }

    const driver = new DeterministicAgentSessionTransport({ scenarioCatalog: catalog() })
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'cx-session.code-with-attachment', setup: setup('chatroom.generalist', 'Ordinary') })
    if (created.status !== 'accepted') throw new Error('Attachment Session create failed')
    await created.handle.agent.followup({
      ...message('cx-message.code-with-attachment', '1'),
      content: [{ type: 'text', text: '1' }, { type: 'image', ref: 'data:image/png;base64,AA==', mediaType: 'image/png' }],
    })
    await created.handle.agent.whenIdle()
    const events = await readAll(runtime, created.sessionId)
    expect(events.some(event => event.type === 'playground/scenario')).toBe(false)
    await runtime.dispose()
  })

  it('persists source-message/catalog/code idempotency across restart and reports a retryable exact failure step', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-session-scenario-restart-'))
    try {
      const store = new PlaygroundAgentSessionStore(home)
      let first!: CordisXAgentSessionRuntime
      const firstObservations = { delegations: 0, operationIds: [] as string[] }
      const firstDriver = new DeterministicAgentSessionTransport({ scenarioCatalog: catalog(), roomBridge: bridgeFor(() => first, firstObservations), delegationTimeoutMs: 1_000 })
      first = new CordisXAgentSessionRuntime({ driver: firstDriver, authorize: async () => true, persistence: store })
      const lead = await first.create(owner, { sessionId: binding.sessionId!, setup: setup('chatroom.generalist', 'Lead') })
      if (lead.status !== 'accepted') throw new Error('Persisted Lead create failed')
      await first.registerAnswerer(owner, lead.handle.agent, async () => 'allowed-once')
      const source = message('cx-message.persisted-scenario', '01234')
      await lead.handle.agent.followup(source)
      await lead.handle.agent.whenIdle()
      const before = await readAll(first, binding.sessionId!)
      await first.dispose()

      const recovered = await store.load()
      const secondObservations = { delegations: 0, operationIds: [] as string[] }
      let second!: CordisXAgentSessionRuntime
      const secondDriver = new DeterministicAgentSessionTransport({ recoveredSessions: recovered, scenarioCatalog: catalog(), roomBridge: bridgeFor(() => second, secondObservations), delegationTimeoutMs: 1_000 })
      second = new CordisXAgentSessionRuntime({ driver: secondDriver, authorize: async () => true, persistence: store, initialSessions: recovered })
      const resumed = await second.resume(owner, { sessionId: binding.sessionId! })
      if (resumed.status !== 'accepted') throw new Error('Persisted Lead resume failed')
      expect(await resumed.handle.agent.followup(source)).toMatchObject({ status: 'accepted' })
      const after = await readAll(second, binding.sessionId!)
      expect(after).toEqual(before)
      expect(secondObservations.delegations).toBe(0)

      const retry = await resumed.handle.agent.followup(message('cx-message.retry-failure', 'fail'))
      expect(retry).toMatchObject({ status: 'accepted' })
      await resumed.handle.agent.whenIdle()
      const failed = await readAll(second, binding.sessionId!)
      expect(failed.findLast(event => event.type === 'playground/scenario')).toMatchObject({
        data: { code: 'fail', phase: 'failed', stepIndex: 2, stepType: 'failure', error: { code: 'declared-stop', message: 'Declared failure at the second step.' } },
      })
      expect(failed.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'declared-stop' } } } })
      const firstFailedRun = failed.findLast(event => event.type === 'playground/scenario')?.type === 'playground/scenario'
        ? failed.findLast(event => event.type === 'playground/scenario')!.data.runId
        : undefined
      await resumed.handle.agent.followup(message('cx-message.retry-failure-two', 'fail'))
      await resumed.handle.agent.whenIdle()
      const retried = await readAll(second, binding.sessionId!)
      const failedRuns = retried.filter(event => event.type === 'playground/scenario' && event.data.phase === 'failed')
        .map(event => event.type === 'playground/scenario' ? event.data.runId : '')
      expect(new Set(failedRuns)).toEqual(new Set([firstFailedRun, failedRuns.at(-1)]))
      expect(failedRuns.at(-1)).not.toBe(firstFailedRun)

      await resumed.handle.agent.followup(message('cx-message.cancel-scenario', 'cancel'))
      await resumed.handle.agent.whenIdle()
      const cancelled = await readAll(second, binding.sessionId!)
      expect(cancelled.findLast(event => event.type === 'playground/scenario')).toMatchObject({
        data: { code: 'cancel', phase: 'cancelled', stepIndex: 1, stepType: 'cancel', error: { code: 'scenario-cancelled', message: 'Declared cancellation.' } },
      })
      expect(cancelled.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
      await second.dispose()
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('does not repeat delegated scope activation when the same durable source message is replayed after restart', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-session-scenario-scope-restart-'))
    try {
      const store = new PlaygroundAgentSessionStore(home)
      let activations = 0
      let runtime!: CordisXAgentSessionRuntime
      const scopeClient = (): PlaygroundScenarioSessionScopeClient => ({
        activate: async input => {
          activations += 1
          const agent = await runtime.get(owner, input.targetSessionId)
          if (agent === undefined) return { status: 'unavailable', code: 'session-unavailable', message: 'missing target' }
          await runtime.registerAnswerer(owner, agent, async () => 'allowed-once')
          let active = true
          let settle!: (value: { readonly code: 'completed' }) => void
          const closed = new Promise<{ readonly code: 'completed' }>(resolve => { settle = resolve })
          return { status: 'available', handle: Object.freeze({
            runId: input.runId, sessionId: input.targetSessionId, routeInstanceId: `scenario:${input.runId}`, closed,
            active: () => active,
            close: () => { if (active) { active = false; settle({ code: 'completed' }) } },
          }) }
        },
      })
      const firstObservations = { delegations: 0, operationIds: [] as string[] }
      const firstDriver = new DeterministicAgentSessionTransport({
        scenarioCatalog: delegatedApprovalCatalog(), roomBridge: bridgeFor(() => runtime, firstObservations),
        scenarioSessionScope: scopeClient(), delegationTimeoutMs: 1_000,
      })
      runtime = new CordisXAgentSessionRuntime({ driver: firstDriver, authorize: async () => true, persistence: store })
      const lead = await runtime.create(owner, { sessionId: binding.sessionId!, setup: setup('chatroom.generalist', 'Lead') })
      if (lead.status !== 'accepted') throw new Error('Persisted scoped Lead create failed')
      const source = message('cx-message.persisted-delegated-scope', 'delegated')
      await lead.handle.agent.followup(source)
      await lead.handle.agent.whenIdle()
      expect(activations).toBe(1)
      const before = await readAll(runtime, binding.sessionId!)
      await runtime.dispose()

      const recovered = await store.load()
      const secondObservations = { delegations: 0, operationIds: [] as string[] }
      const secondDriver = new DeterministicAgentSessionTransport({
        recoveredSessions: recovered, scenarioCatalog: delegatedApprovalCatalog(),
        roomBridge: bridgeFor(() => runtime, secondObservations), scenarioSessionScope: scopeClient(), delegationTimeoutMs: 1_000,
      })
      runtime = new CordisXAgentSessionRuntime({ driver: secondDriver, authorize: async () => true, persistence: store, initialSessions: recovered })
      const resumed = await runtime.resume(owner, { sessionId: binding.sessionId! })
      if (resumed.status !== 'accepted') throw new Error('Persisted scoped Lead resume failed')
      expect(await resumed.handle.agent.followup(source)).toMatchObject({ status: 'accepted' })
      expect(await readAll(runtime, binding.sessionId!)).toEqual(before)
      expect(activations).toBe(1)
      expect(secondObservations.delegations).toBe(0)
      await runtime.dispose()
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('does not queue a duplicate scenario operation after the first source message was claimed', async () => {
    const pendingCatalog = parsePlaygroundSessionScenarioCatalog({
      version: 1, revision: 'pending-approval-1', enabled: true,
      scenarios: { hold: { entryAgentId: 'chatroom.generalist', steps: [
        { type: 'approval-request', request: 'hold', toolName: 'fixture.hold' },
        { type: 'final-summary', text: 'Released.' },
      ] } },
    })
    if (pendingCatalog === undefined) throw new Error('Pending catalog fixture did not parse')
    const driver = new DeterministicAgentSessionTransport({ scenarioCatalog: pendingCatalog })
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'cx-session.duplicate-active', setup: setup('chatroom.generalist', 'Lead') })
    if (created.status !== 'accepted') throw new Error('Duplicate test Session create failed')
    let release!: (outcome: 'allowed-once') => void
    const waiting = new Promise<'allowed-once'>(resolve => { release = resolve })
    let approvalStarted!: () => void
    const started = new Promise<void>(resolve => { approvalStarted = resolve })
    await runtime.registerAnswerer(owner, created.handle.agent, async () => {
      approvalStarted()
      return await waiting
    })
    const source = message('cx-message.duplicate-active', 'hold')
    expect(await created.handle.agent.followup(source)).toMatchObject({ status: 'accepted' })
    await started
    expect(await created.handle.agent.followup(source)).toMatchObject({ status: 'accepted' })
    release('allowed-once')
    expect(await created.handle.agent.whenIdle()).toEqual({ status: 'idle' })
    const events = await readAll(runtime, created.sessionId)
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'playground/scenario' && event.data.phase === 'completed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(2)
    expect(events.findLast(event => event.type === 'agent/inbox/spliced')).toMatchObject({ data: { removedCount: 1, inserted: [] } })
    await runtime.dispose()
  })

  it('closes an interrupted recovered run once without replaying its completed side effects', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-session-scenario-interrupted-'))
    try {
      const store = new PlaygroundAgentSessionStore(home)
      await store.create({
        id: binding.sessionId!, generation: 1,
        header: { id: binding.sessionId!, formatVersion: 1, createdAt: 1_780_000_000_000, isSeeded: false },
        setup: setup('chatroom.generalist', 'Lead'),
        events: [{
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
          contract: 'cordisx.session-event/v1', schemaVersion: 1, sessionId: binding.sessionId!, seq: 0,
          time: 1_780_000_000_001, type: 'playground/scenario', ignorable: true,
          data: {
            runId: 'playground-scenario.interrupted', sourceMessageId: 'cx-message.interrupted', catalogRevision: 'catalog-september-1', code: '01234',
            actor: 'lead', phase: 'step-started', stepIndex: 2, stepCount: 8, stepType: 'room-delegation',
          },
        }],
      })
      const recovered = await store.load()
      const driver = new DeterministicAgentSessionTransport({ recoveredSessions: recovered, scenarioCatalog: catalog() })
      const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true, persistence: store, initialSessions: recovered })
      const resumed = await runtime.resume(owner, { sessionId: binding.sessionId! })
      expect(resumed.status).toBe('accepted')
      await new Promise(resolve => setTimeout(resolve, 10))
      const events = await readAll(runtime, binding.sessionId!)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        type: 'playground/scenario', ignorable: true,
        data: {
          runId: 'playground-scenario.interrupted', phase: 'failed', stepIndex: 2,
          error: { code: 'scenario-runtime-replaced', message: expect.stringContaining('retry safely') },
        },
      })
      await runtime.dispose()

      const after = await store.load()
      const next = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport({ recoveredSessions: after, scenarioCatalog: catalog() }),
        authorize: async () => true, persistence: store, initialSessions: after,
      })
      expect((await next.resume(owner, { sessionId: binding.sessionId! })).status).toBe('accepted')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(await readAll(next, binding.sessionId!)).toHaveLength(2)
      await next.dispose()
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
