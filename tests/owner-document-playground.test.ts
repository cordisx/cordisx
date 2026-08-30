import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(item => rm(item, { recursive: true, force: true })))
})

function tokenFrom(source: string): string {
  const token = source.match(/ownerDocumentBridgeToken:\s*"([^"]+)"/)?.[1]
  if (token === undefined) throw new Error('Playground owner document metadata is missing')
  return token
}

describe('Playground owner document bridge', () => {
  it('persists across normal generation reload and resets only through explicit Playground reset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-owner-document-playground-'))
    roots.push(root)
    const entry = path.resolve('tests/fixtures/owner-documents-runtime-plugin.ts')
    const configPath = path.join(root, 'composition.json')
    await writeFile(configPath, `${JSON.stringify({
      version: 1,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'owner-documents-runtime', entry, enabled: true, config: {} }],
    })}\n`)
    const session = await createPlaygroundSession(configPath)
    const identity = { source: pathToFileURL(entry).href, pluginId: 'owner-documents-runtime' }
    try {
      const first = await session.buildBundle()
      const firstMetadata = { token: tokenFrom(first.source), generation: first.generation }
      const replace = {
        version: 1, requestId: 'replace-one', token: firstMetadata.token, operation: 'replace', identity,
        scope: { profileId: 'playground', generation: firstMetadata.generation },
        documentId: 'rooms', expectedRevision: 0, schemaVersion: 1,
        value: { operationId: 'stable-create-1', state: 'planned' },
      }
      await expect(session.handleOwnerDocumentRequest(JSON.stringify(replace))).resolves.toMatchObject({
        requestId: 'replace-one', ok: true, value: { status: 'accepted', snapshot: { revision: 1 } },
      })

      const second = await session.buildBundle()
      const secondMetadata = { token: tokenFrom(second.source), generation: second.generation }
      expect(secondMetadata.generation).not.toBe(firstMetadata.generation)
      await expect(session.handleOwnerDocumentRequest(JSON.stringify({
        ...replace,
        requestId: 'load-after-reload', token: secondMetadata.token, operation: 'load',
        scope: { profileId: 'playground', generation: secondMetadata.generation },
        expectedRevision: undefined, schemaVersion: undefined, value: undefined,
      }))).resolves.toMatchObject({
        requestId: 'load-after-reload', ok: true,
        value: { status: 'loaded', snapshot: { revision: 1, value: { operationId: 'stable-create-1', state: 'planned' } } },
      })
      await expect(session.handleOwnerDocumentRequest(JSON.stringify({ ...replace, requestId: 'stale-load', operation: 'load' })))
        .resolves.toMatchObject({ value: { status: 'unavailable', code: 'host-unavailable' } })

      await session.reset()
      const third = await session.buildBundle()
      const thirdMetadata = { token: tokenFrom(third.source), generation: third.generation }
      await expect(session.handleOwnerDocumentRequest(JSON.stringify({
        version: 1, requestId: 'load-after-reset', token: thirdMetadata.token, operation: 'load', identity,
        scope: { profileId: 'playground', generation: thirdMetadata.generation }, documentId: 'rooms',
      }))).resolves.toMatchObject({ requestId: 'load-after-reset', value: { status: 'missing', revision: 0 } })
    } finally {
      await session.close()
    }
  }, 30_000)
})
