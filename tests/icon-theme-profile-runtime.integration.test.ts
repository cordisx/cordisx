import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ensureHomeConfig,
  loadHomeConfig,
  updateHomeConfigAtomic,
  type HomeConfigIconThemePreference,
} from '../packages/cli/src/config/home-config.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  IconThemePreferenceBroadcastHub,
  iconThemePreferenceBridgeError,
  parseIconThemePreferenceBindingRequest,
  parseIconThemePreferenceDocumentReadyRequest,
  persistIconThemePreference,
  type IconThemePreferencePersistenceContext,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'tests/fixtures/icon-theme-provider-plugin.ts')
const generation = 'host-process-b'
let preference: HomeConfigIconThemePreference

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

function receiveIconThemeMessage(page: JSDOM, response: Record<string, unknown>): unknown {
  return (page.window as unknown as {
    __cordisxIconThemePreferenceReceiveV1?: (payload: string) => unknown
  }).__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(response))
}

const readyLeaseRevisions = new WeakMap<JSDOM, number>()
function testReadyLease(page: JSDOM): { readonly readyLeaseToken: string; readonly readyLeaseRevision: number } {
  const revision = (readyLeaseRevisions.get(page) ?? 0) + 1
  readyLeaseRevisions.set(page, revision)
  return { readyLeaseToken: `ready_runtime_${String(revision).padStart(8, '0')}`, readyLeaseRevision: revision }
}

function acknowledgeDocumentReady(page: JSDOM, request: Record<string, unknown>): boolean {
  if (request.kind !== 'document-ready') return false
  receiveIconThemeMessage(page, {
    kind: 'document-ready',
    requestId: request.requestId,
    ok: true,
    ...testReadyLease(page),
    documentEpoch: request.documentEpoch,
    synchronization: 'complete',
    requiredRevision: request.currentRevision,
    currentRevision: request.currentRevision,
  })
  return true
}

describe('profile-scoped icon-theme selection runtime', () => {
  let exactBundle = ''
  let changedArtifactBundle = ''
  let unknownBundle = ''
  let disabledBundle = ''

  beforeAll(async () => {
    const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const config = { ...base, plugins: [{ id: 'icon-theme-test', entry: fixture, enabled: true, config: {} }] }
    const discoveryBundle = await buildRendererBundle(config, {
      playground: true,
      profileId: 'default',
      generation: 'host-process-a',
    })
    const discoveryPage = dom()
    try {
      discoveryPage.window.eval(discoveryBundle)
      await waitFor(() => discoveryPage.window.document.documentElement.dataset.cordisxReady === 'true', 'process A runtime readiness')
      const runtime = (discoveryPage.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      const provider = runtime.snapshot().iconThemes!.providers.find(item => item.providerId === 'plugin:icon-theme-test:aurora')!
      preference = {
        revision: 7,
        providerId: provider.providerId,
        namespace: provider.namespace,
        providerVersion: provider.providerVersion,
        providerGeneration: provider.providerGeneration,
      }
      await runtime.dispose()
    } finally {
      discoveryPage.window.close()
    }
    exactBundle = await buildRendererBundle(config, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation,
      iconThemePreference: preference,
      iconThemePreferenceBridgeToken: 'b'.repeat(64),
    })
    changedArtifactBundle = await buildRendererBundle({
      ...config,
      plugins: config.plugins.map(plugin => ({ ...plugin, config: { artifactRevision: 2 } })),
    }, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation: 'host-process-c',
      iconThemePreference: preference,
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
    disabledBundle = await buildRendererBundle({
      ...config,
      plugins: config.plugins.map(plugin => ({ ...plugin, enabled: false })),
    }, {
      playground: true,
      appId: 'codex',
      profileId: 'default',
      generation: 'host-process-d',
      iconThemePreference: preference,
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
      if (acknowledgeDocumentReady(page, request)) return
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
        providerGeneration: preference.providerGeneration,
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

  it('reconciles a durable winner delivered before the runtime subscribes to the bridge', async () => {
    const page = dom()
    const winner: HomeConfigIconThemePreference = {
      revision: preference.revision + 1,
      providerId: 'builtin:reicon',
      namespace: 'reicon',
      providerVersion: '1.2.1',
      providerGeneration: 'reicon-1.2.1',
    }
    let receiver: ((payload: string) => void) | undefined
    Object.defineProperty(page.window, '__cordisxIconThemePreferenceReceiveV1', {
      configurable: true,
      get: () => receiver,
      set: (value: ((payload: string) => void) | undefined) => {
        receiver = value
        if (value !== undefined) value(JSON.stringify({ kind: 'sync', value: winner }))
      },
    })
    Object.defineProperty(page.window, '__cordisxIconThemePreferenceRequestV1', {
      configurable: true,
      value: (payload: string) => { acknowledgeDocumentReady(page, JSON.parse(payload) as Record<string, unknown>) },
    })
    try {
      page.window.eval(exactBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'startup-window runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({
        providerId: 'builtin:reicon',
        providerGeneration: 'reicon-1.2.1',
      })
      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })

  it('replays success and conflict winners when the same target boots a new document epoch', async () => {
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const persistenceContext: IconThemePreferencePersistenceContext = {
      configPath: '/host-private/not-used.json',
      appId: 'codex',
      profileId: 'default',
      hostGeneration: generation,
      token: 'b'.repeat(64),
    }
    const epochs: string[] = []
    const pages: JSDOM[] = []
    const bootDocument = async (): Promise<{ readonly page: JSDOM; readonly runtime: Runtime }> => {
      const page = dom()
      pages.push(page)
      const expectedEpochCount = pages.length
      Object.defineProperty(page.window, '__cordisxIconThemePreferenceRequestV1', {
        configurable: true,
        value: (payload: string) => {
          const request = JSON.parse(payload) as Record<string, unknown>
          if (request.kind !== 'document-ready') throw new Error('unexpected persistence request during document replay test')
          void (async () => {
            const ready = parseIconThemePreferenceDocumentReadyRequest(request, persistenceContext)
            epochs.push(ready.documentEpoch)
            try {
              const reservation = hub.reserve({
                targetId: 'same-target',
                sessionId: 'same-session',
                documentEpoch: ready.documentEpoch,
                executionContextId: epochs.length,
                currentRevision: ready.currentRevision,
                signal: new AbortController().signal,
              })
              const registration = await reservation.register({
                receive: async value => {
                  const ack = receiveIconThemeMessage(page, { kind: 'sync', value })
                  if (ack === null || typeof ack !== 'object') throw new Error('document receiver returned no acknowledgement')
                  return ack as { documentEpoch: string; currentRevision: number }
                },
              })
              const probeAck = receiveIconThemeMessage(page, { kind: 'document-ready-probe' }) as { documentEpoch: string; currentRevision: number }
              await registration.respondReady(probeAck, async (status, lease) => receiveIconThemeMessage(page, {
                kind: 'document-ready', requestId: ready.requestId, ok: true,
                documentEpoch: ready.documentEpoch,
                readyLeaseToken: lease.token, readyLeaseRevision: lease.revision,
                ...status,
              }) as { documentEpoch: string; currentRevision: number })
            } catch (error) {
              receiveIconThemeMessage(page, {
                kind: 'document-ready', requestId: ready.requestId, ok: false,
                documentEpoch: ready.documentEpoch, currentRevision: 0,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          })()
        },
      })
      page.window.eval(exactBundle)
      await waitFor(() => epochs.length === expectedEpochCount
        && page.window.document.documentElement.dataset.cordisxReady === 'true', `document ${expectedEpochCount} ready handshake`)
      return {
        page,
        runtime: (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!,
      }
    }
    try {
      const first = await bootDocument()
      const firstRuntime = first.runtime
      expect(firstRuntime.snapshot().iconThemes?.selected.providerId).toBe('plugin:icon-theme-test:aurora')

      const successWinner: HomeConfigIconThemePreference = {
        revision: preference.revision + 1,
        providerId: 'builtin:reicon', namespace: 'reicon', providerVersion: '1.2.1', providerGeneration: 'reicon-1.2.1',
      }
      await hub.broadcast(successWinner)
      expect(firstRuntime.snapshot().iconThemes?.selected.providerId).toBe('builtin:reicon')

      const second = await bootDocument()
      const secondRuntime = second.runtime
      expect(epochs[1]).not.toBe(epochs[0])
      expect(secondRuntime).not.toBe(firstRuntime)
      expect(secondRuntime.snapshot().iconThemes?.selected.providerId).toBe('builtin:reicon')
      await firstRuntime.dispose()
      first.page.window.close()

      const conflictWinner = { ...preference, revision: successWinner.revision + 1 }
      await hub.broadcast(conflictWinner)
      expect(secondRuntime.snapshot().iconThemes?.selected.providerId).toBe('plugin:icon-theme-test:aurora')

      const third = await bootDocument()
      const thirdRuntime = third.runtime
      expect(epochs[2]).not.toBe(epochs[1])
      expect(thirdRuntime.snapshot().iconThemes?.selected.providerId).toBe('plugin:icon-theme-test:aurora')
      await secondRuntime.dispose()
      second.page.window.close()
      await thirdRuntime.dispose()
    } finally {
      for (const page of pages) page.window.close()
    }
  })

  it('falls back to pinned Reicon when the same-version provider artifact generation changed', async () => {
    const page = dom()
    try {
      page.window.eval(changedArtifactBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'changed-artifact runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({ providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' })
      expect(runtime.snapshot().iconThemes?.providers.find(provider => provider.providerId === 'plugin:icon-theme-test:aurora')?.providerGeneration)
        .not.toBe(preference.providerGeneration)
      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })

  it('converges two active same-profile renderers onto one durable CAS winner without restart', async () => {
    const pages = [dom(), dom()]
    const hub = new IconThemePreferenceBroadcastHub('codex', 'default')
    const configRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-multi-renderer-'))
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
    const requests: Array<{ readonly page: JSDOM; readonly value: Record<string, unknown> }> = []
    const unregisterDocuments: Array<() => void> = []
    const receive = (page: JSDOM, response: Record<string, unknown>): unknown => {
      return (page.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => unknown })
        .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify(response))
    }
    for (const [index, page] of pages.entries()) Object.defineProperty(page.window, '__cordisxIconThemePreferenceRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as Record<string, unknown>
        if (request.kind !== 'document-ready') {
          requests.push({ page, value: request })
          return
        }
        void (async () => {
          const ready = parseIconThemePreferenceDocumentReadyRequest(request, persistenceContext)
          const reservation = hub.reserve({
            targetId: `target-${index}`,
            sessionId: `session-${index}`,
            documentEpoch: ready.documentEpoch,
            executionContextId: index + 1,
            currentRevision: ready.currentRevision,
            signal: new AbortController().signal,
          })
          const registration = await reservation.register({
            receive: async value => receive(page, { kind: 'sync', value }) as { documentEpoch: string; currentRevision: number },
          })
          unregisterDocuments.push(registration.unregister)
          const probeAck = receive(page, { kind: 'document-ready-probe' }) as { documentEpoch: string; currentRevision: number }
          await registration.respondReady(probeAck, async (status, lease) => receive(page, {
            kind: 'document-ready', requestId: ready.requestId, ok: true,
            documentEpoch: ready.documentEpoch,
            readyLeaseToken: lease.token, readyLeaseRevision: lease.revision,
            ...status,
          }) as { documentEpoch: string; currentRevision: number })
        })()
      },
    })
    try {
      for (const page of pages) page.window.eval(exactBundle)
      await Promise.all(pages.map(async (page, index) => await waitFor(
        () => page.window.document.documentElement.dataset.cordisxReady === 'true',
        `multi-renderer ${index} readiness`,
      )))
      const runtimes = pages.map(page => (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!)
      for (const page of pages) {
        page.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')?.click()
        page.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')?.click()
        await waitFor(() => page.window.document.querySelector('#cxr-icon-theme-provider') !== null, 'multi-renderer picker')
      }
      const [pickerA, pickerB] = pages.map(page => page.window.document.querySelector<HTMLSelectElement>('#cxr-icon-theme-provider')!)
      pickerA.value = [...pickerA.options].find(option => option.textContent?.includes('Reicon'))!.value
      pickerA.dispatchEvent(new pages[0]!.window.Event('change', { bubbles: true }))
      pickerB.value = [...pickerB.options].find(option => option.textContent?.includes('Aurora'))!.value
      pickerB.dispatchEvent(new pages[1]!.window.Event('change', { bubbles: true }))
      await waitFor(() => requests.length === 2, 'competing preference requests')

      const builtinRequest = requests.find(item => (item.value.candidate as { providerId?: string }).providerId === 'builtin:reicon')!
      const losingRequest = requests.find(item => item !== builtinRequest)!
      const winner = await persistIconThemePreference(
        persistenceContext,
        parseIconThemePreferenceBindingRequest(builtinRequest.value, persistenceContext),
      )
      await hub.broadcast(winner)
      receive(builtinRequest.page, { requestId: builtinRequest.value.requestId, ok: true, value: winner, synchronization: 'complete' })
      try {
        await persistIconThemePreference(
          persistenceContext,
          parseIconThemePreferenceBindingRequest(losingRequest.value, persistenceContext),
        )
        throw new Error('expected competing preference to conflict')
      } catch (error) {
        const failure = iconThemePreferenceBridgeError(error)
        if (failure.currentPreference !== undefined) await hub.broadcast(failure.currentPreference)
        receive(losingRequest.page, { requestId: losingRequest.value.requestId, ok: false, ...failure, synchronization: 'complete' })
      }

      await waitFor(() => runtimes.every(runtime => runtime.snapshot().iconThemes?.selected.providerId === 'builtin:reicon'), 'renderer convergence')
      expect((await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme).toEqual(winner)
      expect(winner.revision).toBe(8)

      for (const page of pages) {
        const picker = page.window.document.querySelector<HTMLSelectElement>('#cxr-icon-theme-provider')!
        picker.dispatchEvent(new page.window.Event('change', { bubbles: true }))
      }
      await waitFor(() => requests.length === 4, 'post-convergence preference revisions')
      expect(requests.slice(2).map(item => item.value.expectedPreferenceRevision)).toEqual([8, 8])
      await Promise.all(runtimes.map(async runtime => await runtime.dispose()))
    } finally {
      for (const unregister of unregisterDocuments) unregister()
      for (const page of pages) page.window.close()
    }
  }, 30_000)

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

  it('falls back to pinned Reicon when the preferred provider is disabled', async () => {
    const page = dom()
    try {
      page.window.eval(disabledBundle)
      await waitFor(() => page.window.document.documentElement.dataset.cordisxReady === 'true', 'disabled-provider runtime readiness')
      const runtime = (page.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
      expect(runtime.snapshot().iconThemes?.selected).toMatchObject({ providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' })
      expect(runtime.snapshot().iconThemes?.providers).toHaveLength(1)
      await runtime.dispose()
    } finally {
      page.window.close()
    }
  })
})
