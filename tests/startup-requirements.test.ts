import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartupActionAvailabilityV1, StartupCapabilityRefV1 } from '@cordisx/protocol/startup/v1'
import {
  type StartupRequirementsAuthority,
  StartupRequirementsCoordinator,
} from '../packages/cli/src/cli/startup-requirements.js'

const target = { pluginId: 'provider', capabilityId: 'models' }
const dependency = { pluginId: 'dependency', capabilityId: 'service' }
const unrelated = { pluginId: 'slow', capabilityId: 'service' }
const key = (ref: StartupCapabilityRefV1) => ref.pluginId
function fixture(always: StartupCapabilityRefV1[] = []) {
  const values = new Map<string, StartupActionAvailabilityV1>()
  const listeners = new Set<() => void>()
  const signals: AbortSignal[] = []
  const availability = vi.fn((ref: StartupCapabilityRefV1, model?: string): StartupActionAvailabilityV1 => {
    const value = values.get(key(ref)) ?? { available: false, reason: 'preparing' }
    return value.available && model !== undefined && model !== 'member'
      ? { available: false, reason: 'model-unavailable' }
      : value
  })
  const authority: StartupRequirementsAuthority = {
    targets: (_mode, explicit) => explicit === undefined ? always : [explicit, dependency],
    availability,
    wait: vi.fn((ref, options) =>
      new Promise((resolve, reject) => {
        signals.push(options.signal!)
        const cleanup = () => {
          listeners.delete(check)
          options.signal?.removeEventListener('abort', abort)
        }
        const check = () => {
          const value = availability(ref, options.modelId)
          if (!value.available && value.reason === 'preparing') return
          cleanup()
          resolve(value)
        }
        const abort = () => {
          cleanup()
          reject(options.signal?.reason)
        }
        if (options.signal?.aborted) return abort()
        options.signal?.addEventListener('abort', abort, { once: true })
        listeners.add(check)
        check()
      })
    ),
  }
  return {
    authority,
    coordinator: new StartupRequirementsCoordinator(authority),
    signals,
    listeners,
    set(ref: StartupCapabilityRefV1, value: StartupActionAvailabilityV1 = { available: true }) {
      values.set(key(ref), value)
      for (const listener of [...listeners]) listener()
    },
  }
}

afterEach(() => vi.useRealTimers())
describe('caller startup requirements', () => {
  it('ordinary core completion does not wait for background providers', async () => {
    const f = fixture()
    await expect(f.coordinator.wait({ mode: 'interactive', timeoutMs: 100 })).resolves.toEqual({ status: 'ready' })
    expect(f.authority.wait).not.toHaveBeenCalled()
  })

  it('waits for the selected provider and dependencies without waiting for unrelated work', async () => {
    const f = fixture()
    const result = f.coordinator.wait({ mode: 'command', explicit: { target, modelId: 'member' }, timeoutMs: 1000 })
    f.set(target)
    f.set(dependency)
    await expect(result).resolves.toEqual({ status: 'ready' })
    expect(f.authority.availability(unrelated)).toEqual({ available: false, reason: 'preparing' })
    expect(f.listeners.size).toBe(0)
  })

  it('also retains mode-applicable always requirements for an explicit target', async () => {
    const f = fixture([unrelated])
    f.set(target)
    f.set(dependency)
    const result = f.coordinator.wait({ mode: 'command', explicit: { target }, timeoutMs: 1000 })
    expect(f.listeners.size).toBe(1)
    f.set(unrelated)
    await expect(result).resolves.toEqual({ status: 'ready' })
  })

  it.each(
    [
      'authentication-required',
      'failed',
      'catalog-empty',
      'model-unavailable',
      'unknown-target',
      'stopped',
      'revoked',
    ] as const,
  )(
    'returns %s promptly even with a pending dependency',
    async reason => {
      const f = fixture()
      const result = f.coordinator.wait({ mode: 'command', explicit: { target }, timeoutMs: 1000 })
      f.set(target, { available: false, reason })
      await expect(result).resolves.toEqual({ status: 'unavailable', target, reason })
      expect(f.listeners.size).toBe(0)
    },
  )

  it('passes the exact selected model to membership checks without fallback', async () => {
    const f = fixture()
    f.set(target)
    f.set(dependency)
    await expect(f.coordinator.wait({ mode: 'command', explicit: { target, modelId: 'missing' }, timeoutMs: 1000 }))
      .resolves.toEqual({ status: 'unavailable', target, reason: 'model-unavailable' })
    expect(f.authority.wait).not.toHaveBeenCalled()
  })

  it('cancels only one of two independent callers sharing preparation', async () => {
    const f = fixture()
    const controller = new AbortController()
    const first = f.coordinator.wait({
      mode: 'command',
      explicit: { target },
      signal: controller.signal,
      timeoutMs: 1000,
    })
    const second = f.coordinator.wait({ mode: 'command', explicit: { target }, timeoutMs: 1000 })
    controller.abort()
    await expect(first).resolves.toEqual({ status: 'cancelled' })
    expect(f.listeners.size).toBe(2)
    f.set(target)
    f.set(dependency)
    await expect(second).resolves.toEqual({ status: 'ready' })
    expect(f.listeners.size).toBe(0)
  })

  it('has a fixed waiter deadline even if preparation never settles', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = f.coordinator.wait({ mode: 'command', explicit: { target }, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toEqual({ status: 'timed-out' })
    expect(f.signals.every(signal => signal.aborted)).toBe(true)
    expect(f.listeners.size).toBe(0)
  })
})
