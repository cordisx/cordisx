import type { StartupActionAvailabilityV1 } from '@cordisx/protocol/startup/v1'
import { StartupRequirementsCoordinator, type StartupRequirementsResult } from '../cli/startup-requirements.js'
import type { ManagedServiceStartupAuthority } from './managed-service-startup-authority.js'

export interface StartupProviderAdmission {
  availability(providerId: string, modelId: string): StartupActionAvailabilityV1 | undefined
  wait(providerId: string, modelId: string, signal?: AbortSignal): Promise<StartupRequirementsResult | undefined>
}

/** Undefined means legacy/not declared, never a declared provider that is still preparing. */
export function startupProviderAdmission(authority: ManagedServiceStartupAuthority): StartupProviderAdmission {
  const coordinator = new StartupRequirementsCoordinator(authority)
  return {
    availability(providerId, modelId) {
      const target = authority.providerReference(providerId)
      return target === undefined ? undefined : authority.availability(target, modelId)
    },
    async wait(providerId, modelId, signal) {
      const target = authority.providerReference(providerId)
      return target === undefined ? undefined : await coordinator.wait({
        mode: 'command',
        explicit: { target, modelId },
        timeoutMs: 55_000,
        ...(signal === undefined ? {} : { signal }),
      })
    },
  }
}

/** Native composition may still be preparing when the Host control plane opens. */
export function startupTerminalRequests(
  authority: ManagedServiceStartupAuthority,
  current: () => import('./native-submission-composition.js').NativeSubmissionComposition | undefined,
): (
  request: import('./terminal-provider.js').TerminalProviderRequest,
) => Promise<import('./terminal-provider.js').TerminalProviderResult> {
  const waiters = new Map<string, AbortController>()
  return async request => {
    if (request.kind === 'cancel-wait' && waiters.has(request.waiterId)) {
      waiters.get(request.waiterId)!.abort()
      return { kind: 'cancelled' }
    }
    if (request.kind === 'wait') {
      const target = request.providerId === undefined ? undefined : authority.providerReference(request.providerId)
      if (request.providerId === undefined || target !== undefined) {
        if (request.waiterId !== undefined && waiters.has(request.waiterId)) {
          throw new Error('Startup waiter already exists')
        }
        const waiter = new AbortController()
        if (request.waiterId !== undefined) waiters.set(request.waiterId, waiter)
        try {
          const result = await new StartupRequirementsCoordinator(authority).wait({
            signal: waiter.signal,
            mode: 'command',
            timeoutMs: 55_000,
            ...(target === undefined
              ? {}
              : { explicit: { target, ...(request.model === undefined ? {} : { modelId: request.model }) } }),
          })
          return result.status === 'ready' ? { kind: 'ready' } : { kind: 'unavailable', startup: result }
        } finally {
          if (request.waiterId !== undefined) waiters.delete(request.waiterId)
        }
      }
    }
    const native = current()?.terminalProvider
    if (native === undefined) throw new Error('Terminal provider unavailable in this runtime')
    return await native(request)
  }
}
