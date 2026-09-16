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
    const wait = vi.fn(async () => undefined)
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
      { delayMs: 0, wait, log },
    )

    expect(result).toBe('verified')
    expect(attempts).toEqual([1, 2])
    expect(new Set(caches).size).toBe(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      '[registry] release package installation is still propagating (attempt 1/12)',
    )
  })

  it('does not retry a non-propagation failure', async () => {
    const operation = vi.fn(async () => {
      throw new Error('installed license mismatch')
    })

    await expect(retryRegistryPropagation('release package installation', operation, {
      delayMs: 0,
      wait: async () => undefined,
    })).rejects.toThrow('installed license mismatch')
    expect(operation).toHaveBeenCalledOnce()
  })
})
