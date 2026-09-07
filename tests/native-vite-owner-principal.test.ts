import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { verifyOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native Vite owner principal generation', () => {
  it('reissues cached plugin bindings when composition authority changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-owner-principal-'))
    roots.push(root)
    const pluginRoot = path.join(root, 'plugin')
    const cacheRoot = path.join(root, 'cache')
    const entry = path.join(pluginRoot, 'entry.ts')
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(pluginRoot, 'package.json'), '{"name":"principal-fixture","version":"1.0.0"}')
    await writeFile(entry, 'export function apply() {}\n')
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'principal-fixture', entry, enabled: true, config: {} }],
    }
    const vite = await startNativeViteServer(config, { cacheRoot })
    const pluginUrl = vite.url + '@id/__x00__virtual:cordisx-native-plugin/principal-fixture'
    const token = async (): Promise<string> => {
      const source = await fetch(pluginUrl, { headers: { Origin: 'null' } }).then(response => response.text())
      const value = /"token":"([^"]+)"/u.exec(source)?.[1]
      if (value === undefined) throw new Error('fixture plugin principal token is unavailable')
      return value
    }
    try {
      const first = await buildRendererComposition(config, () => undefined, {
        profileId: 'development',
        developmentBuild: (nextConfig, options = {}) => vite.buildBootstrap(nextConfig, options),
      })
      const firstToken = await token()
      expect(verifyOwnerDocumentPrincipalToken(first.ownerDocumentSecret, firstToken)).toBeDefined()

      const second = await buildRendererComposition(config, () => undefined, {
        profileId: 'development',
        developmentBuild: (nextConfig, options = {}) => vite.buildBootstrap(nextConfig, options),
      })
      const secondToken = await token()
      expect(secondToken).not.toBe(firstToken)
      expect(verifyOwnerDocumentPrincipalToken(second.ownerDocumentSecret, secondToken)).toBeDefined()
      expect(verifyOwnerDocumentPrincipalToken(second.ownerDocumentSecret, firstToken)).toBeUndefined()
    } finally {
      await vite.close()
    }
  })
})
