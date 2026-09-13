import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { resolveDevelopmentConfigIdentity } from '../packages/cli/src/launcher/development-source-identity.js'
import { parseConfigBindingRequest } from '../packages/cli/src/launcher/config-rpc.js'
import { createLauncherConfigBridgeHandler } from '../packages/cli/src/launcher/launcher-plugin-config.js'

const token = 'b'.repeat(64)
const generation = 'development-generation-1'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-development-config-write-'))
  const configPath = path.join(root, '.cordisx', 'config.json')
  await mkdir(path.dirname(configPath))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  await writeFile(path.join(root, 'demo.ts'), 'export default { apply() {} }\n')
  const document = {
    version: 1,
    codex: { debugPort: 9229, agentLoopBackend: 'mock' },
    providers: [],
    plugins: [{ id: 'demo', entry: '../demo.ts', enabled: true, config: { accountDisplayName: '' } }],
    futureLauncherField: { retained: true },
  }
  await writeFile(configPath, JSON.stringify(document))
  const composition = await resolveDevelopmentConfigIdentity(await loadConfig(configPath, { profileId: 'development' }))
  const source = composition.plugins[0]!.source!
  const handler = createLauncherConfigBridgeHandler({
    token,
    generation,
    profileId: 'development',
    configPath,
    composition,
    preserveComposition: true,
  })
  const request = (operation: 'stage' | 'commit' | 'abort', revision: number, overrides = {}) =>
    parseConfigBindingRequest(
      {
        version: 1,
        token,
        operation,
        requestId: `request-${operation}-${revision}`,
        identity: { source, pluginId: 'demo' },
        scope: { profileId: 'development', generation },
        ...(operation === 'stage'
          ? { expectedRevision: revision, config: { accountDisplayName: 'local alias' } }
          : { candidateRevision: revision }),
        ...overrides,
      },
      token,
      'development',
      generation,
    )
  return { root, configPath, document, composition, handler, request }
}

describe('explicit development config persistence', () => {
  it('commits the scoped alias, retains the launcher envelope and stable public owner on reload', async () => {
    const f = await fixture()
    const otherFile = path.join(f.root, 'other.json')
    await writeFile(otherFile, 'unrelated sentinel')
    try {
      await expect(f.handler.handle(f.request('stage', 0))).resolves.toEqual({ candidateRevision: 1 })
      await expect(f.handler.handle(f.request('commit', 1))).resolves.toEqual({
        revision: 1,
        config: { accountDisplayName: 'local alias' },
      })
      const persisted = JSON.parse(await readFile(f.configPath, 'utf8'))
      expect(persisted).toEqual({
        ...f.document,
        plugins: [{
          ...f.document.plugins[0],
          profiles: {
            development: { revision: 1, config: { accountDisplayName: 'local alias' } },
          },
        }],
      })
      const reloaded = await resolveDevelopmentConfigIdentity(
        await loadConfig(f.configPath, { profileId: 'development' }),
      )
      expect(reloaded.plugins[0]).toMatchObject({
        source: f.composition.plugins[0]!.source,
        entry: f.composition.plugins[0]!.entry,
        revision: 1,
        config: { accountDisplayName: 'local alias' },
      })
      expect(await readFile(otherFile, 'utf8')).toBe('unrelated sentinel')
      const before = await readFile(f.configPath, 'utf8')
      await expect(f.handler.handle(f.request('stage', 0))).rejects.toMatchObject({ actualRevision: 1 })
      expect(await readFile(f.configPath, 'utf8')).toBe(before)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('aborts only its own candidate and rejects stale generation, spoofed owner and a writer-supplied path', async () => {
    const f = await fixture()
    try {
      const before = await readFile(f.configPath, 'utf8')
      expect(() => f.request('stage', 0, { scope: { profileId: 'development', generation: 'old-generation' } }))
        .toThrow('stale or spoofed')
      expect(() => f.request('stage', 0, { configPath: '/unrelated.json' })).toThrow('not supported')
      await expect(f.handler.handle(f.request('stage', 0, {
        identity: { source: 'file:///other-owner/demo.js', pluginId: 'demo' },
      }))).rejects.toThrow('identity is stale or spoofed')
      expect(await readFile(f.configPath, 'utf8')).toBe(before)
      await f.handler.handle(f.request('stage', 0))
      await f.handler.handle(f.request('abort', 1))
      expect((await loadConfig(f.configPath, { profileId: 'development' })).plugins[0]).toMatchObject({
        revision: 0,
        config: { accountDisplayName: '' },
      })
      await expect(f.handler.handle(f.request('commit', 1))).rejects.toThrow()
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.each(['id', 'entry', 'developmentIdentityEntry', 'enabled'])(
    'rejects externally changed %s before a staged candidate can commit',
    async field => {
      const f = await fixture()
      try {
        await f.handler.handle(f.request('stage', 0))
        const current = JSON.parse(await readFile(f.configPath, 'utf8'))
        current.plugins[0][field] = field === 'id' ? 'different' : field === 'enabled' ? false : '../different.ts'
        await writeFile(f.configPath, JSON.stringify(current))
        const before = await readFile(f.configPath, 'utf8')
        await expect(f.handler.handle(f.request('commit', 1))).rejects.toThrow('composition changed')
        expect(await readFile(f.configPath, 'utf8')).toBe(before)
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    },
  )

  it('rejects an invalid launcher envelope without repairing or rewriting it', async () => {
    const f = await fixture()
    try {
      const before = JSON.stringify({ ...f.document, version: 99 })
      await writeFile(f.configPath, before)
      await expect(f.handler.handle(f.request('stage', 0))).rejects.toThrow('config.version must be 1')
      expect(await readFile(f.configPath, 'utf8')).toBe(before)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink substituted for the selected file', async () => {
    const f = await fixture()
    try {
      const target = path.join(f.root, 'other.json')
      const before = await readFile(f.configPath, 'utf8')
      await writeFile(target, before)
      await rm(f.configPath)
      await symlink(target, f.configPath)
      await expect(f.handler.handle(f.request('stage', 0))).rejects.toThrow('not a symbolic link')
      expect(await readFile(target, 'utf8')).toBe(before)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
