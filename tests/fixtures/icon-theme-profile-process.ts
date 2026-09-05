import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { ensureHomeConfig, loadHomeConfig } from '../../packages/cli/src/config/home-config.js'
import { buildRendererBundle } from '../../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import {
  type IconThemePreferenceBindingRequest,
  iconThemePreferenceBridgeError,
  type IconThemePreferencePersistenceContext,
  parseIconThemePreferenceBindingRequest,
  persistIconThemePreference,
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
      providers: readonly {
        providerId: string
        namespace: string
        providerVersion: string
        providerGeneration: string
      }[]
    }
  }
  dispose(): Promise<void>
}

class HostPrivateWindowMicrotaskScope {
  private accepting = true
  private readonly tasks = new Set<Promise<void>>()
  private readonly errors: unknown[] = []

  queue(callback: VoidFunction): void {
    if (!this.accepting) return
    const task = Promise.resolve().then(callback).catch(error => {
      this.errors.push(error)
    })
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task))
  }

  stop(): void {
    this.accepting = false
  }
  pending(): number {
    return this.tasks.size
  }

  async drain(): Promise<void> {
    let stableTurns = 0
    for (let turn = 0; turn < 64; turn += 1) {
      await Promise.all([...this.tasks])
      await Promise.resolve()
      if (this.tasks.size === 0) {
        stableTurns += 1
        if (stableTurns === 2) {
          if (this.errors.length > 0) {
            throw new AggregateError(this.errors, 'Host-private window microtask drain failed')
          }
          return
        }
      } else {
        stableTurns = 0
      }
    }
    throw new Error('Host-private window microtasks did not reach a fixed point')
  }
}

const windowMicrotasks = new WeakMap<JSDOM, HostPrivateWindowMicrotaskScope>()

function page(): JSDOM {
  const dom = new JSDOM(
    '<!doctype html><html lang="en" class="electron-dark"><head></head><body><button data-cordisx-playground-manager-trigger>Manager</button><main data-cordisx-playground-seat="app"></main></body></html>',
    {
      runScripts: 'dangerously',
      url: 'https://cordisx.local/',
      pretendToBeVisual: true,
    },
  )
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  const microtasks = new HostPrivateWindowMicrotaskScope()
  Object.defineProperty(dom.window, 'queueMicrotask', {
    configurable: true,
    value: (callback: VoidFunction) => microtasks.queue(callback),
  })
  windowMicrotasks.set(dom, microtasks)
  dom.window.console.info = () => {}
  return dom
}

async function closePage(dom: JSDOM): Promise<void> {
  const microtasks = windowMicrotasks.get(dom)
  await microtasks?.drain()
  microtasks?.stop()
  await microtasks?.drain()
  dom.window.close()
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

class HostPrivateCallbackScope {
  private accepting = true
  private readonly tasks = new Set<Promise<void>>()
  private readonly errors: unknown[] = []

  run(callback: () => Promise<void>): void {
    if (!this.accepting) return
    const task = Promise.resolve().then(callback).catch(error => {
      this.errors.push(error)
    })
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task))
  }

  stop(): void {
    this.accepting = false
  }
  active(): boolean {
    return this.accepting
  }
  pending(): number {
    return this.tasks.size
  }
  async drain(): Promise<void> {
    await Promise.all([...this.tasks])
    if (this.errors.length > 0) throw new AggregateError(this.errors, 'Host-private callback drain failed')
  }
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
): Promise<
  {
    selected: { providerId: string; providerGeneration: string }
    providers: readonly { providerId: string; providerGeneration: string }[]
  }
> {
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
    const result = {
      selected: { ...snapshot.selected },
      providers: snapshot.providers.map(provider => ({ ...provider })),
    }
    await runtime.dispose()
    return result
  } finally {
    await closePage(dom)
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
  const callbacks = new HostPrivateCallbackScope()
  const releasePersistedResponse = deferred()
  let lateCallbackTouchedDom = false
  let readyLeaseRevision = 0
  const context: IconThemePreferencePersistenceContext = {
    configPath,
    appId: 'codex',
    profileId: 'default',
    hostGeneration,
    token,
  }
  Object.defineProperty(dom.window, '__cordisxIconThemePreferenceRequestV1', {
    configurable: true,
    value: (payload: string) => {
      if (!callbacks.active()) return
      const request = JSON.parse(payload) as Record<string, unknown>
      if (request.kind === 'document-ready') {
        readyLeaseRevision += 1
        ;(dom.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => unknown })
          .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({
            kind: 'document-ready',
            requestId: request.requestId,
            ok: true,
            readyLeaseToken: `ready_process_${String(readyLeaseRevision).padStart(8, '0')}`,
            readyLeaseRevision,
            documentEpoch: request.documentEpoch,
            synchronization: 'complete',
            requiredRevision: request.currentRevision,
            currentRevision: request.currentRevision,
          }))
        return
      }
      wireCandidateKeys = Object.keys(request.candidate as Record<string, unknown>).sort()
      callbacks.run(async () => {
        try {
          const parsed = parseIconThemePreferenceBindingRequest(request, context)
          const value = await persistIconThemePreference(context, parsed)
          await releasePersistedResponse.promise
          if (!callbacks.active()) return
          lateCallbackTouchedDom = true
          ;(dom.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
            .__cordisxIconThemePreferenceReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        } catch (error) {
          if (!callbacks.active()) return
          lateCallbackTouchedDom = true
          ;(dom.window as unknown as { __cordisxIconThemePreferenceReceiveV1?: (payload: string) => void })
            .__cordisxIconThemePreferenceReceiveV1?.(
              JSON.stringify({ requestId: request.requestId, ok: false, ...iconThemePreferenceBridgeError(error) }),
            )
        }
      })
    },
  })
  try {
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true', 'process A readiness')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: Runtime }).__cordisxRuntime!
    const snapshot = runtime.snapshot().iconThemes!
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')?.click()
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')?.click()
    if (dom.window.document.querySelector('#cxr-icon-theme-provider') !== null) {
      throw new Error('removed icon-theme picker is visible')
    }
    const provider = snapshot.providers.find(item => item.providerId === 'plugin:icon-theme-test:aurora')
    if (provider === undefined) throw new Error('Aurora provider is unavailable')
    const candidate = {
      providerId: provider.providerId,
      namespace: provider.namespace,
      providerVersion: provider.providerVersion,
      providerGeneration: provider.providerGeneration,
    }
    wireCandidateKeys = Object.keys(candidate).sort()
    const request: IconThemePreferenceBindingRequest = {
      requestId: 'process-a-private-persistence',
      expectedPreferenceRevision: 0,
      expectedProfileRevision: snapshot.profileRevision,
      selectedProfileRevision: snapshot.profileRevision,
      candidate,
    }
    const preference = await persistIconThemePreference(context, request)
    const selected = { providerId: preference.providerId, providerGeneration: preference.providerGeneration }
    const callbacksPendingAtShutdown = callbacks.pending()
    callbacks.stop()
    await runtime.dispose()
    releasePersistedResponse.resolve()
    await callbacks.drain()
    let nestedWindowMicrotasksDrained = false
    dom.window.queueMicrotask(() =>
      dom.window.queueMicrotask(() => {
        nestedWindowMicrotasksDrained = true
      })
    )
    await windowMicrotasks.get(dom)?.drain()
    return {
      hostGeneration,
      selected,
      preference,
      wireCandidateKeys,
      teardown: {
        callbacksPendingAtShutdown,
        lateCallbackTouchedDom,
        callbacksDrained: callbacks.pending() === 0,
        nestedWindowMicrotasksDrained,
      },
      configMode: (await stat(configPath)).mode & 0o777,
    }
  } finally {
    callbacks.stop()
    releasePersistedResponse.resolve()
    await callbacks.drain()
    await closePage(dom)
  }
}

async function processB(): Promise<Record<string, unknown>> {
  const preference = (await loadHomeConfig(configPath)).apps.codex!.profiles.default!.iconTheme!
  const exact = await boot(await composition(), preference)
  const changedArtifact = await boot(await composition(true, { artifactRevision: 2 }), preference)
  const missing = await boot({ ...(await composition()), plugins: [] }, preference)
  const disabled = await boot(await composition(false), preference)
  return {
    hostGeneration,
    preference,
    exact,
    changedArtifact,
    missing,
    disabled,
    configMode: (await stat(configPath)).mode & 0o777,
  }
}

async function processDrainFailure(): Promise<Record<string, unknown>> {
  const callbacks = new HostPrivateCallbackScope()
  callbacks.run(async () => {
    throw new Error('discriminating callback failure')
  })
  callbacks.stop()
  await callbacks.drain()
  return { unreachable: true }
}

async function main(): Promise<void> {
  if (phase !== 'a' && phase !== 'b' && phase !== 'drain-error') throw new Error('phase must be a, b, or drain-error')
  const result = phase === 'a' ? await processA() : phase === 'b' ? await processB() : await processDrainFailure()
  process.stdout.write(`CORDISX_ICON_PROCESS_RESULT=${JSON.stringify(result)}\n`)
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
