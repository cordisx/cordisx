import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { CORDISX_PAGE_SCHEMA_V4, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'

const id = 'config-readiness'
const token = 'c'.repeat(64)
let bundle: string

interface RuntimeHandle {
  snapshot(): {
    plugins: readonly { id: string; status: string; configuration: { revision: number; value: unknown } }[]
    navigation: { pages: readonly { owner: string }[]; routes: readonly { owner: string }[] }
    registrations: readonly { owner: string; surface: string }[]
  }
  dispose(): Promise<void>
}

beforeAll(async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config: CordisXConfig = {
    version: 1,
    rootDir: root,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{
      id,
      source: `file:///test/${id}.js`,
      entry: path.join(root, 'tests/fixtures/restart-config-plugin.ts'),
      enabled: true,
      config: { label: 'good' },
      moduleFactorySource: `var __cordisxPluginModule = globalThis.__readinessModule ??= {
        name: '${id}',
        inject: ['i18n', 'pages', 'routes', 'slots', 'managerContent', 'commands'],
        Config: { '~standard': { version: 1, vendor: 'fixture', validate(value) { return { value }; } } },
        apply(ctx, config) {
          const state = globalThis.__readinessState ??= { applications: [], disposed: 0 };
          state.applications.push(config.label);
          const releases = [];
          ctx.effect(() => async () => {
            await Promise.resolve();
            for (const release of releases.reverse()) release();
            state.disposed++;
          });
          releases.push(ctx.pages.register({
            $schema: ${JSON.stringify(CORDISX_PAGE_SCHEMA_V4)}, schemaVersion: 4, id: 'lobby',
            title: { key: 'lobby', fallback: 'Lobby' },
            description: { key: 'description', fallback: 'Readiness fixture' }, chrome: 'standard'
          }, mount => { mount.container.textContent = config.label; }));
          releases.push(ctx.routes.register({
            $schema: ${JSON.stringify(CORDISX_ROUTE_SCHEMA_V2)}, schemaVersion: 2, id: 'lobby',
            path: '/main/${id}/lobby', page: 'lobby', outlet: 'main',
            title: { key: 'lobby', fallback: 'Lobby' },
            description: { key: 'description', fallback: 'Readiness fixture' }
          }));
          releases.push(ctx.slots.register({
            name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95
          }, { label: { key: 'lobby', fallback: 'Lobby' }, route: { id: 'lobby' } }));
        }
      };`,
    }],
  }
  bundle = await buildRendererBundle(config, { profileId: 'development', configBridgeToken: token })
})

async function boot() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
    { runScripts: 'dangerously', url: 'https://codex.local/native' },
  )
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
  Object.defineProperty(dom.window, 'structuredClone', {
    value: (value: unknown) => dom.window.JSON.parse(dom.window.JSON.stringify(value)),
  })
  Object.defineProperty(dom.window, 'TextEncoder', { value: TextEncoder })
  Object.defineProperty(dom.window, 'TextDecoder', { value: TextDecoder })
  const bridge: { revision: number; label: string; candidate?: { revision: number; label: string } } = {
    revision: 0,
    label: 'good',
  }
  const calls: string[] = []
  const globals = dom.window as unknown as Record<string, unknown>
  globals.__cordisxConfigRequestV1 = (payload: string) => {
    const request = JSON.parse(payload) as {
      requestId: string
      operation: 'stage' | 'commit' | 'abort'
      expectedRevision?: number
      candidateRevision?: number
      config?: { label: string }
    }
    calls.push(request.operation)
    let value: unknown
    if (request.operation === 'stage') {
      expect(request.expectedRevision).toBe(bridge.revision)
      expect(bridge.candidate).toBeUndefined()
      bridge.candidate = { revision: bridge.revision + 1, label: request.config!.label }
      value = { candidateRevision: bridge.candidate.revision }
    } else if (request.operation === 'commit') {
      expect(request.candidateRevision).toBe(bridge.candidate?.revision)
      bridge.revision = bridge.candidate!.revision
      bridge.label = bridge.candidate!.label
      delete bridge.candidate
      value = { revision: bridge.revision }
    } else {
      delete bridge.candidate
      // Restore availability only after the failed replacement has been observed.
      dom.window.eval("__readinessModule.inject = __readinessModule.inject.filter(name => name !== 'missingReadiness')")
    }
    queueMicrotask(() => {
      const receive = globals.__cordisxConfigReceiveV1 as (payload: string) => void
      receive(JSON.stringify({ requestId: request.requestId, ok: true, value }))
    })
  }
  dom.window.eval(bundle)
  for (
    let attempt = 0;
    attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
    attempt++
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
  const runtime = globals.__cordisxRuntime as RuntimeHandle
  const state = globals.__readinessState as { applications: string[]; disposed: number }
  const update = () =>
    dom.window.eval(
      `__cordisxRuntime.updatePluginConfig('${id}', 0, [{ op: 'set', path: ['label'], value: 'next' }])`,
    ) as Promise<void>
  return { dom, runtime, state, bridge, calls, update }
}

function expectContributions(runtime: RuntimeHandle) {
  const snapshot = runtime.snapshot()
  expect(snapshot.navigation.pages.filter(item => item.owner === id)).toHaveLength(1)
  expect(snapshot.navigation.routes.filter(item => item.owner === id)).toHaveLength(1)
  expect(snapshot.registrations.filter(item => item.owner === id && item.surface === 'sidebar.navigation.items'))
    .toHaveLength(1)
}

describe('plugin config restart readiness in the production runtime', () => {
  it('remounts the same cached namespace and preserves its page, route and sidebar contribution', async () => {
    const f = await boot()
    try {
      expectContributions(f.runtime)
      f.dom.window.eval('globalThis.__originalReadinessModule = __readinessModule')
      await f.update()
      expect(f.dom.window.eval('__originalReadinessModule === __readinessModule')).toBe(true)
      expect([...f.state.applications]).toEqual(['good', 'next'])
      expect(f.state.disposed).toBe(1)
      expect(f.calls).toEqual(['stage', 'commit'])
      expect(f.bridge).toEqual({ revision: 1, label: 'next' })
      expect(f.runtime.snapshot().plugins.find(plugin => plugin.id === id)).toMatchObject({
        status: 'active',
        configuration: { revision: 1, value: { label: 'next' } },
      })
      expectContributions(f.runtime)
    } finally {
      await f.runtime.dispose()
      f.dom.window.close()
    }
  })

  it('rejects a pending replacement before durable commit and remounts last-good when its dependency returns', async () => {
    const f = await boot()
    try {
      f.dom.window.eval("__readinessModule.inject.push('missingReadiness')")
      await expect(f.update()).rejects.toThrow('last-good restored')
      expect(f.calls).toContain('abort')
      expect(f.calls).not.toContain('commit')
      expect(f.bridge).toEqual({ revision: 0, label: 'good' })
      expect([...f.state.applications]).toEqual(['good', 'good'])
      expect(f.state.disposed).toBe(1)
      expect(f.runtime.snapshot().plugins.find(plugin => plugin.id === id)).toMatchObject({
        status: 'active',
        configuration: { revision: 0, value: { label: 'good' } },
      })
      expectContributions(f.runtime)
    } finally {
      await f.runtime.dispose()
      f.dom.window.close()
    }
  })
})
