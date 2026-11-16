import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configuredPluginDocuments, readPluginDocuments } from '../packages/cli/src/launcher/plugin-documents.js'
import { channelApprovalPreview } from '../packages/cli/src/launcher/channel-approval-card.js'
import {
  loadStagedPluginPackage,
  removeStagedPluginPackage,
  stageLocalPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'
import { buildLocalDevelopmentPlugin, localDevelopmentPackageInfo } from '../packages/cli/src/launcher/development.js'
describe('package documentation and safe display', () => {
  it('keeps an absent optional document descriptor out of development composition imports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-no-docs-'))
    const entry = path.join(root, 'index.ts')
    try {
      await writeFile(entry, 'export function apply() {}')
      await writeFile(path.join(root, 'package.json'), '{}')
      const info = await localDevelopmentPackageInfo(entry)
      expect(info.documents).toEqual([])
      expect(info.packageFiles).not.toContain(path.join(root, 'cordisx-documents.json'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('discovers exact package Markdown, provides a path-free readback, and rejects escapes and symbolic links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-docs-'))
    const entry = path.join(root, 'dist', 'plugin.js')
    try {
      await mkdir(path.dirname(entry))
      await mkdir(path.join(root, 'docs'))
      await writeFile(entry, '')
      await writeFile(path.join(root, 'package.json'), '{}')
      await writeFile(path.join(root, 'docs', 'usage.md'), '# Usage')
      const descriptor = {
        contract: 'cordisx.plugin-documents/v1',
        documents: [{ id: 'usage', title: 'Usage', path: './docs/usage.md' }],
      }
      await writeFile(path.join(root, 'cordisx-documents.json'), JSON.stringify(descriptor))
      const result = await readPluginDocuments(entry, 'plugin')
      expect(result.documents[0]).toMatchObject({ id: 'usage', content: '# Usage' })
      expect(result.documents[0]).not.toHaveProperty('path')
      expect(
        await configuredPluginDocuments([{ id: 'plugin', entry, enabled: true }], { pluginId: 'plugin', id: 'usage' }),
      ).toMatchObject({ status: 'ok', document: { content: '# Usage' } })
      descriptor.documents[0]!.path = './../escape.md'
      await writeFile(path.join(root, 'cordisx-documents.json'), JSON.stringify(descriptor))
      await expect(readPluginDocuments(entry, 'plugin')).rejects.toThrow('INVALID_PLUGIN_DOCUMENT_PATH')
      descriptor.documents[0]!.path = './docs/link.md'
      await symlink('usage.md', path.join(root, 'docs', 'link.md'))
      await writeFile(path.join(root, 'cordisx-documents.json'), JSON.stringify(descriptor))
      await expect(readPluginDocuments(entry, 'plugin')).rejects.toThrow('INVALID_PLUGIN_DOCUMENT_PATH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('redacts secret assignments, secret flags, bearer values and URLs in custom approval cards', () => {
    const result = channelApprovalPreview(
      'TOKEN=private --api-key hidden --password=other Bearer token https://site/?secret=yes',
      '',
    )
    for (const value of ['private', 'hidden', 'other', 'Bearer token', 'https://site']) {
      expect(result).not.toContain(value)
    }
  })
  it('binds documents to immutable packages and development generations, never to an ancestor package', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-doc-lifecycle-'))
    const home = path.join(root, 'home'), source = path.join(root, 'source')
    const digests: `sha256:${string}`[] = []
    try {
      await mkdir(path.join(source, 'docs'), { recursive: true })
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.0' }))
      await writeFile(path.join(source, 'index.ts'), 'export function apply() {}')
      await writeFile(
        path.join(source, 'cordisx.plugin.json'),
        JSON.stringify({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v1.schema.json',
          schemaVersion: 1,
          id: 'index',
          version: '1.0.0',
          entry: './index.ts',
          compatibility: { runtimeAbi: 1, protocol: 1 },
          dependencies: [],
          runtimeManifest: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v1.schema.json',
            schemaVersion: 1,
            id: 'index',
            capabilities: [],
          },
        }),
      )
      await writeFile(
        path.join(source, 'cordisx-documents.json'),
        JSON.stringify({
          contract: 'cordisx.plugin-documents/v1',
          documents: [{ id: 'usage', title: 'Usage', path: './docs/usage.md' }],
        }),
      )
      await writeFile(path.join(source, 'docs/usage.md'), '# First')
      const first = await stageLocalPluginPackage(home, source)
      digests.push(first.digest)
      const devFirst = await buildLocalDevelopmentPlugin(path.join(source, 'index.ts'), { sourcemap: false })
      await writeFile(path.join(source, 'docs/usage.md'), '# Second')
      const second = await stageLocalPluginPackage(home, source)
      digests.push(second.digest)
      const devSecond = await buildLocalDevelopmentPlugin(path.join(source, 'index.ts'), { sourcemap: false })
      expect(second.digest).not.toBe(first.digest)
      expect(devSecond.digest).not.toBe(devFirst.digest)
      expect(devSecond.watchFiles).toContain(path.join(source, 'docs/usage.md'))
      expect((await loadStagedPluginPackage(home, first.digest)).documents?.[0]?.content).toBe('# First')
      const stored = path.join(home, 'packages', 'sha256', second.digest.slice(7))
      expect(
        await configuredPluginDocuments([{ id: 'index', enabled: true, entry: path.join(stored, 'module.js') }], {
          id: 'usage',
        }),
      )
        .toMatchObject({ document: { content: '# Second' } })
      await chmod(path.join(stored, 'plugin-documents.json'), 0o600)
      await writeFile(path.join(stored, 'plugin-documents.json'), '{}')
      await expect(loadStagedPluginPackage(home, second.digest)).rejects.toThrow('integrity readback')
      await mkdir(path.join(source, 'nested'))
      await writeFile(path.join(source, 'nested/package.json'), '{}')
      expect((await readPluginDocuments(path.join(source, 'nested/index.js'), 'nested')).documents).toEqual([])
    } finally {
      for (const digest of digests) await removeStagedPluginPackage(home, digest)
      await rm(root, { recursive: true, force: true })
    }
  })
})
