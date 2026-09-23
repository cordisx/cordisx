import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostGenerationBootloaderSource } from '../packages/cli/src/launcher/host-generation-bootloader.js'
import {
  RENDERER_DISPOSE_EXPRESSION,
  waitForProductionBootstrap,
} from '../packages/cli/src/launcher/cdp-installation-support.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

const origin = `http://127.0.0.1:43210/cordisx-host-generation/${'a'.repeat(64)}`
const manifest = { version: 1, entry: '/host.js', digest: `sha256:${'b'.repeat(64)}` }
const response = () => ({ ok: true, json: async () => manifest })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function launch(
  fetch: ReturnType<typeof vi.fn>,
  budget = 1000,
  importModule = vi.fn(async () => ({ boot: vi.fn(async () => ({})) })),
) {
  const scope: Record<string, any> = {
    __cordisxProductionBootstrapTimeoutMs: budget,
    __cordisxProductionInstallId: 'owned',
  }
  // Replace only the VM's unsupported dynamic-import hook, not the boot logic.
  Function(
    'globalThis',
    'fetch',
    'importModule',
    'console',
    hostGenerationBootloaderSource(origin).replace('import(entry.href)', 'importModule(entry.href)'),
  )(
    scope,
    fetch,
    importModule,
    { error: vi.fn() },
  )
  return { scope, importModule, result: scope.__cordisxCompositionBoot as Promise<unknown> }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe('owned manifest startup window', () => {
  it('accepts a manifest that is denied until 500ms and activates exactly once', async () => {
    const fetch = vi.fn(async () => {
      if (Date.now() < 500) throw new TypeError('Failed to fetch')
      return response()
    })
    const run = launch(fetch)
    await vi.advanceTimersByTimeAsync(500)
    await expect(run.result).resolves.toEqual({})
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(run.importModule).toHaveBeenCalledOnce()
    expect(
      fetch.mock.calls.every(([url, options]) => url === `${origin}/manifest.json` && options.redirect === 'error'),
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds persistent denial and preserves its diagnostic without private URLs', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`ERR_BLOCKED_BY_CLIENT ${origin}`)
    })
    const run = launch(fetch)
    const rejected = expect(run.result).rejects.toThrow(
      'manifest fetch deadline exceeded: ERR_BLOCKED_BY_CLIENT [host graph]',
    )
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(run.importModule).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a stalled fetch at the deadline and ignores its late result', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    const fetch = vi.fn(() => pending.promise)
    const run = launch(fetch)
    const rejected = expect(run.result).rejects.toThrow('deadline exceeded')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    pending.resolve(response())
    await vi.advanceTimersByTimeAsync(0)
    expect(run.importModule).not.toHaveBeenCalled()
  })

  it.each(['fetch', 'json', 'import'] as const)(
    'disposal cancels pending %s and prevents late activation',
    async stage => {
      const pending = deferred<any>()
      const boot = vi.fn(async () => ({}))
      const importModule = vi.fn(() => stage === 'import' ? pending.promise : Promise.resolve({ boot }))
      const fetch = vi.fn(() =>
        stage === 'fetch'
          ? pending.promise
          : Promise.resolve({ ok: true, json: () => stage === 'json' ? pending.promise : Promise.resolve(manifest) })
      )
      const run = launch(fetch, 1000, importModule)
      const rejected = expect(run.result).rejects.toThrow('startup canceled')
      await vi.advanceTimersByTimeAsync(0)
      await Function('globalThis', `return ${RENDERER_DISPOSE_EXPRESSION}`)(run.scope)
      await rejected
      pending.resolve(stage === 'fetch' ? response() : stage === 'json' ? manifest : { boot })
      await vi.advanceTimersByTimeAsync(2000)
      expect(boot).not.toHaveBeenCalled()
      if (stage !== 'import') expect(importModule).not.toHaveBeenCalled()
      expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('cancels the real renderer fetch when the launcher wait is aborted', async () => {
    const fetch = vi.fn(() => new Promise(() => undefined))
    const run = launch(fetch)
    run.scope.__cordisxProductionBootstrapState = { installId: 'owned', status: 'evaluated' }
    const controller = new AbortController()
    const session = {
      isClosed: () => false,
      send: async (_method: string, params: any) => ({
        result: { value: await Function('globalThis', `return ${params.expression}`)(run.scope) },
      }),
    } as unknown as CdpSession
    const waiting = waitForProductionBootstrap(session, 'owned', 1000, controller.signal)
    const rejected = expect(waiting).rejects.toThrow(/abort/i)
    controller.abort()
    await rejected
    await expect(run.result).rejects.toThrow('startup canceled')
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(run.importModule).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, status: 403 }, 'HTTP 403'],
    [{
      ok: true,
      json: async () => {
        throw Error('bad JSON')
      },
    }, 'JSON invalid'],
    [{ ok: true, json: async () => ({ ...manifest, version: 2 }) }, 'schema invalid'],
    [{ ok: true, json: async () => ({ ...manifest, entry: '/../other.js' }) }, 'outside its owned graph'],
  ])('never retries an invalid or rejected manifest', async (value, error) => {
    const fetch = vi.fn(async () => value)
    const run = launch(fetch)
    await expect(run.result).rejects.toThrow(error)
    expect(fetch).toHaveBeenCalledOnce()
    expect(run.importModule).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never replays a failing activation', async () => {
    const boot = vi.fn(async () => {
      throw Error('activation failed')
    })
    const run = launch(vi.fn(async () => response()), 1000, vi.fn(async () => ({ boot })))
    await expect(run.result).rejects.toThrow('activation failed')
    expect(boot).toHaveBeenCalledOnce()
    expect(run.importModule).toHaveBeenCalledOnce()
  })

  it('bounds activation waiting and propagates cancellation to the activation', async () => {
    let signal!: AbortSignal
    const boot = vi.fn((value: AbortSignal) => {
      signal = value
      return new Promise(() => undefined)
    })
    const run = launch(vi.fn(async () => response()), 1000, vi.fn(async () => ({ boot })))
    const rejected = expect(run.result).rejects.toThrow('startup deadline exceeded')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(signal.aborted).toBe(true)
    const cleanup = Function('globalThis', `return ${RENDERER_DISPOSE_EXPRESSION}`)(run.scope)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await cleanup).toMatchObject({ ok: false, error: expect.stringContaining('activation cleanup timed out') })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels renderer work when the outer deadline already elapsed', async () => {
    const fetch = vi.fn(() => new Promise(() => undefined))
    const run = launch(fetch)
    const session = {
      isClosed: () => false,
      send: async (_method: string, params: any) => ({
        result: { value: await Function('globalThis', `return ${params.expression}`)(run.scope) },
      }),
    } as unknown as CdpSession
    await expect(waitForProductionBootstrap(session, 'owned', 0)).rejects.toThrow('timed out')
    await expect(run.result).rejects.toThrow('startup canceled')
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
  })
})
