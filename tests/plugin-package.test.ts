import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import {
  loadStagedPluginPackage,
  normalizePluginPackageManifest,
  removeStagedPluginPackage,
  stageLocalPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CORDISX_PLUGIN_PACKAGE_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { cordisXPluginViteConfig } from '../packages/cli/src/vite.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => {
    const digestRoot = path.join(directory, 'home', 'packages', 'sha256')
    const digests = await readdir(digestRoot).catch(() => [])
    await Promise.all(digests.map(async digest =>
      await removeStagedPluginPackage(
        path.join(directory, 'home'),
        `sha256:${digest}`,
      )
    ))
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
    expect(() =>
      normalizePluginPackageManifest({
        ...manifest(),
        runtimeManifest: { ...manifest().runtimeManifest, id: 'different' },
      })
    ).toThrow('must equal package.id')
    expect(() =>
      normalizePluginPackageManifest({
        ...manifest(),
        dependencies: [{ id: 'fixture', version: '1.0.0' }],
      })
    ).toThrow('depend on itself')
  })

  it('publishes immutable content-addressed artifacts and preserves the prior digest after a source edit', async () => {
    const { home, source } = await fixture()
    const first = await stageLocalPluginPackage(home, source)
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(first.identitySource).toBe('https://plugins.example/fixture')
    expect((await loadStagedPluginPackage(home, first.digest)).artifactSource).toBe(first.artifactSource)
    expect(await readFile(path.join(home, 'packages', 'sha256', first.digest.slice(7), 'README.md'), 'utf8')).toBe(
      '# Fixture\n',
    )
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

  it('publishes a browser-native graph while keeping lazy chunks, CSS, and assets out of the entry', async () => {
    const { home, source } = await fixture(`
      export function apply() {}
      export async function showAvatar() { return await import('./avatar') }
    `)
    await Promise.all([
      writeFile(
        path.join(source, 'src/avatar.ts'),
        `
        import './avatar.css'
        import avatarUrl from './avatar.svg'
        globalThis.__fixtureLazyExecuted = true
        export { avatarUrl }
      `,
      ),
      writeFile(path.join(source, 'src/avatar.css'), '.fixture-avatar { background-image: url(./avatar.svg) }\n'),
      writeFile(
        path.join(source, 'src/avatar.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4"/></svg>\n',
      ),
    ])

    const staged = await stageLocalPluginPackage(home, source)
    const graph = staged.browserArtifact
    expect(graph).toBeDefined()
    expect(graph?.manifest.entry).toBe('./module.js')
    expect(graph?.manifest.initialStyles).toEqual([])
    expect(graph?.manifest.files.some(file => file.path.startsWith('./chunks/') && file.kind === 'module')).toBe(true)
    expect(graph?.manifest.files.some(file => file.path.startsWith('./assets/') && file.kind === 'stylesheet')).toBe(
      true,
    )
    expect(graph?.manifest.files.some(file => file.path.startsWith('./assets/') && file.mediaType === 'image/svg+xml'))
      .toBe(true)
    expect(Buffer.from(graph?.files.get(graph.manifest.entry) ?? []).toString('utf8')).not.toContain(
      '__fixtureLazyExecuted',
    )

    const storedRoot = path.join(home, 'packages', 'sha256', staged.digest.slice(7))
    expect(JSON.parse(await readFile(path.join(storedRoot, 'browser', 'artifact.json'), 'utf8'))).toEqual(
      graph?.manifest,
    )
    const loaded = await loadStagedPluginPackage(home, staged.digest)
    expect(loaded.browserArtifact?.manifest).toEqual(graph?.manifest)
  })

  it('ingests an adjacent author-built graph exactly without recompiling away lazy CSS', async () => {
    const { home, source } = await fixture(`
      export function apply() {}
      export async function showPanel() { return await import('./panel') }
    `)
    const packageManifest = { ...manifest(), entry: './dist/runtime/chatroom.js' }
    await Promise.all([
      writeFile(path.join(source, 'cordisx.plugin.json'), `${JSON.stringify(packageManifest, null, 2)}\n`),
      writeFile(
        path.join(source, 'src/panel.ts'),
        `
        import './panel.css'
        import iconUrl from './panel.svg'
        globalThis.__fixturePanelExecuted = true
        export { iconUrl }
      `,
      ),
      writeFile(path.join(source, 'src/panel.css'), '.fixture-panel { background-image: url(./panel.svg) }\n'),
      writeFile(
        path.join(source, 'src/panel.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M0 0h8v8H0z"/></svg>\n',
      ),
    ])
    await viteBuild({
      ...cordisXPluginViteConfig({
        root: source,
        entry: './src/index.ts',
        outDir: './dist/runtime',
        entryFileName: 'chatroom.js',
      }),
      configFile: false,
    })
    const authorManifest = JSON.parse(await readFile(path.join(source, 'dist/runtime/artifact.json'), 'utf8'))
    const authorEntry = await readFile(path.join(source, 'dist/runtime/chatroom.js'), 'utf8')
    expect(authorManifest.files.some((file: { readonly kind: string }) => file.kind === 'stylesheet')).toBe(true)

    const staged = await stageLocalPluginPackage(home, source)
    expect(staged.browserArtifact?.manifest).toEqual(authorManifest)
    expect(Buffer.from(staged.browserArtifact?.files.get('./chatroom.js') ?? []).toString('utf8')).toBe(authorEntry)
    expect(staged.browserArtifact?.manifest.files.some(file => file.kind === 'stylesheet')).toBe(true)
    expect(staged.browserArtifact?.manifest.files.some(file => file.kind === 'asset')).toBe(true)

    const artifactRoot = path.join(source, 'dist/runtime')
    const manifestPath = path.join(artifactRoot, 'artifact.json')
    const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`
    const externalEntry = `${authorEntry}\nimport 'https://modules.example/escape.js'\n`
    const externalModuleManifest = structuredClone(authorManifest)
    const entryDescriptor = externalModuleManifest.files.find(
      (file: { readonly path: string }) => file.path === externalModuleManifest.entry,
    )
    entryDescriptor.byteLength = Buffer.byteLength(externalEntry)
    entryDescriptor.digest = digest(externalEntry)
    await Promise.all([
      writeFile(path.join(artifactRoot, externalModuleManifest.entry.slice(2)), externalEntry),
      writeFile(manifestPath, `${JSON.stringify(externalModuleManifest, null, 2)}\n`),
    ])
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('undeclared bare or external module import')

    const computedEntry = `${authorEntry}\nconst escapeModule = './escape.js'; void import(escapeModule)\n`
    const computedModuleManifest = structuredClone(authorManifest)
    const computedEntryDescriptor = computedModuleManifest.files.find(
      (file: { readonly path: string }) => file.path === computedModuleManifest.entry,
    )
    computedEntryDescriptor.byteLength = Buffer.byteLength(computedEntry)
    computedEntryDescriptor.digest = digest(computedEntry)
    await Promise.all([
      writeFile(path.join(artifactRoot, computedModuleManifest.entry.slice(2)), computedEntry),
      writeFile(manifestPath, `${JSON.stringify(computedModuleManifest, null, 2)}\n`),
    ])
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('computed module import')

    const stylesheetDescriptor = authorManifest.files.find(
      (file: { readonly kind: string }) => file.kind === 'stylesheet',
    )
    const stylesheetPath = path.join(artifactRoot, stylesheetDescriptor.path.slice(2))
    const stylesheet = await readFile(stylesheetPath, 'utf8')
    const externalStylesheet = `${stylesheet}\n.escape{background:url(https://assets.example/escape.png)}\n`
    const externalStylesheetManifest = structuredClone(authorManifest)
    const changedStylesheet = externalStylesheetManifest.files.find(
      (file: { readonly path: string }) => file.path === stylesheetDescriptor.path,
    )
    changedStylesheet.byteLength = Buffer.byteLength(externalStylesheet)
    changedStylesheet.digest = digest(externalStylesheet)
    await Promise.all([
      writeFile(path.join(artifactRoot, authorManifest.entry.slice(2)), authorEntry),
      writeFile(stylesheetPath, externalStylesheet),
      writeFile(manifestPath, `${JSON.stringify(externalStylesheetManifest, null, 2)}\n`),
    ])
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('not an artifact-relative reference')

    await Promise.all([
      writeFile(stylesheetPath, stylesheet),
      writeFile(manifestPath, `${JSON.stringify(authorManifest, null, 2)}\n`),
    ])

    await writeFile(path.join(source, 'dist/runtime/undeclared.js'), 'export const undeclared = true\n')
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('undeclared files or directories')
  })

  it('rejects escaping symlinks and a second bundled Cordis runtime', async () => {
    const { home, source } = await fixture()
    const outside = path.join(path.dirname(source), 'outside.ts')
    await writeFile(outside, 'export function apply() {}')
    await rm(path.join(source, 'src/index.ts'))
    await symlink(outside, path.join(source, 'src/index.ts'))
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('outside the package directory')

    await rm(path.join(source, 'src/index.ts'))
    await writeFile(
      path.join(source, 'src/index.ts'),
      "import { Context } from '@deepseek-ai/cordis'; export function apply() { return Context }",
    )
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow('must not bundle a second')

    await writeFile(
      path.join(source, 'src/index.ts'),
      "import React from 'react'; export function apply() { return React }",
    )
    await expect(stageLocalPluginPackage(home, source)).rejects.toThrow(
      'must import React and UI components from cordisx/react and cordisx/ui',
    )
  })
})
