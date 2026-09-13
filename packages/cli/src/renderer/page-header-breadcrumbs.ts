import type { CordisXI18nService } from './i18n.js'
import { pageChromeButton } from './navigation-pages.js'
import type { CordisXLocalizationSeat, CordisXLocalizedText, CordisXRouteReference } from '../contracts.js'
import { assertLocalizedText, immutableSnapshot } from './validation.js'
import { assertRoute } from './surface-validation.js'

/** Mounted standard-page title only; navigation retains the owner registry's policy. */
export function createPageHeaderBreadcrumbs(options: {
  readonly leading: HTMLElement
  readonly title: HTMLElement
  readonly active: () => boolean
  readonly button: () => HTMLButtonElement
  readonly resolve: (message: CordisXLocalizedText, index: number) => string
  readonly navigate: (reference: CordisXRouteReference) => Promise<void>
  readonly report: (error: unknown) => void
}) {
  let disposed = false
  let items: readonly CordisXLocalizedText[] | undefined
  let back: CordisXRouteReference | undefined
  let button: HTMLButtonElement | undefined
  const live = () => !disposed && options.active()
  const render = (): boolean => {
    if (!items) return false
    if (!live()) return true
    const document = options.title.ownerDocument
    const resolved = items.map(options.resolve)
    const nodes: HTMLElement[] = []
    resolved.forEach((text, index) => {
      if (index) {
        const separator = document.createElement('span')
        separator.textContent = '/'
        separator.setAttribute('aria-hidden', 'true')
        separator.style.cssText = 'flex:none;font-weight:400;opacity:.55'
        nodes.push(separator)
      }
      const label = document.createElement('span')
      label.textContent = text
      label.title = text
      label.style.cssText = `min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:${
        index === resolved.length - 1 ? '0 1 auto' : '0 2 auto'
      }`
      if (index === resolved.length - 1) label.setAttribute('aria-current', 'page')
      nodes.push(label)
    })
    options.title.style.display = 'flex'
    options.title.style.alignItems = 'center'
    options.title.style.gap = '6px'
    options.title.setAttribute('role', 'navigation')
    options.title.setAttribute('aria-label', resolved.join(' / '))
    options.title.replaceChildren(...nodes)
    return true
  }
  return {
    render,
    update(next: readonly CordisXLocalizedText[], route: CordisXRouteReference): boolean {
      if (!live()) return false
      try {
        if (!Array.isArray(next) || !next.length || next.length > 8) return false
        if (new TextEncoder().encode(JSON.stringify({ next, route })).byteLength > 16384) return false
        next.forEach((message, index) => assertLocalizedText(message, `header breadcrumb ${index}`))
        assertRoute(route, 'header breadcrumb Back')
        if (route.params !== undefined) {
          if (route.params === null || typeof route.params !== 'object' || Array.isArray(route.params)) return false
          for (const value of Object.values(route.params)) {
            if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return false
            if (typeof value === 'number' && !Number.isFinite(value)) return false
          }
        }
        const clonedItems = immutableSnapshot(next)
        const clonedRoute = immutableSnapshot(route)
        // Resolve before touching live chrome so invalid localization fails closed.
        clonedItems.forEach(options.resolve)
        items = clonedItems
        back = clonedRoute
        if (!button) {
          button = options.button()
          button.addEventListener('click', () => {
            if (live() && back) {
              void options.navigate(back).catch(error => {
                if (live()) options.report(error)
              })
            }
          })
          options.leading.replaceChildren(button)
        }
        render()
        return true
      } catch {
        return false
      }
    },
    dispose() {
      disposed = true
      items = undefined
      back = undefined
      button?.remove()
      button = undefined
    },
  }
}

export function mountLocalizedPageHeaderBreadcrumbs(
  options: Omit<Parameters<typeof createPageHeaderBreadcrumbs>[0], 'button' | 'resolve' | 'report'> & {
    readonly i18n: CordisXI18nService
    readonly owner: string
    readonly site: string
    readonly defaultTitle: CordisXLocalizedText
    readonly localization: Pick<CordisXLocalizationSeat, 'effect'>
    readonly state: { error?: string }
    readonly notify: () => void
  },
) {
  const controller = createPageHeaderBreadcrumbs({
    ...options,
    report: error => {
      options.state.error = error instanceof Error ? error.message : String(error)
      options.notify()
    },
    button: () => pageChromeButton(options.title.ownerDocument, 'Back', 'host:back'),
    resolve: (message, index) =>
      options.i18n.resolveFor(options.owner, message, `${options.site}.breadcrumb-title.${index}`).text,
  })
  options.localization.effect(() => {
    if (!controller.render()) {
      options.title.textContent =
        options.i18n.resolveFor(options.owner, options.defaultTitle, `${options.site}.title`).text
    }
    return () => options.i18n.clearDiagnosticSite(options.owner, `${options.site}.title`)
  })
  return {
    ...controller,
    dispose() {
      controller.dispose()
      for (let index = 0; index < 8; index++) {
        options.i18n.clearDiagnosticSite(options.owner, `${options.site}.breadcrumb-title.${index}`)
      }
    },
  }
}
