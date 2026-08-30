import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import { CliProxyProviderAdapter } from '../packages/cli/src/providers/cli-proxy-adapter.js'
import type { CliProxyProviderConfig } from '../packages/cli/src/providers/contracts.js'

function config(codexHome: string): CliProxyProviderConfig {
  return {
    id: 'alpha', kind: 'cli-proxy-api', displayName: 'Alpha', baseUrl: 'https://alpha.test/v1', apiKeyEnv: 'ALPHA_KEY',
    codexExecutable: 'codex', codexHome, enabled: true, timeoutMs: 1_000,
  }
}

function thread(id: string) {
  return {
    id, preview: 'hello', modelProvider: 'alpha', createdAt: 1, updatedAt: 2, cwd: '/workspace', name: null,
    turns: [{
      id: 'turn-active', status: 'inProgress', items: [
        { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello', text_elements: [] }] },
        { type: 'agentMessage', id: 'agent-1', text: 'world' },
      ],
    }],
  }
}

function rpc(calls: { method: string; params: unknown }[], generation = 'generation-1'): CodexAppServerRpc {
  return {
    generation,
    async request<Result>(method: string, params: unknown): Promise<Result> {
      calls.push({ method, params })
      if (method === 'model/list') return { data: [{ model: 'shared-model', displayName: 'Shared', hidden: false, isDefault: true, inputModalities: ['text'] }], nextCursor: null } as Result
      if (method === 'thread/start') return { thread: thread('session-1'), model: 'shared-model', modelProvider: 'alpha' } as Result
      if (method === 'thread/list') return { data: [thread('session-1')], nextCursor: null } as Result
      if (method === 'thread/read') return { thread: thread((params as { threadId: string }).threadId) } as Result
      if (method === 'thread/resume') return { thread: thread('session-1'), model: 'shared-model' } as Result
      if (method === 'thread/fork') return { thread: thread('session-fork'), model: 'shared-model' } as Result
      if (method === 'thread/unarchive') return { thread: thread('session-1') } as Result
      if (method === 'thread/archive' || method === 'thread/delete' || method === 'turn/interrupt') return {} as Result
      if (method === 'turn/start') return { turn: { id: 'turn-started', status: 'inProgress', items: [] } } as Result
      if (method === 'turn/steer') return { turnId: 'turn-active' } as Result
      throw new Error(`unexpected method ${method}`)
    },
    async close() {},
  }
}

describe('CLIProxy provider adapter', () => {
  it('maps stable App Server lifecycle operations without losing provider identity', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-'))
    const calls: { method: string; params: unknown }[] = []
    const adapter = new CliProxyProviderAdapter(config(codexHome), rpc(calls))
    const models = await adapter.listModels()
    expect(models.ok && models.value[0]).toMatchObject({ ref: { providerId: 'alpha', modelId: 'shared-model' } })
    const created = await adapter.createSession({ model: { providerId: 'alpha', modelId: 'shared-model' }, cwd: '/workspace' })
    expect(created.ok && created.value).toMatchObject({
      ref: { providerId: 'alpha', remoteSessionId: 'session-1' }, model: { providerId: 'alpha', modelId: 'shared-model' },
    })
    const listed = await adapter.listSessions({ limit: 10 })
    expect(listed.ok && listed.value.sessions[0]?.model).toEqual({ providerId: 'alpha', modelId: 'shared-model' })
    const read = await adapter.readSession({ providerId: 'alpha', remoteSessionId: 'session-1' })
    expect(read.ok && read.value.turns[0]).toMatchObject({ id: 'turn-active', state: 'in-progress' })
    expect(read.ok && read.value.turns[0]?.items.map(item => [item.kind, item.text])).toEqual([
      ['user-message', 'hello'], ['assistant-message', 'world'],
    ])
    await expect(adapter.controlSession({ action: 'continue', session: { providerId: 'alpha', remoteSessionId: 'session-1' } }))
      .resolves.toMatchObject({ ok: true, value: { action: 'continue' } })
    await expect(adapter.controlSession({ action: 'fork', session: { providerId: 'alpha', remoteSessionId: 'session-1' } }))
      .resolves.toMatchObject({ ok: true, value: { action: 'fork', session: { ref: { remoteSessionId: 'session-fork' } } } })
    await expect(adapter.controlSession({ action: 'archive', session: { providerId: 'alpha', remoteSessionId: 'session-1' } }))
      .resolves.toMatchObject({ ok: true, value: { session: { state: 'archived' } } })
    await expect(adapter.controlSession({ action: 'restore', session: { providerId: 'alpha', remoteSessionId: 'session-1' } }))
      .resolves.toMatchObject({ ok: true, value: { session: { state: 'active' } } })
    await expect(adapter.submitTurn({ session: { providerId: 'alpha', remoteSessionId: 'session-1' }, message: 'next' }))
      .resolves.toMatchObject({ ok: true, value: { turnId: 'turn-started' } })
    await expect(adapter.controlTurn({ action: 'steer', session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn-active', message: 'adjust' }))
      .resolves.toMatchObject({ ok: true, value: { action: 'steer', turnId: 'turn-active' } })
    await expect(adapter.controlTurn({ action: 'interrupt', session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn-active' }))
      .resolves.toMatchObject({ ok: true, value: { action: 'interrupt', turnId: 'turn-active' } })
    await expect(adapter.controlSession({ action: 'delete', session: { providerId: 'alpha', remoteSessionId: 'session-1' } }))
      .resolves.toMatchObject({ ok: true, value: { action: 'delete', deleted: true } })
    expect(calls.map(call => call.method)).toEqual(expect.arrayContaining([
      'thread/start', 'thread/list', 'thread/read', 'thread/resume', 'thread/fork', 'thread/archive', 'thread/unarchive',
      'turn/start', 'turn/steer', 'turn/interrupt', 'thread/delete',
    ]))
    const wrongProvider = await adapter.readSession({ providerId: 'beta', remoteSessionId: 'session-1' })
    expect(wrongProvider).toMatchObject({ ok: false, error: { code: 'invalid-provider' } })
    await adapter.close()
  })

  it('reloads host-owned session model metadata across adapter generations', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-'))
    const first = new CliProxyProviderAdapter(config(codexHome), rpc([], 'generation-1'))
    await first.createSession({ model: { providerId: 'alpha', modelId: 'shared-model' }, cwd: '/workspace' })
    await first.close()
    const second = new CliProxyProviderAdapter(config(codexHome), rpc([], 'generation-2'))
    const page = await second.listSessions({})
    expect(page.ok && page.value.sessions[0]?.model).toEqual({ providerId: 'alpha', modelId: 'shared-model' })
    await second.close()
  })

  it('maps public model ids to one provider-local source id without changing provider identity', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-'))
    const calls: { method: string; params: unknown }[] = []
    const mapped: CliProxyProviderConfig = {
      ...config(codexHome),
      modelMappings: [{
        sourceModelId: 'shared-model', modelId: 'coder', displayName: 'Coder', enabled: true, isDefault: true,
      }],
    }
    const adapter = new CliProxyProviderAdapter(mapped, rpc(calls))
    const models = await adapter.listModels()
    expect(models.ok && models.value[0]).toMatchObject({
      ref: { providerId: 'alpha', modelId: 'coder' }, label: 'Coder', isDefault: true,
    })
    const created = await adapter.createSession({ model: { providerId: 'alpha', modelId: 'coder' }, cwd: '/workspace' })
    expect(created.ok && created.value.model).toEqual({ providerId: 'alpha', modelId: 'coder' })
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
      modelProvider: 'alpha', model: 'shared-model',
    })
    await adapter.close()
  })

  it('forwards only resolved Agent definition instructions and effort into task creation', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-'))
    const calls: { method: string; params: unknown }[] = []
    const adapter = new CliProxyProviderAdapter(config(codexHome), rpc(calls))
    const created = await adapter.createSession({
      model: { providerId: 'alpha', modelId: 'shared-model' }, cwd: '/workspace',
      developerInstructions: '## introduction\n\nInternal assistant', effort: 'high',
    })
    expect(created.ok).toBe(true)
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
      cwd: '/workspace', developerInstructions: '## introduction\n\nInternal assistant', effort: 'high',
    })
    await adapter.close()
  })
})
