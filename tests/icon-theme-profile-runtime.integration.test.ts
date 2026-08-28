import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  iconThemePreferenceBridgeError,
  parseIconThemePreferenceBindingRequest,
  persistIconThemePreference,
  type IconThemePreferencePersistenceContext,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'tests/fixtures/icon-theme-provider-plugin.ts')
const generation = 'host-cold-1'
const preference = {
  revision: 7,
  providerId: 'plugin:icon-theme-test:aurora' as const,
  namespace: 'aurora',
  providerVersion: '2.1.0',
  providerGeneration: `${generation}:icon-theme-test:bundled`,
}

interface Runtime {
  snapshot(): {
    iconThemes?: {
      profileRevision: number
      selected: RuntimeProvider
      providers: readonly RuntimeProvider[]
    }
  }
  dispose(): Promise<void>
}

interface RuntimeProvider {
  readonly providerId: `builtin:${string}` | `plugin:${string}:${string}`
  readonly namespace: string
  readonly providerVersion: string
  readonly providerGeneration: string
  readonly status: string
  readonly coverage: unknown
  readonly tupleCount: number
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function dom(): JSDOM {
  const page = new JSDOM('<!doctype html><html lang="zh-CN" class="electron-dark"><head></head><body><button data-cordisx-playground-manager-trigger>Manager</button><main data-cordisx-playground-seat="app"></main></body></html>', {
    runScripts: 'dangerously', url: 'https://cordisx.local/', pretendToBeVisual: true,
  })
  Object.defineProperty(page.window, 'matchMedia', { configurable: true, value: () => ({
    matches: false, media: '', onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) })
  return page
}

describe('profile-scoped icon-theme selection runtime', () => {
  let exactBundle = ''
  let staleBundle = ''
  let unknownBundle = ''

  beforeAll(async () => {
    const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const config = { ...base, plugins: [{ id: 'icon-theme-test', entry: fixture, enabled: true, config: {} }] }
    exactBundle = await buildRendererBundle(config, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation,
      iconThemePreference: preference,
      iconThemePreferenceBridgeToken: 'b'.repeat(64),
    })
    staleBundle = await buildRendererBundle(config, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation,
      iconThemePreference: { ...preference, providerGeneration: 'stale-provider-generation' },
    })
    unknownBundle = await buildRendererBundle(config, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation,
      iconThemePreference: {
        ...preference,
        providerId: 'plugin:missing:aurora',
        providerGeneration: 'missing-provider-generation',
      },
    })
  }, 20_000)

  it('restores an exact provider after registration and exposes a keyboard-native redacted picker', async () => {
    const page = dom()
    const configRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-runtime-rpc-'))
    const configPath = path.join(configRoot, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(current => ({
      ...current,
      apps: {
        ...current.apps,
        codex: {
          ...current.apps.codex!,
          profiles: {
            ...current.apps.codex!.profiles,
            default: { ...current.apps.codex!.profiles.default!, iconTheme: preference },
          },
        },
      },
    }), configPath)
    const persistenceContext: IconThemePreferencePersistenceContext = {
      configPath,
      appId: 'codex',
      profileId: 'default',
      hostGeneration: generation,
      token: 'b'.repeat(64),
    }
    const persistedRequests: Record<string, unknown>[] = []
    let responseMode: 'reject' | 'persist' | 'hold' = 'reject'
    const receive = (response: Record<string, unknown>): void => {
      ;(page.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
        .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(response))
    }
    const rejectRequest = (request: Record<string, unknown>): void => {
      receive({ requestId: request.requestId, ok: false, code: 'conflict' })
    }
    const persistRequest = async (request: Record<string, unknown>): Promise<void> => {
      const parsed = parseIconThemePreferenceBindingRequest(request, persistenceContext)
      const value = await persistIconThemePreference(persistenceContext, parsed)
      receive({ requestId: request.requestId, ok: true, value })
    }
    Object.defineProperty(page.window, '__cordisxIconThemePreferenceRequestV1', { configurable: true, value: (payload: string) => {
      const request = JSON.parse(payload) as Record<string, unknown>
      persistedRequests.push(request)
      if (responseMode === 'hold') return
      queueMicrotask(() => {
        if (responseMode !== 'persist') return rejectRequest(request)
        void persistRequest(request).catch(error => receive({
          requestId: request.requestId,
          ok: false,
          ...iconThemePreferenceBridgeError(error),
        }))
      })
    } })
    try {
      page.window.eval(exactBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({
        providerId: 'plugin:icon-theme-test:aurora',
        providerGeneration: `${generation}:icon-theme-test:bundled`,
      })
      page.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')?.click()
      page.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')?.click()
      await waitFor(() => page.window.document.querySelector('[data-host-icon-theme-picker]') !== null, 'visible icon theme picker')
      const picker = page.window.document.querySelector<HTMLSelectElement>('#cxr-icon-theme-provider')!
      expect(picker.labels[0]?.textContent).toBe('图标主题提供方')
      expect(picker.options).toHaveLength(2)
      expect(picker.selectedOptions[0]?.textContent).toContain('Aurora · v2.1.0 · 使用中')
      expect(picker.parentElement?.textContent).not.toMatch(/plugin:|providerHandle|principal|descriptor|\/tmp\//u)
      picker.focus()
      expect(page.window.document.activeElement).toBe(picker)

      picker.value = picker.options[0]!.value
      picker.dispatchEvent(new page.window.Event('change', { bubbles: true }))
      await waitFor(() => page.window.document.querySelector('[role="alert"]') !== null, 'failed persistence rollback notice')
      expect(runtime.snapshot().iconThemes?.selected.providerId).toBe('plugin:icon-theme-test:aurora')
      expect(persistedRequests[0]).toMatchObject({ expectedPreferenceRevision: 7, candidate: { providerId: 'builtin:reicon' } })

      responseMode = 'hold'
      picker.value = picker.options[0]!.value
      picker.dispatchEvent(new page.window.Event('change', { bubbles: true }))
      await waitFor(() => runtime.snapshot().iconThemes?.selected.providerId === 'builtin:reicon', 'persisted builtin selection')
      await waitFor(() => persistedRequests.length === 2, 'preference persistence request')
      const persistedRequest = persistedRequests[1]!
      expect(persistedRequest).toMatchObject({
        expectedPreferenceRevision: 7,
        candidate: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' },
      })
      expect(Object.keys(persistedRequest.candidate as Record<string, unknown>).sort()).toEqual([
        'namespace', 'providerGeneration', 'providerId', 'providerVersion',
      ])
      expect(JSON.stringify(persistedRequest)).not.toMatch(/providerHandle|principalHandle|descriptors|commands|paths/u)
      await persistRequest(persistedRequest)
      await waitForAsync(async () => (await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme?.revision === 8, 'durable icon theme preference')
      expect((await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme).toEqual({
        revision: 8,
        providerId: 'builtin:reicon',
        namespace: 'reicon',
        providerVersion: '1.2.1',
        providerGeneration: 'reicon-1.2.1',
      })
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)

      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })

  it('falls back to pinned Reicon when a cold-start preference has a stale provider generation', async () => {
    const page = dom()
    try {
      page.window.eval(staleBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'stale-preference runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({ providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' })
      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })

  it('falls back to pinned Reicon when a cold-start preference names an unknown provider', async () => {
    const page = dom()
    try {
      page.window.eval(unknownBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'unknown-preference runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({ providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' })
      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })
})
