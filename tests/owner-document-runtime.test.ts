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
const other = { source: 'https://plugins.example/other', id: 'other' }

async function setup(generation = 'runtime-1') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owner-document-runtime-')); roots.push(home)
  const secret = 'd'.repeat(64); const store = new OwnerDocumentStore(home)
  let live = true
  const handler = createOwnerDocumentBridgeHandler({
    secret, profileId: 'work', generation, store,
    identityAllowed: candidate => live && ((candidate.source === identity.source && candidate.pluginId === identity.id) || (candidate.source === other.source && candidate.pluginId === other.id)),
  })
  globalThis.__cordisxOwnerDocumentRequestV1 = payload => {
    void (async () => {
      const request = parseOwnerDocumentBindingRequest(JSON.parse(payload))
      const value = request.operation === 'load' ? await handler.load(request) : await handler.replace(request)
      globalThis.__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
    })()
  }
  const bridge = new BrowserOwnerDocumentBridge()
  const broker = new CordisXOwnerDocumentBroker(bridge, [handler.issue({ source: identity.source, pluginId: identity.id }), handler.issue({ source: other.source, pluginId: other.id })])
  return { home, store, broker, handler, retire: () => { live = false } }
}

afterEach(async () => {
  delete globalThis.__cordisxOwnerDocumentRequestV1; delete globalThis.__cordisxOwnerDocumentReceiveV1
  await Promise.all(roots.splice(0).map(item => rm(item, { recursive: true, force: true })))
})

describe('owner document renderer client', () => {
  it('binds a narrow principal token and wire callers cannot choose owner identity or scope', async () => {
    const { broker } = await setup('runtime-fence')
    const client = broker.bind({ identity, active: () => true })
    expect(Object.keys(client)).toEqual([])
    expect(JSON.stringify(client)).toBe('{}')
    expect(() => parseOwnerDocumentBindingRequest({
      version: 1, requestId: 'spoof', token: 'x'.repeat(64), operation: 'load', documentId: 'rooms',
      identity: { source: other.source, pluginId: other.id },
    })).toThrow('identity is not supported')
    const accepted = await client.replace({ contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { owner: 'chatroom' } })
    expect(accepted.status).toBe('accepted')
    const otherClient = broker.bind({ identity: other, active: () => true })
    await expect(otherClient.load('rooms')).resolves.toEqual({ status: 'missing', revision: 0 })
    broker.dispose()
  })

  it('deep-freezes snapshots and preserves accepted after renderer retirement races the response', async () => {
    const { broker } = await setup()
    let active = true
    const client = broker.bind({ identity, active: () => active })
    const pending = client.transaction({ contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1, documentId: 'rooms', expectedRevision: 0, schemaVersion: 2, value: { rooms: [{ id: 'room-1' }] } })
    // Authority already owns linearization; renderer activity after dispatch
    // cannot turn a committed result into stale.
    await Promise.resolve(); active = false
    const accepted = await pending
    expect(accepted).toMatchObject({ status: 'accepted', snapshot: { revision: 1 } })
    expect(Object.isFrozen(accepted)).toBe(true)
    broker.dispose()
  })

  it('shares one polling watch per document and fences unsubscribe/dispose with zero late delivery', async () => {
    const { store, broker } = await setup()
    const client = broker.bind({ identity, active: () => true })
    const first: string[] = []; const second: string[] = []
    const a = client.subscribe('rooms', result => first.push(result.status)); const b = client.subscribe('rooms', result => second.push(result.status))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(first).toEqual(['missing']); expect(second).toEqual(['missing'])
    await store.replace({ scope: { profileId: 'work', identity: { source: identity.source, pluginId: identity.id } }, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { roomId: 'one' } })
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(first).toEqual(['missing', 'loaded']); expect(second).toEqual(['missing', 'loaded'])
    a(); b(); broker.dispose()
    await new Promise(resolve => setTimeout(resolve, 280))
    expect(first).toHaveLength(2); expect(second).toHaveLength(2)
  })

  it('returns typed unavailable when bridge or principal binding is absent', async () => {
    const broker = new CordisXOwnerDocumentBroker()
    const client = broker.bind({ identity, active: () => true })
    await expect(client.load('rooms')).resolves.toMatchObject({ status: 'unavailable', code: 'bridge-unavailable' })
    broker.dispose()
  })

  it('keeps a slow shared watch single-flight', async () => {
    let requests = 0
    globalThis.__cordisxOwnerDocumentRequestV1 = () => { requests += 1 }
    const bridge = new BrowserOwnerDocumentBridge()
    const broker = new CordisXOwnerDocumentBroker(bridge, [{ source: identity.source, pluginId: identity.id, token: 'slow-token'.repeat(8) }])
    const firstClient = broker.bind({ identity, active: () => true })
    const secondClient = broker.bind({ identity, active: () => true })
    const a = firstClient.subscribe('rooms', () => undefined); const b = secondClient.subscribe('rooms', () => undefined)
    await new Promise(resolve => setTimeout(resolve, 700)); expect(requests).toBe(1)
    a(); b(); broker.dispose()
  })
})
