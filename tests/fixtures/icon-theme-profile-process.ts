import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import {
  ensureHomeConfig,
  loadHomeConfig,
} from '../../packages/cli/src/config/home-config.js'
import { buildRendererBundle } from '../../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import {
  iconThemePreferenceBridgeError,
  parseIconThemePreferenceBindingRequest,
  persistIconThemePreference,
  type IconThemePreferencePersistenceContext,
} from '../../packages/cli/src/launcher/icon-theme-rpc.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const providerEntry = path.join(here, 'icon-theme-provider-plugin.ts')
const [phase, configPath, hostGeneration] = process.argv.slice(2)
const token = 'c'.repeat(64)

interface Runtime {
  snapshot(): {
    iconThemes?: {
      profileRevision: number
      selected: { providerId: string; providerGeneration: string }
      providers: readonly { providerId: string; providerGeneration: string }[]
    }
  }
  dispose(): Promise<void>
}

function page(): JSDOM {
  const dom = new JSDOM('<!doctype html><html lang="en" class="electron-dark"><head></head><body><button data-cordisx-playground-manager-trigger>Manager</button><main data-cordisx-playground-seat="app"></main></body></html>', {
    runScripts: 'dangerously',
    url: 'https://cordisx.local/',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({
    matches: false, media: '', onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) })
  dom.window.console.info = () => {}
  return dom
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function settleDisposedDom(): Promise<void> {
  // React schedules cleanup microtasks after the Host runtime promise settles.
  // Flush them before JSDOM detaches window.document during close().
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 25))
}

async function composition(enabled = true, config: unknown = {}): Promise<ReturnType<typeof loadConfig>> {
  const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
  return {
    ...base,
    plugins: [{ id: 'icon-theme-test', entry: providerEntry, enabled, config }],
  }
}

async function boot(
  config: Awaited<ReturnType<typeof loadConfig>>,
  preference: Awaited<ReturnType<typeof loadHomeConfig>>['apps'][string]['profiles'][string]['iconTheme'],
): Promise<{ selected: { providerId: string; providerGeneration: string }; providers: readonly { providerId: string; providerGeneration: string }[] }> {
  const bundle = await buildRendererBundle(config, {
    playground: true,
    appId: 'codex',
    profileId: 'default',
    generation: hostGeneration,
    ...(preference === undefined ? {} : { iconThemePreference: preference }),
  })
  const dom = page()
  try {
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true', 'renderer readiness')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
    const snapshot = runtime.snapshot().iconThemes!
    const result = { selected: { ...snapshot.selected }, providers: snapshot.providers.map(provider => ({ ...provider })) }
    await runtime.dispose()
    await settleDisposedDom()
    return result
  } finally {
    dom.window.close()
  }
}

async function processA(): Promise<Record<string, unknown>> {
  await ensureHomeConfig(configPath)
  const config = await composition()
  const bundle = await buildRendererBundle(config, {
    playground: true,
    appId: 'codex',
    profileId: 'default',
    generation: hostGeneration,
    iconThemePreferenceBridgeToken: token,
  })
  const dom = page()
  let wireCandidateKeys: string[] = []
  const context: IconThemePreferencePersistenceContext = {
    configPath,
    appId: 'codex',
    profileId: 'default',
    hostGeneration,
    token,
  }
  Object.defineProperty(dom.window, '__cordisxIconThemePreferenceRequestV1', { configurable: true, value: (payload: string) => {
    const request = JSON.parse(payload) as Record<string, unknown>
    wireCandidateKeys = Object.keys(request.candidate as Record<string, unknown>).sort()
    queueMicrotask(() => { void (async () => {
      try {
        const parsed = parseIconThemePreferenceBindingRequest(request, context)
        const value = await persistIconThemePreference(context, parsed)
        ;(dom.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
          .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
      } catch (error) {
        ;(dom.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
          .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: false, ...iconThemePreferenceBridgeError(error) }))
      }
    })() })
  } })
  try {
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true', 'process A readiness')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')?.click()
    await waitFor(() => dom.window.document.querySelector('#cxr-icon-theme-provider') !== null, 'process A picker')
    const picker = dom.window.document.querySelector<HTMLSelectElement>('#cxr-icon-theme-provider')!
    const aurora = [...picker.options].find(option => option.textContent?.startsWith('Aurora'))!
    picker.value = aurora.value
    picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await waitFor(async () => (await loadHomeConfig(configPath)).apps.codex?.profiles.default?.iconTheme?.revision === 1, 'process A durable preference')
    const preference = (await loadHomeConfig(configPath)).apps.codex!.profiles.default!.iconTheme!
    const selected = runtime.snapshot().iconThemes!.selected
    await runtime.dispose()
    await settleDisposedDom()
    return {
      hostGeneration,
      selected,
      preference,
      wireCandidateKeys,
      configMode: (await stat(configPath)).mode & 0o777,
    }
  } finally {
    dom.window.close()
  }
}

async function processB(): Promise<Record<string, unknown>> {
  const preference = (await loadHomeConfig(configPath)).apps.codex!.profiles.default!.iconTheme!
  const exact = await boot(await composition(), preference)
  const changedArtifact = await boot(await composition(true, { artifactRevision: 2 }), preference)
  const missing = await boot({ ...(await composition()), plugins: [] }, preference)
  const disabled = await boot(await composition(false), preference)
  return { hostGeneration, preference, exact, changedArtifact, missing, disabled, configMode: (await stat(configPath)).mode & 0o777 }
}

async function main(): Promise<void> {
  if (phase !== 'a' && phase !== 'b') throw new Error('phase must be a or b')
  const result = phase === 'a' ? await processA() : await processB()
  process.stdout.write(`CORDISX_ICON_PROCESS_RESULT=${JSON.stringify(result)}\n`)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
