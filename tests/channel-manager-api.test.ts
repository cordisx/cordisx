import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChannelRuntime,
  type ChannelAdapterDefinition,
  type ChannelInboundEnvelope,
  type ChannelPluginIdentity,
  type ChannelTenantRef,
} from '@cordisx/channel-runtime'
import { createChannelManagerApi } from '../packages/cli/src/launcher/channel-manager-api.js'

const temporary = new Set<string>()
const identity: ChannelPluginIdentity = Object.freeze({
  source: 'file:///launcher-private-source', pluginId: 'channel', generation: 'plugin-generation',
})
const ref: ChannelTenantRef = Object.freeze({ adapterId: 'simulator', accountId: 'local', tenantId: 'test' })

afterEach(async () => {
  await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true })))
  temporary.clear()
})

function adapter(account: ChannelTenantRef, revision: number): ChannelAdapterDefinition {
  return {
    descriptor: {
      ref: account, kind: 'simulator', implementationStatus: 'verified',
      configurationRevision: revision, secretState: 'unavailable',
    },
    start: async () => ({
      send: async () => ({ externalMessageId: 'unused' }),
      stop: async () => undefined,
    }),
  }
}

function createEnvelope(eventId: string): ChannelInboundEnvelope {
  return {
    routeId: 'default',
    operation: { kind: 'create', workspace: { alias: 'workspace' } },
    input: {
      contract: 'cordisx.channel-user-input/v1', schemaVersion: 1, role: 'user',
      content: [{ type: 'text', text: 'Create this task.' }],
      source: { kind: 'channel', event: {
        ...ref, conversationId: 'conversation', kind: 'direct', threadId: 'thread', semantics: 'conversation',
        eventId, actor: { ...ref, userId: 'user' },
      } },
      receivedAt: '2026-08-25T00:00:00.000Z',
    },
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-manager-api-'))
  temporary.add(root)
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'runtime.json'),
    permissions: { authorize: async () => 'allow' },
    gateway: { execute: async operation => operation.kind === 'create'
      ? { session: { providerId: 'codex', remoteSessionId: 'session-1' } }
      : {} },
  })
  const handle = await runtime.activate(adapter(ref, 1), identity)
  await runtime.activate(adapter({ adapterId: 'simulator', accountId: 'other', tenantId: 'test' }, 1), identity)
  await handle.receive(createEnvelope('create-1'))
  await handle.drainInbound()
  const current = { generation: 'local-generation-1', runtime }
  const api = createChannelManagerApi({
    active: () => current,
    connection: async () => 'not-found',
  })
  return { api, runtime }
}

describe('launcher-private Channel manager API', () => {
  it('returns redacted, filterable and paged audit logs with a JSON export payload', async () => {
    const { api, runtime } = await fixture()
    const page = api.logs({ action: 'channel.adapter.activate', outcome: 'ready', limit: 1 })
    expect(page).toMatchObject({ total: 2, offset: 0, limit: 1, hasMore: true })
    expect(page.records[0]).toEqual(expect.objectContaining({ action: 'channel.adapter.activate', outcome: 'ready' }))
    expect(JSON.stringify(page.records)).not.toContain('launcher-private-source')
    expect(JSON.stringify(page.records)).not.toContain('plugin-generation')
    const exported = api.exportLogs({ action: 'channel.adapter.activate' })
    expect(exported.filename).toMatch(/^cordisx-channel-logs-.*\.json$/)
    const payload = JSON.parse(exported.payload)
    expect(payload).toMatchObject({ contract: 'cordisx.channel-manager-logs-export/v1', schemaVersion: 1 })
    expect(payload.records).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'channel.adapter.activate' })]))
    expect(exported.payload).not.toContain('launcher-private-source')
    await runtime.dispose()
  })

  it('archives, restores, and unbinds durable bindings while returning refreshed projections', async () => {
    const { api, runtime } = await fixture()
    const bindingId = api.snapshot()!.bindings[0]!.bindingId
    const archived = await api.bindings.archive({ bindingId, generation: 'local-generation-1' })
    expect(archived).toMatchObject({ status: 'applied', projection: { bindings: [expect.objectContaining({ state: 'archived' })] } })
    expect(api.logs({ action: 'channel.binding.archive' }).records).toEqual([
      expect.objectContaining({ bindingRevision: 1, outcome: 'applied' }),
    ])
    const restored = await api.bindings.restore({ bindingId, generation: archived.generation })
    expect(restored).toMatchObject({ status: 'applied', projection: { bindings: [expect.objectContaining({ state: 'active' })] } })
    const unbound = await api.bindings.unbind({ bindingId, generation: restored.generation })
    expect(unbound).toMatchObject({ status: 'applied', projection: { bindings: [] } })
    await expect(api.bindings.archive({ bindingId, generation: unbound.generation })).resolves.toMatchObject({ status: 'not-found' })
    await expect(api.bindings.restore({ bindingId, generation: 'stale-generation' })).resolves.toMatchObject({ status: 'unavailable' })
    await runtime.dispose()
  })
})
