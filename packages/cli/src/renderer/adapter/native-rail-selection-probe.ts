interface FiberLike {
  readonly memoizedProps?: unknown
  readonly return?: FiberLike | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read-only 26.924 native rail state. React props remain intact during a Host DOM projection. */
export function readNativeRailSelection(rail: HTMLElement): HTMLButtonElement | undefined {
  if (!rail.isConnected || rail.matches('nav[data-app-navigation-rail="true"]') === false) return undefined
  const buttons = [...rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination]')]
  if (buttons.length < 2) return undefined
  const selected: HTMLButtonElement[] = []
  const identities = new Set<string>()
  for (const button of buttons) {
    const destination = button.getAttribute('data-sidebar-destination')
    const keys = Object.keys(button).filter(key => key.startsWith('__reactFiber$'))
    if (destination === null || identities.has(destination) || keys.length !== 1) return undefined
    identities.add(destination)
    const fiber = (button as unknown as Record<string, unknown>)[keys[0]!] as FiberLike | undefined
    const props = record(fiber?.return?.memoizedProps) ? fiber.return.memoizedProps : undefined
    if (props?.['data-sidebar-destination'] !== destination || typeof props.selected !== 'boolean') {
      return undefined
    }
    if (props.selected) {
      const nativeProps = record(fiber?.memoizedProps) ? fiber.memoizedProps : undefined
      if (props['aria-current'] !== 'page' || nativeProps?.['data-selected'] === undefined) return undefined
      selected.push(button)
    }
  }
  return selected.length === 1 ? selected[0] : undefined
}
