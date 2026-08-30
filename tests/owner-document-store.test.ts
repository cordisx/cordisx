import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CORDISX_OWNER_DOCUMENT_SERVICE_V1 } from '../packages/cli/src/durable-document-contracts.js'
import {
  OWNER_DOCUMENT_MAX_DOCUMENT_BYTES,
  OwnerDocumentStore,
  type OwnerDocumentStoreScope,
} from '../packages/cli/src/launcher/owner-document-store.js'

const roots: string[] = []
const scope: OwnerDocumentStoreScope = {
  profileId: 'work',
  identity: { source: 'https://plugins.example/chatroom', pluginId: 'chatroom' },
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owner-documents-'))
  roots.push(value)
  return value
}

async function storedFile(home: string): Promise<string> {
  const top = path.join(home, 'state', 'owner-documents', 'v1')
  const buckets = await readdir(top)
  const files = await readdir(path.join(top, buckets[0]!))
  return path.join(top, buckets[0]!, files[0]!)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(item => rm(item, { recursive: true, force: true })))
})

describe('OwnerDocumentStore', () => {
  it('persists an outbox operation across Host restart and enforces atomic CAS', async () => {
    const home = await root()
    const first = new OwnerDocumentStore(home)
    const payload = {
      deliveryId: 'delivery-1',
      operationId: 'send-operation-1',
      issuedAt: 1_786_000_000_000,
      exactPayload: { text: 'hello', memberId: 'lead' },
      state: 'planned',
    } as const
    const accepted = await first.replace({ scope, documentId: 'room-registry', expectedRevision: 0, schemaVersion: 3, value: payload })
    expect(accepted).toEqual({
      status: 'accepted',
      snapshot: { contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1, revision: 1, schemaVersion: 3, value: payload },
    })

    const cold = new OwnerDocumentStore(home)
    await expect(cold.load(scope, 'room-registry')).resolves.toEqual({ status: 'loaded', snapshot: (accepted as { snapshot: unknown }).snapshot })
    const [winner, loser] = await Promise.all([
      cold.replace({ scope, documentId: 'room-registry', expectedRevision: 1, schemaVersion: 3, value: { ...payload, state: 'sending-unknown' } }),
      cold.replace({ scope, documentId: 'room-registry', expectedRevision: 1, schemaVersion: 3, value: { ...payload, state: 'committed' } }),
    ])
    expect([winner.status, loser.status].sort()).toEqual(['accepted', 'conflict'])
    expect([winner, loser].find(result => result.status === 'conflict')).toEqual({ status: 'conflict', actualRevision: 2 })
  })

  it('isolates profile, source, and plugin id while ignoring runtime/module generations by construction', async () => {
    const store = new OwnerDocumentStore(await root())
    await store.replace({ scope, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { owner: 'chatroom' } })
    await expect(store.load({ ...scope, profileId: 'other' }, 'rooms')).resolves.toEqual({ status: 'missing', revision: 0 })
    await expect(store.load({ ...scope, identity: { ...scope.identity, source: 'https://plugins.example/replacement' } }, 'rooms')).resolves.toEqual({ status: 'missing', revision: 0 })
    await expect(store.load({ ...scope, identity: { ...scope.identity, pluginId: 'other' } }, 'rooms')).resolves.toEqual({ status: 'missing', revision: 0 })
    await expect(store.load(scope, 'rooms')).resolves.toMatchObject({ status: 'loaded', snapshot: { value: { owner: 'chatroom' } } })
  })

  it('fails closed on corruption without overwriting recoverable bytes', async () => {
    const home = await root()
    const store = new OwnerDocumentStore(home)
    await store.replace({ scope, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { ok: true } })
    const file = await storedFile(home)
    const corrupt = '{"contract":"cordisx.owner-documents/v1","documents":'
    await writeFile(file, corrupt)
    await expect(store.load(scope, 'rooms')).resolves.toEqual({
      status: 'unavailable', code: 'corrupt-store', diagnostic: 'owner document store is corrupt', recoverable: true,
    })
    await expect(store.replace({ scope, documentId: 'rooms', expectedRevision: 1, schemaVersion: 2, value: { migrated: true } }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'corrupt-store', recoverable: true })
    await expect(readFile(file, 'utf8')).resolves.toBe(corrupt)
  })

  it('preserves unsupported Host envelopes and leaves consumer migration entirely CAS-owned', async () => {
    const home = await root()
    const store = new OwnerDocumentStore(home)
    await store.replace({ scope, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { legacy: true } })
    const legacy = await store.load(scope, 'rooms')
    expect(legacy).toMatchObject({ status: 'loaded', snapshot: { revision: 1, schemaVersion: 1, value: { legacy: true } } })
    // A failed consumer migration performs no replacement and cannot erase the source snapshot.
    await expect(new OwnerDocumentStore(home).load(scope, 'rooms')).resolves.toEqual(legacy)
    await expect(store.replace({ scope, documentId: 'rooms', expectedRevision: 1, schemaVersion: 2, value: { migrated: true } }))
      .resolves.toMatchObject({ status: 'accepted', snapshot: { revision: 2, schemaVersion: 2 } })

    const file = await storedFile(home)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const unsupported = `${JSON.stringify({ ...parsed, storeSchemaVersion: 2 })}\n`
    await writeFile(file, unsupported)
    await expect(store.load(scope, 'rooms')).resolves.toEqual({
      status: 'unavailable', code: 'unsupported-store-schema', diagnostic: 'store schema is unsupported', recoverable: true,
    })
    await expect(store.replace({ scope, documentId: 'rooms', expectedRevision: 2, schemaVersion: 3, value: { no: 'overwrite' } }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'unsupported-store-schema', recoverable: true })
    await expect(readFile(file, 'utf8')).resolves.toBe(unsupported)
  })

  it('returns typed quota and invalid JSON errors without writing', async () => {
    const home = await root()
    const store = new OwnerDocumentStore(home)
    const oversized = 'x'.repeat(OWNER_DOCUMENT_MAX_DOCUMENT_BYTES + 1)
    await expect(store.replace({ scope, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: oversized }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'quota-exceeded', recoverable: false })
    await expect(store.replace({ scope, documentId: 'rooms', expectedRevision: 0, schemaVersion: 1, value: { invalid: Number.NaN } }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'invalid-request', recoverable: false })
    await expect(store.load(scope, 'rooms')).resolves.toEqual({ status: 'missing', revision: 0 })
  })
})
