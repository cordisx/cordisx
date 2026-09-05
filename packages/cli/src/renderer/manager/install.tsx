import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { ManagerModel } from '../manager.js'
import { resolveManagerTriggerTarget } from '../host-probes.js'
import { HostThemeProjection } from '../host-theme.js'
import { ManagerApp } from './ManagerApp.js'
import { createManagerMarketplaceStore } from './model/marketplace-store.js'
import { REACT_MANAGER_STYLES } from './styles.js'
import type { HostManagerNavigationController } from './navigation-controller.js'

export interface ReactManagerInstallOptions {
  readonly triggerTarget?: () => HTMLElement | undefined
  readonly navigationController?: HostManagerNavigationController
}

/** One React root owns the complete Manager shell and every Host-owned page. */
export function installReactCordisXManager(
  document: Document,
  model: ManagerModel,
  options: ReactManagerInstallOptions = {},
): () => void {
  const view = document.defaultView
  const installedAnimationFrameFallback = view !== null && typeof view.requestAnimationFrame !== 'function'
  if (installedAnimationFrameFallback) {
    view.requestAnimationFrame = callback => view.setTimeout(() => callback(view.performance.now()), 16)
    view.cancelAnimationFrame = handle => view.clearTimeout(handle)
  }
  const style = document.createElement('style')
  style.id = 'cordisx-react-manager-style'
  style.textContent = REACT_MANAGER_STYLES
  ;(document.head ?? document.documentElement).append(style)
  const rootSeat = document.createElement('div')
  rootSeat.className = 'cxr-root'
  rootSeat.dataset.cordisxReactManager = 'true'
  const triggerSeat = document.createElement('span')
  triggerSeat.className = 'cxr-trigger-seat'
  ;(document.body ?? document.documentElement).append(rootSeat)
  const theme = new HostThemeProjection(document)
  const detachRootTheme = theme.attach(rootSeat)
  const detachTriggerTheme = theme.attach(triggerSeat)
  const marketplace = createManagerMarketplaceStore(document)
  const root = createRoot(rootSeat)
  // The Manager trigger is part of the Host bootstrap contract. Commit the
  // initial tree before returning so callers never observe a half-installed
  // renderer (and tests do not need renderer-specific timing workarounds).
  flushSync(() =>
    root.render(
      <ManagerApp
        model={model}
        marketplace={marketplace.model}
        triggerSeat={triggerSeat}
        {...(options.navigationController === undefined ? {} : { navigationController: options.navigationController })}
      />,
    )
  )

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = () => {
    scheduled = false
    const target = options.triggerTarget?.() ?? resolveManagerTriggerTarget(document)
    if (target === undefined) {
      triggerSeat.remove()
      currentTarget = undefined
      return
    }
    if (target === currentTarget && triggerSeat.isConnected && triggerSeat.previousElementSibling === target) return
    target.after(triggerSeat)
    currentTarget = target
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const Observer = document.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(schedule)
  observer?.observe(document.documentElement, { childList: true, subtree: true })
  reconcile()

  return () => {
    observer?.disconnect()
    root.unmount()
    marketplace.dispose()
    detachTriggerTheme()
    detachRootTheme()
    theme.dispose()
    triggerSeat.remove()
    rootSeat.remove()
    style.remove()
    if (installedAnimationFrameFallback && view !== null) {
      Reflect.deleteProperty(view, 'requestAnimationFrame')
      Reflect.deleteProperty(view, 'cancelAnimationFrame')
    }
  }
}
