import type { ExtensionPointMenuItemV2 } from '@cordisx/protocol/extension-point-interactions/v2'
import { renderHostIconSvg } from './icons.js'

type Panel = { node: HTMLDivElement; parent?: HTMLButtonElement }
/** Validate before mutation; copy every level to prevent later plugin mutation. */
export function copyVisualMenu(value: readonly ExtensionPointMenuItemV2[] | null): readonly ExtensionPointMenuItemV2[] {
  const ids = new Set<string>()
  const visit = (items: unknown, depth: number): readonly ExtensionPointMenuItemV2[] => {
    if (!Array.isArray(items) || items.length > 20 || depth > 3 || (depth > 1 && !items.length)) {
      throw new TypeError('Invalid visual menu items')
    }
    return Object.freeze(items.map(item => {
      if (
        !item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100 || ids.has(item.id)
        || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200
        || (item.disabled !== undefined && typeof item.disabled !== 'boolean')
        || (item.icon !== undefined
          && (typeof item.icon !== 'string' || item.icon.length > 100 || !/^[a-zA-Z][\w.-]*$/.test(item.icon)))
        || Object.keys(item).some(key => !['id', 'label', 'disabled', 'icon', 'children'].includes(key))
      ) throw new TypeError('Invalid visual menu items')
      ids.add(item.id)
      if (ids.size > 64) throw new TypeError('Invalid visual menu items')
      return Object.freeze({
        ...item,
        ...(item.children !== undefined ? { children: visit(item.children, depth + 1) } : {}),
      })
    }))
  }
  return value === null ? [] : visit(value, 1)
}

/** Host chrome, outside inert artwork. No nodes or browser events cross the capability. */
export class ComposerVisualMenu {
  private items: readonly ExtensionPointMenuItemV2[] = []
  private panels: Panel[] = []
  private disposed = false
  constructor(
    private readonly target: HTMLButtonElement,
    private readonly permitted: () => boolean,
    private readonly change: (open: boolean, actionId?: string) => void,
  ) {}
  get open(): boolean {
    return this.panels.length > 0
  }
  set(items: readonly ExtensionPointMenuItemV2[] | null): void {
    if (this.disposed) return
    const copy = copyVisualMenu(items)
    this.close(false)
    this.items = copy
    if (copy.length) this.target.setAttribute('aria-haspopup', 'menu')
    else this.target.removeAttribute('aria-haspopup')
  }
  show(): void {
    if (this.disposed || !this.permitted() || !this.items.length || this.target.style.display === 'none') return
    this.close(false)
    const document = this.target.ownerDocument
    this.addPanel(this.items)
    document.addEventListener('pointerdown', this.outside, true)
    document.addEventListener('focusin', this.outside, true)
    document.addEventListener('scroll', this.scroll, true)
    document.defaultView?.addEventListener('blur', this.dismiss)
    document.defaultView?.addEventListener('resize', this.dismiss)
    this.target.setAttribute('aria-expanded', 'true')
    this.change(true)
    this.buttons(this.panels[0]?.node)[0]?.focus({ preventScroll: true })
  }
  private addPanel(items: readonly ExtensionPointMenuItemV2[], parent?: HTMLButtonElement): void {
    const document = this.target.ownerDocument, depth = this.panels.length
    const node = document.createElement('div')
    node.dataset.cordisxComposerMenu = String(depth)
    node.setAttribute('role', 'menu')
    node.setAttribute('aria-label', parent?.textContent ?? this.target.getAttribute('aria-label') ?? '')
    node.tabIndex = -1
    if (!depth) {
      const style = document.createElement('style')
      style.textContent = `
        [data-cordisx-composer-menu] { position:fixed; z-index:2147483200; display:grid; box-sizing:border-box; min-width:min(160px,calc(100vw - 16px)); max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto; padding:5px; border:1px solid var(--color-border,GrayText); border-radius:10px; background:var(--color-surface-elevated,Canvas); color:var(--color-text,CanvasText); box-shadow:0 10px 30px #0004; -webkit-app-region:no-drag; }
        [data-cordisx-composer-menu] button { display:flex; align-items:center; gap:8px; text-align:start; font:inherit; padding:6px 10px; border:0; border-radius:6px; background:transparent; color:inherit; overflow-wrap:anywhere; }
        [data-cordisx-composer-menu] button > svg { flex:none; width:16px; height:16px; }
        [data-cordisx-composer-menu] button > span { flex:1; }
        [data-cordisx-composer-menu] button:disabled { opacity:.45; }
        [data-cordisx-composer-menu] button:focus-visible, [data-cordisx-composer-menu] button:hover:not(:disabled) { outline:2px solid var(--color-ring,Highlight); outline-offset:-2px; background:var(--color-background-primary-ghost-hover,ButtonFace); }
      `
      node.append(style)
    }
    const panel: Panel = { node, ...(parent ? { parent } : {}) }
    this.panels.push(panel)
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.dataset.cordisxMenuItem = item.id
      button.disabled = item.disabled === true
      button.tabIndex = -1
      if (item.icon) button.append(renderHostIconSvg(document, item.icon, { size: 16 }).svg)
      const label = document.createElement('span')
      label.textContent = item.label
      button.append(label)
      if (item.children) {
        button.setAttribute('aria-haspopup', 'menu')
        button.setAttribute('aria-expanded', 'false')
        button.append(renderHostIconSvg(document, 'control.chevron-right', { size: 16 }).svg)
      }
      const expand = (focus: boolean) => {
        if (!this.permitted()) {
          this.close(false)
          return
        }
        if (button.disabled || this.panels[depth] !== panel) return
        if (this.panels[depth + 1]?.parent !== button) {
          this.trim(depth + 1)
          if (item.children) this.addPanel(item.children, button)
        }
        if (focus && item.children) {
          ;(this.buttons(this.panels[depth + 1]?.node)[0] ?? this.panels[depth + 1]?.node)?.focus()
        }
      }
      button.addEventListener('pointerenter', () => expand(false))
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (!this.permitted()) {
          this.close(false)
          return
        }
        if (button.disabled || this.panels[depth] !== panel) return
        if (item.children) expand(true)
        else this.close(true, item.id)
      })
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' && item.children) {
          event.preventDefault()
          event.stopPropagation()
          expand(true)
        }
      })
      node.append(button)
    }
    node.addEventListener('keydown', this.key)
    node.addEventListener('contextmenu', event => {
      event.preventDefault()
      event.stopPropagation()
    })
    document.body.append(node)
    const rect = (parent ?? this.target).getBoundingClientRect()
    const width = document.defaultView?.innerWidth ?? 0, height = document.defaultView?.innerHeight ?? 0
    let left = parent ? rect.right : rect.left
    if (parent && left + node.offsetWidth > width - 8) left = rect.left - node.offsetWidth
    node.style.left = `${Math.max(8, Math.min(left, width - node.offsetWidth - 8))}px`
    node.style.top = `${Math.max(8, Math.min(parent ? rect.top : rect.bottom, height - node.offsetHeight - 8))}px`
    parent?.setAttribute('aria-expanded', 'true')
  }
  private buttons(node?: HTMLDivElement): HTMLButtonElement[] {
    return Array.from(node?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  }
  private trim(length: number): void {
    for (const panel of this.panels.splice(length)) {
      panel.parent?.setAttribute('aria-expanded', 'false')
      panel.node.remove()
    }
  }
  private key = (event: KeyboardEvent): void => {
    if (!this.permitted()) {
      this.close(false)
      return
    }
    const depth = this.panels.findIndex(panel => panel.node === event.currentTarget)
    if (depth < 0) return
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Tab') {
      if (event.key !== 'Tab') event.preventDefault()
      event.stopPropagation()
      if (depth > 0 && event.key !== 'Tab') {
        const parent = this.panels[depth]?.parent
        this.trim(depth)
        parent?.focus()
      } else if (event.key !== 'ArrowLeft') this.close(true)
      return
    }
    const buttons = this.buttons(this.panels[depth]?.node)
    const index = buttons.indexOf(this.target.ownerDocument.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End'
      ? buttons.length - 1
      : event.key === 'ArrowDown'
      ? (index + 1) % buttons.length
      : event.key === 'ArrowUp'
      ? (index - 1 + buttons.length) % buttons.length
      : undefined
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    this.trim(depth + 1)
    buttons[next]?.focus()
  }
  private contains(target: EventTarget | null): boolean {
    return this.panels.some(panel => panel.node.contains(target as Node))
  }
  private outside = (event: Event): void => {
    if (!this.contains(event.target)) this.close(false)
  }
  private scroll = (event: Event): void => {
    const depth = this.panels.findIndex(panel => panel.node.contains(event.target as Node))
    if (depth < 0) this.close(false)
    else this.trim(depth + 1)
  }
  private dismiss = (): void => {
    this.close(false)
  }
  close(restore: boolean, actionId?: string): void {
    if (!this.open) return
    this.trim(0)
    const document = this.target.ownerDocument
    document.removeEventListener('pointerdown', this.outside, true)
    document.removeEventListener('focusin', this.outside, true)
    document.removeEventListener('scroll', this.scroll, true)
    document.defaultView?.removeEventListener('blur', this.dismiss)
    document.defaultView?.removeEventListener('resize', this.dismiss)
    this.target.setAttribute('aria-expanded', 'false')
    if (restore && this.target.isConnected && this.permitted()) this.target.focus({ preventScroll: true })
    this.change(false, actionId)
  }
  dispose(): void {
    this.close(false)
    this.disposed = true
    this.items = []
  }
}
