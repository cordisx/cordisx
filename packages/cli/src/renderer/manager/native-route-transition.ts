export interface NativeRouteSnapshot {
  readonly available: boolean
  readonly key?: string
  readonly index?: number
  readonly nativeLocation?: Readonly<{ pathname: string; search: string; hash: string }>
}

export interface NativeRouteSource {
  snapshot(): NativeRouteSnapshot
  subscribe(listener: () => void): () => void
}

/** The Codex router is the authority; pointer and focus events carry no route identity. */
export function nativeRouteIdentity(snapshot: NativeRouteSnapshot): string | undefined {
  const location = snapshot.nativeLocation
  if (
    !snapshot.available || location === undefined || snapshot.key === undefined
  ) return undefined
  return JSON.stringify([
    location.pathname,
    location.search,
    location.hash,
    snapshot.key,
    snapshot.index ?? null,
  ])
}

/** Observe only committed router transitions, including native Back/Forward. */
export function observeNativeRouteTransition(
  source: NativeRouteSource,
  onLeave: () => void,
): () => void {
  const initial = nativeRouteIdentity(source.snapshot())
  if (initial === undefined) {
    onLeave()
    return () => {}
  }
  let active = true
  const onTransition = () => {
    if (!active) return
    if (nativeRouteIdentity(source.snapshot()) !== initial) {
      active = false
      onLeave()
    }
  }
  const unsubscribe = source.subscribe(onTransition)
  // A transition between the initial read and listener installation must not
  // leave the Manager mounted on the wrong native page.
  onTransition()
  return () => {
    active = false
    unsubscribe()
  }
}
