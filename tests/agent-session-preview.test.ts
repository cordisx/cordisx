import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'

describe('Agent/Session development composition', () => {
  it('embeds a shared React/UI local artifact and projects its Session task without sourcemap imports or a permission dialog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-session-local-artifact-'))
    const entry = path.join(root, 'chatroom.tsx')
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatroom-fixture', version: '1.0.0' }))
    await writeFile(entry, `
import { createElement } from 'cordisx/react'
import { Button } from 'cordisx/ui'

export const manifest = ${JSON.stringify({
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  schemaVersion: 5,
  id: 'chatroom',
  services: [],
  capabilities: [
    { name: 'sessions.get', required: true, scope: {} },
    { name: 'agents.create', required: true, scope: {} },
    { name: 'agents.message.submit', required: true, scope: {} },
  ],
})}
export const inject = ['sessions', 'agents']
export async function apply(ctx) {
  const explicitElement = createElement(Button, null, 'Chatroom')
  const automaticElement = <Button>Chatroom JSX</Button>
  await ctx.sessions.get('cx-session.playground-local-artifact')
  const acquired = await ctx.agents.create({ sessionId: 'cx-session.playground-local-artifact' })
  if (acquired.status === 'accepted') await acquired.handle.agent.followup({
    id: 'cx-message.playground-local-artifact.1', role: 'user', content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'plugin', pluginId: acquired.owner.pluginId, generation: acquired.owner.generation,
      correlation: { namespace: 'chatroom.room-run', id: 'fixture-room/fixture-run' } },
  })
  globalThis.__playgroundLocalSessionGetApplied = explicitElement.type === Button && automaticElement.type === Button && acquired.status === 'accepted'
}
`)
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: [],
      plugins: [{ id: 'chatroom', entry: './chatroom.tsx', enabled: true, config: {} }],
    }))
    const ordinaryLocalDevelopmentBuild = await buildLocalDevelopmentPlugin(entry)
    expect(ordinaryLocalDevelopmentBuild.moduleFactorySource).toContain('sourceMappingURL=data:application/json;base64,')
    expect(ordinaryLocalDevelopmentBuild.watchFiles).not.toContain(`${root}/cordisx-shared-react:cordisx/react`)
    expect(ordinaryLocalDevelopmentBuild.watchFiles).not.toContain(`${root}/cordisx-shared-react:cordisx/ui`)
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
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('file:///cordisx-local-dev/')
      expect(composition.source).toContain('origin":"local-dev')
      expect(composition.source).toContain('artifactGeneration')
      expect(composition.watchFiles).toContain(entry)
      expect(composition.source).not.toContain('sourceMappingURL=')
      expect(composition.source).not.toContain(`${root}/cordisx-shared-react:cordisx/react`)
      expect(composition.source).not.toContain(`${root}/cordisx-shared-react:cordisx/ui`)
      expect(composition.watchFiles).not.toContain(`${root}/cordisx-shared-react:cordisx/react`)
      expect(composition.watchFiles).not.toContain(`${root}/cordisx-shared-react:cordisx/ui`)

      const built = await session.buildBundle()
      dom.window.eval(built.source)
      for (let attempt = 0; attempt < 200 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      expect((dom.window as unknown as { __playgroundLocalSessionGetApplied?: boolean }).__playgroundLocalSessionGetApplied).toBe(true)
      expect(dom.window.document.querySelector('[data-permission-prompt]')).toBeNull()
      await new Promise(resolve => setTimeout(resolve, 20))
      const runtime = (dom.window as unknown as { __cordisxRuntime: {
        playgroundAgentSessions?(): { readonly tasks: readonly { readonly taskRef: string; readonly events: readonly { readonly sessionEvent?: { readonly type: string } }[] }[] } | undefined
        dispose(): Promise<void>
      } }).__cordisxRuntime
      expect(runtime.playgroundAgentSessions?.()?.tasks).toMatchObject([{
        taskRef: 'cx-session.playground-local-artifact',
        events: expect.arrayContaining([
          expect.objectContaining({ sessionEvent: expect.objectContaining({ type: 'user/message' }) }),
          expect.objectContaining({ sessionEvent: expect.objectContaining({ type: 'assistant/message' }) }),
        ]),
      }])
      await runtime.dispose()
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
