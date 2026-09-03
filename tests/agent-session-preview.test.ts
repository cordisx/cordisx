import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'

describe('Agent/Session development composition', () => {
  it('mints configured local file plugins as exact no-dialog Playground development artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-session-local-artifact-'))
    const entry = path.join(root, 'chatroom.ts')
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(entry, `
export const manifest = ${JSON.stringify({
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  schemaVersion: 5,
  id: 'chatroom',
  services: [],
  capabilities: [{ name: 'sessions.get', required: true, scope: {} }],
})}
export const inject = ['sessions']
export async function apply(ctx) {
  await ctx.sessions.get('cx-session.playground-local-artifact')
  globalThis.__playgroundLocalSessionGetApplied = true
}
`)
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: [],
      plugins: [{ id: 'chatroom', entry: './chatroom.ts', enabled: true, config: {} }],
    }))
    const session = await createPlaygroundSession(configPath)
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://127.0.0.1/',
    })
    try {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
        configurable: true,
        value: () => ({ length: 1 }),
      })
      Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('file:///cordisx-local-dev/')
      expect(composition.source).toContain('origin":"local-dev')
      expect(composition.source).toContain('artifactGeneration')
      expect(composition.watchFiles).toContain(entry)

      const built = await session.buildBundle()
      dom.window.eval(built.source)
      for (let attempt = 0; attempt < 200 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      expect((dom.window as unknown as { __playgroundLocalSessionGetApplied?: boolean }).__playgroundLocalSessionGetApplied).toBe(true)
      expect(dom.window.document.querySelector('[data-permission-prompt]')).toBeNull()
      await (dom.window as unknown as { __cordisxRuntime: { dispose(): Promise<void> } }).__cordisxRuntime.dispose()
    } finally {
      dom.window.close()
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not create a Provider Fleet or a local CLI connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-session-development-preview-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      codex: { executable: '/must-not-start/codex' },
      providers: [],
      plugins: [],
    }))
    const createFleet = vi.spyOn(ProviderFleet, 'create')
    const session = await createPlaygroundSession(configPath)
    try {
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('hostKind: "playground"')
      expect(composition.source).not.toContain('providerBridgeToken')
      expect(createFleet).not.toHaveBeenCalled()
    } finally {
      await session.close()
      createFleet.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
