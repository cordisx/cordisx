import type { CordisXPlatformDiagnostic, CordisXPlatformResult } from '../contracts.js'
import { ProviderRegistryError } from '../renderer/provider-registry.js'

export function failure(
  code: CordisXPlatformDiagnostic['code'],
  message: string,
  retryable = false,
): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable: true } : {}) } }
}

export function copy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export function registryFailure(error: unknown): CordisXPlatformResult<never> {
  if (error instanceof ProviderRegistryError) {
    return failure(
      error.code === 'invalid-provider' ? 'invalid-provider' : 'adapter-unavailable',
      error.message,
      error.code !== 'invalid-provider',
    )
  }
  return failure('adapter-failure', 'External provider routing failed', true)
}
