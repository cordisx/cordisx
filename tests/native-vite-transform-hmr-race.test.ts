import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import type { Plugin, ViteDevServer } from 'vite'

const captured = vi.hoisted(() => ({
  plugin: undefined as Plugin | undefined,
  server: undefined as ViteDevServer | undefined,
}))
vi.mock('../packages/cli/node_modules/vite/dist/node/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('vite')>()
  return {
    ...original,
    createServer: async (...args: Parameters<typeof original.createServer>) => {
      const server = await original.createServer(...args)
      captured.server = server
      captured.plugin = server.config.plugins.find(plugin => plugin.name === 'cordisx-native-development')
      return server
    },
  }
})
import { startNativeViteServer } from '../packages/cli/src/launcher/vite-development.js'

it('a module load cannot acknowledge a pending file change before its HMR replacement is sent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-vite-load-race-'))
  const entry = path.join(root, 'plugin.ts')
  const before = "export const version = 'before'; export function apply() {}\n"
  const after = "export const version = 'after'; export function apply() {}\n"
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'hmr-race', version: '0.0.0', type: 'module' }),
  )
  await writeFile(entry, before)
  const cacheRoot = path.join(root, 'cache')
  await mkdir(cacheRoot, { mode: 0o700 })
  const native = await startNativeViteServer({
    version: 1,
    rootDir: root,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{ id: 'race', entry, enabled: true, config: {} }],
  }, { cacheRoot })
  try {
    const server = captured.server!
    const integration = captured.plugin!
    // Control only this test server's event delivery to deterministically put a
    // normal module transform ahead of its queued filesystem HMR notification.
    await server.watcher.close()
    const transform = typeof integration.transform === 'function'
      ? integration.transform
      : integration.transform!.handler
    const hotUpdate = typeof integration.handleHotUpdate === 'function'
      ? integration.handleHotUpdate
      : integration.handleHotUpdate!.handler
    await transform.call({} as never, before, entry)
    await writeFile(entry, after)
    await transform.call({} as never, after, entry)
    const sent = vi.spyOn(server.environments.client!.hot, 'send')
    await hotUpdate.call({} as never, {
      file: entry,
      timestamp: Date.now(),
      modules: [],
      read: async () => after,
      server,
    })
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'custom',
        event: 'cordisx:replace-plugin',
        data: expect.objectContaining({ pluginId: 'race' }),
      }),
    )
    const count = sent.mock.calls.length
    await hotUpdate.call({} as never, {
      file: entry,
      timestamp: Date.now(),
      modules: [],
      read: async () => after,
      server,
    })
    expect(sent.mock.calls.length).toBe(count)
  } finally {
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})
