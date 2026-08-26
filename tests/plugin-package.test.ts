import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadStagedPluginPackage,
  normalizePluginPackageManifest,
  removeStagedPluginPackage,
  stageLocalPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CORDISX_PLUGIN_PACKAGE_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => {
    const digestRoot = path.join(directory, 'home', 'packages', 'sha256')
    const digests = await readdir(digestRoot).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(
      path.join(directory, 'home'),
      `sha256:${digest}`,
    )))
    await chmod(directory, 0o700).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }))
  temporary.clear()
})

function manifest(id = 'fixture', version = '1.0.0') {
  return {
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
    schemaVersion: 1,
    id,
    version,
    entry: './src/index.ts',
    readme: './README.md',
    canonicalSource: `https://plugins.example/${id}`,
    compatibility: { runtimeAbi: 1, protocol: 1 },
    dependencies: [],
    runtimeManifest: {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id,
      name: 'Fixture',
      capabilities: [],
    },
  } as const
}

async function fixture(entry = 'export function apply() {}'): Promise<{ home: string; source: string }> {
  const root = await mkdtemp(path.join(process.cwd(), '.plugin-package-test-'))
  temporary.add(root)
  const home = path.join(root, 'home')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await Promise.all([
    writeFile(path.join(source, 'cordisx.plugin.json'), `${JSON.stringify(manifest(), null, 2)}\n`),
    writeFile(path.join(source, 'src/index.ts'), entry),
    writeFile(path.join(source, 'README.md'), '# Fixture\n'),
  ])
  return { home, source }
}

describe('local plugin package store', () => {
  it('normalizes the exact v1 contract and rejects package/runtime identity drift', () => {
    expect(normalizePluginPackageManifest(manifest())).toMatchObject({ id: 'fixture', version: '1.0.0' })
    expect(() => normalizePluginPackageManifest({
      ...manifest(),
      runtimeManifest: { ...manifest().runtimeManifest, id: 'different' },
    })).toThrow('must equal package.id')
    expect(() => normalizePluginPackageManifest({
      ...manifest(),
      dependencies: [{ id: 'fixture', version: '1.0.0' }],
    })).toThrow('depend on itself')
  })

  it('publishes immutable content-addressed artifacts and preserves the prior digest after a source edit', async () => {
    const { home, source } = await fixture()
    const first = await stageLocalPluginPackage(home, source)
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.identitySource).toBe('https://plugins.example/fixture')
    expect((await loadStagedPluginPackage(home, first.digest)).artifactSource).toBe(first.artifactSource)
    expect(await readFile(path.join(home, 'packages', 'sha256', first.digest.slice(7), 'README.md'), 'utf8')).toBe('# Fixture\n')
    if (process.platform !== 'win32') {
      expect((await lstat(path.join(home, 'packages', 'sha256', first.digest.slice(7)))).mode & 0o777).toBe(0o555)
    }

    await writeFile(path.join(source, 'src/index.ts'), 'export function apply() { globalThis.__fixtureVersion = 2 }')
    const second = await stageLocalPluginPackage(home, source)
    expect(second.digest).not.toBe(first.digest)
    expect((await loadStagedPluginPackage(home, first.digest)).artifactSource).toBe(first.artifactSource)
  })

  it('compiles shared React imports into the immutable plugin artifact without bundling React', async () => {
    const { home, source } = await fixture(`
      import { createElement } from 'cordisx/react'
      import { Button } from 'cordisx/ui'
      export function apply() { globalThis.__fixtureElement = createElement(Button, null, 'Ready') }
    `)
    const staged = await stageLocalPluginPackage(home, source)
    expect(staged.moduleSource).toContain('__cordisxSharedReactRuntime')
    expect(staged.moduleSource).not.toContain('react.production.js')
    expect(staged.moduleSource).not.toContain('react.development.js')
  })

  it('rejects escaping symlinks and a second bundled Cordis runtime', async () => {
    const { home, source } = await fixture()
    const outside = path.join(path.dirname(source), 'outside.ts')
    await writeFile(outside, 'export function apply() {}')
    await rm(path.join(source, 'src/index.ts'))
    await symlink(outside, path.join(source, 'src/index.ts'))
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('outside the package directory')

    await rm(path.join(source, 'src/index.ts'))
    await writeFile(path.join(source, 'src/index.ts'), "import { Context } from '@deepseek-ai/cordis'; export function apply() { return Context }")
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('must not bundle a second')

    await writeFile(path.join(source, 'src/index.ts'), "import React from 'react'; export function apply() { return React }")
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('must import React and UI components from cordisx/react and cordisx/ui')
  })
})
