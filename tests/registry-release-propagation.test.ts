import { describe, expect, it, vi } from 'vitest'
import {
  markRegistryPropagationError,
  registryAttemptCache,
  retryRegistryPropagation,
} from '../scripts/registry-release-propagation.mjs'

describe('registry release propagation retries', () => {
  it('retries an installed-version mismatch with a fresh cache', async () => {
    const attempts: number[] = []
    const caches: string[] = []
    let elapsed = 0
    const wait = vi.fn(async (delay: number) => {
      elapsed += delay
    })
    const log = vi.fn()

    const result = await retryRegistryPropagation(
      'release package installation',
      async attempt => {
        attempts.push(attempt)
        caches.push(registryAttemptCache('/tmp/release', 'install', attempt))
        if (attempt === 1) {
          throw markRegistryPropagationError(new Error('create-cordisx-plugin installed version mismatch'))
        }
        return 'verified'
      },
      { initialDelayMs: 1000, maxDelayMs: 4000, timeoutMs: 10_000, wait, log, now: () => elapsed },
    )

    expect(result).toBe('verified')
    expect(attempts).toEqual([1, 2])
    expect(new Set(caches).size).toBe(2)
    expect(wait).toHaveBeenCalledWith(1000)
    expect(log).toHaveBeenCalledWith(
      '[registry] release package installation is still propagating after 0s '
        + '(attempt 1); retrying in 1s (deadline 10s)',
    )
  })

  it('uses bounded exponential backoff while a 404 propagates', async () => {
    let elapsed = 0
    const wait = vi.fn(async (delay: number) => {
      elapsed += delay
    })
    const operation = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw markRegistryPropagationError(new Error('npm view failed with E404'))
      return 'visible'
    })

    await expect(retryRegistryPropagation('package metadata', operation, {
      initialDelayMs: 1000,
      maxDelayMs: 1500,
      timeoutMs: 5000,
      wait,
      now: () => elapsed,
    })).resolves.toBe('visible')
    expect(wait.mock.calls).toEqual([[1000], [1500]])
  })

  it('does not retry a non-propagation failure', async () => {
    const operation = vi.fn(async () => {
      throw new Error('installed license mismatch')
    })

    await expect(retryRegistryPropagation('release package installation', operation, {
      initialDelayMs: 1,
      wait: async () => undefined,
    })).rejects.toThrow('installed license mismatch')
    expect(operation).toHaveBeenCalledOnce()
  })
})
