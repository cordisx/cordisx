import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'

it('replaces nested helper exports through fresh plugin URLs while retaining the shared React URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-helper-'))
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-helper-cache-'))
  const entry = path.join(root, 'src/index.ts')
  const leaf = path.join(root, 'src/nested/leaf.ts')
  await mkdir(path.dirname(leaf), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"helper-demo","version":"1.0.0","type":"module"}')
  await writeFile(entry, "export { marker } from './nested/middle.js'; export function apply() {}\n")
  await writeFile(
    path.join(root, 'src/nested/middle.ts'),
    "import { value } from './leaf.js'; import { useState } from 'cordisx/react'; export const marker = value; export const shared = useState;\n",
  )
  await writeFile(leaf, "export const value = 'before';\n")
  const config = {
    version: 1 as const,
    rootDir: root,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{ id: 'helper-demo', entry, enabled: true, config: {} }],
  }
  const vite = await startNativeViteServer(config, { cacheRoot })
  let socket: WebSocket | undefined
  const origin = new URL(vite.url).origin
  const get = async (url: string) => {
    const response = await fetch(new URL(url, origin), { signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    return response.text()
  }
  // Model the browser's URL-keyed ESM cache while evaluating the real Vite-served sources.
  const cache = new Map<string, Promise<string>>()
  const sharedUrls: string[] = []
  const moduleUrl = (url: string): Promise<string> => {
    const previous = cache.get(url)
    if (previous) return previous
    const pending = (async () => {
      let source = await get(url)
      for (const match of [...source.matchAll(/(?:from\s*|import\s*)"([^"]+)"/g)]) {
        const dependency = match[1]!
        let replacement: string
        if (dependency.includes('virtual:cordisx-native-shared/')) {
          sharedUrls.push(dependency)
          replacement = 'data:text/javascript,export%20function%20useState()%20%7B%7D'
        } else replacement = await moduleUrl(dependency)
        source = source.replace(JSON.stringify(dependency), JSON.stringify(replacement))
      }
      return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    })()
    cache.set(url, pending)
    return pending
  }
  const pluginPath = new URL(vite.url).pathname + '@id/__x00__virtual:cordisx-native-plugin/helper-demo'
  const load = async (suffix = '') => {
    const wrapper = await get(pluginPath + suffix)
    const entryUrl = wrapper.match(/import\("([^"]+\/index\.ts\?cordisx-plugin-generation=[^"]+)"\)/)?.[1]
    expect(entryUrl).toBeDefined()
    return import(await moduleUrl(entryUrl!))
  }
  try {
    await buildRendererComposition(config, () => {}, {
      developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
    })
    expect((await load()).marker).toBe('before')
    const firstShared = sharedUrls[0]
    expect(firstShared).toBeDefined()
    const client = await get(new URL(vite.url).pathname + '@vite/client')
    const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
    socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr')
    await once(socket, 'open')
    const messages: { type: string; event?: string; data?: { pluginId?: string; timestamp: number } }[] = []
    socket.on('message', data => messages.push(JSON.parse(String(data))))
    await writeFile(leaf, "export const value = 'after';\n")
    await vi.waitFor(() => expect(messages.some(message => message.event === 'cordisx:replace-plugin')).toBe(true), {
      timeout: 10_000,
    })
    const replacement = messages.find(message => message.event === 'cordisx:replace-plugin')!
    expect((await load('?t=' + replacement.data!.timestamp)).marker).toBe('after')
    expect(sharedUrls).toHaveLength(2)
    expect(sharedUrls[1]).toBe(firstShared)
    expect(messages.some(message => message.type === 'full-reload' || message.event === 'cordisx:restart-host')).toBe(
      false,
    )
  } finally {
    socket?.close()
    await vite.close()
    await rm(root, { recursive: true, force: true })
    await rm(cacheRoot, { recursive: true, force: true })
  }
}, 30_000)
