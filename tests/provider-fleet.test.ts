import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodexAppServerRpc } from '../packages/cli/src/providers/codex-app-server.js'
import type { CliProxyProviderConfig } from '../packages/cli/src/providers/contracts.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

function config(root: string, id: string): CliProxyProviderConfig {
  return {
    id, kind: 'cli-proxy-api', displayName: id.toUpperCase(), baseUrl: `https://${id}.test/v1`, apiKeyEnv: `${id.toUpperCase()}_KEY`,
    codexExecutable: 'codex', codexHome: path.join(root, id), enabled: true, timeoutMs: 1_000,
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
})
