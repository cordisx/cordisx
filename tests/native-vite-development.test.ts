import { getEventListeners } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeViteEntityGenerationHandler,
  nativeViteBootModuleSource,
  nativeViteEntryModuleSource,
  nativeViteHotPayload,
  nativeViteRoot,
  startNativeViteServer,
} from '../packages/cli/src/launcher/vite-development.js'
import { NativeViteSourceMapStore } from '../packages/cli/src/launcher/vite-development-source-maps.js'
import { nativeViteWatchOptions } from '../packages/cli/src/launcher/vite-development-watcher.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { CdpPluginLifecycleRuntime, watchAndInject } from '../packages/cli/src/launcher/cdp.js'
import { EntityDirectoryAuthority, entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { entityInstallationId, entityPluginGeneration } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { NativeViteDevelopmentClient } from '../packages/cli/src/renderer/vite-development-client.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
  certifiedPermissionEndpointTakeKey,
  createCertifiedPermissionDocumentChannel,
} from '../packages/cli/src/renderer/certified-permission-channel.js'

const PACKAGE_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v5.schema.json'
const ENTITY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'

const viteCacheDirectories: string[] = []
const viteCacheRoots: string[] = []

async function startTestViteServer(config: Parameters<typeof startNativeViteServer>[0]) {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cache-root-'))
  viteCacheRoots.push(cacheRoot)
  const vite = await startNativeViteServer(config, { cacheRoot })
  viteCacheDirectories.push(vite.cacheDir)
  return vite
}

afterEach(async () => {
  await Promise.all(viteCacheDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  await Promise.all(viteCacheRoots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('native Vite development transport', () => {
  it('transfers one Certified document channel between Vite clients on a same-document Host restart', async () => {
    const activation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'default',
      runtimeGeneration: 'runtime-generation',
      revision: 0,
      lastGoodRevision: 0,
      plugins: [],
    }
    const firstSink = {
      replaceCertifiedPermissionSnapshot: vi.fn(),
      clearCertifiedPermissionSnapshot: vi.fn(),
    }
    const secondSink = {
      replaceCertifiedPermissionSnapshot: vi.fn(),
      clearCertifiedPermissionSnapshot: vi.fn(),
    }
    const token = 'a'.repeat(64)
    const channel = createCertifiedPermissionDocumentChannel({
      token,
      profileId: 'default',
      runtimeGeneration: 'runtime-generation',
      sink: firstSink,
    })
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    const endpoint = (globals[certifiedPermissionEndpointTakeKey(token)] as (() => {
      deliver(payload: string): unknown
    }))()
    endpoint.deliver(JSON.stringify({
      contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
      profileId: 'default',
      runtimeGeneration: 'runtime-generation',
      documentEpoch: channel.documentEpoch,
      deliverySequence: 1,
      authorityRevision: 1,
      snapshot: { revision: 1, projections: [] },
    }))
    const runtimes = [firstSink, secondSink].map((sink, index) => ({
      activePluginGeneration: () => activation,
      releaseCertifiedPermissionChannel: vi.fn(() => index === 0 ? channel : undefined),
      dispose: vi.fn(async () => undefined),
      sink,
    }))
    const install = vi.fn(async (
      _plugins: readonly unknown[],
      _metadata: unknown,
      _bootstrap?: unknown,
      _signal?: AbortSignal,
      options?: { certifiedPermissionChannel?: typeof channel },
    ) => {
      const runtime = runtimes[install.mock.calls.length - 1]!
      options?.certifiedPermissionChannel?.replaceSink(runtime.sink)
      return runtime as never
    })
    const previous = new NativeViteDevelopmentClient(
      { profileId: 'default', generation: 'runtime-generation' } as never,
      [],
      () => undefined,
    )

    await previous.restart(install as never)
    const transferred = previous.releaseCertifiedPermissionChannel()
    await previous.dispose(true)
    const client = new NativeViteDevelopmentClient(
      { profileId: 'default', generation: 'runtime-generation' } as never,
      [],
      () => undefined,
      undefined,
      transferred,
    )
    await client.restart(install as never)
    endpoint.deliver(JSON.stringify({
      contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
      profileId: 'default',
      runtimeGeneration: 'runtime-generation',
      documentEpoch: channel.documentEpoch,
      deliverySequence: 2,
      authorityRevision: 2,
      snapshot: { revision: 2, projections: [] },
    }))

    expect(runtimes[0]!.releaseCertifiedPermissionChannel).toHaveBeenCalledOnce()
    expect(secondSink.replaceCertifiedPermissionSnapshot).toHaveBeenCalledWith({ revision: 1, projections: [] })
    expect(secondSink.replaceCertifiedPermissionSnapshot).toHaveBeenCalledWith({ revision: 2, projections: [] })
    channel.dispose()
  })

  it('allows the generated entry failure path to close a channel transferred before old-client disposal', async () => {
    const channel = {
      documentEpoch: 'document-epoch-1234',
      ready: Promise.resolve(),
      replaceSink: vi.fn(),
      dispose: vi.fn(),
    }
    const runtime = {
      activePluginGeneration: () => ({
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1 as const,
        recordKind: 'active' as const,
        profileId: 'default',
        runtimeGeneration: 'runtime-generation',
        revision: 0,
        lastGoodRevision: 0,
        plugins: [],
      }),
      releaseCertifiedPermissionChannel: vi.fn(() => channel),
      dispose: vi.fn(async () => {
        throw new Error('old runtime disposal failed')
      }),
    }
    const install = vi.fn(async () => runtime as never)
    const previous = new NativeViteDevelopmentClient(
      { profileId: 'default', generation: 'runtime-generation' } as never,
      [],
      () => undefined,
    )
    await previous.restart(install as never)
    const transferred = previous.releaseCertifiedPermissionChannel()
    await expect(previous.dispose(true)).rejects.toThrow('old runtime disposal failed')
    transferred?.dispose()

    expect(runtime.releaseCertifiedPermissionChannel).toHaveBeenCalledOnce()
    expect(channel.dispose).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
  })

  it('generates a cache-busted Host restart that transfers Certified channel ownership', () => {
    const bootSource = nativeViteBootModuleSource({
      reactPrepareUrl: 'http://127.0.0.1/react-prepare',
      entryUrl: 'http://127.0.0.1/entry',
    })
    const entrySource = nativeViteEntryModuleSource({
      hostImport: '/renderer/runtime.ts',
      helperImport: '/renderer/vite-development-client.ts',
      pluginsSource: '[]',
      metadataSource: '{}',
      pluginImports: [],
      pluginUrls: [],
    })

    expect(bootSource).toContain("import.meta.hot.on('cordisx:restart-host'")
    expect(bootSource).toContain('"http://127.0.0.1/entry" + \'?t=\' + Date.now()')
    expect(entrySource).toContain('previous?.releaseCertifiedPermissionChannel()')
    expect(entrySource).toContain('await previous.dispose(true)')
    expect(entrySource).toContain('stagePluginGeneration, certifiedPermissionChannel)')
    expect(entrySource).toContain('catch (error) { certifiedPermissionChannel?.dispose(); throw error; }')
    expect(entrySource.indexOf('previous?.releaseCertifiedPermissionChannel()')).toBeLessThan(
      entrySource.indexOf('await previous.dispose(true)'),
    )
  })

  it('ignores launcher-owned package staging without suppressing source updates', () => {
    const options = nativeViteWatchOptions('/repo/packages/cli/dist/', ['/home/packages/.source-staging'])

    expect(options.ignored).toContain('/repo/packages/cli/dist/**')
    expect(options.ignored).toContain('/home/packages/.source-staging/**')
    expect(options.ignored).not.toContain('/repo/packages/cli/src/**')
  })

  it('does not root immutable installed compositions at the user config directory', () => {
    const installed = {
      id: 'installed',
      entry: '/home/.cordisx/packages/sha256/abc/browser/module.js',
      enabled: true,
      config: {},
      package: {
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}` as const,
        moduleGeneration: 'installed-generation',
        dependencies: [],
      },
    }

    expect(nativeViteRoot('/home/.cordisx', '/repo/packages/cli', [installed])).toBe('/repo/packages/cli')
    expect(nativeViteRoot('/project', '/repo/packages/cli', [{ ...installed, package: undefined }])).toBe('/project')
    expect(nativeViteRoot('/project', '/repo/packages/cli', [{
      ...installed,
      development: {
        origin: 'local-dev',
        pluginId: 'installed',
        sourcePath: '/project/index.ts',
        state: 'ready',
        lastSuccessfulAt: '2026-09-26T00:00:00.000Z',
      },
    }])).toBe('/project')
  })

  it('converts full reloads into Host restarts without rebuilding the whole module graph', () => {
    expect(nativeViteHotPayload({ type: 'full-reload', path: '*' }, 42)).toEqual({
      type: 'custom',
      event: 'cordisx:restart-host',
      data: { timestamp: 42 },
    })
    const update = { type: 'update', updates: [] }
    expect(nativeViteHotPayload(update, 42)).toBe(update)
  })

  it('bounds retained source maps by decoded bytes before allocating oversized maps', () => {
    const maps = new NativeViteSourceMapStore({ maxEntries: 3, maxBytes: 10, maxEntryBytes: 6 })
    const first = maps.remember('/dev/', Buffer.from('123456').toString('base64'))
    const second = maps.remember('/dev/', Buffer.from('abcde').toString('base64'))
    const oversized = maps.remember('/dev/', Buffer.from('1234567').toString('base64'))

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(maps.get(first!)).toBeUndefined()
    expect(maps.get(second!)).toBe('abcde')
    expect(oversized).toBeUndefined()
  })

  it('closes an idle server while retaining its reusable dependency cache', async () => {
    const vite = await startTestViteServer({
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    })
    await vite.close()
    await expect(access(vite.cacheDir)).resolves.toBeUndefined()
    await expect(fetch(vite.url)).rejects.toThrow()
  })

  it('finishes the configured Host and plugin dependency scan before returning and reuses its cache', async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-prebundle-'))
    viteCacheRoots.push(cacheRoot)
    const config = {
      version: 1 as const,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const first = await startNativeViteServer(config, { cacheRoot, prebundleHostDependencies: true })
    viteCacheDirectories.push(first.cacheDir)
    const metadataPath = path.join(first.cacheDir, 'deps', '_metadata.json')
    await expect(access(metadataPath)).resolves.toBeUndefined()
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      readonly optimized?: Readonly<Record<string, unknown>>
    }
    expect(Object.keys(metadata.optimized ?? {})).toEqual(expect.arrayContaining([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
    ]))
    await first.close()

    const second = await startNativeViteServer(config, { cacheRoot, prebundleHostDependencies: true })
    expect(second.cacheDir).toBe(first.cacheDir)
    await expect(access(path.join(second.cacheDir, 'deps', '_metadata.json'))).resolves.toBeUndefined()
    await second.close()
  }, 30_000)

  it('validates cold plugin dependency batches without Host prebundling', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cold-plugin-deps-'))
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cold-plugin-cache-'))
    const entry = path.join(root, 'index.ts')
    viteCacheRoots.push(cacheRoot)
    await symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir')
    await Promise.all([
      writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'cold-plugin-dependencies',
          version: '1.0.0',
          type: 'module',
          dependencies: {
            '@deepseek-ai/schemastery': '^3.18.1',
            'react-markdown': '10.1.0',
            'rehype-raw': '^7.0.0',
            'rehype-sanitize': '^6.0.0',
            'remark-gfm': '4.0.1',
          },
        }),
      ),
      writeFile(
        entry,
        "import './schema.js'\nimport './markdown.js'\nexport function apply() {}\n",
      ),
      writeFile(
        path.join(root, 'schema.ts'),
        "import Schema from '@deepseek-ai/schemastery'\nexport const schema = Schema.object({})\n",
      ),
      writeFile(
        path.join(root, 'markdown.ts'),
        "import Markdown from 'react-markdown'\nimport rehypeRaw from 'rehype-raw'\nimport rehypeSanitize from 'rehype-sanitize'\nimport remarkGfm from 'remark-gfm'\nexport const markdown = [Markdown, rehypeRaw, rehypeSanitize, remarkGfm]\n",
      ),
    ])
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'cold-dependencies', entry, enabled: true, config: {} }],
    }
    let vite: Awaited<ReturnType<typeof startNativeViteServer>> | undefined
    try {
      vite = await startNativeViteServer(config, { cacheRoot, prebundleHostDependencies: false })
      viteCacheDirectories.push(vite.cacheDir)
      await expect(buildRendererComposition(config, () => {}, {
        developmentBuild: (nextConfig, options) => vite!.buildBootstrap(nextConfig, options ?? {}),
      })).resolves.toMatchObject({ source: expect.any(String) })
    } finally {
      await vite?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a symlinked cache root before changing or using its target', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cache-symlink-'))
    const target = path.join(parent, 'target')
    const cacheRoot = path.join(parent, 'cache-root')
    await mkdir(target, { mode: 0o755 })
    await symlink(target, cacheRoot, 'dir')
    try {
      await expect(startNativeViteServer({
        version: 1,
        rootDir: parent,
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [],
      }, { cacheRoot })).rejects.toThrow('cache path must be a real directory')
      expect((await stat(target)).mode & 0o777).toBe(0o755)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('serves Host vendor CSS inline imports as JavaScript through symlinked dependencies', async () => {
    const nestedProjectRoot = path.resolve('artifacts')
    const vite = await startTestViteServer({
      version: 1,
      rootDir: nestedProjectRoot,
      projectRoot: nestedProjectRoot,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    })
    try {
      const rendererRoot = path.resolve('packages/cli/src/renderer')
      for (
        const modulePath of [
          path.join(rendererRoot, 'host-ui/tdesign-styles.ts'),
          path.join(rendererRoot, 'host-ui/avatar/AgentAvatar.tsx'),
        ]
      ) {
        const transformed = await fetch(
          new URL(`@fs/${modulePath}`, vite.url),
          { headers: { Origin: 'null' }, signal: AbortSignal.timeout(5_000) },
        )
        expect(transformed.status).toBe(200)
        const source = await transformed.text()
        const cssUrl = source.match(/from\s+"([^"]+\.css\?inline)"/u)?.[1]
        expect(cssUrl).toBeDefined()
        const cssModule = await fetch(new URL(cssUrl!, new URL(vite.url).origin), {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5_000),
        })
        expect(cssModule.status).toBe(200)
        expect(cssModule.headers.get('content-type')).toContain('javascript')
        const cssModuleSource = await cssModule.text()
        const imported = await import(`data:text/javascript;base64,${Buffer.from(cssModuleSource).toString('base64')}`)
        expect(imported.default).toBeTypeOf('string')
        expect(imported.default).toMatch(/(?:--td-brand-color|\.oneworks-avatar)/u)
      }
    } finally {
      await vite.close()
    }
  })

  it('reuses renderer-only package validation instead of erasing formal dependencies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-dependencies-'))
    const entry = path.join(root, 'index.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"dependent","version":"1.0.0","type":"module"}')
    await writeFile(
      path.join(root, 'cordisx-package.json'),
      JSON.stringify({
        dependencies: [{ id: 'base', version: '1.0.0' }],
      }),
    )
    await writeFile(entry, 'export function apply() {}\n')
    try {
      await expect(startTestViteServer({
        version: 1,
        rootDir: root,
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [{ id: 'dependent', entry, enabled: true, config: {} }],
      })).rejects.toThrow('local development phase 1 is renderer-only; package dependencies are unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects validated entity templates into the Host-owned Vite generation sink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-entity-template-'))
    const entry = path.join(root, 'index.ts')
    const entityDirectory = path.join(root, 'entities', 'lead')
    const entityPath = path.join(entityDirectory, 'entity.json')
    await mkdir(entityDirectory, { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"name":"entity-template","version":"1.2.3","type":"module"}')
    await writeFile(entry, 'export function apply() {}\n')
    const entityText = `${
      JSON.stringify(
        {
          $schema: ENTITY_SCHEMA_V1,
          contract: 'cordisx.entity-file/v1',
          schemaVersion: 1,
          agentId: 'lead',
          name: 'Lead',
          inherit: {
            promptSections: 'none',
            rules: 'none',
            skills: 'none',
            tools: 'none',
            mcpServers: 'none',
            runtimeDefaults: 'none',
          },
        },
        null,
        2,
      )
    }\n`
    await writeFile(entityPath, entityText)
    const digest = entityTreeDigest(entityText, [])
    await writeFile(
      path.join(root, 'cordisx-package.json'),
      JSON.stringify({
        $schema: PACKAGE_SCHEMA_V5,
        schemaVersion: 5,
        compatibility: { protocolSchemas: [ENTITY_SCHEMA_V1] },
        dependencies: [],
        entityTemplates: [{ agentId: 'lead', entityPath: './entities/lead/entity.json', digest }],
      }),
    )
    const vite = await startTestViteServer({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'entity-template', entry, enabled: true, config: {} }],
    })
    try {
      const generations: Parameters<Parameters<typeof vite.synchronizePluginGenerations>[0]>[0][] = []
      await vite.synchronizePluginGenerations(async generation => {
        generations.push(generation)
        return { commit: async () => undefined, rollback: async () => undefined }
      })
      expect(generations).toHaveLength(1)
      expect(generations[0]).toMatchObject({
        pluginId: 'entity-template',
        version: '1.2.3',
        entityTemplates: [{ declaration: { agentId: 'lead', digest }, entityText }],
      })
    } finally {
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rolls the renderer generation back when the Host rejects its package-generation commit', async () => {
    const digest = `sha256:${'1'.repeat(64)}` as const
    const activation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'development',
      runtimeGeneration: 'runtime-generation',
      revision: 0,
      lastGoodRevision: 0,
      plugins: [],
    }
    const calls: string[] = []
    const mutations: unknown[] = []
    const runtime = {
      activePluginGeneration: () => activation,
      settleRegistryProjection: async () => {
        calls.push('settle')
      },
      stagePluginMutation: async (mutation: unknown) => {
        mutations.push(mutation)
        calls.push('renderer-stage')
      },
      publishPluginMutation: async () => {
        calls.push('publish')
      },
      completePluginMutation: async () => {
        calls.push('complete')
      },
      finalizePluginMutation: async () => {
        calls.push('finalize')
      },
      rollbackPluginMutation: async () => {
        calls.push('rollback')
      },
      dispose: async () => undefined,
    }
    const stageGeneration = vi.fn(async () => {
      calls.push('entity-stage')
      return {
        managedServiceUICapabilities: [{
          pluginId: 'entity-template',
          pluginGeneration: 'vite-generation',
          token: 'managed-token',
        }],
        async commit() {
          calls.push('entity-commit')
          throw new Error('entity template rejected')
        },
        async rollback() {
          calls.push('entity-rollback')
        },
      }
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new NativeViteDevelopmentClient(
      { profileId: 'development', generation: 'runtime-generation' } as never,
      [],
      () => undefined,
      stageGeneration,
    )
    try {
      await client.restart(async () => runtime as never)
      await expect(client.update({
        plugin: {
          id: 'entity-template',
          source: 'file:///entity-template.js',
          enabled: true,
          config: {},
          package: { version: '1.0.0', digest, moduleGeneration: 'vite-generation', dependencies: [] },
          development: {
            origin: 'local-dev',
            pluginId: 'entity-template',
            sourcePath: '/entity-template.ts',
            state: 'ready',
            lastSuccessfulAt: new Date(0).toISOString(),
          },
          module: { apply() {} },
        },
        ownerDocumentBindings: [],
      } as never)).rejects.toThrow('entity template rejected')
      expect(stageGeneration).toHaveBeenCalledWith('entity-template', 'vite-generation')
      expect(mutations).toEqual([expect.objectContaining({
        managedServiceUICapabilities: [{
          pluginId: 'entity-template',
          pluginGeneration: 'vite-generation',
          token: 'managed-token',
        }],
      })])
      expect(calls).toEqual([
        'settle',
        'entity-stage',
        'renderer-stage',
        'publish',
        'complete',
        'finalize',
        'entity-commit',
        'rollback',
        'entity-rollback',
      ])
    } finally {
      await client.dispose()
      consoleError.mockRestore()
    }
  })

  it('restores the last committed entity declarations when a Host generation commit fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-entity-rollback-'))
    const authority = new EntityDirectoryAuthority(root, 'development')
    const stage = createNativeViteEntityGenerationHandler(authority, 'development')
    const commit = async (generation: Parameters<typeof stage>[0]): Promise<void> => {
      const transaction = await stage(generation)
      await transaction.commit()
    }
    const entityText = `${
      JSON.stringify({
        $schema: ENTITY_SCHEMA_V1,
        contract: 'cordisx.entity-file/v1',
        schemaVersion: 1,
        agentId: 'lead',
        name: 'Lead',
        inherit: {
          promptSections: 'none',
          rules: 'none',
          skills: 'none',
          tools: 'none',
          mcpServers: 'none',
          runtimeDefaults: 'none',
        },
      })
    }\n`
    const digest = entityTreeDigest(entityText, [])
    const template = {
      declaration: { agentId: 'lead', entityPath: './entities/lead/entity.json' as const, digest },
      entityText,
      promptFiles: [],
    }
    const initial = {
      pluginId: 'entity-template',
      version: '1.0.0',
      digest: `sha256:${'3'.repeat(64)}` as const,
      moduleGeneration: 'vite-initial',
      entityTemplates: [template],
    }
    try {
      await commit(initial)
      const blockedText = entityText.replaceAll('lead', 'blocked').replace('Lead', 'Blocked')
      const blockedDigest = entityTreeDigest(blockedText, [])
      const blockedTemplate = {
        declaration: {
          agentId: 'blocked',
          entityPath: './entities/blocked/entity.json' as const,
          digest: blockedDigest,
        },
        entityText: blockedText,
        promptFiles: [],
      }
      await commit({
        pluginId: 'other-plugin',
        version: '1.0.0',
        digest: `sha256:${'6'.repeat(64)}`,
        moduleGeneration: 'vite-other',
        entityTemplates: [blockedTemplate],
      })
      const invalidDigest = `sha256:${'4'.repeat(64)}` as const
      await expect(commit({
        ...initial,
        digest: `sha256:${'5'.repeat(64)}`,
        moduleGeneration: 'vite-invalid',
        entityTemplates: [
          { ...template, declaration: { ...template.declaration, digest: invalidDigest } },
          blockedTemplate,
        ],
      })).rejects.toThrow('ownership-conflict')
      const binding = {
        profileId: 'development',
        installationId: entityInstallationId('development', 'entity-template'),
        pluginId: 'entity-template',
        pluginGeneration: entityPluginGeneration(initial.moduleGeneration),
      }
      await expect(authority.materialize(binding, initial.version, initial.digest, [template])).resolves.toMatchObject([
        { status: 'preserved', code: 'entity-present', agentId: 'lead' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
