import { resolveNativeViewportTitlebarOwner } from './native-viewport-titlebar.js'

export interface ManagerCollapsedSidebarSeat {
  readonly rail: HTMLElement
  readonly main: { readonly anchor: HTMLElement; readonly frame: HTMLElement }
  readonly sidebar: {
    readonly container: HTMLElement
    readonly native: readonly HTMLElement[]
    readonly left: number
    readonly width: number
    readonly inMain: boolean
  }
  readonly titlebar: {
    readonly slot: HTMLElement
    readonly native: readonly HTMLElement[]
    readonly bounds: Readonly<{ left: number; top: number; width: number; height: number }>
  }
  readonly provenance: 'codex-26.1103-collapsed-sidebar'
}

function near(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 2
}

function region(style: CSSStyleDeclaration): string {
  return style.getPropertyValue('-webkit-app-region').trim()
    || (style as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion?.trim()
    || ''
}

/** A collapsed native sidebar is a layout state, not a different Manager page. */
export function resolveManagerCollapsedSidebarSeat(
  document: Document,
  rail: HTMLElement | undefined,
  main: ManagerCollapsedSidebarSeat['main'] | undefined,
): ManagerCollapsedSidebarSeat | undefined {
  const view = document.defaultView
  if (view === null || rail === undefined || main === undefined) return undefined
  const aside = rail.closest<HTMLElement>('aside[data-app-shell-left-panel-appearance]')
  const headers = [...document.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')]
    .filter(element =>
      element.closest('[data-app-shell-active-page]')?.getAttribute('data-app-shell-active-page') !== 'false'
    )
  const header = headers[0]
  if (aside === null || headers.length !== 1 || header === undefined) return undefined
  const triggers = [...header.querySelectorAll<HTMLButtonElement>(
    'button[data-app-shell-sidebar-trigger="true"][aria-expanded="false"][aria-controls="app-shell-sidebar"]',
  )].filter(element => element.getClientRects().length > 0 && view.getComputedStyle(element).visibility === 'visible')
  const trigger = triggers[0]
  const target = document.getElementById('app-shell-sidebar')
  const navigations = target === null ? [] : [...target.querySelectorAll<HTMLElement>('nav[role="navigation"]')]
    .filter(element => element.closest('[data-cordisx-manager-sidebar-root]') === null)
  const outerNavigations = navigations.filter(element =>
    !navigations.some(outer => outer !== element && outer.contains(element))
  )
  const navigation = outerNavigations[0]
  if (
    triggers.length !== 1 || trigger === undefined || target === null || !aside.contains(target)
    || !target.contains(rail) || outerNavigations.length !== 1 || navigation === undefined
    || navigation.closest('[data-sidebar-collapsed]') === null
    || ![aside, rail, main.anchor, main.frame].every(element => element.isConnected)
    || resolveNativeViewportTitlebarOwner(header) === undefined
  ) return undefined
  const asideRect = aside.getBoundingClientRect()
  const railRect = rail.getBoundingClientRect()
  const mainRect = main.anchor.getBoundingClientRect()
  const headerRect = header.getBoundingClientRect()
  if (
    !near(asideRect.left, 0) || !near(asideRect.right, railRect.right)
    || !near(mainRect.left, railRect.right) || !near(mainRect.top, headerRect.bottom)
    || !near(mainRect.bottom, railRect.bottom) || railRect.width < 40 || railRect.width > 80
    || mainRect.width < 320 || mainRect.height < 240
    || view.getComputedStyle(header).pointerEvents !== 'none'
    || region(view.getComputedStyle(header)) !== 'drag'
  ) return undefined
  const titles = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  const title = titles[0]
  const slots = title?.querySelectorAll<HTMLElement>(
    '[data-app-shell-titlebar-slot="main"][data-app-shell-focus-area="main"]',
  )
  const slot = slots?.[0]
  const starts = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="start"]')
  const ends = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="end"]')
  if (
    titles.length !== 1 || title === undefined || slots?.length !== 1 || slot === undefined
    || starts.length !== 1 || ends.length !== 1 || !starts[0]!.contains(trigger)
  ) return undefined
  const slotRect = slot.getBoundingClientRect()
  const endRect = ends[0]!.getBoundingClientRect()
  const controls = [...starts[0]!.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[role="button"]')]
    .filter(element => element.getClientRects().length > 0 && view.getComputedStyle(element).visibility === 'visible')
  if (
    controls.length !== 3 || !controls.includes(trigger)
    || controls.some(element => {
      const rect = element.getBoundingClientRect()
      return element.tagName !== 'BUTTON' || rect.left < 80 || rect.right > 190
        || rect.width < 24 || rect.width > 36 || rect.height < 24 || rect.height > 36
        || view.getComputedStyle(element).pointerEvents !== 'auto'
        || region(view.getComputedStyle(element)) !== 'no-drag'
    })
    || !near(slotRect.left, mainRect.left) || !near(slotRect.top, headerRect.top)
    || !near(slotRect.height, headerRect.height) || slotRect.right > mainRect.right + 2
    || !near(endRect.right, headerRect.right)
  ) return undefined
  // The native start slot expands to fit its controls even though the content
  // starts beside the 52px rail. Clip Host chrome after all three controls.
  const left = Math.max(slotRect.left, ...controls.map(element => element.getBoundingClientRect().right + 16))
  const right = Math.min(slotRect.right, endRect.left)
  const children = [...slot.children]
  const host = children.filter(element => element.hasAttribute('data-cordisx-manager-titlebar-seat'))
  if (
    right - left < 200 || host.length > 1
    || (host.length === 1 && (host[0] !== slot.lastElementChild
      || host[0]?.getAttribute('data-cordisx-manager-titlebar-seat') !== 'true'))
  ) return undefined
  const native = children.filter((element): element is HTMLElement =>
    element instanceof view.HTMLElement && !element.hasAttribute('data-cordisx-manager-titlebar-seat')
  )
  if (native.length + host.length !== children.length) return undefined
  return {
    rail,
    main,
    sidebar: { container: main.anchor, native: [navigation], left: 0, width: 0, inMain: false },
    titlebar: { slot, native, bounds: { left, top: headerRect.top, width: right - left, height: headerRect.height } },
    provenance: 'codex-26.1103-collapsed-sidebar',
  }
}
