import type { CordisXPlatformResult } from '../contracts.js'
import { failure } from './fleet-results.js'

export function selectFleetProviders(
  snapshots: readonly { readonly providerId: string; readonly state: string }[],
  names: ReadonlyMap<string, string>,
  requested?: readonly string[],
): CordisXPlatformResult<readonly string[]> {
  const active = new Set(snapshots.filter(item => item.state === 'active').map(item => item.providerId))
  const selected = requested === undefined || requested.length === 0 ? [...active].sort() : [...requested].sort()
  const unavailable = selected.find(providerId => !active.has(providerId))
  if (unavailable === undefined) return { ok: true, value: selected }
  return names.has(unavailable)
    ? failure('adapter-unavailable', `External provider ${unavailable} is unavailable`, true)
    : failure('invalid-provider', `External provider ${unavailable} is not configured`)
}
