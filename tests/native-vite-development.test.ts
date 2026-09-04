import { getEventListeners, once } from 'node:events'
import { access, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeViteEntityGenerationHandler, startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'
import { EntityDirectoryAuthority, entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { entityInstallationId, entityPluginGeneration } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { NativeViteDevelopmentClient } from '../packages/cli/src/renderer/vite-development-client.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const PACKAGE_SCHEMA_V5 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v5.schema.json'
const ENTITY_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'

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
  it('closes an idle server while retaining its reusable dependency cache', async () => {
    const vite = await startTestViteServer({
      version: 1, rootDir: process.cwd(), codex: { debugPort: 9229 }, providers: [], plugins: [],
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
    await expect(access(path.join(first.cacheDir, 'deps', '_metadata.json'))).resolves.toBeUndefined()
    await first.close()

    const second = await startNativeViteServer(config, { cacheRoot, prebundleHostDependencies: true })
    expect(second.cacheDir).toBe(first.cacheDir)
    await expect(access(path.join(second.cacheDir, 'deps', '_metadata.json'))).resolves.toBeUndefined()
    await second.close()
  }, 30_000)

  it('rejects a symlinked cache root before changing or using its target', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-cache-symlink-'))
    const target = path.join(parent, 'target')
    const cacheRoot = path.join(parent, 'cache-root')
    await mkdir(target, { mode: 0o755 })
    await symlink(target, cacheRoot, 'dir')
    try {
      await expect(startNativeViteServer({
        version: 1, rootDir: parent, codex: { debugPort: 9229 }, providers: [], plugins: [],
      }, { cacheRoot })).rejects.toThrow('cache path must be a real directory')
      expect((await stat(target)).mode & 0o777).toBe(0o755)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reuses renderer-only package validation instead of erasing formal dependencies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-dependencies-'))
    const entry = path.join(root, 'index.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"dependent","version":"1.0.0","type":"module"}')
    await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({
      dependencies: [{ id: 'base', version: '1.0.0' }],
    }))
    await writeFile(entry, 'export function apply() {}\n')
    try {
      await expect(startTestViteServer({
        version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [],
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
    const entityText = `${JSON.stringify({
      $schema: ENTITY_SCHEMA_V1,
      contract: 'cordisx.entity-file/v1',
      schemaVersion: 1,
      agentId: 'lead',
      name: 'Lead',
      inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    }, null, 2)}\n`
    await writeFile(entityPath, entityText)
    const digest = entityTreeDigest(entityText, [])
    await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({
      $schema: PACKAGE_SCHEMA_V5,
      schemaVersion: 5,
      compatibility: { protocolSchemas: [ENTITY_SCHEMA_V1] },
      dependencies: [],
      entityTemplates: [{ agentId: 'lead', entityPath: './entities/lead/entity.json', digest }],
    }))
    const vite = await startTestViteServer({
      version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [],
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
    const runtime = {
      activePluginGeneration: () => activation,
      settleRegistryProjection: async () => { calls.push('settle') },
      stagePluginMutation: async () => { calls.push('renderer-stage') },
      publishPluginMutation: async () => { calls.push('publish') },
      completePluginMutation: async () => { calls.push('complete') },
      finalizePluginMutation: async () => { calls.push('finalize') },
      rollbackPluginMutation: async () => { calls.push('rollback') },
      dispose: async () => undefined,
    }
    const stageGeneration = vi.fn(async () => {
      calls.push('entity-stage')
      return {
        async commit() {
          calls.push('entity-commit')
          throw new Error('entity template rejected')
        },
        async rollback() { calls.push('entity-rollback') },
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
          id: 'entity-template', source: 'file:///entity-template.js', enabled: true, config: {},
          package: { version: '1.0.0', digest, moduleGeneration: 'vite-generation', dependencies: [] },
          development: {
            origin: 'local-dev', pluginId: 'entity-template', sourcePath: '/entity-template.ts',
            state: 'ready', lastSuccessfulAt: new Date(0).toISOString(),
          },
          module: { apply() {} },
        },
        ownerDocumentBindings: [],
      } as never)).rejects.toThrow('entity template rejected')
      expect(stageGeneration).toHaveBeenCalledWith('entity-template', 'vite-generation')
      expect(calls).toEqual([
        'settle', 'entity-stage', 'renderer-stage', 'publish', 'complete', 'finalize',
        'entity-commit', 'rollback', 'entity-rollback',
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
    const entityText = `${JSON.stringify({
      $schema: ENTITY_SCHEMA_V1,
      contract: 'cordisx.entity-file/v1', schemaVersion: 1, agentId: 'lead', name: 'Lead',
      inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    })}\n`
    const digest = entityTreeDigest(entityText, [])
    const template = {
      declaration: { agentId: 'lead', entityPath: './entities/lead/entity.json' as const, digest },
      entityText,
      promptFiles: [],
    }
    const initial = {
      pluginId: 'entity-template', version: '1.0.0', digest: `sha256:${'3'.repeat(64)}` as const,
      moduleGeneration: 'vite-initial', entityTemplates: [template],
    }
    try {
      await commit(initial)
      const blockedText = entityText.replaceAll('lead', 'blocked').replace('Lead', 'Blocked')
      const blockedDigest = entityTreeDigest(blockedText, [])
      const blockedTemplate = {
        declaration: { agentId: 'blocked', entityPath: './entities/blocked/entity.json' as const, digest: blockedDigest },
        entityText: blockedText,
        promptFiles: [],
      }
      await commit({
        pluginId: 'other-plugin', version: '1.0.0', digest: `sha256:${'6'.repeat(64)}`,
        moduleGeneration: 'vite-other', entityTemplates: [blockedTemplate],
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

  it('keeps plugin source in Vite graph and sends file edits through Vite HMR', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-'))
    const entry = path.join(root, 'demo.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"demo","version":"1.0.0","type":"module"}')
    await writeFile(path.join(root, 'business-marker.ts'), "export const workspaceMarker = 'business-root';\n")
    await writeFile(entry, "export { workspaceMarker } from '/business-marker.ts'; export const revision = 'version-one'; export function apply() {}\n")
    await writeFile(path.join(root, 'README.md'), 'Plugin documentation survives Vite composition')
    const config = {
      version: 1 as const, rootDir: root, codex: { debugPort: 9229 }, providers: [],
      plugins: [
        { id: 'demo', entry, enabled: true, config: {} },
        { id: 'disabled', entry: path.join(root, 'missing.ts'), enabled: false, config: {} },
      ],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    const get = async (name: string) => {
      const response = await fetch(vite.url + name, { headers: { Origin: 'null' }, signal: AbortSignal.timeout(5000) })
      expect(response.status).toBe(200)
      return await response.text()
    }
    try {
      const composition = await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      expect(Buffer.byteLength(composition.source)).toBeLessThan(1024)
      expect(composition.source).not.toContain('version-one')
      const bootSource = await get('@id/__x00__virtual:cordisx-native-boot')
      expect(bootSource).toContain('virtual:cordisx-native-react-prepare')
      expect(bootSource.indexOf('virtual:cordisx-native-react-prepare')).toBeLessThan(bootSource.indexOf('virtual:cordisx-native-entry'))
      const entrySource = await get('@id/__x00__virtual:cordisx-native-entry')
      expect(entrySource).toContain('/renderer/runtime.ts')
      expect(entrySource).toContain('import.meta.hot.accept')
      expect(entrySource).toContain('modules.find(item => item.plugin.id === plugin.id)')
      expect(entrySource).not.toContain('modules.map(module => module.default)')
      expect(entrySource).toContain('Plugin documentation survives Vite composition')
      expect(entrySource).toContain('id: "disabled"')
      expect(entrySource).not.toContain('virtual:cordisx-native-plugin/disabled')
      const pluginUrl = '@id/__x00__virtual:cordisx-native-plugin/demo'
      const plugin = await get(pluginUrl)
      expect(plugin).not.toContain('version-one')
      expect(plugin).toContain('export async function load()')
      expect(plugin).toContain('module: pluginModule')
      expect(plugin).not.toContain('sourceMappingURL=data:')
      const mapUrl = plugin.match(/sourceMappingURL=(http:\/\/[^\s]+)/)?.[1]
      expect(mapUrl).toBeDefined()
      const map = await fetch(mapUrl!).then(response => response.json())
      expect(map).toBeTypeOf('object')
      const sourcePath = plugin.match(/import\("([^"]+\/demo\.ts)\?cordisx-plugin-generation=/)?.[1]
      expect(sourcePath).toBeDefined()
      const sourceUrl = new URL(sourcePath!, new URL(vite.url).origin).href
      const transformedSource = await fetch(sourceUrl).then(response => response.text())
      expect(transformedSource).toContain('version-one')
      const rootImport = transformedSource.match(/from "([^"]+\/business-marker\.ts)"/)?.[1]
      expect(rootImport).toBeDefined()
      await expect(fetch(new URL(rootImport!, new URL(vite.url).origin)).then(response => response.text())).resolves.toContain('business-root')
      const client = await get('@vite/client')
      expect(client).toContain('__cordisxViteHmrDispose')
      expect(client).toContain('transport.disconnect()')
      expect(client).toContain('removeStyle(id)')
      const disposeSource = client.match(/const __cordisxDisposeViteHmr = async \(\) => \{[\s\S]*?globalThis\.__cordisxViteHmrDispose = __cordisxDisposeViteHmr;/)?.[0]
      expect(disposeSource).toBeDefined()
      const fakeGlobal: Record<string, unknown> = {}
      const sheets = new Map([['component.css', {}]])
      const links = new Map([['theme.css', {}]])
      const observations: string[] = []
      const state = Function('sheetsMap', 'linkSheetsMap', 'removeStyle', 'transport', 'globalThis', `
        let willUnload = false;
        ${disposeSource}
        return { getWillUnload: () => willUnload };
      `)(sheets, links, (id: string) => { sheets.delete(id); links.delete(id) }, {
        connect: async () => { observations.push(`connect:${String(state.getWillUnload())}`) },
        disconnect: async () => { observations.push(`disconnect:${String(state.getWillUnload())}`) },
      }, fakeGlobal) as { readonly getWillUnload: () => boolean }
      await (fakeGlobal.__cordisxViteHmrDispose as () => Promise<void>)()
      expect(observations).toEqual(['connect:true', 'disconnect:true'])
      expect(sheets.size + links.size).toBe(0)
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', { handshakeTimeout: 5000 })
      await once(socket, 'open')
      const messages: Record<string, unknown>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))
      await writeFile(entry, "export { workspaceMarker } from '/business-marker.ts'; export const revision = 'version-two'; export function apply() {}\n")
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'demo')).toBe(true), { timeout: 10_000 })
      expect(messages.some(message => message.type === 'full-reload')).toBe(false)
      expect(await fetch(sourceUrl + '?t=' + Date.now()).then(response => response.text())).toContain('version-two')
      expect(await get(pluginUrl + '?t=' + Date.now())).not.toContain('version-two')
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
    await expect(fetch(vite.url)).rejects.toThrow()
  }, 30_000)

  it('uses React Fast Refresh for component leaves and exposes targeted manual reload over Vite HMR', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-react-'))
    const entry = path.join(root, 'index.tsx')
    const component = path.join(root, 'Counter.tsx')
    await writeFile(path.join(root, 'package.json'), '{"name":"react-demo","version":"1.0.0","type":"module"}')
    await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"cordisx/react"}}')
    await writeFile(entry, "export { Counter } from './Counter.js'; export function PluginBadge() { return <span>plugin</span> }; export function apply() {}\n")
    await writeFile(component, "import { useState } from 'cordisx/react'; export function Counter() { const [n] = useState(1); return <button>{n}</button> }\n")
    const config = {
      version: 1 as const, rootDir: root, codex: { debugPort: 9229 }, providers: [],
      plugins: [{ id: 'react-demo', entry, enabled: true, config: {} }],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const request = async (pathname: string): Promise<string> => await fetch(new URL(pathname, new URL(vite.url).origin), {
        headers: { Origin: 'null' }, signal: AbortSignal.timeout(5000),
      }).then(async response => {
        expect(response.status).toBe(200)
        return await response.text()
      })
      const pluginPath = new URL(vite.url).pathname + '@id/__x00__virtual:cordisx-native-plugin/react-demo'
      const wrapper = await request(pluginPath)
      const firstDigest = wrapper.match(/sha256:[a-f0-9]{64}/)?.[0]
      expect(firstDigest).toBeDefined()
      const entryPath = wrapper.match(/import\("([^"]+\/index\.tsx\?cordisx-plugin-generation=[^"]+)"\)/)?.[1]
      expect(entryPath).toBeDefined()
      const transformedEntry = await request(entryPath!)
      expect(transformedEntry).toContain('$RefreshReg$')
      const componentPath = transformedEntry.match(/from "([^"]+\/Counter\.tsx(?:\?[^\"]*)?)"/)?.[1]
      expect(componentPath).toBeDefined()
      const transformedComponent = await request(componentPath!)
      expect(transformedComponent).toContain('$RefreshReg$')
      expect(transformedComponent).toContain('import.meta.hot.accept')
      const componentHotPath = transformedComponent.match(/createHotContext\("([^"]+)"\)/)?.[1]
      expect(componentHotPath).toBeDefined()

      const client = await request(new URL(vite.url).pathname + '@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', { handshakeTimeout: 5000 })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))

      await writeFile(entry, "export { Counter } from './Counter.js'; export function PluginBadge() { return <span>plugin changed</span> }; export function apply() { return 'changed' }\n")
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'react-demo')).toBe(true), { timeout: 10_000 })
      const entryDigest = (await request(pluginPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]
      expect(entryDigest).not.toBe(firstDigest)
      messages.length = 0

      await writeFile(component, "import { useState } from 'cordisx/react'; export function Counter() { const [n] = useState(1); return <button>updated {n}</button> }\n")
      await vi.waitFor(() => expect(messages.some(message => message.type === 'update')).toBe(true), { timeout: 10_000 })
      const update = messages.find(message => message.type === 'update')
      expect(update.updates.some((item: any) => item.path.includes('Counter.tsx') && item.acceptedPath.includes('Counter.tsx'))).toBe(true)
      expect(messages.some(message => message.type === 'full-reload')).toBe(false)
      expect((await request(pluginPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(entryDigest)

      messages.length = 0
      socket.send(JSON.stringify({
        type: 'custom', event: 'vite:invalidate',
        data: { path: componentHotPath, firstInvalidatedBy: componentHotPath, message: 'incompatible mixed export' },
      }))
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'react-demo')).toBe(true), { timeout: 10_000 })
      const invalidated = messages.find(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'react-demo')
      const invalidatedDigest = (await request(pluginPath + '?t=' + invalidated.data.timestamp)).match(/sha256:[a-f0-9]{64}/)?.[0]
      expect(invalidatedDigest).not.toBe(entryDigest)

      messages.length = 0
      const requestId = 'manual-reload-test'
      socket.send(JSON.stringify({ type: 'custom', event: 'cordisx:reload-plugin', data: { pluginId: 'react-demo', requestId } }))
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:reload-plugin-result'
        && message.data?.requestId === requestId)).toBe(true), { timeout: 10_000 })
      const result = messages.find(message => message.type === 'custom'
        && message.event === 'cordisx:reload-plugin-result'
        && message.data?.requestId === requestId)
      expect(result.data.error).toBeUndefined()
      const reloaded = await request(pluginPath + '?t=' + result.data.timestamp)
      expect(reloaded.match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(invalidatedDigest)
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('serves multiple plugin entries from one Vite session and scopes source updates to their owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-multi-'))
    const first = path.join(root, 'plugins', 'first.ts')
    const second = path.join(root, 'plugins', 'second.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"multi-demo","version":"1.0.0","type":"module"}')
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }), mkdir(path.dirname(second), { recursive: true }),
    ])
    await writeFile(first, "import { marker as secondMarker } from './second.js'; export const marker = 'first-one-' + secondMarker; export function apply() {}\n")
    await writeFile(second, "export const marker = 'second-one'; export function apply() {}\n")
    const config = {
      version: 1 as const, rootDir: root, codex: { debugPort: 9229 }, providers: [],
      plugins: [
        { id: 'first', entry: first, enabled: true, config: {} },
        { id: 'second', entry: second, enabled: true, config: {} },
      ],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    const get = async (name: string) => await fetch(vite.url + name, {
      headers: { Origin: 'null' }, signal: AbortSignal.timeout(5000),
    }).then(async response => {
      expect(response.status).toBe(200)
      return await response.text()
    })
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const entrySource = await get('@id/__x00__virtual:cordisx-native-entry')
      expect(entrySource).toContain('virtual:cordisx-native-plugin/first')
      expect(entrySource).toContain('virtual:cordisx-native-plugin/second')
      const firstPath = '@id/__x00__virtual:cordisx-native-plugin/first'
      const secondPath = '@id/__x00__virtual:cordisx-native-plugin/second'
      const firstBefore = await get(firstPath)
      const secondBefore = await get(secondPath)
      const firstEntryPath = firstBefore.match(/import\("([^"]+\/first\.ts\?cordisx-plugin-generation=[^"]+)"\)/)?.[1]
      expect(firstEntryPath).toBeDefined()
      await expect(fetch(new URL(firstEntryPath!, new URL(vite.url).origin)).then(response => response.status)).resolves.toBe(200)
      const firstDigest = firstBefore.match(/sha256:[a-f0-9]{64}/)?.[0]
      const secondDigest = secondBefore.match(/sha256:[a-f0-9]{64}/)?.[0]
      const client = await get('@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', { handshakeTimeout: 5000 })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))
      await writeFile(first, "import { marker as secondMarker } from './second.js'; export const marker = 'first-two-' + secondMarker; export function apply() {}\n")
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'first')).toBe(true), { timeout: 10_000 })
      expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'second'), JSON.stringify(messages)).toBe(false)
      expect((await get(firstPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(firstDigest)
      expect((await get(secondPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(secondDigest)

      messages.length = 0
      await writeFile(second, "export const marker = 'second-two'; export function apply() {}\n")
      await vi.waitFor(() => {
        const replacements = messages.filter(message => message.type === 'custom'
          && message.event === 'cordisx:replace-plugin').map(message => message.data?.pluginId)
        expect(replacements).toContain('first')
        expect(replacements).toContain('second')
      }, { timeout: 10_000 })
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('reloads only the embedded plugin that owns a changed README', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-readmes-'))
    const firstRoot = path.join(root, 'plugins', 'first')
    const secondRoot = path.join(root, 'plugins', 'second')
    const first = path.join(firstRoot, 'src', 'index.ts')
    const second = path.join(secondRoot, 'src', 'index.ts')
    const firstReadme = path.join(firstRoot, 'README.md')
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }), mkdir(path.dirname(second), { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(root, 'package.json'), '{"name":"embedded-demo","version":"1.0.0","type":"module"}'),
      writeFile(firstReadme, '# First plugin\n'),
      writeFile(path.join(secondRoot, 'README.md'), '# Second plugin\n'),
      writeFile(first, 'export function apply() {}\n'),
      writeFile(second, 'export function apply() {}\n'),
    ])
    const config = {
      version: 1 as const, rootDir: root, codex: { debugPort: 9229 }, providers: [],
      plugins: [
        { id: 'first', entry: first, enabled: true, config: {} },
        { id: 'second', entry: second, enabled: true, config: {} },
      ],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    const get = async (name: string) => await fetch(vite.url + name, {
      headers: { Origin: 'null' }, signal: AbortSignal.timeout(5000),
    }).then(async response => {
      expect(response.status).toBe(200)
      return await response.text()
    })
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const firstPath = '@id/__x00__virtual:cordisx-native-plugin/first'
      const secondPath = '@id/__x00__virtual:cordisx-native-plugin/second'
      const firstDigest = (await get(firstPath)).match(/sha256:[a-f0-9]{64}/)?.[0]
      const secondDigest = (await get(secondPath)).match(/sha256:[a-f0-9]{64}/)?.[0]
      const client = await get('@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', { handshakeTimeout: 5000 })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))

      await writeFile(firstReadme, '# First plugin updated\n')
      await vi.waitFor(() => expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'first')).toBe(true), { timeout: 10_000 })
      expect(messages.some(message => message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'second')).toBe(false)
      expect((await get(firstPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(firstDigest)
      expect((await get(secondPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(secondDigest)
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('waits for the Vite bootstrap acknowledgement and restores the development CSP setting on disposal', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let acknowledge!: () => void
    let bootChecks = 0
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      socket.on('message', data => {
      const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
      requests.push(request)
      const reply = () => socket.send(JSON.stringify({ id: request.id, result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: 'vite-bootstrap' } : { result: { value: { ok: true } } } }))
      if (String(request.params.expression).includes('await globalThis.__cordisxViteBoot')) {
        bootChecks += 1
        if (bootChecks === 1) {
          socket.send(JSON.stringify({ id: request.id, result: { result: { value: { ok: false, error: 'cordisx:vite-boot-pending' } } } }))
        } else acknowledge = reply
      }
      else {
        reply()
        if (request.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      }
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: 'native-vite', title: 'Codex', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/native` },
      { id: 'web-chatgpt', title: 'ChatGPT', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/web` },
    ]))) as typeof fetch
    const ready = vi.fn()
    const controller = new AbortController()
    let installId: string | undefined
    const watching = watchAndInject({ port, source: 'small-vite-entry', viteDevelopment: true, signal: controller.signal, onReady: ready })
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
      expect(ready).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 5_100))
      expect(ready).not.toHaveBeenCalled()
      acknowledge()
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
      expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([true])
      expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(['granted'])
      expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(1)
      const installedSource = String(requests.find(item => item.method === 'Page.addScriptToEvaluateOnNewDocument')?.params.source)
      installId = installedSource.match(/__cordisxViteInstallId = "([^"]+)"/)?.[1]
      expect(installId).toBeDefined()
      const acknowledgementSource = String(requests.find(item => item.method === 'Runtime.evaluate'
        && String(item.params.expression).includes('cordisx:vite-boot-pending'))?.params.expression)
      expect(acknowledgementSource).toContain(`__cordisxViteInstallId !== "${installId}"`)
      expect(bootChecks).toBe(2)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([true, false])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(['granted', 'prompt'])
    expect(requests.some(item => String(item.params.expression).includes('__cordisxViteClient?.dispose'))).toBe(true)
    expect(requests.some(item => String(item.params.expression).includes('__cordisxViteHmrDispose?.()'))).toBe(true)
    const cleanupExpression = String(requests.find(item => item.method === 'Runtime.evaluate'
      && String(item.params.expression).includes('__cordisxViteHmrDispose?.()'))?.params.expression)
    const cleanupCalls: string[] = []
    const cleanupGlobal: Record<string, unknown> = {
      __cordisxViteClient: { dispose: async () => { cleanupCalls.push('client'); throw new Error('plugin cleanup failed') } },
      __cordisxSharedReactRuntime: { dispose: () => { cleanupCalls.push('react') } },
      __cordisxViteHmrDispose: async () => { cleanupCalls.push('hmr') },
      __cordisxViteBoot: Promise.resolve(),
      __cordisxViteInstallId: installId,
    }
    await expect(Function('globalThis', `return ${cleanupExpression}`)(cleanupGlobal)).rejects.toThrow('plugin cleanup failed')
    expect(cleanupCalls).toEqual(['client', 'react', 'hmr'])
    expect(cleanupGlobal).toEqual({})
    expect(connections).toBe(1)
  }, 30_000)

  it('restores a loopback grant through the browser endpoint after the native target disconnects', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { path: string; method: string; params: Record<string, unknown> }[] = []
    let targetSocket: WebSocket | undefined
    server.on('connection', (socket, request) => {
      const socketPath = request.url ?? ''
      if (socketPath === '/native') targetSocket = socket as unknown as WebSocket
      socket.on('message', data => {
        const item = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        requests.push({ path: socketPath, method: item.method, params: item.params })
        socket.send(JSON.stringify({
          id: item.id,
          result: item.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'vite-bootstrap' }
            : { result: { value: { ok: true } } },
        }))
        if (item.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      })
    })
    let targets = [{
      id: 'native-vite', title: 'ChatGPT', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/native`,
    }]
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async input => String(input).endsWith('/json/version')
      ? new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }))
      : new Response(JSON.stringify(targets))) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port, source: 'small-vite-entry', viteDevelopment: true, signal: controller.signal, onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 })
      targets = []
      targetSocket?.close()
      await vi.waitFor(() => expect(requests.some(item => item.path === '/browser'
        && item.method === 'Browser.setPermission' && item.params.setting === 'prompt')).toBe(true), { timeout: 10_000 })
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
  }, 30_000)

  it('keeps browser-scoped loopback permission until the last native window is removed', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    server.on('connection', socket => socket.on('message', data => {
      const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
      requests.push(request)
      socket.send(JSON.stringify({
        id: request.id,
        result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
          ? { identifier: `vite-bootstrap-${request.id}` }
          : { result: { value: { ok: true } } },
      }))
      if (request.method === 'Page.reload') {
        queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
      }
    }))
    const targets = [
      { id: 'native-main', title: 'ChatGPT', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` },
      { id: 'native-secondary', title: 'ChatGPT', type: 'page', url: 'app://-/secondary.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/secondary` },
    ]
    let currentTargets = targets
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(currentTargets))) as typeof fetch
    const controller = new AbortController()
    const ready = vi.fn()
    const watching = watchAndInject({
      port, source: 'small-vite-entry', viteDevelopment: true,
      signal: controller.signal, onReady: ready,
    })
    try {
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2), { timeout: 10_000 })
      expect(requests.filter(item => item.method === 'Browser.setPermission'
        && item.params.setting === 'granted')).toHaveLength(1)
      currentTargets = [targets[1]!]
      await vi.waitFor(() => expect(requests.filter(item => item.method === 'Page.setBypassCSP'
        && item.params.enabled === false)).toHaveLength(1), { timeout: 10_000 })
      expect(requests.some(item => item.method === 'Browser.setPermission'
        && item.params.setting === 'prompt')).toBe(false)
    } finally {
      controller.abort()
      await watching
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.filter(item => item.method === 'Browser.setPermission'
      && item.params.setting === 'prompt')).toHaveLength(1)
  }, 30_000)

  it.each(['add-script', 'reload', 'bootstrap'] as const)('aborts a pending native Vite %s without reporting an installation failure and runs cleanup', async pendingPhase => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let bootChecks = 0
    server.on('connection', socket => {
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        requests.push(request)
        const bootCheck = request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('cordisx:vite-boot-pending')
        if (bootCheck) bootChecks += 1
        if (pendingPhase === 'add-script' && request.method === 'Page.addScriptToEvaluateOnNewDocument') return
        if (pendingPhase === 'reload' && request.method === 'Page.reload') return
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'pending-vite-bootstrap' }
            : { result: { value: bootCheck
              ? { ok: false, error: 'cordisx:vite-boot-pending' }
              : { ok: true } } },
        }))
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'native-vite-pending', title: 'Codex', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
    }]))) as typeof fetch
    const controller = new AbortController()
    const watching = watchAndInject({ port, source: 'pending-vite-entry', viteDevelopment: true, signal: controller.signal })
    try {
      if (pendingPhase === 'add-script') {
        await vi.waitFor(() => expect(requests.some(item => item.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true))
      } else if (pendingPhase === 'reload') {
        await vi.waitFor(() => expect(requests.some(item => item.method === 'Page.reload')).toBe(true))
      } else {
        await vi.waitFor(() => expect(bootChecks).toBeGreaterThanOrEqual(5))
      }
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(pendingPhase === 'add-script' ? 0 : 1)
      const startedAt = Date.now()
      controller.abort()
      await expect(watching).resolves.toBeUndefined()
      expect(Date.now() - startedAt).toBeLessThan(pendingPhase === 'add-script' ? 6_000 : 1_000)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      controller.abort()
      await watching.catch(() => undefined)
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(pendingPhase !== 'add-script')
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([true, false])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(['granted', 'prompt'])
  }, 30_000)

  it('fails one broken native Vite installation without entering the CDP retry loop', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const requests: { method: string; params: Record<string, unknown> }[] = []
    let connections = 0
    server.on('connection', socket => {
      connections += 1
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
        requests.push(request)
        const failedBoot = request.method === 'Runtime.evaluate'
          && String(request.params.expression).includes('await globalThis.__cordisxViteBoot')
        socket.send(JSON.stringify({
          id: request.id,
          result: request.method === 'Page.addScriptToEvaluateOnNewDocument'
            ? { identifier: 'failed-vite-bootstrap' }
            : failedBoot ? { result: { value: { ok: false, error: 'fixture Vite module failed' } } }
              : { result: { value: { ok: true } } },
        }))
        if (request.method === 'Page.reload') {
          queueMicrotask(() => socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })))
        }
      })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: 'native-vite-failure', title: 'Codex', type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
    }]))) as typeof fetch
    const controller = new AbortController()
    try {
      await expect(watchAndInject({ port, source: 'broken-vite-entry', viteDevelopment: true, signal: controller.signal }))
        .rejects.toThrow('CordisX Vite renderer installation failed: fixture Vite module failed')
    } finally {
      controller.abort()
      globalThis.fetch = originalFetch
      server.close()
      await once(server, 'close')
    }
    expect(connections).toBe(1)
    expect(requests.filter(item => item.method === 'Page.reload')).toHaveLength(1)
    expect(requests.filter(item => item.method === 'Page.setBypassCSP').map(item => item.params.enabled)).toEqual([true, false])
    expect(requests.filter(item => item.method === 'Browser.setPermission').map(item => item.params.setting)).toEqual(['granted', 'prompt'])
    expect(requests.some(item => item.method === 'Page.removeScriptToEvaluateOnNewDocument')).toBe(true)
  })
})
