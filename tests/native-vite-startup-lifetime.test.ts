import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nativeViteBootModuleSource,
  nativeViteEntryModuleSource,
} from '../packages/cli/src/launcher/vite-development.js'
import { nativeViteManifestLoaderSource } from '../packages/cli/src/launcher/vite-manifest-loader.js'
import { VITE_DISPOSE_EXPRESSION } from '../packages/cli/src/launcher/cdp-installation-support.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(load: (url: string) => Promise<unknown>) {
  const install = vi.fn(async (_plugins, _metadata, _bootstrap, signal) => {
    signal.throwIfAborted()
    return { active: true }
  })
  const releaseReact = vi.fn()
  const prepareReact = vi.fn(() => releaseReact)
  const context = createContext({
    load,
    setTimeout,
    clearTimeout,
    AbortController,
    document: {},
    console,
    hot: undefined,
    installCordisX: install,
    prepareCordisXViteReactRuntime: prepareReact,
    NativeViteDevelopmentClient: class {
      constructor(..._args: unknown[]) {}
      restart(operation: typeof install) {
        return operation([], {}, undefined, undefined, {})
      }
    },
  })
  const owner = () => runInContext(nativeViteManifestLoaderSource('http://loopback/manifest'), context)
  const boot = nativeViteBootModuleSource({
    reactPrepareUrl: 'http://loopback/prepare',
    entryUrl: 'http://loopback/entry',
  })
    .replace('export function start', 'globalThis.bootStart = function')
    .replaceAll('import.meta.hot', 'hot').replace(/\bimport\(/g, 'load(')
  const entry = nativeViteEntryModuleSource({
    hostImport: 'host',
    helperImport: 'client',
    pluginsSource: '[]',
    metadataSource: '{}',
    pluginImports: [],
    pluginUrls: ['http://loopback/plugin'],
  }).replace(/^import[^\n]*\n/gm, '')
    .replace('export async function start', 'globalThis.entryStart = async function')
    .replaceAll('import.meta.hot', 'hot').replace(/\bimport\(/g, 'load(')
  runInContext(boot, context)
  runInContext(entry, context)
  return { context, owner, install, prepareReact, releaseReact }
}
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe('generated native Vite startup lifetime', () => {
  it.each(['prepare', 'entry'])('cannot activate after disposal while %s import is pending', async phase => {
    const pending = deferred<unknown>()
    let f!: ReturnType<typeof fixture>
    const load = vi.fn(async (url: string) => {
      if (url.includes('/' + phase + '?')) return await pending.promise
      return url.includes('/entry?') ? { start: f.context.entryStart } : {}
    })
    f = fixture(load)
    const startup = f.owner()
    const task = f.context.bootStart(startup)
    const rejection = expect(task).rejects.toThrow('startup canceled')
    await tick()
    await runInContext(VITE_DISPOSE_EXPRESSION, f.context)
    pending.resolve({ start: f.context.entryStart })
    await rejection
    expect(f.install).not.toHaveBeenCalled()
    expect(f.prepareReact).not.toHaveBeenCalled()
    if (phase === 'prepare') expect(load.mock.calls.some(([url]) => url.includes('/entry?'))).toBe(false)
  })

  it('cannot create a client after disposal while plugin preparation is pending', async () => {
    const pending = deferred<{ load(): Promise<unknown> }>()
    const f = fixture(async () => await pending.promise)
    expect(f.prepareReact).not.toHaveBeenCalled() // Evaluating the imported entry is inert.
    const startup = f.owner()
    const task = f.context.entryStart(startup)
    const rejection = expect(task).rejects.toThrow('startup canceled')
    await tick()
    await runInContext(VITE_DISPOSE_EXPRESSION, f.context)
    pending.resolve({ load: async () => ({ plugin: { id: 'fixture' } }) })
    await rejection
    expect(f.install).not.toHaveBeenCalled()
    expect(f.context.__cordisxViteClient).toBeUndefined()
    expect(f.releaseReact).toHaveBeenCalledOnce()
  })

  it('cleans a transferred channel when disposal wins old-client cleanup', async () => {
    const pending = deferred<void>()
    const channel = { dispose: vi.fn() }
    const f = fixture(async () => ({}))
    f.context.__cordisxViteClient = {
      releaseCertifiedPermissionChannel: () => channel,
      dispose: () => pending.promise,
    }
    const startup = f.owner()
    const task = f.context.entryStart(startup)
    const rejection = expect(task).rejects.toThrow('startup canceled')
    startup.abort()
    pending.resolve()
    await rejection
    expect(channel.dispose).toHaveBeenCalledOnce()
    expect(f.prepareReact).not.toHaveBeenCalled()
    expect(f.install).not.toHaveBeenCalled()
  })

  it('cancels retry timers and queued HMR starts with the captured owner', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => {
      throw Error('temporary import failure')
    })
    const f = fixture(load)
    const startup = f.owner()
    const first = f.context.bootStart(startup)
    const second = f.context.bootStart()
    const failures = [
      expect(first).rejects.toThrow('startup canceled'),
      expect(second).rejects.toThrow('startup canceled'),
    ]
    await tick()
    expect(vi.getTimerCount()).toBe(1)
    await runInContext(VITE_DISPOSE_EXPRESSION, f.context)
    await Promise.all(failures)
    expect(vi.getTimerCount()).toBe(0)
    expect(load).toHaveBeenCalledOnce()
  })

  it('keeps an old pending task fenced while a replacement owner can start normally', async () => {
    const pending = deferred<unknown>()
    let f!: ReturnType<typeof fixture>
    let first = true
    const load = vi.fn(async (url: string) => {
      if (url.includes('/prepare?') && first) {
        first = false
        return await pending.promise
      }
      if (url.includes('/entry?')) return { start: f.context.entryStart }
      return { load: async () => ({ plugin: { id: 'fixture' } }) }
    })
    f = fixture(load)
    const old = f.owner()
    const stale = f.context.bootStart(old)
    const rejection = expect(stale).rejects.toThrow('startup canceled')
    await tick()
    await runInContext(VITE_DISPOSE_EXPRESSION, f.context)
    const replacement = f.owner()
    const task = f.context.bootStart(replacement)
    pending.resolve({})
    await rejection
    await task
    expect(f.install).toHaveBeenCalledOnce()
    expect(f.install.mock.calls[0]![3]).toBe(replacement.signal)
    expect(old.signal.aborted).toBe(true)
    expect(replacement.signal.aborted).toBe(false)
  })
})
