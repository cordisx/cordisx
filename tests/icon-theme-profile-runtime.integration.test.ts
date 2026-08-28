import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

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
    iconThemes?: { profileRevision: number; selected: { providerId: string; providerGeneration: string } }
  }
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
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
    let persistedRequest: Record<string, unknown> | undefined
    let acceptPersistence = false
    Object.defineProperty(page.window, '__cordisxIconThemePreferenceRequestV1', { configurable: true, value: (payload: string) => {
      persistedRequest = JSON.parse(payload) as Record<string, unknown>
      const requestId = persistedRequest.requestId
      const candidate = persistedRequest.candidate as Record<string, unknown>
      queueMicrotask(() => (page.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
        .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(acceptPersistence
          ? { requestId, ok: true, value: { revision: 8, ...candidate } }
          : { requestId, ok: false, code: 'conflict' })))
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
      expect(persistedRequest).toMatchObject({ expectedPreferenceRevision: 7, candidate: { providerId: 'builtin:reicon' } })

      acceptPersistence = true
      picker.value = picker.options[0]!.value
      picker.dispatchEvent(new page.window.Event('change', { bubbles: true }))
      await waitFor(() => runtime.snapshot().iconThemes?.selected.providerId === 'builtin:reicon', 'persisted builtin selection')
      await waitFor(() => persistedRequest !== undefined, 'preference persistence request')
      expect(persistedRequest).toMatchObject({
        expectedPreferenceRevision: 7,
        candidate: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' },
      })
      expect(JSON.stringify(persistedRequest)).not.toMatch(/providerHandle|principalHandle|descriptors|commands|paths/u)
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
