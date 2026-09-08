import type {
  RestrictedContentFailureV1,
  RestrictedContentSeatV1,
  RestrictedContentV1,
} from '@cordisx/protocol/restricted-content/v1'
import { mountRestrictedScene } from './restricted-content/index.js'
/** Per-owner facade. Renderer lifetimes and callbacks never come from author scene data. */
export function createRestrictedContentService(active: () => boolean): RestrictedContentV1 {
  const lifetime = new AbortController()
  const seats = new Set<RestrictedContentSeatV1>()
  const elements = new WeakSet<HTMLElement>()
  const live = () => !lifetime.signal.aborted && active()
  return Object.freeze({
    contract: 'cordisx.restricted-content/v1',
    async mount(input: Parameters<RestrictedContentV1['mount']>[0]) {
      if (!live()) return { status: 'unavailable' as const, code: 'disposed' as const }
      if (
        !input?.element?.ownerDocument || typeof input.onAction !== 'function' || elements.has(input.element)
        || seats.size >= 16
      ) {
        return { status: 'unavailable' as const, code: 'invalid-request' as const }
      }
      try {
        const native = mountRestrictedScene({
          element: input.element,
          onAction: input.onAction,
          isCurrent: live,
          signal: lifetime.signal,
        })
        let disposed = false
        const seat: RestrictedContentSeatV1 = Object.freeze({
          contract: 'cordisx.restricted-content-seat/v1',
          publish(
            snapshot: Parameters<RestrictedContentSeatV1['publish']>[0],
          ): ReturnType<RestrictedContentSeatV1['publish']> {
            if (disposed || !live()) return { status: 'unavailable', code: 'disposed' }
            const result = native.publish({ sequence: snapshot.sequence, scene: snapshot.payload })
            if (result.status === 'accepted') return { status: 'accepted', value: null }
            const code: RestrictedContentFailureV1 = result.code === 'invalid-scene' ? 'invalid-request' : result.code
            try {
              input.onUnavailable?.(code)
            } catch { /* Consumer notification does not change lifetime. */ }
            return { status: 'unavailable', code }
          },
          dispose() {
            if (disposed) return
            disposed = true
            native.dispose()
            elements.delete(input.element)
            seats.delete(seat)
          },
        })
        seats.add(seat)
        elements.add(input.element)
        return { status: 'accepted' as const, value: seat }
      } catch {
        return { status: 'unavailable' as const, code: 'invalid-request' as const }
      }
    },
    dispose() {
      lifetime.abort()
      for (const seat of seats) seat.dispose()
    },
  })
}
