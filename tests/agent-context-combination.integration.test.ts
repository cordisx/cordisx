import path from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { AGENT_CONTEXT_BINDING, installAgentContextCdpBinding } from '../packages/cli/src/launcher/agent-context-cdp.js'
import { HostAgentContextBridge } from '../packages/cli/src/launcher/agent-context-bridge.js'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

it(
  'carries launch metadata through the production renderer and private CDP bridge to an authorized exact session',
  async () => {
    const root = path.resolve('.'), entry = path.resolve('tests/fixtures/agent-context-combination-plugin.ts')
    const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const config = {
      ...base,
      providers: [],
      plugins: [{ id: 'agent-context-combination', entry, enabled: true, config: {} }],
    }
    const identity = { id: 'agent-context-combination', source: pathToFileURL(realpathSync(entry)).href }
    const policies = [
      createPermissionPolicyRecord({
        profileId: 'test',
        identity,
        capability: 'agent.events.read',
        scope: { sessionIds: ['owned'] },
        policy: 'allow',
      }),
    ]
    const bundle = await buildRendererBundle(config, {
      profileId: 'test',
      generation: 'combo',
      agentContextBridgeToken: 'context-token',
      permission: { profileId: 'test', policies, bridgeToken: 'permission-token' },
    })
    const dom = new JSDOM(
      '<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    Object.defineProperty(dom.window, 'structuredClone', { value: structuredClone })
    const listeners = new Map<string, (value: any) => void>()
    const session = {
      send: async (method: string, params: any) => {
        if (method === 'Runtime.evaluate') dom.window.eval(params.expression)
        return {}
      },
      onEvent: (method: string, cb: (value: any) => void) => {
        listeners.set(method, cb)
        return () => listeners.delete(method)
      },
      onClose: () => () => {},
    } as unknown as CdpSession
    const observations = new ContextObservations(() => 100), epoch = observations.open('owned', 1)
    observations.observe({
      sessionId: 'owned',
      sessionGeneration: 1,
      usedTokens: 40,
      budget: { status: 'resolved', tokens: 80 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    })
    const dispose = await installAgentContextCdpBinding(session, {
      token: 'context-token',
      createBridge: () => new HostAgentContextBridge(observations, 10, () => 100),
      authorize: id => id === 'owned',
    })
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', { configurable: true, value: () => {} })
    Object.defineProperty(dom.window, AGENT_CONTEXT_BINDING, {
      configurable: true,
      value: (payload: string) =>
        listeners.get('Runtime.bindingCalled')!({ name: AGENT_CONTEXT_BINDING, executionContextId: 1, payload }),
    })
    let runtime: any
    try {
      dom.window.eval(bundle)
      await expect.poll(() => dom.window.document.documentElement.dataset.cordisxReady, { timeout: 15000 }).toBe('true')
      runtime = (dom.window as any).__cordisxRuntime
      await expect.poll(() => dom.window.document.documentElement.dataset.contextRead, { timeout: 5000 }).toBeDefined()
      const result = JSON.parse(dom.window.document.documentElement.dataset.contextRead!)
      expect(result).toMatchObject({ status: 'available', sample: { sessionId: 'owned', usedTokens: 40, ratio: .5 } })
      runtime = (dom.window as any).__cordisxRuntime
      expect(JSON.stringify(runtime.snapshot())).not.toContain('context-token')
    } finally {
      await runtime?.dispose()
      dispose()
      observations.dispose()
      dom.window.close()
    }
  },
  30000,
)
