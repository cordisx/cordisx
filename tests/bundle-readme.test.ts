import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('plugin README composition', () => {
  it('finds and watches the nearest package README for a source entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-readme-'))
    temporaryDirectories.push(root)
    const pluginRoot = path.join(root, 'plugin')
    const sourceRoot = path.join(pluginRoot, 'src')
    const entry = path.join(sourceRoot, 'index.ts')
    const readme = path.join(pluginRoot, 'README.md')
    await mkdir(sourceRoot, { recursive: true })
    await Promise.all([
      writeFile(path.join(pluginRoot, 'package.json'), '{"name":"fixture-plugin","type":"module"}\n'),
      writeFile(readme, '# Package-level README\n\nVisible in the Manager.\n'),
      writeFile(entry, 'export function apply() {}\n'),
    ])
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'fixture-plugin', entry, enabled: true, config: {} }],
    }

    const composition = await buildRendererCompositionSource(config, { playground: true })

    expect(composition.source).toContain('# Package-level README')
    expect(composition.watchFiles).toEqual([entry, readme])
  })

  it('keeps embedded plugin READMEs scoped below a shared .cordisx package root', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'cordisx-embedded-readmes-'))
    temporaryDirectories.push(project)
    const root = path.join(project, '.cordisx')
    const firstRoot = path.join(root, 'plugins', 'first')
    const secondRoot = path.join(root, 'plugins', 'second')
    const firstEntry = path.join(firstRoot, 'src', 'index.ts')
    const secondEntry = path.join(secondRoot, 'src', 'index.ts')
    const firstReadme = path.join(firstRoot, 'README.md')
    const secondReadme = path.join(secondRoot, 'README.md')
    await Promise.all([
      mkdir(path.dirname(firstEntry), { recursive: true }),
      mkdir(path.dirname(secondEntry), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(root, 'package.json'), '{"name":"embedded-cordisx","private":true,"type":"module"}\n'),
      writeFile(path.join(root, 'README.md'), '# Shared CordisX environment\n'),
      writeFile(firstReadme, '# First embedded plugin\n'),
      writeFile(secondReadme, '# Second embedded plugin\n'),
      writeFile(firstEntry, 'export function apply() {}\n'),
      writeFile(secondEntry, 'export function apply() {}\n'),
    ])
    const config: CordisXConfig = {
      version: 1,
      rootDir: project,
      projectRoot: project,
      configRoot: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [
        { id: 'first', entry: firstEntry, enabled: true, config: {} },
        { id: 'second', entry: secondEntry, enabled: true, config: {} },
      ],
    }

    const composition = await buildRendererCompositionSource(config, { playground: true })

    expect(composition.source).toContain('# First embedded plugin')
    expect(composition.source).toContain('# Second embedded plugin')
    expect(composition.source).not.toContain('# Shared CordisX environment')
    expect(composition.watchFiles).toEqual([firstEntry, secondEntry, firstReadme, secondReadme])
  })

  it('resolves external plugin contracts from the exact Host instead of a shadow package', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-external-contracts-'))
    temporaryDirectories.push(root)
    const pluginRoot = path.join(root, 'plugin')
    const entry = path.join(pluginRoot, 'src', 'index.ts')
    const shadowPackage = path.join(pluginRoot, 'node_modules', 'cordisx')
    await mkdir(path.dirname(entry), { recursive: true })
    await mkdir(shadowPackage, { recursive: true })
    await Promise.all([
      writeFile(path.join(pluginRoot, 'package.json'), '{"name":"fixture-plugin","type":"module"}\n'),
      writeFile(path.join(shadowPackage, 'package.json'), JSON.stringify({
        name: 'cordisx', type: 'module', exports: { './contracts': './contracts.js' },
      })),
      writeFile(path.join(shadowPackage, 'contracts.js'), 'export const SHADOW_CONTRACT = "stale"\n'),
      writeFile(entry, `
        import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'
        export const schemas = [CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2]
        export function apply() {}
      `),
    ])
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'fixture-plugin', entry, enabled: true, config: {} }],
    }

    const composition = await buildRendererCompositionSource(config, { playground: true })

    expect(composition.source).toContain('page.v3.schema.json')
    expect(composition.source).toContain('route.v2.schema.json')
    expect(composition.source).not.toContain('SHADOW_CONTRACT')
  })

  it('holds manifest-v5 Host DOM code as worker source instead of a renderer module factory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-host-dom-worker-bundle-'))
    temporaryDirectories.push(root)
    const entry = path.join(root, 'host-dom-plugin.ts')
    await writeFile(entry, `
      globalThis.__hostDomRendererExecutionWouldBeABug = true
      export function apply() {}
    `)
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: 'host-dom-plugin',
        entry,
        enabled: true,
        config: {},
        manifest: {
          $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
          schemaVersion: 5,
          id: 'host-dom-plugin',
          capabilities: [{
            name: 'ui.host-dom.read',
            required: false,
            rationale: {
              title: { key: 'host-dom-title', fallback: 'Read the Host UI' },
              description: { key: 'host-dom-description', fallback: 'Reads bounded Host UI state.' },
              feature: { key: 'host-dom-feature', fallback: 'Host UI status' },
              deniedBehavior: { key: 'host-dom-denied', fallback: 'Host UI status stays unavailable.' },
            },
            security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
            scope: { rootIds: ['app.shell'], operations: ['read-text'] },
          }],
          services: [],
        },
      }],
    }

    const composition = await buildRendererCompositionSource(config, { playground: true })

    expect(composition.source).toContain('isolatedArtifactSource:')
    expect(composition.source).toContain('__cordisxHostDomPluginModuleV1')
    expect(composition.source).toContain('__hostDomRendererExecutionWouldBeABug')
    expect(composition.source).not.toContain('moduleFactory: (console)')
  })
})
