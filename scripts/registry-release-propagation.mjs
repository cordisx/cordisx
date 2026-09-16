import path from 'node:path'
import { isNpmRegistryPropagationError } from './npm-pack-report.mjs'

export function registryAttemptCache(root, phase, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('registry attempt must be a positive integer')
  return path.join(root, 'npm-cache', phase, String(attempt))
}

export function markRegistryPropagationError(error) {
  if (!(error instanceof Error)) throw new Error('registry propagation failures must be Error instances')
  error.commandOutput = `${typeof error.commandOutput === 'string' ? error.commandOutput : ''}\nETARGET`
  return error
}

export async function retryRegistryPropagation(label, operation, options = {}) {
  const attempts = options.attempts ?? 12
  const delayMs = options.delayMs ?? 5000
  const wait = options.wait ?? (duration => new Promise(resolve => setTimeout(resolve, duration)))
  const log = options.log ?? console.log

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (!isNpmRegistryPropagationError(error) || attempt === attempts) throw error
      log(`[registry] ${label} is still propagating (attempt ${attempt}/${attempts})`)
      await wait(delayMs)
    }
  }
}
