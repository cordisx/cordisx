import path from 'node:path'
import { isNpmRegistryPropagationError } from './npm-pack-report.mjs'

export function registryAttemptCache(root, phase, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('registry attempt must be a positive integer')
  return path.join(root, 'npm-cache', phase, String(attempt))
}

export function markRegistryPropagationError(error, phase) {
  if (!(error instanceof Error)) throw new Error('registry propagation failures must be Error instances')
  error.commandOutput = `${typeof error.commandOutput === 'string' ? error.commandOutput : ''}\nETARGET`
  if (phase !== undefined) error.releasePhase = phase
  return error
}

export async function retryRegistryPropagation(label, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const initialDelayMs = options.initialDelayMs ?? 5000
  const maxDelayMs = options.maxDelayMs ?? 60 * 1000
  const factor = options.factor ?? 2
  const wait = options.wait ?? (duration => new Promise(resolve => setTimeout(resolve, duration)))
  const log = options.log ?? console.log
  const now = options.now ?? Date.now

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('registry timeout must be positive')
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw new Error('registry initial delay must be positive')
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error('registry maximum delay must be at least the initial delay')
  }
  if (!Number.isFinite(factor) || factor <= 1) throw new Error('registry backoff factor must exceed one')

  const startedAt = now()
  for (let attempt = 1;; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (!isNpmRegistryPropagationError(error)) throw error
      const elapsedMs = Math.max(0, now() - startedAt)
      const remainingMs = timeoutMs - elapsedMs
      if (remainingMs <= 0) {
        throw new Error(
          `[registry] ${label} timed out after ${attempt} attempts within ${Math.round(timeoutMs / 1000)}s`,
          {
            cause: error,
          },
        )
      }
      const backoffMs = initialDelayMs * factor ** (attempt - 1)
      const delayMs = Math.min(backoffMs, maxDelayMs, remainingMs)
      log(
        `[registry] ${label} is still propagating after ${Math.round(elapsedMs / 1000)}s `
          + `(attempt ${attempt}); retrying in ${Math.round(delayMs / 1000)}s `
          + `(deadline ${Math.round(timeoutMs / 1000)}s)`,
      )
      await wait(delayMs)
    }
  }
}
