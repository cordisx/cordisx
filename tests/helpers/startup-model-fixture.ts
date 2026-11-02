import { vi } from 'vitest'
import type {
  StartupEventV1,
  StartupObserverV1,
  StartupProjectionV1,
  StartupSnapshotV1,
} from '@cordisx/protocol/startup/v1'

export function startupProvider(patch: Partial<StartupProjectionV1> = {}): StartupProjectionV1 {
  return {
    identity: { pluginId: 'p', capabilityId: 'models', serviceId: 'service', providerId: 'first' },
    generation: { host: 'host-1', plugin: 'plugin-1', service: 'service-1' },
    state: 'declared',
    service: 'unknown',
    process: 'not-started',
    health: 'unknown',
    authentication: 'unknown',
    catalog: { state: 'pending' },
    provider: 'unpublished',
    milestones: [],
    actions: {
      execute: { available: false, reason: 'not-prepared' },
      authenticate: { available: false, reason: 'unsupported' },
      retry: { available: false, reason: 'not-prepared' },
    },
    ...patch,
  }
}

export function startupSnapshot(entries = [startupProvider()], epoch = 'epoch-1', sequence = 1): StartupSnapshotV1 {
  return {
    contract: 'cordisx.startup-snapshot/v1',
    cursor: { scopeId: 'scope', hostGeneration: 'host-1', epoch, sequence },
    entries,
    pages: [],
  }
}

export function startupObserver(snapshot = startupSnapshot()) {
  let listener: ((event: StartupEventV1) => void) | undefined
  const close = vi.fn()
  const observer: StartupObserverV1 = {
    contract: 'cordisx.startup-observer/v1',
    read: async () => snapshot,
    subscribe: async callback => {
      listener = callback
      callback({ kind: 'snapshot', reason: 'initial', snapshot })
      return { close }
    },
  }
  return { observer, close, emit: (event: StartupEventV1) => listener!(event) }
}
