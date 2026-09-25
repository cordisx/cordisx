import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'

const PACKAGE_SCHEMA_V8 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v8.schema.json'
const RUNTIME_SCHEMA_V8 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json'

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

describe('native Vite plugin graph development', () => {
  it('keeps plugin source in Vite graph and sends file edits through Vite HMR', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-'))
    const entry = path.join(root, 'demo.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"demo","version":"1.0.0","type":"module"}')
    await writeFile(path.join(root, 'business-marker.ts'), "export const workspaceMarker = 'business-root';\n")
    await writeFile(
      entry,
      "export { workspaceMarker } from '/business-marker.ts'; export const revision = 'version-one'; export function apply() {}\n",
    )
    await writeFile(path.join(root, 'README.md'), 'Plugin documentation survives Vite composition')
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
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
      expect(bootSource).toContain("import.meta.hot.on('cordisx:restart-host'")
      expect(bootSource).toContain("virtual:cordisx-native-entry\" + '?t=' + Date.now()")
      expect(bootSource.indexOf('virtual:cordisx-native-react-prepare')).toBeLessThan(
        bootSource.indexOf('virtual:cordisx-native-entry'),
      )
      const entrySource = await get('@id/__x00__virtual:cordisx-native-entry')
      expect(entrySource).toContain('/renderer/runtime.ts')
      expect(entrySource).toContain('import.meta.hot.accept')
      expect(entrySource).toContain('modules.find(item => item.plugin.id === plugin.id)')
      expect(entrySource).toContain('previous?.releaseCertifiedPermissionChannel()')
      expect(entrySource).toContain('await previous.dispose(true)')
      expect(entrySource).toContain('stagePluginGeneration, certifiedPermissionChannel)')
      expect(entrySource.indexOf('previous?.releaseCertifiedPermissionChannel()')).toBeLessThan(
        entrySource.indexOf('await previous.dispose(true)'),
      )
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
      await expect(fetch(new URL(rootImport!, new URL(vite.url).origin)).then(response => response.text())).resolves
        .toContain('business-root')
      const client = await get('@vite/client')
      expect(client).toContain('__cordisxViteHmrDispose')
      expect(client).toContain('transport.disconnect()')
      expect(client).toContain('removeStyle(id)')
      const disposeSource = client.match(
        /const __cordisxDisposeViteHmr = async \(\) => \{[\s\S]*?globalThis\.__cordisxViteHmrDispose = __cordisxDisposeViteHmr;/,
      )?.[0]
      expect(disposeSource).toBeDefined()
      const fakeGlobal: Record<string, unknown> = {}
      const sheets = new Map([['component.css', {}]])
      const links = new Map([['theme.css', {}]])
      const observations: string[] = []
      const state = Function(
        'sheetsMap',
        'linkSheetsMap',
        'removeStyle',
        'transport',
        'globalThis',
        `
        let willUnload = false;
        ${disposeSource}
        return { getWillUnload: () => willUnload };
      `,
      )(sheets, links, (id: string) => {
        sheets.delete(id)
        links.delete(id)
      }, {
        connect: async () => {
          observations.push(`connect:${String(state.getWillUnload())}`)
        },
        disconnect: async () => {
          observations.push(`disconnect:${String(state.getWillUnload())}`)
        },
      }, fakeGlobal) as { readonly getWillUnload: () => boolean }
      await (fakeGlobal.__cordisxViteHmrDispose as () => Promise<void>)()
      expect(observations).toEqual(['connect:true', 'disconnect:true'])
      expect(sheets.size + links.size).toBe(0)
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', {
        handshakeTimeout: 5000,
      })
      await once(socket, 'open')
      const messages: Record<string, unknown>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))
      await writeFile(
        entry,
        "export { workspaceMarker } from '/business-marker.ts'; export const revision = 'version-two'; export function apply() {}\n",
      )
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'demo'
        )).toBe(true), { timeout: 10_000 })
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

  it('keeps transient-canvas plugin code out of the renderer module graph', async () => {
    const root = path.resolve('tests/fixtures/send-confetti-plugin')
    const entry = path.join(root, 'src/send-confetti.ts')
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'send-confetti', entry, enabled: true, config: {} }],
    }
    const vite = await startTestViteServer(config)
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const get = async (name: string): Promise<string> =>
        await fetch(vite.url + name, {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5000),
        }).then(async response => {
          expect(response.status).toBe(200)
          return await response.text()
        })
      const entrySource = await get('@id/__x00__virtual:cordisx-native-entry')
      const pluginSource = await get('@id/__x00__virtual:cordisx-native-plugin/send-confetti')

      expect(entrySource).not.toContain('ctx.transientCanvas.register')
      expect(pluginSource).toContain('isolatedArtifactSource')
      expect(pluginSource).toContain('ctx.transientCanvas.register')
      expect(pluginSource).toContain('"schemaVersion":7')
      expect(pluginSource).not.toContain('module: pluginModule')
      expect(pluginSource).not.toContain('/send-confetti.ts?cordisx-plugin-generation=')
    } finally {
      await vite.close()
    }
  }, 30_000)

  it('keeps a structured v8 package in the renderer graph across consecutive replacements', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-structured-v8-'))
    const entry = path.join(root, 'structured-v8.ts')
    const runtimeManifest = JSON.stringify(
      {
        $schema: RUNTIME_SCHEMA_V8,
        schemaVersion: 8,
        id: 'structured-v8',
        name: 'Structured v8',
        capabilities: [],
        services: [],
      },
      null,
      2,
    ) + '\n'
    const runtimeDigest = `sha256:${createHash('sha256').update(runtimeManifest).digest('hex')}`
    await Promise.all([
      writeFile(path.join(root, 'package.json'), '{"name":"structured-v8","version":"1.0.0","type":"module"}'),
      writeFile(path.join(root, 'runtime-manifest.json'), runtimeManifest),
      writeFile(
        path.join(root, 'cordisx-package.json'),
        JSON.stringify({
          $schema: PACKAGE_SCHEMA_V8,
          schemaVersion: 8,
          id: 'structured-v8',
          version: '1.0.0',
          entry: './dist/structured-v8.js',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: { runtimeAbi: 1, protocolSchemas: [RUNTIME_SCHEMA_V8] },
          dependencies: [],
          runtimeManifest: { path: './runtime-manifest.json', schema: RUNTIME_SCHEMA_V8, digest: runtimeDigest },
        }),
      ),
      writeFile(entry, "export const revision = 'one'; export function apply() {}\n"),
    ])
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'structured-v8', entry, enabled: true, config: {} }],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (value, options) => vite.buildBootstrap(value, options ?? {}),
      })
      const request = async (pathname: string): Promise<string> =>
        await fetch(vite.url + pathname, {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5000),
        }).then(async response => {
          expect(response.status).toBe(200)
          return await response.text()
        })
      const pluginPath = '@id/__x00__virtual:cordisx-native-plugin/structured-v8'
      const assertStructuredWrapper = (source: string): string => {
        expect(source).toContain('module: pluginModule')
        expect(source).toContain('"schemaVersion":8')
        expect(source).not.toContain('isolatedArtifactSource')
        expect(source).toContain('/structured-v8.ts?cordisx-plugin-generation=')
        const digest = source.match(/sha256:[a-f0-9]{64}/)?.[0]
        expect(digest).toBeDefined()
        return digest!
      }
      let digest = assertStructuredWrapper(await request(pluginPath))
      const client = await request('@vite/client')
      const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
      expect(token).toBeDefined()
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', {
        handshakeTimeout: 5000,
      })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))

      for (const revision of ['two', 'three']) {
        messages.length = 0
        await writeFile(entry, `export const revision = '${revision}'; export function apply() {}\n`)
        await vi.waitFor(() =>
          expect(messages.some(message =>
            message.type === 'custom'
            && message.event === 'cordisx:replace-plugin'
            && message.data?.pluginId === 'structured-v8'
          )).toBe(true), { timeout: 10_000 })
        const replacement = messages.find(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'structured-v8'
        )
        const nextDigest = assertStructuredWrapper(await request(pluginPath + '?t=' + replacement.data.timestamp))
        expect(nextDigest).not.toBe(digest)
        digest = nextDigest
      }
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('uses React Fast Refresh for component leaves and exposes targeted manual reload over Vite HMR', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-react-'))
    const entry = path.join(root, 'index.tsx')
    const component = path.join(root, 'Counter.tsx')
    await writeFile(path.join(root, 'package.json'), '{"name":"react-demo","version":"1.0.0","type":"module"}')
    await writeFile(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"cordisx/react"}}',
    )
    await writeFile(
      entry,
      "export { Counter } from './Counter.js'; export function PluginBadge() { return <span>plugin</span> }; export function apply() {}\n",
    )
    await writeFile(
      component,
      "import { useState } from 'cordisx/react'; export function Counter() { const [n] = useState(1); return <button>{n}</button> }\n",
    )
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'react-demo', entry, enabled: true, config: {} }],
    }
    const vite = await startTestViteServer(config)
    let socket: WebSocket | undefined
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const request = async (pathname: string): Promise<string> =>
        await fetch(new URL(pathname, new URL(vite.url).origin), {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5000),
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
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', {
        handshakeTimeout: 5000,
      })
      await once(socket, 'open')
      const messages: Record<string, any>[] = []
      socket.on('message', data => messages.push(JSON.parse(String(data))))

      await writeFile(
        entry,
        "export { Counter } from './Counter.js'; export function PluginBadge() { return <span>plugin changed</span> }; export function apply() { return 'changed' }\n",
      )
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'react-demo'
        )).toBe(true), { timeout: 10_000 })
      const entryDigest = (await request(pluginPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]
      expect(entryDigest).not.toBe(firstDigest)
      messages.length = 0

      await writeFile(
        component,
        "import { useState } from 'cordisx/react'; export function Counter() { const [n] = useState(1); return <button>updated {n}</button> }\n",
      )
      await vi.waitFor(() => expect(messages.some(message => message.type === 'update')).toBe(true), {
        timeout: 10_000,
      })
      const update = messages.find(message => message.type === 'update')
      expect(
        update.updates.some((item: any) =>
          item.path.includes('Counter.tsx') && item.acceptedPath.includes('Counter.tsx')
        ),
      ).toBe(true)
      expect(messages.some(message => message.type === 'full-reload')).toBe(false)
      expect((await request(pluginPath + '?t=' + Date.now())).match(/sha256:[a-f0-9]{64}/)?.[0]).toBe(entryDigest)

      messages.length = 0
      socket.send(JSON.stringify({
        type: 'custom',
        event: 'vite:invalidate',
        data: { path: componentHotPath, firstInvalidatedBy: componentHotPath, message: 'incompatible mixed export' },
      }))
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:replace-plugin'
          && message.data?.pluginId === 'react-demo'
        )).toBe(true), { timeout: 10_000 })
      const invalidated = messages.find(message =>
        message.type === 'custom'
        && message.event === 'cordisx:replace-plugin'
        && message.data?.pluginId === 'react-demo'
      )
      const invalidatedDigest = (await request(pluginPath + '?t=' + invalidated.data.timestamp)).match(
        /sha256:[a-f0-9]{64}/,
      )?.[0]
      expect(invalidatedDigest).not.toBe(entryDigest)

      messages.length = 0
      const requestId = 'manual-reload-test'
      socket.send(
        JSON.stringify({ type: 'custom', event: 'cordisx:reload-plugin', data: { pluginId: 'react-demo', requestId } }),
      )
      await vi.waitFor(() =>
        expect(messages.some(message =>
          message.type === 'custom'
          && message.event === 'cordisx:reload-plugin-result'
          && message.data?.requestId === requestId
        )).toBe(true), { timeout: 10_000 })
      const result = messages.find(message =>
        message.type === 'custom'
        && message.event === 'cordisx:reload-plugin-result'
        && message.data?.requestId === requestId
      )
      expect(result.data.error).toBeUndefined()
      const reloaded = await request(pluginPath + '?t=' + result.data.timestamp)
      expect(reloaded.match(/sha256:[a-f0-9]{64}/)?.[0]).not.toBe(invalidatedDigest)
    } finally {
      socket?.close()
      await vite.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
