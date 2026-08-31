import { createHostSurfaceIcon } from '../icons.js'

export interface SidebarItemOptions {
  readonly id: string
  readonly label: string
  readonly ariaLabel?: string
  readonly secondary?: string
  readonly icon?: string
  readonly iconElement?: HTMLElement
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly onActivate?: () => void
}

export interface SidebarItemControl {
  readonly element: HTMLDivElement
  readonly primary: HTMLButtonElement
  readonly actions: HTMLSpanElement
  setSelected(selected: boolean, current?: boolean): void
  setDisabled(disabled: boolean): void
  setActivate(activate: (() => void) | undefined): void
  dispose(): void
}

/**
 * The single Host-owned navigation-row renderer used by native and structured
 * sidebar entries. Callers provide data and activation only, never row DOM.
 */
export function createSidebarItem(document: Document, options: SidebarItemOptions): SidebarItemControl {
  const element = document.createElement('div')
  element.className = 'cxsi-row cordisx-nav-row'
  element.dataset.sidebarItem = options.id
  element.dataset.variant = options.secondary === undefined ? 'single-line' : 'two-line'

  const primary = document.createElement('button')
  primary.type = 'button'
  primary.className = 'cxsi-primary cordisx-nav-primary'
  primary.dataset.cordisxNoDrag = 'true'
  primary.style.setProperty('-webkit-app-region', 'no-drag')
  primary.setAttribute('aria-label', options.ariaLabel ?? options.label)
  primary.title = options.ariaLabel ?? options.label

  const icon = options.iconElement ?? createHostSurfaceIcon(document, options.icon)
  icon.classList.add('cxsi-icon')
  const copy = document.createElement('span')
  copy.className = 'cxsi-copy cordisx-nav-copy'
  const title = document.createElement('span')
  title.className = 'cxsi-title'
  title.textContent = options.label
  copy.append(title)
  if (options.secondary !== undefined) {
    const secondary = document.createElement('span')
    secondary.className = 'cxsi-secondary'
    secondary.textContent = options.secondary
    copy.append(secondary)
  }
  primary.append(icon, copy)

  const actions = document.createElement('span')
  actions.className = 'cxsi-actions cordisx-nav-actions'
  element.append(primary, actions)

  let activate = options.onActivate
  const onClick = (): void => activate?.()
  primary.addEventListener('click', onClick)
  let disposed = false

  const control: SidebarItemControl = {
    element,
    primary,
    actions,
    setSelected(selected, current = false) {
      element.dataset.selected = String(selected)
      primary.setAttribute('aria-pressed', String(selected))
      if (selected && current) primary.setAttribute('aria-current', 'page')
      else primary.removeAttribute('aria-current')
    },
    setDisabled(disabled) {
      primary.disabled = disabled
      if (disabled) primary.setAttribute('aria-disabled', 'true')
      else primary.removeAttribute('aria-disabled')
    },
    setActivate(next) { activate = next },
    dispose() {
      if (disposed) return
      disposed = true
      activate = undefined
      primary.removeEventListener('click', onClick)
      element.remove()
    },
  }
  control.setSelected(options.selected === true)
  control.setDisabled(options.disabled === true)
  return control
}
