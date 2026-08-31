import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import type { CliProxyProviderConfig, LocalCodexProviderConfig } from '../packages/cli/src/providers/contracts.js'
import { AgentLoopAuthority } from '../packages/cli/src/launcher/agent-loop-authority.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

function config(root: string, id: string): CliProxyProviderConfig {
  return {
    id, kind: 'cli-proxy-api', displayName: id.toUpperCase(), baseUrl: `https://${id}.test/v1`, apiKeyEnv: `${id.toUpperCase()}_KEY`,
    codexExecutable: 'codex', codexHome: path.join(root, id), enabled: true, timeoutMs: 1_000,
  }
}

function localConfig(root: string): LocalCodexProviderConfig {
  return {
    id: 'codex-local', kind: 'local-codex', displayName: 'Local Codex', sourceProviderId: 'openai',
    codexExecutable: 'codex', codexHome: path.join(root, 'codex-local'), enabled: true, timeoutMs: 1_000,
  }
}

function server(id: string, calls: { provider: string; method: string; params: unknown }[]): CodexAppServerRpc {
  return {
    generation: `generation-${id}`,
    async request<Result>(method: string, params: unknown): Promise<Result> {
      calls.push({ provider: id, method, params })
      if (method === 'model/list') return { data: [{ id: 'shared-model', model: 'shared-model', displayName: 'Shared', hidden: false, isDefault: true }], nextCursor: null } as Result
      if (method === 'thread/list') {
        const cursor = (params as { cursor?: string }).cursor
        return {
          data: [{ id: cursor === undefined ? 'shared-session' : `${id}-later`, preview: `${id} session`, modelProvider: id, createdAt: 1, updatedAt: cursor === undefined ? (id === 'alpha' ? 20 : 10) : 1, cwd: '/workspace', turns: [] }],
          nextCursor: cursor === undefined ? `${id}-cursor` : null,
        } as Result
      }
      if (method === 'thread/start') {
        return { thread: { id: `${id}-created`, preview: '', modelProvider: id, createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] }, model: 'shared-model' } as Result
      }
      throw new Error(`unexpected ${method}`)
    },
    async close() {},
  }
}

describe('Provider Fleet', () => {
  it('preserves composite identities across collisions and model-routed creation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    const calls: { provider: string; method: string; params: unknown }[] = []
    const fleet = await ProviderFleet.create([config(root, 'alpha'), config(root, 'beta')], {
      startServer: async provider => server(provider.id, calls),
    })
    const models = await fleet.listModels({})
    expect(models.ok && models.value.models.map(item => item.ref)).toEqual([
      { providerId: 'alpha', modelId: 'shared-model' },
      { providerId: 'beta', modelId: 'shared-model' },
    ])
    const sessions = await fleet.listTasks({ limit: 2 })
    expect(sessions.ok && sessions.value.sessions.map(item => item.ref)).toEqual([
      { providerId: 'alpha', remoteSessionId: 'shared-session' },
      { providerId: 'beta', remoteSessionId: 'shared-session' },
    ])
    const created = await fleet.createTask({ model: { providerId: 'beta', modelId: 'shared-model' }, cwd: '/workspace' })
    expect(created.ok && created.value.ref).toEqual({ providerId: 'beta', remoteSessionId: 'beta-created' })
    expect(calls.filter(call => call.method === 'thread/start').map(call => call.provider)).toEqual(['beta'])
    expect(fleet.status()).toMatchObject({ mode: 'read-write', secondConnectionCreated: false, rawBridgeExposed: false })
    expect(fleet.providerStatuses()).toEqual([
      { providerId: 'alpha', displayName: 'ALPHA', generation: 'generation-alpha', state: 'ready' },
      { providerId: 'beta', displayName: 'BETA', generation: 'generation-beta', state: 'ready' },
    ])
    expect(fleet.status().diagnostics).toContainEqual(expect.objectContaining({ code: 'current-connection-client-unavailable' }))
    await fleet.close()
  })

  it('reports availability per configured provider instead of flattening a partial Fleet failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    const fleet = await ProviderFleet.create([config(root, 'alpha'), config(root, 'beta')], {
      startServer: async provider => {
        if (provider.id === 'beta') throw new Error('beta is offline')
        return server(provider.id, [])
      },
    })
    expect(fleet.status().mode).toBe('read-write')
    expect(fleet.providerStatuses()).toEqual([
      { providerId: 'alpha', displayName: 'ALPHA', generation: 'generation-alpha', state: 'ready' },
      { providerId: 'beta', displayName: 'BETA', state: 'unavailable' },
    ])
    await fleet.close()
  })

  it('binds opaque continuation cursors to provider filters and query generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    const fleet = await ProviderFleet.create([config(root, 'alpha'), config(root, 'beta')], {
      startServer: async provider => server(provider.id, []),
    })
    const first = await fleet.listTasks({ limit: 1 })
    expect(first.ok && first.value.nextCursor).toEqual(expect.any(String))
    if (!first.ok || first.value.nextCursor === undefined) throw new Error('missing cursor')
    const mismatch = await fleet.listTasks({ providerIds: ['alpha'], limit: 1, cursor: first.value.nextCursor })
    expect(mismatch).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid-request' }) }))
    await fleet.close()
  })

  it('normalizes id-less provider lifecycle notifications into replayable launcher events without retaining raw frames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    let notify: ((method: string, params: unknown) => void) | undefined
    const fleet = await ProviderFleet.create([config(root, 'alpha')], {
      startServer: async provider => {
        const base = server(provider.id, [])
        return {
        ...base,
        async request<Result>(method: string, params: unknown): Promise<Result> {
          if (method === 'turn/start') return { turn: { id: 'turn-1' } } as Result
          return await base.request<Result>(method, params)
        },
        subscribeNotifications(listener) { notify = listener; return () => { notify = undefined } },
        }
      },
    })
    const dispatched = await fleet.dispatchCreate({
      operationId: 'channel-op-1', model: { providerId: 'alpha', modelId: 'shared-model' }, cwd: '/workspace', message: 'hello',
    })
    if (dispatched.session === undefined || dispatched.turn === undefined || notify === undefined) throw new Error('dispatch did not create a lifecycle target')
    notify('turn/completed', { threadId: dispatched.session.remoteSessionId, turnId: dispatched.turn.turnId, text: 'Done.', rawEvent: { secret: 'never retained' } })
    const events = fleet.readLifecycle(dispatched.session, 0)
    expect(events).toMatchObject({ nextAfterSequence: 2, events: [
      { type: 'turn.started', operationId: 'channel-op-1' },
      { type: 'turn.completed', output: [{ type: 'text', text: 'Done.' }] },
    ] })
    expect(JSON.stringify(events)).not.toContain('rawEvent')
    await fleet.close()
  })

  it('keeps distinct approvals for one turn while deduplicating exact notification replays', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    let notify: ((method: string, params: unknown) => void) | undefined
    const fleet = await ProviderFleet.create([config(root, 'alpha')], {
      startServer: async provider => {
        const base = server(provider.id, [])
        return {
          ...base,
          subscribeNotifications(listener) { notify = listener; return () => { notify = undefined } },
        }
      },
    })
    if (notify === undefined) throw new Error('provider lifecycle subscription was not registered')
    const session = { providerId: 'alpha', remoteSessionId: 'shared-session' }
    const approval = (method: 'approval/requested' | 'approval/resolved', approvalId: string) => ({
      threadId: session.remoteSessionId,
      turnId: 'turn-with-two-approvals',
      approvalId,
      approval: { kind: 'command', ...(method === 'approval.resolved' ? { outcome: 'approved' } : {}) },
    })
    for (const approvalId of ['approval-1', 'approval-2']) {
      notify('approval/requested', approval('approval/requested', approvalId))
      notify('approval/resolved', approval('approval/resolved', approvalId))
    }
    notify('approval/requested', approval('approval/requested', 'approval-2'))
    notify('approval/resolved', approval('approval/resolved', 'approval-2'))
    notify('turn/completed', { threadId: session.remoteSessionId, turn: { id: 'turn-with-two-approvals', status: 'completed' } })
    notify('turn/completed', { threadId: session.remoteSessionId, turn: { id: 'turn-with-two-approvals', status: 'failed' } })

    expect(fleet.readLifecycle(session).events.map(event => [event.type, event.approval?.approvalId])).toEqual([
      ['approval.required', 'approval-1'],
      ['approval.resolved', 'approval-1'],
      ['approval.required', 'approval-2'],
      ['approval.resolved', 'approval-2'],
      ['turn.completed', undefined],
    ])
    await fleet.close()
  })

  it('runs durable v4 create, send, and self-introduction through the exact local provider generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-v4-'))
    const calls: { method: string; params: unknown }[] = []
    let notify: ((method: string, params: unknown) => void) | undefined
    const authority = await AgentLoopAuthority.open(root, 'work')
    const fleet = await ProviderFleet.create([localConfig(root)], {
      agentLoopAuthority: authority,
      startServer: async () => ({
        generation: 'local-generation-1',
        async request<Result>(method: string, params: unknown): Promise<Result> {
          calls.push({ method, params })
          if (method === 'thread/start') return { thread: { id: 'local-session', preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
          if (method === 'thread/read') return { thread: { id: 'local-session', preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
          if (method === 'turn/start') return { turn: { id: `turn-${calls.filter(call => call.method === 'turn/start').length}` } } as Result
          if (method === 'turn/interrupt') return {} as Result
          throw new Error(`unexpected ${method}`)
        },
        subscribeNotifications(listener) { notify = listener; return () => { notify = undefined } },
        async close() {},
      }),
    })
    const scope = { profileId: 'work', compositionGeneration: 'composition-1', ownerKey: 'plugin-owner' }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    const createInput = {
      scope, command: { type: 'create-or-bind', commandId: 'create-1' }, operationId: 'create-1', definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace', developerInstructions: 'private definition body',
    }
    const created = await fleet.createAgentLoopV4(createInput) as { status: string; locator?: { task: string; binding: { bindingId: string; generation: number }; definition: typeof definition }; delivery?: string }
    expect(created).toMatchObject({ status: 'accepted', delivery: 'executed', locator: { providerGeneration: 'local-generation-1' } })
    const replayedCreate = await fleet.createAgentLoopV4(createInput)
    expect(replayedCreate).toMatchObject({ status: 'accepted', delivery: 'replayed' })
    expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    const task = created.locator?.task
    if (task === undefined) throw new Error('missing durable task')

    const binding = created.locator?.binding
    if (binding === undefined) throw new Error('missing durable binding')
    const sendInput = { scope, command: { type: 'send', commandId: 'send-1', content: [{ kind: 'text', text: 'private message' }] }, operationId: 'send-1', task, binding, definition, message: 'private message' }
    expect(await fleet.sendAgentLoopV4(sendInput)).toMatchObject({ status: 'accepted', delivery: 'executed' })
    expect(await fleet.sendAgentLoopV4(sendInput)).toMatchObject({ status: 'accepted', delivery: 'replayed' })
    const introductionInput = {
      scope, command: { type: 'request-member-self-introduction', commandId: 'intro-1' }, operationId: 'intro-1', task,
      binding, definition, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1',
    }
    expect(await fleet.requestAgentLoopIntroductionV4(introductionInput)).toMatchObject({ status: 'accepted', delivery: 'executed' })
    expect(await fleet.requestAgentLoopIntroductionV4(introductionInput)).toMatchObject({ status: 'accepted', delivery: 'replayed' })
    notify?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-2', status: 'completed' }, text: 'Hello from the Agent.' })
    const turns = calls.filter(call => call.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect(turns[0]?.params).toMatchObject({ clientUserMessageId: 'send-1' })
    expect(turns[0]?.params).not.toHaveProperty('responsesapiClientMetadata')
    expect(turns[1]?.params).toMatchObject({ input: [], clientUserMessageId: 'intro-1' })
    expect(turns[1]?.params).not.toHaveProperty('responsesapiClientMetadata')
    expect(await fleet.readAgentLoopV4Lifecycle({ scope, task, binding, definition, afterSequence: 0 })).toMatchObject({
      status: 'accepted',
      events: [{ turnId: 'turn-2', type: 'turn.completed', introduction: {
        operationId: 'intro-1', participantId: 'participant-1', memberId: 'member-1', runId: 'run-1',
      } }],
    })
    expect(await fleet.cancelAgentLoopIntroductionV4({
      scope, command: { type: 'cancel-member-self-introduction', commandId: 'cancel-completed' }, operationId: 'cancel-completed', requestOperationId: 'intro-1',
      task, binding, definition, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1',
    })).toMatchObject({ status: 'conflict', code: 'introduction-completed' })
    expect(calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0)
    const failedIntroduction = {
      scope, command: { type: 'request-member-self-introduction', commandId: 'intro-failed' }, operationId: 'intro-failed', task,
      binding, definition, participantId: 'participant-2', memberId: 'member-2', runId: 'run-2',
    }
    expect(await fleet.requestAgentLoopIntroductionV4(failedIntroduction)).toMatchObject({ status: 'accepted', delivery: 'executed', turn: 'turn-3' })
    notify?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-3', status: 'failed' } })
    expect(await fleet.requestAgentLoopIntroductionV4(failedIntroduction)).toMatchObject({ status: 'accepted', delivery: 'replayed', introductionState: 'failed' })
    notify?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-3', status: 'completed' }, text: 'Late contradictory completion.' })
    expect(await fleet.requestAgentLoopIntroductionV4({
      ...failedIntroduction,
      command: { type: 'request-member-self-introduction', commandId: 'intro-retry' }, operationId: 'intro-retry',
    })).toMatchObject({ status: 'accepted', delivery: 'executed', turn: 'turn-4' })
    notify?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-4', status: 'completed' }, text: 'Retry succeeded.' })
    notify?.('turn/completed', { threadId: 'local-session', turn: { id: 'turn-4', status: 'failed' } })
    expect(await fleet.requestAgentLoopIntroductionV4({
      ...failedIntroduction,
      command: { type: 'request-member-self-introduction', commandId: 'intro-after-completed' }, operationId: 'intro-after-completed',
    })).toMatchObject({ status: 'conflict', code: 'introduction-conflict' })
    const rebound = await fleet.bindAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: 'bind-1', target: { mode: 'bind', task } },
      operationId: 'bind-1', task, definition,
    }) as { status: string; locator?: { binding: { bindingId: string; generation: number } } }
    expect(rebound).toMatchObject({ status: 'accepted', locator: { binding: { bindingId: binding.bindingId, generation: binding.generation + 1 } } })
    expect(await fleet.sendAgentLoopV4({ ...sendInput, operationId: 'send-stale', command: { type: 'send', commandId: 'send-stale' } })).toMatchObject({ status: 'unavailable', code: 'binding-closed' })
    expect(await fleet.readAgentLoopV4Lifecycle({ scope, task, binding, definition, afterSequence: 0 })).toMatchObject({ status: 'unavailable', code: 'binding-closed' })
    expect(JSON.stringify(authority.snapshotForTests())).not.toContain('private definition body')
    expect(JSON.stringify(authority.snapshotForTests())).not.toContain('private message')
    await fleet.close()
  })

  it('rejects cancellation when the introduction request belongs to another task and never interrupts it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-v4-cross-task-'))
    const authority = await AgentLoopAuthority.open(root, 'work')
    const calls: { method: string; params: unknown }[] = []
    let nextSession = 1
    const fleet = await ProviderFleet.create([localConfig(root)], {
      agentLoopAuthority: authority,
      startServer: async () => ({
        generation: 'local-generation-1',
        async request<Result>(method: string, params: unknown): Promise<Result> {
          calls.push({ method, params })
          if (method === 'thread/start') return { thread: { id: `session-${nextSession++}`, preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
          if (method === 'turn/start') return { turn: { id: 'introduction-turn-task-one' } } as Result
          if (method === 'turn/interrupt') return {} as Result
          throw new Error(`unexpected ${method}`)
        },
        async close() {},
      }),
    })
    const scope = { profileId: 'work', compositionGeneration: 'composition', ownerKey: 'owner' }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    const create = async (operationId: string) => await fleet.createAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: operationId }, operationId, definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace',
    }) as { status: string; locator: { task: string; binding: { bindingId: string; generation: number } } }
    const first = await create('create-one')
    const second = await create('create-two')
    expect(await fleet.requestAgentLoopIntroductionV4({
      scope, command: { type: 'request-member-self-introduction', commandId: 'intro-one' }, operationId: 'intro-one',
      task: first.locator.task, binding: first.locator.binding, definition,
      participantId: 'participant', memberId: 'member', runId: 'run',
    })).toMatchObject({ status: 'accepted' })
    expect(await fleet.cancelAgentLoopIntroductionV4({
      scope, command: { type: 'cancel-member-self-introduction', commandId: 'cancel-cross-task' }, operationId: 'cancel-cross-task', requestOperationId: 'intro-one',
      task: second.locator.task, binding: second.locator.binding, definition,
      participantId: 'participant', memberId: 'member', runId: 'run',
    })).toMatchObject({ status: 'conflict', code: 'introduction-conflict' })
    expect(calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0)
    expect(await fleet.cancelAgentLoopIntroductionV4({
      scope, command: { type: 'cancel-member-self-introduction', commandId: 'cancel-exact-task' }, operationId: 'cancel-exact-task', requestOperationId: 'intro-one',
      task: first.locator.task, binding: first.locator.binding, definition,
      participantId: 'participant', memberId: 'member', runId: 'run',
    })).toMatchObject({ status: 'accepted', delivery: 'executed' })
    expect(await fleet.cancelAgentLoopIntroductionV4({
      scope, command: { type: 'cancel-member-self-introduction', commandId: 'cancel-after-cancelled' }, operationId: 'cancel-after-cancelled', requestOperationId: 'intro-one',
      task: first.locator.task, binding: first.locator.binding, definition,
      participantId: 'participant', memberId: 'member', runId: 'run',
    })).toMatchObject({ status: 'conflict', code: 'introduction-cancelled' })
    expect(calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1)
    expect(await fleet.readAgentLoopV4Lifecycle({
      scope, task: first.locator.task, binding: first.locator.binding, definition, afterSequence: 0,
    })).toMatchObject({
      status: 'accepted',
      events: [expect.objectContaining({
        turnId: 'introduction-turn-task-one', type: 'turn.cancelled', cancellation: { operationId: 'cancel-exact-task' },
      })],
    })
    await fleet.close()
  })

  it('joins structural-exact concurrent durable commands and conflicts a changed in-flight payload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-v4-concurrent-'))
    const authority = await AgentLoopAuthority.open(root, 'work')
    let releaseTurn!: () => void
    let observeTurn!: () => void
    let turnStarted = new Promise<void>(resolve => { observeTurn = resolve })
    let turnGate = new Promise<void>(resolve => { releaseTurn = resolve })
    let turnExecutions = 0
    const fleet = await ProviderFleet.create([localConfig(root)], {
      agentLoopAuthority: authority,
      startServer: async () => ({
        generation: 'local-generation-1',
        async request<Result>(method: string): Promise<Result> {
          if (method === 'thread/start') return { thread: { id: 'session-one', preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
          if (method === 'turn/start') {
            turnExecutions += 1
            observeTurn()
            await turnGate
            return { turn: { id: `turn-${turnExecutions}` } } as Result
          }
          throw new Error(`unexpected ${method}`)
        },
        async close() {},
      }),
    })
    const scope = { profileId: 'work', compositionGeneration: 'composition', ownerKey: 'owner' }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    const created = await fleet.createAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: 'create' }, operationId: 'create', definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace',
    }) as { locator: { task: string; binding: { bindingId: string; generation: number } } }
    const send = (message: string) => fleet.sendAgentLoopV4({
      scope, command: { type: 'send', commandId: 'shared-send', content: [{ kind: 'text', text: message }] }, operationId: 'shared-send',
      task: created.locator.task, binding: created.locator.binding, definition, message,
    })
    const first = send('same payload')
    await turnStarted
    const replay = send('same payload')
    const conflict = await send('changed payload')
    releaseTurn()
    expect(await Promise.all([first, replay])).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'accepted', delivery: 'executed' }),
      expect.objectContaining({ status: 'accepted', delivery: 'replayed' }),
    ]))
    expect(conflict).toMatchObject({ status: 'conflict', code: 'operation-conflict' })
    expect(turnExecutions).toBe(1)

    turnStarted = new Promise<void>(resolve => { observeTurn = resolve })
    turnGate = new Promise<void>(resolve => { releaseTurn = resolve })
    const pending = fleet.sendAgentLoopV4({
      scope, command: { type: 'send', commandId: 'second-send', content: [{ kind: 'text', text: 'next' }] }, operationId: 'second-send',
      task: created.locator.task, binding: created.locator.binding, definition, message: 'next',
    })
    await turnStarted
    releaseTurn()
    await pending
    await fleet.close()
  })

  it('holds provider lifecycle behind the launcher durable causation fence until introduction commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-v4-causation-'))
    const authority = await AgentLoopAuthority.open(root, 'work')
    let notify: ((method: string, params: unknown) => void) | undefined
    let releaseIntroduction!: () => void
    let observedIntroduction!: () => void
    const introductionGate = new Promise<void>(resolve => { releaseIntroduction = resolve })
    const introductionObserved = new Promise<void>(resolve => { observedIntroduction = resolve })
    const fleet = await ProviderFleet.create([localConfig(root)], {
      agentLoopAuthority: authority,
      startServer: async () => ({
        generation: 'local-generation-1',
        async request<Result>(method: string, params: unknown): Promise<Result> {
          if (method === 'thread/start') return { thread: { id: 'session-causation', preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
          if (method === 'turn/start') {
            const input = (params as { input?: unknown[] }).input
            if (input?.length === 0) {
              notify?.('turn/completed', { threadId: 'session-causation', turn: { id: 'turn-introduction', status: 'completed' }, text: 'I help the team review changes.' })
              observedIntroduction()
              await introductionGate
              return { turn: { id: 'turn-introduction' } } as Result
            }
          }
          throw new Error(`unexpected ${method}`)
        },
        subscribeNotifications(listener) { notify = listener; return () => { notify = undefined } },
        async close() {},
      }),
    })
    const scope = { profileId: 'work', compositionGeneration: 'composition', ownerKey: 'owner' }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    const created = await fleet.createAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: 'create' }, operationId: 'create', definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace',
    }) as { locator: { task: string; binding: { bindingId: string; generation: number } } }
    const request = fleet.requestAgentLoopIntroductionV4({
      scope, command: { type: 'request-member-self-introduction', commandId: 'intro' }, operationId: 'intro',
      task: created.locator.task, binding: created.locator.binding, definition,
      participantId: 'participant', memberId: 'member', runId: 'run',
    })
    await introductionObserved
    expect(await fleet.readAgentLoopV4Lifecycle({
      scope, task: created.locator.task, binding: created.locator.binding, definition, afterSequence: 0,
    })).toMatchObject({ status: 'accepted', nextAfterSequence: 0, events: [] })
    releaseIntroduction()
    expect(await request).toMatchObject({ status: 'accepted', delivery: 'executed' })
    expect(await fleet.readAgentLoopV4Lifecycle({
      scope, task: created.locator.task, binding: created.locator.binding, definition, afterSequence: 0,
    })).toMatchObject({
      status: 'accepted',
      events: [expect.objectContaining({
        turnId: 'turn-introduction', type: 'turn.completed',
        introduction: { operationId: 'intro', participantId: 'participant', memberId: 'member', runId: 'run' },
      })],
    })
    await fleet.close()
  })

  it('drains in-flight generations before both replacement finalize and rollback authority cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-v4-replacement-drain-'))
    const authority = await AgentLoopAuthority.open(root, 'work')
    const gates: Array<{ entered: Promise<void>; enter(): void; release: Promise<void>; resolve(): void }> = []
    const gate = () => {
      let enter!: () => void; let resolve!: () => void
      const value = { entered: new Promise<void>(done => { enter = done }), enter: () => enter(), release: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
      gates.push(value)
      return value
    }
    let generation = 0
    const fleet = await ProviderFleet.create([localConfig(root)], {
      agentLoopAuthority: authority,
      startServer: async () => {
        generation += 1
        const currentGeneration = generation
        return {
          generation: `local-generation-${currentGeneration}`,
          async request<Result>(method: string): Promise<Result> {
            if (method === 'thread/start') {
              const pending = gates.shift()
              if (pending !== undefined) { pending.enter(); await pending.release }
              return { thread: { id: `session-${currentGeneration}`, preview: '', modelProvider: 'openai', createdAt: 1, updatedAt: 1, cwd: '/workspace', turns: [] } } as Result
            }
            throw new Error(`unexpected ${method}`)
          },
          async close() {},
        }
      },
    })
    const scope = { profileId: 'work', compositionGeneration: 'composition', ownerKey: 'owner' }
    const definition = { agentId: 'agent-1', revision: 'revision-1' }
    const firstGate = gate()
    const oldCreate = fleet.createAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: 'create-old' }, operationId: 'create-old', definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace',
    }) as Promise<{ status: string; locator: { task: string } }>
    await firstGate.entered
    const replacement = await fleet.reconfigure([localConfig(root)])
    const finalizing = replacement.finalize()
    firstGate.resolve()
    const oldCreated = await oldCreate
    await finalizing
    expect(oldCreated.status).toBe('accepted')
    expect(authority.resolveTask(scope, oldCreated.locator.task)?.state).toBe('closed')

    const nextReplacement = await fleet.reconfigure([localConfig(root)])
    const rollbackGate = gate()
    const replacementCreate = fleet.createAgentLoopV4({
      scope, command: { type: 'create-or-bind', commandId: 'create-rollback' }, operationId: 'create-rollback', definition,
      model: { providerId: 'codex-local', modelId: 'gpt-5' }, cwd: '/workspace',
    }) as Promise<{ status: string; locator: { task: string } }>
    await rollbackGate.entered
    const rollingBack = nextReplacement.rollback()
    rollbackGate.resolve()
    const rollbackCreated = await replacementCreate
    await rollingBack
    expect(rollbackCreated.status).toBe('accepted')
    expect(authority.resolveTask(scope, rollbackCreated.locator.task)?.state).toBe('closed')
    await fleet.close()
  })

  it('rewires lifecycle observation during reconfigure and fences the retired provider generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-fleet-'))
    const notifications: Array<((method: string, params: unknown) => void) | undefined> = []
    let ordinal = 0
    const fleet = await ProviderFleet.create([config(root, 'alpha')], {
      startServer: async provider => {
        ordinal += 1
        const base = server(provider.id, [])
        const index = ordinal - 1
        return {
          ...base,
          generation: `generation-alpha-${ordinal}`,
          subscribeNotifications(listener) { notifications[index] = listener; return () => { notifications[index] = undefined } },
        }
      },
    })
    const previousNotify = notifications[0]
    if (previousNotify === undefined) throw new Error('initial lifecycle source is unavailable')
    const replacement = await fleet.reconfigure([config(root, 'alpha')])
    const currentNotify = notifications[1]
    if (currentNotify === undefined) throw new Error('replacement lifecycle source is unavailable')
    const session = { providerId: 'alpha', remoteSessionId: 'shared-session' }
    previousNotify('turn/completed', { threadId: session.remoteSessionId, turnId: 'old-turn', text: 'must be fenced' })
    currentNotify('turn/completed', { threadId: session.remoteSessionId, turnId: 'new-turn', text: 'replacement reply' })
    expect(fleet.readLifecycle(session).events).toEqual([
      expect.objectContaining({ providerGeneration: 'generation-alpha-2', turnId: 'new-turn', output: [{ type: 'text', text: 'replacement reply' }] }),
    ])
    await replacement.finalize()
    await fleet.close()
  })
})
