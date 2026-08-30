import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CORDISX_OWNER_DOCUMENT_SERVICE_V1 } from '../packages/cli/src/durable-document-contracts.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { createOwnerDocumentBridgeHandler, parseOwnerDocumentBindingRequest } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { BrowserOwnerDocumentBridge, CordisXOwnerDocumentBroker } from '../packages/cli/src/renderer/owner-documents.js'

const roots: string[] = []
const identity = { source: 'https://plugins.example/chatroom', id: 'chatroom' }

async function setup(generation = 'runtime-1') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owner-document-runtime-'))
  roots.push(home)
  const token = 'd'.repeat(64)
  const store = new OwnerDocumentStore(home)
  const handler = createOwnerDocumentBridgeHandler({
    token, profileId: 'work', generation, store,
    identityAllowed: candidate => candidate.source === identity.source && candidate.pluginId === identity.id,
  })
  globalThis.__cordisxOwnerDocumentRequestV1 = payload => {
    void (async () => {
      const request = parseOwnerDocumentBindingRequest(JSON.parse(payload), token, 'work', generation)
      const value = request.operation === 'load' ? await handler.load(request) : await handler.replace(request)
      globalThis.__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
    })()
  }
  const bridge = new BrowserOwnerDocumentBridge(token, 'work', generation)
  const broker = new CordisXOwnerDocumentBroker(bridge)
  return { home, store, broker }
}

afterEach(async () => {
  delete globalThis.__cordisxOwnerDocumentRequestV1
  delete globalThis.__cordisxOwnerDocumentReceiveV1
  await Promise.all(roots.splice(0).map(item => rm(item, { recursive: true, force: true })))
})

describe('owner document renderer client', () => {
  it('rejects spoofed bridge scope and stale owner identity before storage access', async () => {
    const { store, broker } = await setup('runtime-fence')
    const raw = {
      version: 1, requestId: 'load-fence', token: 'd'.repeat(64), operation: 'load',
      identity: { source: identity.source, pluginId: identity.id },
      scope: { profileId: 'work', generation: 'runtime-fence' }, documentId: 'rooms',
    }
    expect(() => parseOwnerDocumentBindingRequest({ ...raw, scope: { ...raw.scope, profileId: 'other' } }, raw.token, 'work', 'runtime-fence'))
      .toThrow('profile is stale or spoofed')
    expect(() => parseOwnerDocumentBindingRequest({ ...raw, scope: { ...raw.scope, generation: 'old' } }, raw.token, 'work', 'runtime-fence'))
      .toThrow('generation is stale or spoofed')
    const rejected = createOwnerDocumentBridgeHandler({
      token: raw.token, profileId: 'work', generation: 'runtime-fence', store,
      identityAllowed: () => false,
    })
    const parsed = parseOwnerDocumentBindingRequest(raw, raw.token, 'work', 'runtime-fence')
    await expect(rejected.load(parsed)).resolves.toEqual({
      status: 'unavailable', code: 'stale-generation', diagnostic: 'plugin owner is stale', recoverable: true,
    })
    broker.dispose()
  })

  it('binds owner identity, deep-freezes snapshots, and replaces through one CAS transaction shape', async () => {
    const { broker } = await setup()
    const client = broker.bind({ identity, active: () => true })
    const accepted = await client.transaction({
      contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
      documentId: 'rooms', expectedRevision: 0, schemaVersion: 2,
      value: { rooms: [{ id: 'room-1' }] },
    })
    expect(accepted).toMatchObject({ status: 'accepted', snapshot: { revision: 1, schemaVersion: 2 } })
    const loaded = await client.load('rooms')
    expect(loaded).toEqual({ status: 'loaded', snapshot: (accepted as { snapshot: unknown }).snapshot })
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(loaded.status === 'loaded' && Object.isFrozen(loaded.snapshot.value)).toBe(true)
    broker.dispose()
  })

  it('propagates authoritative revisions across fibers and fences unsubscribe/dispose with zero late delivery', async () => {
    const { store, broker } = await setup()
    const first = broker.bind({ identity, active: () => true })
    let secondLive = true
    const second = broker.bind({ identity, active: () => secondLive })
    const seen: string[] = []
    const unsubscribe = second.subscribe('rooms', result => seen.push(result.status === 'loaded' ? `loaded:${result.snapshot.revision}` : result.status))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toEqual(['missing'])
    await store.replace({
      scope: { profileId: 'work', identity: { source: identity.source, pluginId: identity.id } },
      documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { roomId: 'one' },
    })
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(seen).toEqual(['missing', 'loaded:1'])
    unsubscribe()
    await first.replace({
      contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
      documentId: 'rooms', expectedRevision: 1, schemaVersion: 1, value: { roomId: 'two' },
    })
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(seen).toEqual(['missing', 'loaded:1'])
    secondLive = false
    await expect(second.load('rooms')).resolves.toMatchObject({ status: 'unavailable', code: 'stale-generation' })
    broker.dispose()
  })

  it('returns typed unavailable when the launcher bridge is absent', async () => {
    const broker = new CordisXOwnerDocumentBroker()
    const client = broker.bind({ identity, active: () => true })
    await expect(client.load('rooms')).resolves.toMatchObject({ status: 'unavailable', code: 'bridge-unavailable' })
    broker.dispose()
  })

  it('keeps a slow subscription single-flight and cancels its pending request without late delivery', async () => {
    let requests = 0
    globalThis.__cordisxOwnerDocumentRequestV1 = () => { requests += 1 }
    const broker = new CordisXOwnerDocumentBroker(new BrowserOwnerDocumentBridge('slow-token', 'work', 'slow-generation'))
    const client = broker.bind({ identity, active: () => true })
    const seen: unknown[] = []
    const unsubscribe = client.subscribe('rooms', result => seen.push(result))
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(requests).toBe(1)
    unsubscribe()
    broker.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toEqual([])
  })
})
