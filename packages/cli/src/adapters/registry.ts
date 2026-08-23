import { codexAdapter } from './codex.js'
import { HostAdapterError, type HostAdapter } from './contracts.js'

const adapters = new Map<string, HostAdapter>([
  [codexAdapter.id, codexAdapter],
])

export function resolveHostAdapter(id: string): HostAdapter {
  const adapter = adapters.get(id)
  if (adapter === undefined) {
    throw new HostAdapterError('adapter-not-installed', `host adapter is not installed: ${id}`)
  }
  if (typeof adapter.resolveLaunchPlan !== 'function') {
    throw new HostAdapterError('adapter-not-launch-capable', `host adapter cannot launch: ${id}`)
  }
  return adapter
}

export function listHostAdapters(): readonly HostAdapter[] {
  return [...adapters.values()]
}
