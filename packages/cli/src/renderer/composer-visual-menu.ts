import type { ExtensionPointMenuItemV1 } from '@cordisx/protocol/extension-point-interactions/v1'

/** Host chrome, outside the inert artwork. No nodes or browser events cross the capability. */
export class ComposerVisualMenu {
  private items: readonly ExtensionPointMenuItemV1[] = []
  private root: HTMLDivElement | undefined
  private disposed = false
  constructor(
    private readonly target: HTMLButtonElement,
    private readonly permitted: () => boolean,
    private readonly change: (open: boolean, actionId?: string) => void,
  ) {}
  get open(): boolean {
    return this.root !== undefined
  }
  set(items: readonly ExtensionPointMenuItemV1[] | null): void {
    if (this.disposed) return
    if (
      items !== null
      && (!Array.isArray(items) || items.length > 20
        || items.some(item =>
          !item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100
          || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 200
          || (item.disabled !== undefined && typeof item.disabled !== 'boolean')
          || Object.keys(item).some(key => !['id', 'label', 'disabled'].includes(key))
        ) || new Set(items.map(item => item.id)).size !== items.length)
    ) throw new TypeError('Invalid visual menu items')
    this.close(false)
    this.items = items?.map(item => Object.freeze({ ...item })) ?? []
    if (this.items.length) this.target.setAttribute('aria-haspopup', 'menu')
    else this.target.removeAttribute('aria-haspopup')
  }
  show(): void {
    if (this.disposed || !this.permitted() || !this.items.length || this.target.style.display === 'none') return
    this.close(false)
    const document = this.target.ownerDocument
    const root = document.createElement('div')
    root.dataset.cordisxComposerMenu = ''
    root.setAttribute('role', 'menu')
    root.setAttribute('aria-label', this.target.getAttribute('aria-label') ?? '')
    root.tabIndex = -1
    const style = document.createElement('style')
    style.textContent = `
      [data-cordisx-composer-menu] { position:fixed; z-index:2147483200; display:grid; box-sizing:border-box; min-width:min(160px,calc(100vw - 16px)); max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto; padding:5px; border:1px solid var(--color-border,GrayText); border-radius:10px; background:var(--color-surface-elevated,Canvas); color:var(--color-text,CanvasText); box-shadow:0 10px 30px #0004; -webkit-app-region:no-drag; }
      [data-cordisx-composer-menu] button { text-align:start; font:inherit; padding:6px 10px; border:0; border-radius:6px; background:transparent; color:inherit; overflow-wrap:anywhere; }
      [data-cordisx-composer-menu] button:disabled { opacity:.45; }
      [data-cordisx-composer-menu] button:focus-visible, [data-cordisx-composer-menu] button:hover:not(:disabled) { outline:2px solid var(--color-ring,Highlight); outline-offset:-2px; background:var(--color-background-primary-ghost-hover,ButtonFace); }
    `
    root.append(style)
    for (const item of this.items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = item.disabled === true
      button.tabIndex = -1
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (!this.permitted() || button.disabled || this.root !== root) {
          this.close(false)
          return
        }
        this.close(true, item.id)
      })
      root.append(button)
    }
    root.addEventListener('keydown', this.key)
    root.addEventListener('contextmenu', event => {
      event.preventDefault()
      event.stopPropagation()
    })
    this.root = root
    document.body.append(root)
    const rect = this.target.getBoundingClientRect()
    const width = document.defaultView?.innerWidth ?? 0, height = document.defaultView?.innerHeight ?? 0
    root.style.left = `${Math.max(8, Math.min(rect.left, width - root.offsetWidth - 8))}px`
    root.style.top = `${Math.max(8, Math.min(rect.bottom, height - root.offsetHeight - 8))}px`
    document.addEventListener('pointerdown', this.outside, true)
    document.addEventListener('focusin', this.focusOutside, true)
    document.defaultView?.addEventListener('blur', this.dismiss)
    document.defaultView?.addEventListener('resize', this.dismiss)
    document.addEventListener('scroll', this.scroll, true)
    this.target.setAttribute('aria-expanded', 'true')
    this.change(true)
    if (this.root === root) (this.buttons()[0] ?? root).focus({ preventScroll: true })
  }
  private buttons(): HTMLButtonElement[] {
    return [...(this.root?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  }
  private key = (event: KeyboardEvent): void => {
    if (!this.permitted()) {
      this.close(false)
      return
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      event.stopPropagation()
      this.close(true)
      return
    }
    const buttons = this.buttons()
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
    buttons[next]?.focus()
  }
  private outside = (event: Event): void => {
    if (!this.root?.contains(event.target as Node)) this.close(false)
  }
  private focusOutside = (event: Event): void => {
    if (!this.root?.contains(event.target as Node)) this.close(false)
  }
  private scroll = (event: Event): void => {
    if (!this.root?.contains(event.target as Node)) this.close(false)
  }
  private dismiss = (): void => {
    this.close(false)
  }
  close(restore: boolean, actionId?: string): void {
    if (!this.root) return
    this.root.remove()
    this.root = undefined
    const document = this.target.ownerDocument
    document.removeEventListener('pointerdown', this.outside, true)
    document.removeEventListener('focusin', this.focusOutside, true)
    document.defaultView?.removeEventListener('blur', this.dismiss)
    document.defaultView?.removeEventListener('resize', this.dismiss)
    document.removeEventListener('scroll', this.scroll, true)
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
