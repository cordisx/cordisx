import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import {
  createNativeViteEntityGenerationHandler,
  startNativeViteServer,
} from '../packages/cli/src/launcher/vite-development.js'
import type { EntityDirectoryAuthority } from '../packages/cli/src/launcher/entity-directory.js'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'

it(
  'lets a later native window acknowledge the current committed generation while rejecting obsolete generations',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generation-windows-'))
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-generation-cache-'))
    const entry = path.join(root, 'index.ts')
    await writeFile(path.join(root, 'package.json'), '{"name":"window-demo","version":"1.0.0","type":"module"}')
    await writeFile(entry, 'export function apply() {}\n')
    const config = {
      version: 1 as const,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'window-demo', entry, enabled: true, config: {} }],
    }
    const vite = await startNativeViteServer(config, { cacheRoot })
    const sockets: WebSocket[] = []
    try {
      const materialize = vi.fn(async () => [])
      await vite.synchronizePluginGenerations(createNativeViteEntityGenerationHandler({
        register: vi.fn(),
        materialize,
      } as unknown as EntityDirectoryAuthority, 'development'))
      await buildRendererComposition(config, () => {}, {
        developmentBuild: (config, options) => vite.buildBootstrap(config, options ?? {}),
      })
      const request = async (pathname: string) =>
        await fetch(new URL(pathname, vite.url), {
          headers: { Origin: 'null' },
          signal: AbortSignal.timeout(5000),
        }).then(response => response.text())
      const token = (await request('@vite/client')).match(/const wsToken = "([^"]+)"/)![1]
      const connect = async () => {
        const socket = new WebSocket(vite.url.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr')
        sockets.push(socket)
        await once(socket, 'open')
        return socket
      }
      const send = async (socket: WebSocket, event: string, data: Record<string, string>) => {
        const requestId = crypto.randomUUID()
        const responses: any[] = []
        const listener = (raw: WebSocket.RawData) => {
          const message = JSON.parse(String(raw))
          if (message.data?.requestId === requestId) responses.push(message.data)
        }
        socket.on('message', listener)
        try {
          socket.send(JSON.stringify({ type: 'custom', event, data: { ...data, requestId } }))
          await vi.waitFor(() => expect(responses).toHaveLength(1), { timeout: 5000 })
          return responses[0]
        } finally {
          socket.off('message', listener)
        }
      }
      const first = await connect()
      const second = await connect()
      const reload = async () => {
        const result = await send(first, 'cordisx:reload-plugin', { pluginId: 'window-demo' })
        expect(result.error).toBeUndefined()
        const wrapper = await request('@id/__x00__virtual:cordisx-native-plugin/window-demo?t=' + result.timestamp)
        return JSON.parse(wrapper.match(/"moduleGeneration":\s*("[^"]+")/)![1]) as string
      }
      const transact = (socket: WebSocket, action: string, moduleGeneration: string, transactionId: string) =>
        send(socket, 'cordisx:plugin-generation-transaction', {
          pluginId: 'window-demo',
          action,
          moduleGeneration,
          transactionId,
        })
      const generation = await reload()
      expect((await transact(first, 'stage', generation, 'first')).error).toBeUndefined()
      expect((await transact(first, 'commit', generation, 'first')).error).toBeUndefined()
      // This failed after the first window removed the global pending snapshot.
      expect((await transact(second, 'stage', generation, 'second')).error).toBeUndefined()
      expect((await transact(second, 'commit', generation, 'second')).error).toBeUndefined()
      expect((await transact(second, 'stage', 'invented', 'unknown')).error).toMatch(/Unknown or stale/)
      const next = await reload()
      expect((await transact(second, 'stage', generation, 'obsolete')).error).toMatch(/Unknown or stale/)
      const stages = await Promise.all([
        transact(first, 'stage', next, 'concurrent-first'),
        transact(second, 'stage', next, 'concurrent-second'),
      ])
      expect(stages.map(result => result.error)).toEqual([undefined, undefined])
      expect((await transact(first, 'commit', next, 'concurrent-first')).error).toBeUndefined()
      expect((await transact(second, 'rollback', next, 'concurrent-second')).error).toBeUndefined()
      expect(materialize).toHaveBeenCalledTimes(3)
    } finally {
      for (const socket of sockets) socket.terminate()
      await vite.close()
      await rm(root, { recursive: true, force: true })
      await rm(cacheRoot, { recursive: true, force: true })
    }
  },
  30_000,
)
