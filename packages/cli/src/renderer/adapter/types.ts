interface ResolvedOutletAnchor {
  readonly anchor: HTMLElement
  readonly contextKey: string
  readonly nativeSessionId?: string
  readonly insets?: Readonly<{
    top?: number
    right?: number
    bottom?: number
    left?: number
  }>
  readonly pageChromeSafeLeft?: number
}

type OutletResolver = () => ResolvedOutletAnchor | undefined

interface NativeSurfaceSeat {
  readonly key: string
  readonly parent: HTMLElement
  readonly before: ChildNode | null
  readonly className: string
}

interface NativeActionSeat extends NativeSurfaceSeat {
  readonly template: HTMLButtonElement
}

interface NavigationLeadingVisualMount {
  readonly element: HTMLElement
  readonly semanticKey: string
  readonly dispose: () => void
}

export type { NativeActionSeat, NativeSurfaceSeat, NavigationLeadingVisualMount, OutletResolver, ResolvedOutletAnchor }
