import type { RouteLinkResolutionResult } from '@cordisx/protocol/route-link-resolution/v1'
import type { CordisXRouteReference } from '../contracts.js'

/** Public validation and result projection around the existing authorized canonical link generator. */
export function resolveRouteLink(reference: CordisXRouteReference, state: {
  readonly disposed: boolean
  readonly active: () => boolean
  readonly deepLink: () => string
}): RouteLinkResolutionResult {
  if (state.disposed) return { status: 'unavailable', code: 'host-unavailable' }
  if (!state.active()) return { status: 'unavailable', code: 'caller-unavailable' }
  if (
    reference === null || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).some(key => key !== 'id' && key !== 'params')
    || typeof reference.id !== 'string' || reference.id.length < 1 || [...reference.id].length > 256
    || (reference.params !== undefined && (reference.params === null || typeof reference.params !== 'object'
      || Array.isArray(reference.params) || Object.values(reference.params).some(value =>
        value !== null && typeof value !== 'string' && typeof value !== 'boolean'
        && (typeof value !== 'number' || !Number.isFinite(value))
      )))
  ) return { status: 'unavailable', code: 'invalid-route' }
  try {
    const url = state.deepLink()
    return state.active() ? { status: 'accepted', url } : { status: 'unavailable', code: 'caller-unavailable' }
  } catch {
    return { status: 'unavailable', code: 'route-unavailable' }
  }
}
