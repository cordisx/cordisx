import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'

it(
  'connects the generated Vite callback to the normal Manager reload control and replaces its owning fiber',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-manager-reload-'))
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-manager-cache-'))
    const entry = path.join(root, 'index.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"manager-demo","version":"1.0.0","type":"module"}')
    await writeFile(entry, 'export function apply() {}\n')
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'manager-demo', entry, enabled: true, config: {} }],
    }
    const vite = await startNativeViteServer(config, { cacheRoot })
    const dom = new JSDOM(
      '<html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      {
        runScripts: 'dangerously',
        url: 'https://codex.local/native',
      },
    )
    let socket: WebSocket | undefined
    try {
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const request = async (pathname: string) =>
        await fetch(new URL(pathname, vite.url), {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5000),
        }).then(async response => {
          expect(response.status).toBe(200)
          return response.text()
        })
      const token = (await request('@vite/client')).match(/const wsToken = "([^"]+)"/)![1]
      socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr')
      await once(socket, 'open')
      const listeners = new Map<string, (data: any) => void>()
      const sent: string[] = []
      const hot = {
        accept() {},
        on(event: string, callback: (data: any) => void) {
          listeners.set(event, callback)
        },
        send(event: string, data: any) {
          sent.push(event)
          socket!.send(JSON.stringify({ type: 'custom', event, data }))
        },
      }
      socket.on('message', raw => {
        const message = JSON.parse(String(raw))
        if (message.type === 'custom') listeners.get(message.event)?.(message.data)
      })
      let applies = 0
      let disposals = 0
      const window = dom.window as any
      Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
      installNativeManagerShell(dom)
      window.structuredClone = structuredClone
      window.TextEncoder = TextEncoder
      window.TextDecoder = TextDecoder
      window.crypto.randomUUID = randomUUID
      window.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
      window.fixtureHot = hot
      // Substitute browser ESM imports only; retain the generated reload callback,
      // real Vite WebSocket protocol, runtime, Manager and fiber transactions.
      window.fixtureImport = async (url: string) => {
        const wrapper = await request(url)
        const descriptor = JSON.parse(wrapper.match(/const plugin = (\{[^\n]+\});/)![1])
        return {
          load: async () => ({
            plugin: {
              ...descriptor,
              module: {
                apply(ctx: any) {
                  applies += 1
                  ctx.effect(() => () => {
                    disposals += 1
                  })
                },
              },
            },
            ownerDocumentBindings: [],
          }),
        }
      }
      let source = await request('@id/__x00__virtual:cordisx-native-entry')
      source = source.replaceAll('import.meta.hot', 'globalThis.fixtureHot')
        .replace(/\bimport\(/g, 'globalThis.fixtureImport(')
        .replace('export const ready =', 'globalThis.fixtureReady =')
      const imports = source.match(/^import[^\n]*\n/gm) ?? []
      source = source.replace(/^import[^\n]*\n/gm, '')
      const bundle = await build({
        stdin: {
          contents: imports.join('') + '\nglobalThis.fixtureBootstrap = (async () => {\n' + source + '\n})();',
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
        plugins: [{
          name: 'vite-browser-fixture',
          setup(builder) {
            builder.onResolve({ filter: /@vite\/client/ }, () => ({ path: 'hot', namespace: 'fixture' }))
            builder.onLoad(
              { filter: /.*/, namespace: 'fixture' },
              () => ({
                contents:
                  'export const createHotContext = () => globalThis.fixtureHot; export const injectQuery = url => url;',
              }),
            )
            builder.onResolve(
              { filter: /\/@fs\// },
              args => ({ path: args.path.slice(args.path.indexOf('/@fs/') + 4) }),
            )
          },
        }],
      })
      window.eval(bundle.outputFiles[0]!.text)
      await window.fixtureBootstrap
      await window.fixtureReady
      expect(applies).toBe(1)
      const runtime = window.__cordisxRuntime
      const previous = runtime.activePluginGeneration().plugins[0].moduleGeneration
      window.document.querySelector('[data-cordisx-manager-trigger]').click()
      await vi.waitFor(() => expect(window.document.querySelector('[data-unified-plugins-page]')).not.toBeNull())
      const reload = window.document.querySelector('[data-unified-plugins-page] button[aria-label="Reload plugin"]')
      expect(reload).not.toBeNull()
      expect(reload.disabled).toBe(false)
      reload.click()
      await vi.waitFor(() => expect(applies).toBe(2), { timeout: 10000 })
      await vi.waitFor(() => expect(disposals).toBe(1))
      expect(sent).toContain('cordisx:reload-plugin')
      expect(runtime.activePluginGeneration().plugins[0].moduleGeneration).not.toBe(previous)
      // Disposal releases the replacement too, without a native-document reload.
      await window.__cordisxViteClient.dispose()
      expect(disposals).toBe(2)
    } finally {
      await (dom.window as any).__cordisxViteClient?.dispose()
      dom.window.close()
      socket?.terminate()
      await vite.close()
      await rm(root, { recursive: true, force: true })
      await rm(cacheRoot, { recursive: true, force: true })
    }
  },
  30_000,
)
