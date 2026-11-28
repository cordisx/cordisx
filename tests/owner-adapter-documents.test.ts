import { mkdtemp, rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { CordisXConfigPlugin } from '../packages/cli/src/launcher/config.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { createOwnerAdapterDocuments } from '../packages/cli/src/cli/owner-adapter-documents.js'

const identity = { source: 'https://example.test/plugin', pluginId: 'fixture' }
const active = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1 as const,
  recordKind: 'active' as const,
  profileId: 'default',
  runtimeGeneration: 'owner-1',
  revision: 0,
  lastGoodRevision: 0,
  plugins: [],
}
const configured = [{
  id: identity.pluginId,
  source: identity.source,
  entry: '/fixture.js',
  enabled: true,
}] as CordisXConfigPlugin[]
const token = (secret: string, source = identity.source) =>
  issueOwnerDocumentPrincipalToken(secret, {
    profileId: 'default',
    generation: 'owner-1',
    moduleGeneration: 'module-1',
    identity: { pluginId: identity.pluginId, source },
  })

it('shares documents through the owner while rejecting another principal or session secret', async () => {
  const root = await mkdtemp('/tmp/cx-adapter-document-')
  const firstSecret = 'a'.repeat(64)
  const secondSecret = 'b'.repeat(64)
  const handler = createOwnerAdapterDocuments({
    homeDir: root,
    profileId: 'default',
    generation: 'owner-1',
    configured,
    snapshot: () => ({ active, registryEpoch: 0 }),
  })
  const first = { secret: firstSecret, current: () => true }
  const second = { secret: secondSecret, current: () => true }
  const replace = {
    version: 1,
    requestId: 'write',
    token: token(firstSecret),
    operation: 'replace',
    documentId: 'state',
    expectedRevision: 0,
    schemaVersion: 1,
    value: { example: 42 },
  }
  const load = { version: 1, requestId: 'read', token: token(secondSecret), operation: 'load', documentId: 'state' }
  try {
    await expect(handler(replace, first)).resolves.toMatchObject({ status: 'accepted', snapshot: { revision: 1 } })
    await expect(handler(load, second)).resolves.toMatchObject({
      status: 'loaded',
      snapshot: { revision: 1, value: { example: 42 } },
    })
    await expect(handler({ ...load, token: token(firstSecret) }, second)).resolves.toMatchObject({
      status: 'unavailable',
    })
    await expect(handler({ ...load, token: token(secondSecret, 'https://example.test/other') }, second))
      .resolves.toMatchObject({ status: 'unavailable' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rechecks the owner at the document commit point', async () => {
  const root = await mkdtemp('/tmp/cx-adapter-document-')
  let current = true
  const secret = 'c'.repeat(64)
  const store = new OwnerDocumentStore(root, { beforeCommit: () => current = false })
  const handler = createOwnerAdapterDocuments({
    homeDir: root,
    profileId: 'default',
    generation: 'owner-1',
    configured,
    store,
    snapshot: () => ({ active, registryEpoch: 0 }),
  })
  try {
    await expect(handler({
      version: 1,
      requestId: 'write',
      token: token(secret),
      operation: 'replace',
      documentId: 'state',
      expectedRevision: 0,
      schemaVersion: 1,
      value: { example: 42 },
    }, { secret, current: () => current })).resolves.toMatchObject({ status: 'unavailable', code: 'stale-generation' })
    current = true
    await expect(handler({
      version: 1,
      requestId: 'read',
      token: token(secret),
      operation: 'load',
      documentId: 'state',
    }, { secret, current: () => current })).resolves.toEqual({ status: 'missing', revision: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
