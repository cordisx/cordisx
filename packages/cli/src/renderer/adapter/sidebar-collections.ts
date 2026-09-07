import { nativeControlInsertionAnchor, strictlyVisible } from './dom.js'
import type { NativeSurfaceSeat } from './types.js'

const sectionSelector = '[data-app-action-sidebar-section]'
const ownedSelector = '[data-cordisx-surface-host]'
const toggleSelector = 'button[aria-expanded], [role="button"][aria-expanded]'

export interface SidebarCollectionsSeat extends NativeSurfaceSeat {
  readonly heading?: HTMLElement
  readonly selectedRow?: HTMLElement
  readonly row?: HTMLElement
  readonly section?: HTMLElement
}

/** Same public collection surface, separate Host-owned group-area insertion seat. */
export function resolveSidebarCollectionsSeat(
  document: Document,
  sidebar: HTMLElement,
): SidebarCollectionsSeat | undefined {
  const sections = [...sidebar.querySelectorAll<HTMLElement>(sectionSelector)]
    .filter(element => element.closest(ownedSelector) === null && element.getClientRects().length > 0)
    .filter(element => element.parentElement?.closest(sectionSelector) === null)
  const first = sections[0]
  if (first === undefined) return undefined
  const anchor = nativeControlInsertionAnchor(document, first)
  const parent = anchor.parentElement
  if (parent === null || !sidebar.contains(parent)) return undefined
  const heading = first.matches(toggleSelector) ? first : first.querySelector<HTMLElement>(toggleSelector) ?? undefined
  const rows = [...sidebar.querySelectorAll<HTMLElement>('[data-app-action-sidebar-thread-id]')]
    .filter(element => element.closest(ownedSelector) === null && strictlyVisible(element))
  const row = rows[0]
  const selectedRow = rows.find(element =>
    element.getAttribute('data-app-action-sidebar-thread-selected') === 'true'
    && !element.matches(':hover, :focus-within')
  )
  return {
    key: 'sidebar.collections',
    parent,
    before: anchor,
    className: 'cordisx-sidebar-navigation cordisx-sidebar-collections',
    section: first,
    ...(selectedRow === undefined ? {} : { selectedRow }),
    ...(heading === undefined ? {} : { heading }),
    ...(row === undefined ? {} : { row }),
  }
}

export function projectSidebarGroupAppearance(root: HTMLElement, seat: SidebarCollectionsSeat): void {
  const view = root.ownerDocument.defaultView
  const heading = seat.heading === undefined ? undefined : view?.getComputedStyle(seat.heading)
  const section = seat.section === undefined ? undefined : view?.getComputedStyle(seat.section)
  // Only a visibly selected, non-hovered/non-focused session row can supply
  // selected colors. Never turn the current action template fill into idle paint.
  const selected = seat.selectedRow === undefined ? undefined : view?.getComputedStyle(seat.selectedRow)
  const background = selected?.backgroundColor
  const selectedValues = {
    '--cordisx-nav-selected-background': background === 'transparent' || background === 'rgba(0, 0, 0, 0)'
      ? ''
      : background ?? '',
    '--cordisx-nav-selected-foreground': selected?.color ?? '',
  }
  for (const [property, value] of Object.entries(selectedValues)) {
    if (root.style.getPropertyValue(property) === value) continue
    if (value === '') root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }
  const values: Record<string, string | undefined> = {
    'font-family': heading?.fontFamily,
    'font-size': heading?.fontSize,
    'font-weight': heading?.fontWeight,
    'line-height': heading?.lineHeight,
    color: heading?.color,
    'padding-inline': heading?.paddingInlineStart,
    'padding-block': heading?.paddingBlockStart,
    'margin-block': section?.marginBlockStart,
    gap: view?.getComputedStyle(seat.parent).rowGap,
  }
  for (const [name, sampled] of Object.entries(values)) {
    const property = `--cordisx-nav-group-${name}`
    const value = sampled === 'normal' ? '' : sampled ?? ''
    if (root.style.getPropertyValue(property) === value) continue
    if (value === '') root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }
}
