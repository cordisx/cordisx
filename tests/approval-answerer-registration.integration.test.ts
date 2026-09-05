import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'

describe('Approval answerer registration composition', () => {
  it('mounts a Chatroom-like v6 acquire path before any dynamic Session route is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-answerer-registration-'))
    const configPath = path.join(root, 'playground.config.json')
    const entry = path.resolve('tests/fixtures/agent-session-answerer-chatroom.ts')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [],
        plugins: [{ id: 'agent-session-answerer-chatroom', entry, enabled: true, config: {} }],
      }),
    )
    const session = await createPlaygroundSession(configPath, { homeDir: path.join(root, 'home') })
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
      const built = await session.buildBundle()
      dom.window.eval(built.source)
      for (
        let attempt = 0;
        attempt < 200 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
        attempt += 1
      ) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(dom.window.document.documentElement.dataset.cordisxRuntimeError).toBeUndefined()
      const runtime = (dom.window as unknown as {
        __cordisxRuntime?: {
          snapshot(): {
            readonly plugins: readonly { readonly id: string; readonly status: string; readonly error?: string }[]
          }
          dispose(): Promise<void>
        }
      }).__cordisxRuntime
      expect(runtime?.snapshot().plugins).toContainEqual(expect.objectContaining({
        id: 'agent-session-answerer-chatroom',
        status: 'active',
      }))
      expect(
        (dom.window as unknown as { __cordisxAnswererRegisteredBeforeRoute?: boolean })
          .__cordisxAnswererRegisteredBeforeRoute,
      ).toBe(true)
      expect(dom.window.document.querySelector('[data-permission-prompt]')).toBeNull()
      await runtime?.dispose()
    } finally {
      dom.window.close()
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
