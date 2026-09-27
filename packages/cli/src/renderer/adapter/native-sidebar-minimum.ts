import { MAX_MANAGER_SIDEBAR_WIDTH, MIN_MANAGER_SIDEBAR_WIDTH } from '../manager/sidebar-width.js'

interface FiberLike {
  readonly memoizedProps?: unknown
  readonly return?: FiberLike | null
}

export interface NativeSidebarMinimumSeat {
  readonly document: Document
  readonly aside: HTMLElement
  readonly rail: HTMLElement
  readonly navigation: HTMLElement
  readonly resizer: HTMLElement
}

export interface NativeSidebarMinimum {
  readonly width: number
  readonly source: 'native-controller' | 'native-style' | 'current-native' | 'host-floor'
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the native expanded panel's total minimum, then subtract the measured rail. */
export function readNativeSidebarMinimum(seat: NativeSidebarMinimumSeat): NativeSidebarMinimum {
  const { document, aside, rail, navigation, resizer } = seat
  const railRect = rail.getBoundingClientRect()
  const asideRect = aside.getBoundingClientRect()
  const navRect = navigation.getBoundingClientRect()
  const resizerRect = resizer.getBoundingClientRect()
  const valid = aside.isConnected && rail.isConnected && navigation.isConnected && resizer.isConnected
    && aside.matches('aside[data-app-shell-left-panel-appearance]')
    && aside.contains(rail) && aside.contains(navigation) && aside.contains(resizer)
    && railRect.width >= 40 && railRect.width <= 80
    && Math.abs(navRect.left - railRect.right) <= 2 && Math.abs(navRect.right - asideRect.right) <= 2
    && Math.abs(resizerRect.left + resizerRect.width / 2 - navRect.right) <= 8
  if (!valid) return { width: MIN_MANAGER_SIDEBAR_WIDTH, source: 'host-floor' }
  const minimum = (total: number): number | undefined => {
    const content = Math.ceil(total - railRect.width)
    return Number.isFinite(total)
        && content >= MIN_MANAGER_SIDEBAR_WIDTH && content <= MAX_MANAGER_SIDEBAR_WIDTH
      ? content
      : undefined
  }
  const keys = Object.keys(aside).filter(key => key.startsWith('__reactFiber$'))
  if (keys.length === 1) {
    let fiber = (aside as unknown as Record<string, unknown>)[keys[0]!] as FiberLike | undefined
    const candidates: number[] = []
    const seen = new Set<FiberLike>()
    while (fiber !== undefined && fiber !== null && seen.size < 16) {
      if (seen.has(fiber)) break
      seen.add(fiber)
      const props = record(fiber.memoizedProps) ? fiber.memoizedProps : undefined
      if (typeof props?.minimumWidth === 'number') candidates.push(props.minimumWidth)
      fiber = fiber.return ?? undefined
    }
    const width = candidates.length === 1 ? minimum(candidates[0]!) : undefined
    if (width !== undefined) return { width, source: 'native-controller' }
  }
  const raw = document.defaultView?.getComputedStyle(aside).getPropertyValue('--codex-sidebar-preferred-width').trim()
  const preferred = raw === undefined ? undefined : /^\d+(?:\.\d+)?px$/u.test(raw) ? Number.parseFloat(raw) : undefined
  const styledWidth = preferred === undefined ? undefined : minimum(preferred)
  if (styledWidth !== undefined) return { width: styledWidth, source: 'native-style' }
  const currentWidth = Math.ceil(navRect.width)
  if (currentWidth >= MIN_MANAGER_SIDEBAR_WIDTH && currentWidth <= MAX_MANAGER_SIDEBAR_WIDTH) {
    return { width: currentWidth, source: 'current-native' }
  }
  return { width: MIN_MANAGER_SIDEBAR_WIDTH, source: 'host-floor' }
}
