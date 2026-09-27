import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeViteManifestLoaderSource } from '../packages/cli/src/launcher/vite-manifest-loader.js'
import { VITE_DISPOSE_EXPRESSION } from '../packages/cli/src/launcher/cdp-installation-support.js'

const url = 'http://127.0.0.1:12345/launch/host-manifest.json'
function fixture(fetch: unknown) {
  vi.useFakeTimers()
  const context = createContext({ fetch, setTimeout, clearTimeout, AbortController })
  const owner = runInContext(nativeViteManifestLoaderSource(url), context)
  return { owner, context }
}
afterEach(() => vi.useRealTimers())
describe('native Vite initial manifest', () => {
  it('waits through native startup transport denial without changing destination or policy', async () => {
    const response = { ok: true }
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(response)
    const { owner } = fixture(fetch)
    const pending = owner.read()
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toBe(response)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(args => args[0] === url && args[1].signal instanceof AbortSignal)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps permanent denials unavailable after the wall-clock budget', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { owner } = fixture(fetch)
    const result = expect(owner.read()).rejects.toThrow('manifest fetch timed out')
    await vi.advanceTimersByTimeAsync(20000)
    await result
    expect(fetch).toHaveBeenCalledTimes(80)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a hanging fetch even when the transport ignores abort', async () => {
    const fetch = vi.fn((_input: string, _options: { signal: AbortSignal }) => new Promise(() => {}))
    const { owner } = fixture(fetch)
    const result = expect(owner.read()).rejects.toThrow('manifest fetch timed out')
    await vi.advanceTimersByTimeAsync(20000)
    await result
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('disposal cancels pending fetch and prevents a late activation', async () => {
    let finish!: (response: unknown) => void
    const fetch = vi.fn(() =>
      new Promise(resolve => {
        finish = resolve
      })
    )
    const { owner, context } = fixture(fetch)
    const activate = vi.fn()
    const task = owner.read().then(() => {
      owner.check()
      activate()
    })
    const result = expect(task).rejects.toThrow('startup canceled')
    await runInContext(VITE_DISPOSE_EXPRESSION, context)
    await result
    finish({ ok: true })
    await Promise.resolve()
    expect(activate).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(context.__cordisxViteStartupAbort).toBeUndefined()
  })
  it('disposal releases a pending retry timer', async () => {
    const { owner, context } = fixture(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = expect(owner.read()).rejects.toThrow('startup canceled')
    await vi.advanceTimersByTimeAsync(0)
    await runInContext(VITE_DISPOSE_EXPRESSION, context)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not retry HTTP policy denials or missing manifests', async () => {
    const response = { ok: false, status: 403 }
    const fetch = vi.fn().mockResolvedValue(response)
    const { owner } = fixture(fetch)
    expect(await owner.read()).toBe(response)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
