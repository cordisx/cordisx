import { readNativeRailSelection } from './native-rail-selection-probe.js'
import {
  consumeNativeRailIconOwner,
  nativeRailIconOwnerCurrent,
  type NativeRailIconOwnerToken,
  watchNativeRailIconOwner,
} from './native-rail-icon-owner.js'
import {
  loadNativeRailRuntime,
  nativeRailIconVersionAllowed,
  type NativeRailReact,
  type NativeRailReactDOM,
  type NativeRailRuntime,
  type NativeRailRuntimeIO,
} from './native-rail-icon-runtime.js'

interface RailItem {
  readonly id: string
  readonly isCurrentDestination: boolean
  readonly largeIcon?: unknown
  readonly railIcons?: { readonly default?: unknown; readonly selected?: unknown }
}

export interface NativeRailIconVisualHandle {
  readonly destination: string
  isCurrent(): boolean
  dispose(): void
}

export type NativeRailIconVisualResult =
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'active'; handle: NativeRailIconVisualHandle }>

export interface NativeRailIconVisualRequest {
  readonly document: Document
  readonly appVersion: string
  /** Captured before Host clears native markers; used only while item fibers lag. */
  readonly provisionalOwner?: NativeRailIconOwnerToken
  /** The owner must close its Host projection if native icon ownership changes. */
  readonly onLost: () => void
  /** Test seam; normal launches discover the already-loaded native ESM module. */
  readonly runtime?: NativeRailRuntime
  readonly runtimeIO?: NativeRailRuntimeIO
}

const active = new WeakMap<Document, NativeRailIconVisualHandle>()
const pending = new WeakSet<Document>()

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function railItem(button: HTMLButtonElement): RailItem | undefined {
  const destination = button.getAttribute('data-sidebar-destination')
  const keys = Object.keys(button).filter(key => key.startsWith('__reactFiber$'))
  if (destination === null || keys.length !== 1) return undefined
  const seen = new Set<object>()
  const candidates: RailItem[] = []
  let fiber = (button as unknown as Record<string, unknown>)[keys[0]!] as Record<string, unknown> | undefined
  for (let depth = 0; object(fiber) && depth < 35; depth++) {
    if (seen.has(fiber)) return undefined
    seen.add(fiber)
    const props = fiber.memoizedProps
    const item = object(props) ? props.item : undefined
    if (
      object(item) && item.id === destination && typeof item.isCurrentDestination === 'boolean'
    ) candidates.push(item as unknown as RailItem)
    fiber = object(fiber.return) ? fiber.return : undefined
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function variant(item: RailItem): unknown {
  return item.railIcons?.default ?? item.largeIcon
}

function iconSvg(button: HTMLButtonElement): SVGSVGElement | undefined {
  const svgs = [...button.querySelectorAll<SVGSVGElement>('svg')].filter(svg => {
    if (svg.closest('[data-cordisx-native-rail-icon-visual]') !== null) return false
    const rect = svg.getBoundingClientRect()
    return rect.width >= 12 && rect.width <= 32 && rect.height >= 12 && rect.height <= 32
  })
  return svgs.length === 1 ? svgs[0] : undefined
}

function pathSignature(svg: SVGSVGElement): string | undefined {
  const paths = [...svg.querySelectorAll('path')].map(path => path.getAttribute('d'))
  return paths.length > 0 && paths.every(path => typeof path === 'string' && path.length > 0)
    ? JSON.stringify(paths)
    : undefined
}

function visualSignature(svg: SVGSVGElement): string | undefined {
  if (pathSignature(svg) === undefined) return undefined
  const attributes = (element: Element, names: readonly string[]) => names.map(name => element.getAttribute(name))
  return JSON.stringify({
    svg: attributes(svg, ['viewBox', 'width', 'height', 'fill', 'class']),
    paths: [...svg.querySelectorAll('path')].map(path =>
      attributes(path, ['d', 'fill', 'stroke', 'fill-rule', 'clip-rule'])
    ),
  })
}

async function renderDefaultSvg(
  document: Document,
  react: NativeRailReact,
  reactDOM: NativeRailReactDOM,
  icon: unknown,
  color: string,
): Promise<SVGSVGElement | undefined> {
  if (!react.isValidElement(icon) && typeof icon !== 'function') return undefined
  const container = document.createElement('div')
  container.dataset.cordisxNativeIconRenderProbe = 'true'
  Object.assign(container.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '24px',
    height: '24px',
    opacity: '0',
    pointerEvents: 'none',
    color,
  })
  document.body.append(container)
  let renderError: unknown
  let root: ReturnType<NativeRailReactDOM['createRoot']> | undefined
  try {
    root = reactDOM.createRoot(container, { onUncaughtError: error => renderError = error })
    root.render(react.isValidElement(icon) ? icon : react.createElement(icon))
    for (let attempt = 0; attempt < 25 && renderError === undefined; attempt++) {
      const svgs = container.querySelectorAll<SVGSVGElement>('svg')
      if (svgs.length === 1 && pathSignature(svgs[0]!) !== undefined) {
        return svgs[0]!.cloneNode(true) as SVGSVGElement
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return undefined
  } catch {
    return undefined
  } finally {
    try {
      root?.unmount()
    } catch {
      // The detached container is still removed below.
    } finally {
      container.remove()
    }
  }
}

function rail(document: Document): HTMLElement | undefined {
  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  return rails.length === 1 ? rails[0] : undefined
}

/** Only one Host-owned visual override may exist in a document. Native route state is never written. */
export async function projectNativeRailDefaultIcon(
  request: NativeRailIconVisualRequest,
): Promise<NativeRailIconVisualResult> {
  const { document } = request
  if (active.has(document) || pending.has(document)) {
    return { status: 'unavailable', reason: 'visual-lease-exists' }
  }
  pending.add(document)
  try {
    return await projectReservedNativeRailDefaultIcon(request)
  } catch {
    return { status: 'unavailable', reason: 'native-icon-probe-threw' }
  } finally {
    pending.delete(document)
  }
}

async function projectReservedNativeRailDefaultIcon(
  request: NativeRailIconVisualRequest,
): Promise<NativeRailIconVisualResult> {
  const { document, appVersion, onLost } = request
  if (!nativeRailIconVersionAllowed(appVersion) || document.defaultView?.location.href !== 'app://-/index.html') {
    return { status: 'unavailable', reason: 'unsupported-app-context' }
  }
  const currentRail = rail(document)
  const token = request.provisionalOwner
  if (token !== undefined && !consumeNativeRailIconOwner(token, document)) {
    return { status: 'unavailable', reason: 'native-provisional-owner-invalid' }
  }
  const button = token?.button ?? (currentRail === undefined ? undefined : readNativeRailSelection(currentRail))
  const item = button === undefined ? undefined : railItem(button)
  const nativeSvg = button === undefined ? undefined : iconSvg(button)
  const provisional = token !== undefined && item?.isCurrentDestination === false
  if (
    currentRail === undefined || button === undefined || !currentRail.contains(button)
    || (item?.isCurrentDestination !== true && !provisional)
    || nativeSvg === undefined || variant(item) === undefined
  ) return { status: 'unavailable', reason: 'native-icon-owner-unavailable' }
  const runtime = request.runtime ?? await loadNativeRailRuntime(document, appVersion, request.runtimeIO)
  if (runtime === undefined) return { status: 'unavailable', reason: 'native-react-runtime-unavailable' }
  const other = [...currentRail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination]')]
    .filter(candidate => candidate !== button)
    .map(candidate => ({ button: candidate, item: railItem(candidate), svg: iconSvg(candidate) }))
    .find(candidate =>
      candidate.item?.isCurrentDestination === false
      && candidate.svg !== undefined && variant(candidate.item) !== undefined
    )
  if (other?.item === undefined || other.svg === undefined) {
    return { status: 'unavailable', reason: 'native-default-control-unavailable' }
  }
  const peerColor = document.defaultView!.getComputedStyle(other.button).color
  const peer = await renderDefaultSvg(document, runtime.react, runtime.reactDOM, variant(other.item), peerColor)
  if (peer === undefined || visualSignature(peer) !== visualSignature(other.svg)) {
    return { status: 'unavailable', reason: 'native-default-render-mismatch' }
  }
  const replacement = await renderDefaultSvg(document, runtime.react, runtime.reactDOM, variant(item), peerColor)
  if (replacement === undefined) return { status: 'unavailable', reason: 'native-default-render-failed' }
  let selectedSignature: string | undefined
  if (provisional) {
    const selectedVariant = item.railIcons?.selected ?? item.largeIcon
    const selectedIcon = await renderDefaultSvg(
      document,
      runtime.react,
      runtime.reactDOM,
      selectedVariant,
      document.defaultView!.getComputedStyle(button).color,
    )
    selectedSignature = selectedIcon === undefined ? undefined : visualSignature(selectedIcon)
    if (selectedSignature === undefined || selectedSignature !== visualSignature(nativeSvg)) {
      return { status: 'unavailable', reason: 'native-selected-render-mismatch' }
    }
    if (visualSignature(replacement) === selectedSignature) {
      return { status: 'unavailable', reason: 'native-icon-already-default' }
    }
  }
  const freshRail = rail(document)
  const ownerCurrent = () => {
    if (
      rail(document) !== currentRail || !button.isConnected || !currentRail?.contains(button)
      || railItem(button)?.id !== item.id
    ) return false
    if (token !== undefined && !nativeRailIconOwnerCurrent(token, true)) return false
    if (readNativeRailSelection(currentRail) === button && railItem(button)?.isCurrentDestination === true) return true
    return provisional && token !== undefined
      && selectedSignature === visualSignature(nativeSvg)
  }
  if (
    freshRail !== currentRail || !ownerCurrent() || iconSvg(button) !== nativeSvg
  ) return { status: 'unavailable', reason: 'native-icon-owner-changed' }
  const iconParent = nativeSvg.parentElement
  const svgRect = nativeSvg.getBoundingClientRect()
  const parentRect = iconParent?.getBoundingClientRect()
  if (
    iconParent === null || iconParent === undefined || parentRect === undefined
    || svgRect.width <= 0 || svgRect.height <= 0 || parentRect.width <= 0 || parentRect.height <= 0
  ) {
    return { status: 'unavailable', reason: 'native-icon-geometry-unavailable' }
  }
  const overlay = document.createElement('span')
  overlay.dataset.cordisxNativeRailIconVisual = 'true'
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${svgRect.left - parentRect.left}px`,
    top: `${svgRect.top - parentRect.top}px`,
    width: `${svgRect.width}px`,
    height: `${svgRect.height}px`,
    color: peerColor,
    pointerEvents: 'none',
    display: 'block',
  })
  replacement.setAttribute('aria-hidden', 'true')
  replacement.setAttribute('focusable', 'false')
  overlay.append(replacement)
  const previousVisibility = nativeSvg.style.visibility
  const previousPosition = iconParent.style.position
  let disposed = false
  let observer: MutationObserver | undefined
  let themeObserver: MutationObserver | undefined
  let unwatchRoute: (() => void) | undefined
  let colorScheme: MediaQueryList | undefined
  let checkTheme: (() => void) | undefined
  let scheduleThemeChecks: (() => void) | undefined
  let themeCheckTimers: ReturnType<typeof setTimeout>[] = []
  const handle: NativeRailIconVisualHandle = {
    destination: item.id,
    isCurrent: () =>
      !disposed && active.get(document) === handle && button.isConnected
      && ownerCurrent() && iconSvg(button) === nativeSvg
      && iconParent.contains(overlay),
    dispose: () => {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      themeObserver?.disconnect()
      unwatchRoute?.()
      for (const timer of themeCheckTimers) clearTimeout(timer)
      themeCheckTimers = []
      if (colorScheme !== undefined && scheduleThemeChecks !== undefined) {
        colorScheme.removeEventListener('change', scheduleThemeChecks)
      }
      overlay.remove()
      nativeSvg.style.visibility = previousVisibility
      iconParent.style.position = previousPosition
      if (active.get(document) === handle) active.delete(document)
    },
  }
  const lost = () => {
    if (disposed) return
    handle.dispose()
    try {
      onLost()
    } catch {
      // An observer cannot interrupt native cleanup.
    }
  }
  try {
    if (document.defaultView!.getComputedStyle(iconParent).position === 'static') {
      iconParent.style.position = 'relative'
    }
    iconParent.append(overlay)
    nativeSvg.style.visibility = 'hidden'
    active.set(document, handle)
    const Observer = document.defaultView?.MutationObserver
    if (Observer === undefined) throw Error('native icon observer unavailable')
    observer = new Observer(() => {
      if (!handle.isCurrent()) lost()
      else checkTheme?.()
    })
    checkTheme = () => {
      try {
        if (!other.button.isConnected || document.defaultView!.getComputedStyle(other.button).color !== peerColor) {
          lost()
        }
      } catch {
        lost()
      }
    }
    scheduleThemeChecks = () => {
      checkTheme?.()
      if (disposed) return
      for (const timer of themeCheckTimers) clearTimeout(timer)
      themeCheckTimers = [40, 240].map(delay => setTimeout(() => checkTheme?.(), delay))
    }
    themeObserver = new Observer(scheduleThemeChecks)
    themeObserver.observe(document.documentElement, { attributes: true })
    themeObserver.observe(document.body, { attributes: true })
    themeObserver.observe(document.head, { attributes: true, childList: true, subtree: true })
    colorScheme = document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
    colorScheme?.addEventListener('change', scheduleThemeChecks)
    observer.observe(currentRail, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-sidebar-destination', 'aria-current', 'data-selected', 'class', 'style'],
    })
    if (token !== undefined) {
      unwatchRoute = watchNativeRailIconOwner(token, () => {
        if (!handle.isCurrent()) lost()
      })
    }
    if (!handle.isCurrent()) throw Error('native icon owner changed during commit')
    return { status: 'active', handle }
  } catch {
    handle.dispose()
    return { status: 'unavailable', reason: 'native-icon-commit-failed' }
  }
}
