import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder, TextEncoder } from 'node:util'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
  type AgentDefinition,
  type AgentLoopCommand,
  type AgentLoopEvent,
  type BoundAgentLoopClient,
} from '../packages/cli/src/agent-loop-contracts.js'
import { buildRendererBundle, buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CordisXAgentLoopBroker } from '../packages/cli/src/renderer/agent-loop.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import {
  DeterministicPlaygroundMockCliExecutor,
  PlaygroundMockAgentLoopHost,
} from '../packages/cli/src/renderer/playground-mock-agent-loop.js'
import {
  navigateTaskDetails,
  simulatorTaskIdFromPath,
  taskNavigationTarget,
} from '../packages/cli/src/playground/client/task-details-navigation.js'

const inherit: AgentDefinition['inherit'] = {
  promptSections: 'append', rules: 'append', skills: 'append', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
}

function definition(agentId: string, input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId, revision: 'r1' },
    inherit,
    ...input,
  }
}

function createCommand(
  commandId: string,
  target: AgentDefinition,
  definitions: readonly [AgentDefinition, ...AgentDefinition[]],
): Extract<AgentLoopCommand, { type: 'create-or-bind' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
    contract: 'cordisx.agent-loop-command/v1',
    schemaVersion: 1,
    commandId,
    type: 'create-or-bind',
    definition: target.identity,
    definitions,
    target: { mode: 'create' },
  }
}

function sendCommand(
  commandId: string,
  binding: Extract<Awaited<ReturnType<ReturnType<CordisXAgentLoopBroker['bind']>['createOrBind']>>, { status: 'accepted' }>['binding'],
  text: string,
): Extract<AgentLoopCommand, { type: 'send' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
    contract: 'cordisx.agent-loop-command/v1',
    schemaVersion: 1,
    commandId,
    type: 'send',
    binding,
    content: [{ kind: 'text', text }],
  }
}

const allowed = async (request: { capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit' }) => ({
  capability: request.capability,
  state: 'allowed' as const,
  code: 'allowed' as const,
})

afterEach(() => vi.useRealTimers())

describe('Playground deterministic AgentLoop Simulator', () => {
  it('uses the normal AgentLoop broker for isolated Lead/Reviewer bindings, cursors, replies, approval, failure, and cleanup', async () => {
    vi.useFakeTimers()
    const executor = new DeterministicPlaygroundMockCliExecutor()
    const host = new PlaygroundMockAgentLoopHost(executor)
    const broker = new CordisXAgentLoopBroker(host, () => new Date('2026-08-31T00:00:00.000Z'))
    const client = broker.bind({ ownerKey: 'chatroom', active: () => true, authorize: allowed })
    const lead = definition('chatroom.generalist', {
      name: 'Chatroom Agent',
      promptSections: [
        { sectionId: 'introduction', kind: 'introduction', text: 'Lead introduction' },
        { sectionId: 'personality', kind: 'personality', text: 'Concise' },
        { sectionId: 'memory', kind: 'memory', text: 'Room memory' },
      ],
      rules: ['room-isolation'], skills: ['summarize'], tools: { include: ['read'] }, mcpServers: { exclude: ['external'] },
      runtimeDefaults: { adapterId: 'codex', effort: 'medium' },
    })
    const reviewer = definition('chatroom.reviewer', {
      name: 'Chatroom Reviewer', extends: [lead.identity],
      promptSections: [{ sectionId: 'reviewer-role', kind: 'role', text: 'Review the assigned work.' }],
      rules: ['public-summary-only'],
    })
    const [leadCreate, reviewerCreate] = await Promise.all([
      client.createOrBind(createCommand('create-lead', lead, [lead])),
      client.createOrBind(createCommand('create-reviewer', reviewer, [lead, reviewer])),
    ])
    if (leadCreate.status !== 'accepted' || reviewerCreate.status !== 'accepted') throw new Error('Simulator bindings were not accepted')
    expect(leadCreate.binding.binding).not.toEqual(reviewerCreate.binding.binding)
    expect(leadCreate.binding.task).not.toBe(reviewerCreate.binding.task)

    const [leadSubscription, reviewerSubscription] = await Promise.all([
      client.subscribe(leadCreate.binding, -1), client.subscribe(reviewerCreate.binding, -1),
    ])
    if (leadSubscription.status !== 'accepted' || reviewerSubscription.status !== 'accepted') throw new Error('Simulator subscriptions were not accepted')
    const leadPages = leadSubscription.handle.pages[Symbol.asyncIterator]()
    const reviewerPages = reviewerSubscription.handle.pages[Symbol.asyncIterator]()
    await Promise.all([leadPages.next(), reviewerPages.next()])

    const leadSend = sendCommand('send-lead', leadCreate.binding, 'check token=secret /private/work [approval]')
    const [leadSent, leadRetry, reviewerSent] = await Promise.all([
      client.send(leadSend),
      client.send(leadSend),
      client.send(sendCommand('send-reviewer', reviewerCreate.binding, 'review this [cli-fail]')),
    ])
    expect(leadRetry).toEqual(leadSent)
    expect(leadSent.status).toBe('accepted')
    expect(reviewerSent.status).toBe('accepted')
    await Promise.all([leadPages.next(), reviewerPages.next()])
    await vi.advanceTimersByTimeAsync(250)
    const [leadLifecycle, reviewerLifecycle] = await Promise.all([leadPages.next(), reviewerPages.next()])
    expect(leadLifecycle.value?.subscription.binding).toEqual(leadCreate.binding.binding)
    expect(leadLifecycle.value?.events).toMatchObject([
      { type: 'approval', approval: { state: 'pending' } },
      { type: 'approval', approval: { state: 'resolved', outcome: 'approved' } },
      { type: 'message', message: { role: 'assistant', content: [{ text: expect.stringContaining('[Mock / Simulator] Leader') }] } },
      { type: 'lifecycle', lifecycle: { phase: 'turn.completed' } },
    ])
    expect(reviewerLifecycle.value?.subscription.binding).toEqual(reviewerCreate.binding.binding)
    expect(reviewerLifecycle.value?.events).toMatchObject([
      { type: 'lifecycle', lifecycle: { phase: 'turn.failed', failure: { code: 'SIMULATED_CLI_FAILURE' } } },
    ])

    const snapshot = host.snapshot()
    expect(snapshot.label).toBe('Mock / Simulator')
    expect(snapshot.tasks.map(task => [task.memberLabel, task.roomLabel, task.runLabel, task.status])).toEqual([
      ['Leader', 'Room 1', 'Run 1', 'completed'],
      ['Reviewer', 'Room 1', 'Run 1', 'error'],
    ])
    expect(snapshot.tasks[1]?.layers.map(layer => layer.identity.agentId)).toEqual(['chatroom.generalist', 'chatroom.reviewer'])
    expect(snapshot.tasks[1]?.effective.promptSections?.map(section => section.kind)).toEqual(['introduction', 'personality', 'memory', 'role'])
    expect(snapshot.tasks[0]?.input).toBe('check token=[redacted] [path redacted] [approval]')
    expect(host.activeTaskPresentations().map(task => task.memberLabel)).toEqual(['Leader'])
    expect(snapshot.tasks[0]!.detailsUrl).toEqual({
      url: 'app://-/playground/simulator/tasks/Simulator%20Task%201',
      target: 'host',
    })
    expect(host.taskDetails('Simulator Task 2')?.status).toBe('error')
    expect(executor.invocations.map(item => item.argv)).toEqual([
      ['debug:agent-loop/mock/v1', 'respond', '--format', 'text'],
      ['debug:agent-loop/mock/v1', 'review', '--format', 'text'],
    ])
    expect(JSON.stringify(snapshot)).not.toContain('cxloop-binding')
    expect(JSON.stringify(snapshot)).not.toContain('debug:agent-loop/mock/v1:task:')

    client.dispose()
    expect(host.snapshot().tasks.every(task => !task.active)).toBe(true)
    expect(host.activeTaskPresentations()).toEqual([])
    broker.dispose()
  })

  it('navigates create-time task URLs through history and rejects unapproved URL schemes', async () => {
    const dom = new JSDOM('<!doctype html>', { url: 'http://127.0.0.1/' })
    expect(navigateTaskDetails(dom.window, {
      url: 'app://-/playground/simulator/tasks/Simulator%20Task%201',
      target: 'host',
    })).toBe(true)
    expect(dom.window.location.pathname).toBe('/playground/simulator/tasks/Simulator%20Task%201')
    expect(simulatorTaskIdFromPath(dom.window.location.pathname)).toBe('Simulator Task 1')
    dom.window.history.back()
    await new Promise(resolve => dom.window.addEventListener('popstate', resolve, { once: true }))
    expect(dom.window.location.pathname).toBe('/')
    dom.window.history.forward()
    await new Promise(resolve => dom.window.addEventListener('popstate', resolve, { once: true }))
    expect(simulatorTaskIdFromPath(dom.window.location.pathname)).toBe('Simulator Task 1')

    const opened: string[] = []
    expect(navigateTaskDetails(dom.window, { target: 'external', url: 'https://example.com/task' }, url => opened.push(url.href))).toBe(true)
    expect(navigateTaskDetails(dom.window, { target: 'external', url: 'codex://task/example' }, url => opened.push(url.href))).toBe(true)
    expect(navigateTaskDetails(dom.window, { target: 'external', url: 'claude://task/example' }, url => opened.push(url.href))).toBe(true)
    for (const url of ['http://example.com', 'file:///tmp/task', 'data:text/plain,task', 'javascript:alert(1)', 'blob:https://example.com/id', 'not a url']) {
      expect(navigateTaskDetails(dom.window, { target: 'external', url }, target => opened.push(target.href))).toBe(false)
    }
    expect(taskNavigationTarget({ target: 'host', url: 'https://example.com/task' })).toBeUndefined()
    expect(opened).toHaveLength(3)
    dom.window.close()
  })

  it('resets deterministically and records changed effective prompt snapshots only from actual create inputs', async () => {
    const first = new PlaygroundMockAgentLoopHost()
    const base = definition('lead', { promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Version one' }] })
    const prepared = await first.prepare(base as never)
    if (!prepared.ok) throw new Error('Simulator preparation failed')
    await first.create({ ...base, sourceDefinitions: [base.identity] }, prepared.value, { target: base.identity, definitions: [base] })
    const firstTask = (await first.create({ ...base, sourceDefinitions: [base.identity] }, prepared.value, { target: base.identity, definitions: [base] }))
    if (!firstTask.ok) throw new Error('Simulator create failed')
    const createTimeUrl = first.snapshot().tasks[1]?.detailsUrl
    expect((await first.bind(firstTask.value.task)).ok).toBe(true)
    expect(first.snapshot().tasks[1]?.detailsUrl).toEqual(createTimeUrl)
    const changed = definition('lead', { identity: { agentId: 'lead', revision: 'r2' }, promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Version two' }] })
    await first.create({ ...changed, sourceDefinitions: [changed.identity] }, prepared.value, { target: changed.identity, definitions: [changed] })
    expect(first.snapshot().tasks.map(task => task.effective.promptSections?.[0]?.text)).toEqual(['Version one', 'Version one', 'Version two'])

    const reset = new PlaygroundMockAgentLoopHost()
    expect(reset.snapshot().tasks).toEqual([])
    await reset.create({ ...base, sourceDefinitions: [base.identity] }, prepared.value, { target: base.identity, definitions: [base] })
    expect(reset.snapshot().tasks[0]?.debugTaskId).toBe('Simulator Task 1')
  })

  it('is an explicit Playground-only backend with no provider bridge or codex-local registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-loop-simulator-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({ version: 1, codex: { agentLoopBackend: 'mock' }, plugins: [] }))
    try {
      const config = await loadConfig(configPath)
      expect(config.codex.agentLoopBackend).toBe('mock')
      await expect(buildRendererCompositionSource(config)).rejects.toThrow('only in the explicit UI Playground')
      const composition = await buildRendererCompositionSource(config, { playground: true }, { runtimeImport: '/runtime.ts', awaitBoot: true })
      expect(composition.source).toContain('hostKind: "playground"')
      expect(composition.source).toContain('agentLoopBackend: "mock"')
      expect(composition.source).not.toContain('codex-local')
      expect(composition.source).not.toContain('providerBridgeToken')
      const source = await readFile(path.resolve('packages/cli/src/renderer/playground-mock-agent-loop.ts'), 'utf8')
      expect(source).not.toMatch(/startCodexAppServer|startLocalCodexAppServer|child_process|spawn\(|fetch\(/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never creates a Provider Fleet for a mock Playground generation even when local-cli config is enabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-loop-simulator-provider-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      codex: { agentLoopBackend: 'mock', executable: '/must-not-start/codex' },
      providers: [],
      plugins: [],
    }))
    const createFleet = vi.spyOn(ProviderFleet, 'create')
    const session = await createPlaygroundSession(configPath)
    try {
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('agentLoopBackend: "mock"')
      expect(composition.source).not.toContain('providerBridgeToken')
      expect(createFleet).not.toHaveBeenCalled()
    } finally {
      await session.close()
      createFleet.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a failed trace on retry/rebind and closes only after the final binding is released', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const lead = definition('lead')
    const prepared = await host.prepare()
    if (!prepared.ok) throw new Error('Simulator preparation failed')
    const created = await host.create({ ...lead, sourceDefinitions: [lead.identity] }, prepared.value, {
      target: lead.identity, definitions: [lead],
    })
    if (!created.ok) throw new Error('Simulator create failed')

    await host.send(created.value, [{ kind: 'text', text: '[cli-fail]' }])
    expect(host.activeTaskPresentations()).toEqual([])
    expect(host.snapshot().tasks[0]).toMatchObject({ status: 'error', active: false })

    await host.send(created.value, [{ kind: 'text', text: 'retry succeeds' }])
    expect(host.snapshot().tasks[0]).toMatchObject({ status: 'completed', active: true })
    expect(host.activeTaskPresentations()).toHaveLength(1)

    const rebound = await host.bind(created.value.task)
    if (!rebound.ok) throw new Error('Simulator rebind failed')
    host.release(created.value)
    expect(host.activeTaskPresentations()).toHaveLength(1)
    host.release(rebound.value)
    expect(host.activeTaskPresentations()).toEqual([])
    expect(host.snapshot().tasks[0]).toMatchObject({ status: 'closed', active: false })

    const reopened = await host.bind(created.value.task)
    if (!reopened.ok) throw new Error('Simulator reopen failed')
    expect(host.snapshot().tasks[0]).toMatchObject({ status: 'created', active: true })
    expect(host.snapshot().tasks[0]?.events.at(-1)?.type).toBe('task.bound')
    host.release(reopened.value)
  })

  it('boots the same bundled ctx.agentLoop client without a provider bridge and returns only normal public events', async () => {
    const root = path.resolve('.')
    const entry = path.join(root, 'tests/fixtures/agent-loop-runtime-plugin.ts')
    const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const identity = { source: pathToFileURL(entry).href, id: 'agent-loop-runtime' }
    const manifest = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1 as const,
      id: identity.id,
      name: 'AgentLoop Runtime Fixture',
      capabilities: (['tasks.create', 'tasks.content.read', 'turns.submit'] as const).map(name => ({
        name, required: true, reason: { key: `mock.${name}`, fallback: name }, scope: {},
      })),
    }
    const policies = (['tasks.create', 'tasks.content.read', 'turns.submit'] as const).map(capability => createPermissionPolicyRecord({
      profileId: 'playground', identity, capability, scope: {}, policy: 'allow',
    }))
    const bundle = await buildRendererBundle({
      ...base,
      codex: { ...base.codex, agentLoopBackend: 'mock' },
      providers: [],
      plugins: [{ id: identity.id, entry, enabled: true, config: {}, manifest }],
    }, { playground: true, generation: 'mock-runtime-test', permission: { profileId: 'playground', policies } })
    const dom = new JSDOM(`<!doctype html><html><body>
      <button data-cordisx-playground-manager-trigger>Manager</button>
      <nav data-cordisx-playground-surface="sidebar.navigation.items"></nav>
      <main data-cordisx-playground-seat="app"></main><main data-cordisx-playground-seat="main"></main><main data-cordisx-playground-seat="session.content"></main>
    </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
    Object.defineProperty(dom.window, 'TextEncoder', { value: TextEncoder })
    Object.defineProperty(dom.window, 'TextDecoder', { value: TextDecoder })
    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    const fixture = (dom.window as unknown as { __cordisxAgentLoopRuntimeFixture?: { client: BoundAgentLoopClient } }).__cordisxAgentLoopRuntimeFixture
    if (fixture === undefined) throw new Error('ctx.agentLoop fixture did not mount')
    const lead = definition('chatroom.generalist', { promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Lead prompt' }] })
    const created = await fixture.client.createOrBind(createCommand('bundle-create', lead, [lead]))
    if (created.status !== 'accepted') throw new Error(`bundled Simulator create was not accepted: ${JSON.stringify(created)}`)
    const subscribed = await fixture.client.subscribe(created.binding, -1)
    if (subscribed.status !== 'accepted') throw new Error('bundled Simulator subscribe was not accepted')
    const pages = subscribed.handle.pages[Symbol.asyncIterator]()
    await pages.next()
    expect(await fixture.client.send(sendCommand('bundle-send', created.binding, 'bundled hello'))).toMatchObject({ status: 'accepted' })
    await pages.next()
    const terminalEvents: AgentLoopEvent[] = []
    while (!terminalEvents.some(event => event.type === 'lifecycle' && event.lifecycle.phase === 'turn.completed')) {
      const page = await Promise.race([
        pages.next(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Simulator terminal event timeout')), 2_000)),
      ])
      terminalEvents.push(...(page.value?.events ?? []))
    }
    expect(terminalEvents).toMatchObject([
      { type: 'message', message: { role: 'assistant', content: [{ text: '[Mock / Simulator] Leader processed: bundled hello' }] } },
      { type: 'lifecycle', lifecycle: { phase: 'turn.completed' } },
    ])
    const trace = (dom.window as unknown as { __cordisxRuntime?: { playgroundMockAgentLoop?(): { tasks: readonly { identity: { agentId: string } }[] }; dispose(): Promise<void> } }).__cordisxRuntime?.playgroundMockAgentLoop?.()
    expect(trace?.tasks).toMatchObject([{ identity: { agentId: 'chatroom.generalist' } }])
    expect((dom.window as unknown as { __cordisxProviderRequestV1?: unknown }).__cordisxProviderRequestV1).toBeUndefined()
    await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
    dom.window.close()
  }, 30_000)

  it('keeps an independent Host-owned exact Simulator Task page outside Chatroom and Recent tasks', async () => {
    const [page, app] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/components/MockAgentTaskPage.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
    ])
    expect(page).toContain('data-playground-simulator="true"')
    expect(page).toContain('Mock / Simulator')
    expect(page).toContain('Ordered definition catalog')
    expect(page).toContain('task.execution')
    expect(page).not.toContain('cxloop-binding')
    expect(app).toContain('pg-simulator-task-list')
    expect(app).toContain('data-simulator-task-row')
    expect(app).toContain('task.detailsUrl')
    expect(app.indexOf('pg-session-list')).toBeLessThan(app.indexOf('pg-simulator-task-list'))
  })
})
