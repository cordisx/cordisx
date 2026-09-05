import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ChannelAdapterDefinition,
  type ChannelInboundEnvelope,
  type ChannelPluginIdentity,
  ChannelRuntime,
  type ChannelTenantRef,
} from '@cordisx/channel-runtime'
import { createChannelManagerApi } from '../packages/cli/src/launcher/channel-manager-api.js'

const temporary = new Set<string>()
const identity: ChannelPluginIdentity = Object.freeze({
  source: 'file:///launcher-private-source',
  pluginId: 'channel',
  generation: 'plugin-generation',
})
const ref: ChannelTenantRef = Object.freeze({ adapterId: 'simulator', accountId: 'local', tenantId: 'test' })

afterEach(async () => {
  await Promise.all([...temporary].map(async root => await rm(root, { recursive: true, force: true })))
  temporary.clear()
})

function adapter(account: ChannelTenantRef, revision: number): ChannelAdapterDefinition {
  return {
    descriptor: {
      ref: account,
      kind: 'simulator',
      implementationStatus: 'verified',
      configurationRevision: revision,
      secretState: 'unavailable',
    },
    start: async () => ({
      send: async () => ({ externalMessageId: 'unused' }),
      stop: async () => undefined,
    }),
  }
}

function createEnvelope(eventId: string): ChannelInboundEnvelope {
  return {
    input: {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: 'Create this task.' }],
      source: {
        kind: 'channel',
        event: {
          ...ref,
          conversationId: 'conversation',
          kind: 'direct',
          threadId: 'thread',
          semantics: 'conversation',
          eventId,
          actor: { ...ref, userId: 'user' },
        },
      },
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
    expect(payload.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'channel.adapter.activate' })]),
    )
    expect(exported.payload).not.toContain('launcher-private-source')
    await runtime.dispose()
  })

  it('does not expose task bindings from the connection-only Channel core', async () => {
    const { api, runtime } = await fixture()
    expect(api.snapshot()!.bindings).toEqual([])
    await expect(api.bindings.archive({ bindingId: 'consumer-owned', generation: 'local-generation-1' }))
      .resolves.toMatchObject({ status: 'unavailable', projection: { bindings: [] } })
    await expect(api.bindings.restore({ bindingId: 'consumer-owned', generation: 'stale-generation' }))
      .resolves.toMatchObject({ status: 'unavailable' })
    await runtime.dispose()
  })
})
