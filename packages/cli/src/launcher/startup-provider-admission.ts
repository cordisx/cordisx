import { safeStartupSnapshot } from './startup-ui-projection.js'
import type {
  StartupActionAvailabilityV1,
  StartupCapabilityRefV1,
  StartupObserverV1,
  StartupSnapshotV1,
} from '@cordisx/protocol/startup/v1'
import { StartupRequirementsCoordinator, type StartupRequirementsResult } from '../cli/startup-requirements.js'
import type { ManagedServiceStartupAuthority } from './managed-service-startup-authority.js'

export interface StartupProviderAdmission {
  snapshot?(): Promise<StartupSnapshotV1>
  availability(providerId: string, modelId: string): StartupActionAvailabilityV1 | undefined
  wait(providerId: string, modelId: string, signal?: AbortSignal): Promise<StartupRequirementsResult | undefined>
}

/** Native clients select gateway model IDs; startup discovery reports aliases. */
export async function waitForNativeStartupProvider(
  authority: ManagedServiceStartupAuthority,
  target: StartupCapabilityRefV1,
  modelId?: string,
  signal?: AbortSignal,
): Promise<StartupRequirementsResult> {
  const result = await new StartupRequirementsCoordinator(authority).wait({
    mode: 'command',
    explicit: { target },
    timeoutMs: 55_000,
    ...(signal === undefined ? {} : { signal }),
  })
  if (signal?.aborted) return { status: 'cancelled' }
  if (result.status !== 'ready' || modelId === undefined) return result
  const admission = authority.nativeCatalogAdmission(target)
  if (!admission.available) return { status: 'unavailable', target, reason: admission.reason }
  return admission.modelIds.has(modelId)
    ? result
    : { status: 'unavailable', target, reason: 'model-unavailable' }
}

/** Undefined means legacy/not declared, never a declared provider that is still preparing. */
export function startupProviderAdmission(
  authority: ManagedServiceStartupAuthority,
  observer?: StartupObserverV1,
): StartupProviderAdmission {
  return {
    ...(observer === undefined ? {} : { snapshot: async () => safeStartupSnapshot(await observer.read()) }),
    availability(providerId, modelId) {
      const target = authority.providerReference(providerId)
      if (target === undefined) {
        return authority.hasProvider(providerId) ? { available: false, reason: 'unknown-target' } : undefined
      }
      const admission = authority.nativeCatalogAdmission(target)
      if (!admission.available) return admission
      return admission.modelIds.has(modelId) ? { available: true } : { available: false, reason: 'model-unavailable' }
    },
    async wait(providerId, modelId, signal) {
      const target = authority.providerReference(providerId)
      return target === undefined ? undefined : await waitForNativeStartupProvider(authority, target, modelId, signal)
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
          const result = target === undefined
            ? await new StartupRequirementsCoordinator(authority).wait({
              signal: waiter.signal,
              mode: 'command',
              timeoutMs: 55_000,
            })
            : await waitForNativeStartupProvider(authority, target, request.model, waiter.signal)
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
