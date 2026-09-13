import type { CordisXLocalizedText, CordisXPageHeaderAction, CordisXPageHeaderActionV4 } from '../contracts.js'
import { assertLocalizedText, immutableSnapshot } from './validation.js'
import { assertPageHeaderAction } from './navigation-pages.js'
import type { CordisXPageHeaderVisual } from '../contracts.js'
import { createHostSurfaceIcon } from './icons.js'
import { HostTooltipController } from './tooltips.js'

/** The navigation owner supplies authorization and lifecycle; this module owns only chrome. */
export function mountPageHeaderActions(options: {
  readonly registerLabelUpdater?: (update: (id: string, label: CordisXLocalizedText) => boolean) => void
  readonly registerVisualUpdater?: (update: (id: string, visual: CordisXPageHeaderVisual) => boolean) => void
  readonly chrome: HTMLElement
  readonly actions: readonly CordisXPageHeaderActionV4[]
  readonly button: (label: string, icon: string) => HTMLButtonElement
  readonly resolve: (text: CordisXLocalizedText, site: string) => string
  readonly localize: (refresh: () => void) => void
  readonly visible: (action: CordisXPageHeaderActionV4) => boolean
  readonly available: (action: CordisXPageHeaderAction) => boolean
  readonly subscribe: (refresh: () => void) => () => void
  readonly execute: (action: CordisXPageHeaderAction, actionId: string) => Promise<void>
}): () => void {
  const { chrome } = options
  const document = chrome.ownerDocument
  const disposers: (() => void)[] = []
  const tooltips = new HostTooltipController(document, 'header')
  disposers.push(() => tooltips.dispose())
  const style = document.createElement('style')
  style.textContent = `
.cordisx-page-chrome-action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:var(--cordisx-page-chrome-action-size,28px);height:var(--cordisx-page-chrome-action-size,28px);min-width:var(--cordisx-page-chrome-action-size,28px);flex:0 0 var(--cordisx-page-chrome-action-size,28px);padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-text-tertiary,var(--color-text-secondary,color-mix(in srgb,currentColor 65%,transparent)));cursor:pointer;font-family:var(--cordisx-page-chrome-title-font-family,-apple-system,system-ui,sans-serif);font-size:var(--cordisx-page-chrome-action-font-size,13px);font-weight:var(--cordisx-page-chrome-action-font-weight,430);line-height:var(--cordisx-page-chrome-action-line-height,18px)}
.cordisx-page-chrome-action>.cordisx-host-icon{display:inline-flex;width:var(--cordisx-page-chrome-icon-size,16px);height:var(--cordisx-page-chrome-icon-size,16px);flex:0 0 var(--cordisx-page-chrome-icon-size,16px);align-items:center;justify-content:center}
.cordisx-page-chrome-action>.cordisx-host-icon>svg{display:block;width:16px;height:16px}
.cordisx-page-chrome-action[data-presentation="primary"]{width:auto;max-width:180px;flex:0 1 auto;gap:6px;padding:0 9px;color:var(--color-text-primary,inherit);background:var(--color-background-surface-hover,color-mix(in srgb,currentColor 8%,transparent))}
.cordisx-page-chrome-action[data-presentation="text"]{width:auto;max-width:180px;flex:0 1 auto;gap:6px;padding:0 9px;color:var(--color-text-primary,inherit)}
.cordisx-page-chrome-action[data-presentation="primary"][data-variant="outlined"]{border:1px solid var(--color-border,color-mix(in srgb,currentColor 14%,transparent));background:transparent}
.cordisx-page-header-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cordisx-page-chrome-action:hover:not(:disabled),.cordisx-page-header-menu button:hover:not(:disabled){background:var(--color-background-surface-hover,color-mix(in srgb,currentColor 8%,transparent))}
.cordisx-page-chrome-action:focus-visible,.cordisx-page-header-menu button:focus-visible{outline:2px solid var(--color-accent,color-mix(in srgb,currentColor 60%,transparent));outline-offset:1px}
.cordisx-page-chrome-action:disabled,.cordisx-page-header-menu button:disabled{opacity:.45;cursor:default}
.cordisx-page-chrome-action[hidden],.cordisx-page-header-menu [hidden]{display:none}
[data-cordisx-page-leading]>.cordisx-host-icon,[data-cordisx-page-leading] svg{display:block;width:var(--cordisx-page-chrome-icon-size,16px);height:var(--cordisx-page-chrome-icon-size,16px)}
.cordisx-page-header-visual{width:20px;height:20px;object-fit:cover;flex:none;border-radius:4px}
.cordisx-page-header-visual[data-avatar]{border-radius:50%;background:var(--color-background-surface-hover,color-mix(in srgb,currentColor 8%,transparent))}
.cordisx-page-header-menu{position:fixed;z-index:2147483400;box-sizing:border-box;min-width:160px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--color-border,color-mix(in srgb,currentColor 14%,transparent));border-radius:9px;background:var(--color-background-surface,var(--cx-surface,#181818));color:var(--color-text-primary,inherit);font:12px/1.4 system-ui;-webkit-app-region:no-drag}
.cordisx-page-header-menu button{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:center;gap:8px;min-height:30px;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.cordisx-page-header-menu-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cordisx-page-header-menu-leading{display:flex;align-items:center;justify-content:center;width:16px;height:16px;color:inherit}
.cordisx-page-header-menu-leading>.cordisx-host-icon{display:inline-flex;width:16px;height:16px;flex:none}
.cordisx-page-header-menu-leading>.cordisx-host-icon>svg{display:block;width:16px;height:16px}
`
  chrome.append(style)
  disposers.push(() => style.remove())
  let closeOpen: (() => void) | undefined
  let disposed = false
  const labelUpdates = new Map<string, (label: CordisXLocalizedText) => void>()
  options.registerLabelUpdater?.((id, label) => {
    if (disposed) return false
    const update = labelUpdates.get(id)
    if (!update) return false
    try {
      const cloned = immutableSnapshot(label)
      assertLocalizedText(cloned, 'page header label update')
      if (cloned.namespace !== undefined && typeof cloned.namespace !== 'string') return false
      if (Object.values(cloned.params ?? {}).some(value => typeof value === 'number' && !Number.isFinite(value))) {
        return false
      }
      if (new TextEncoder().encode(JSON.stringify(cloned)).byteLength > 16384) return false
      update(cloned)
      return true
    } catch {
      return false
    }
  })
  const visualUpdates = new Map<string, (visual: CordisXPageHeaderVisual) => void>()
  options.registerVisualUpdater?.((id, visual) => {
    if (disposed) return false
    const action = options.actions.find(item => item.id === id)
    const update = visualUpdates.get(id)
    if (!action?.visual || !update || visual?.kind !== action.visual.kind) return false
    try {
      assertPageHeaderAction({ ...action, visual }, 'page header visual update', true)
      update(structuredClone(visual))
      return true
    } catch {
      return false
    }
  })
  for (const action of options.actions) {
    const trigger = options.button(action.id, action.icon ?? 'host:more')
    trigger.dataset.cordisxPageHeaderAction = action.id
    const primary = 'presentation' in action && action.presentation === 'primary'
    const text = action.presentation === 'text'
    trigger.dataset.presentation = primary ? 'primary' : text ? 'text' : 'icon'
    if (text && action.icon === undefined) trigger.replaceChildren()
    if (primary && action.variant === 'outlined') trigger.dataset.variant = 'outlined'
    let currentLabel = action.label
    const visibleLabel = primary || text ? document.createElement('span') : undefined
    if (visibleLabel) {
      visibleLabel.className = 'cordisx-page-header-label'
      trigger.append(visibleLabel)
    }
    if (action.visual !== undefined) {
      const renderVisual = (visual: CordisXPageHeaderVisual) => {
        const anonymous = (): SVGSVGElement | HTMLElement => {
          if (visual.kind !== 'avatar') return createHostSurfaceIcon(document, 'host:more')
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('viewBox', '-2 -2 28 28')
          svg.setAttribute('aria-hidden', 'true')
          svg.classList.add('cordisx-page-header-visual')
          svg.dataset.avatar = 'anonymous'
          const path = document.createElementNS(svg.namespaceURI, 'path')
          path.setAttribute('d', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0')
          path.setAttribute('fill', 'none')
          path.setAttribute('stroke', 'currentColor')
          path.setAttribute('stroke-width', '1.5')
          svg.append(path)
          return svg
        }
        trigger.replaceChildren(anonymous())
        if (visual.src !== undefined) {
          const img = document.createElement('img')
          img.className = 'cordisx-page-header-visual'
          if (visual.kind === 'avatar') img.dataset.avatar = 'custom'
          img.alt = ''
          img.draggable = false
          img.addEventListener('error', () => img.replaceWith(anonymous()), { once: true })
          img.src = visual.src
          trigger.replaceChildren(img)
        }
      }
      visualUpdates.set(action.id, renderVisual)
      renderVisual(action.visual)
    }
    let pending = false
    let menu: HTMLElement | undefined
    let menuCleanup: (() => void) | undefined
    const items = new Map<CordisXPageHeaderAction, HTMLButtonElement>()
    const close = (restore = false): void => {
      menuCleanup?.()
      menuCleanup = undefined
      menu?.remove()
      menu = undefined
      items.clear()
      if (action.menu !== undefined) trigger.setAttribute('aria-expanded', 'false')
      trigger.removeAttribute('aria-controls')
      if (restore && trigger.isConnected) trigger.focus()
    }
    disposers.push(() => close())
    const refresh = (): void => {
      trigger.hidden = !options.visible(action)
      trigger.disabled = pending || action.disabled?.value === true || (action.menu === undefined
        ? !options.available(action)
        : !action.menu.some(item => options.visible(item) && !item.disabled?.value && options.available(item)))
      if (trigger.hidden || trigger.disabled) close()
      for (const [item, button] of items) {
        button.hidden = !options.visible(item)
        button.disabled = item.disabled?.value === true || !options.available(item)
      }
    }
    const localize = (message = currentLabel): void => {
      const label = options.resolve(action.ariaLabel ?? message, `${action.id}.label`)
      const visibleText = visibleLabel ? options.resolve(message, `${action.id}.visible-label`) : undefined
      const tooltip = action.disabled?.value && action.disabled.reason
        ? options.resolve(action.disabled.reason, `${action.id}.disabled`)
        : label
      trigger.setAttribute('aria-label', label)
      if (visibleLabel) visibleLabel.textContent = visibleText!
      trigger.dataset.cordisxTooltip = tooltip
      menu?.setAttribute('aria-label', label)
      for (const [item, button] of items) {
        button.lastElementChild!.textContent = options.resolve(item.label, `${action.id}.${item.id}.label`)
        button.setAttribute('aria-label', options.resolve(item.ariaLabel ?? item.label, `${action.id}.${item.id}.aria`))
      }
    }
    labelUpdates.set(action.id, message => {
      localize(message)
      currentLabel = message
    })
    const run = async (item: CordisXPageHeaderAction, id: string): Promise<void> => {
      if (
        disposed || pending || !options.visible(action) || action.disabled?.value || !options.visible(item)
        || item.disabled?.value || !options.available(item)
      ) return
      close(true)
      pending = true
      trigger.setAttribute('aria-busy', 'true')
      refresh()
      try {
        await options.execute(item, id)
      } finally {
        pending = false
        trigger.removeAttribute('aria-busy')
        if (!disposed) refresh()
      }
    }
    const open = (): void => {
      if (trigger.disabled || trigger.hidden || action.menu === undefined) return
      closeOpen?.()
      closeOpen = () => close()
      menu = document.createElement('div')
      menu.className = 'cordisx-page-header-menu'
      menu.setAttribute('role', 'menu')
      menu.tabIndex = -1
      menu.id = `cordisx-header-menu-${crypto.randomUUID()}`
      trigger.setAttribute('aria-controls', menu.id)
      trigger.setAttribute('aria-expanded', 'true')
      for (const item of action.menu) {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        const leading = document.createElement('span')
        leading.className = 'cordisx-page-header-menu-leading'
        leading.setAttribute('aria-hidden', 'true')
        if (item.icon) leading.append(createHostSurfaceIcon(document, item.icon, { variant: 'regular' }))
        const label = document.createElement('span')
        label.className = 'cordisx-page-header-menu-label'
        button.append(leading, label)
        button.addEventListener('click', () => {
          void run(item, `${action.id}/${item.id}`)
        })
        items.set(item, button)
        menu.append(button)
      }
      // Portal escapes the page's clipping boundary; inherit the exact chrome theme.
      const updateTheme = (): void => {
        const computed = document.defaultView?.getComputedStyle(chrome)
        if (computed && menu) {
          menu.style.backgroundColor = computed.backgroundColor
          menu.style.color = computed.color
        }
      }
      updateTheme()
      const observer = new document.defaultView!.MutationObserver(updateTheme)
      for (const target of [document.documentElement, document.body, chrome]) {
        observer.observe(target, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
        })
      }
      document.body.append(menu)
      localize()
      refresh()
      const bounds = trigger.getBoundingClientRect()
      const rect = menu!.getBoundingClientRect()
      const win = document.defaultView!
      menu!.style.left = `${Math.max(8, Math.min(bounds.right - rect.width, win.innerWidth - rect.width - 8))}px`
      menu!.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, win.innerHeight - rect.height - 8))}px`
      const enabled = (): HTMLButtonElement[] =>
        [...items.values()].filter(button => !button.hidden && !button.disabled)
      ;(enabled()[0] ?? menu!).focus()
      const pointer = (event: Event): void => {
        if (!menu?.contains(event.target as Node) && !trigger.contains(event.target as Node)) close()
      }
      const key = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close(true)
          return
        }
        if (event.key === 'Tab') {
          close(true)
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = enabled()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
      const reposition = (): void => close()
      document.addEventListener('pointerdown', pointer, true)
      menu!.addEventListener('keydown', key)
      win.addEventListener('resize', reposition)
      menuCleanup = () => {
        observer.disconnect()
        document.removeEventListener('pointerdown', pointer, true)
        win.removeEventListener('resize', reposition)
      }
    }
    if (action.menu !== undefined) {
      trigger.setAttribute('aria-haspopup', 'menu')
      trigger.setAttribute('aria-expanded', 'false')
      trigger.addEventListener('click', () => menu ? close(true) : open())
      trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          open()
        }
      })
    } else {trigger.addEventListener('click', () => {
        void run(action, action.id)
      })}
    options.localize(localize)
    localize()
    refresh()
    disposers.push(options.subscribe(refresh))
    disposers.push(tooltips.attach(trigger, () => trigger.dataset.cordisxTooltip, 'bottom'))
    chrome.append(trigger)
    disposers.push(() => trigger.remove())
  }
  return () => {
    disposed = true
    disposers.reverse().forEach(dispose => dispose())
  }
}
