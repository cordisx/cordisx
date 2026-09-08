import { nativeButtons, nativeControlInsertionAnchor, strictlyVisible } from './dom.js'
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
  let anchor = nativeControlInsertionAnchor(document, first)
  let parent = anchor.parentElement
  // Native sections have a separate drag/drop wrapper. Insert beside that
  // wrapper, so display:contents can expose both as peers in the flex gap.
  // Never lift across another section or the top action area.
  while (
    parent !== null && parent !== sidebar
    && !sections.slice(1).some(section => parent!.contains(section))
    && nativeButtons(parent).every(button => button.closest(sectionSelector) !== null)
  ) {
    anchor = parent
    parent = parent.parentElement
  }
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
  const rowList = seat.row?.parentElement
  const rowListStyle = rowList === undefined || rowList === null ? undefined : view?.getComputedStyle(rowList)
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
    'margin-block-end': section?.marginBlockEnd,
    'section-padding-block-start': section?.paddingBlockStart,
    'section-padding-block-end': section?.paddingBlockEnd,
    ...collectionHorizontalInsets(root, seat),
    gap: view?.getComputedStyle(collectionLayoutParent(seat.parent)).rowGap,
    'item-gap': rowListStyle?.display === 'grid'
        || (rowListStyle?.display === 'flex' && rowListStyle.flexDirection === 'column')
      ? rowListStyle.rowGap
      : undefined,
  }
  for (const [name, sampled] of Object.entries(values)) {
    const property = `--cordisx-nav-group-${name}`
    const value = sampled === 'normal' ? '' : sampled ?? ''
    if (root.style.getPropertyValue(property) === value) continue
    if (value === '') root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }
}

/** Native section padding can live several wrappers above its zero-padding toggle. */
function collectionHorizontalInsets(
  root: HTMLElement,
  seat: SidebarCollectionsSeat,
): Record<string, string | undefined> {
  const view = root.ownerDocument.defaultView
  const outer = root.getBoundingClientRect()
  const rtl = view?.getComputedStyle(root).direction === 'rtl'
  const bounds = (element: HTMLElement | undefined, content = false): { left: number; right: number } | undefined => {
    if (element === undefined || view === null || outer.width <= 0) return undefined
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return undefined
    const style = view.getComputedStyle(element)
    const pixels = (value: string): number => Number.parseFloat(value) || 0
    return {
      left: rect.left + (content ? pixels(style.paddingLeft) + pixels(style.borderLeftWidth) : 0),
      right: rect.right - (content ? pixels(style.paddingRight) + pixels(style.borderRightWidth) : 0),
    }
  }
  const section = bounds(seat.section, true)
  const heading = bounds(seat.heading) ?? section
  const row = bounds(seat.row) ?? section
  const start = (box: typeof section): string | undefined =>
    box === undefined
      ? undefined
      : `${Math.max(0, rtl ? outer.right - box.right : box.left - outer.left)}px`
  const end = (box: typeof section): string | undefined =>
    box === undefined
      ? undefined
      : `${Math.max(0, rtl ? box.left - outer.left : outer.right - box.right)}px`
  return {
    'heading-inset-start': start(heading),
    // A native label-sized toggle must not cap a different plugin label's width.
    'heading-inset-end': end(section),
    'row-inset-start': start(row),
    'row-inset-end': end(row),
  }
}

function collectionLayoutParent(parent: HTMLElement): HTMLElement {
  const view = parent.ownerDocument.defaultView
  let current = parent
  while (view?.getComputedStyle(current).display === 'contents' && current.parentElement !== null) {
    current = current.parentElement
  }
  return current
}
