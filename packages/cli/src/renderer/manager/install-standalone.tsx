import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { ManagerModel } from '../manager.js'
import type { PluginManagementBinding } from '../management-binding.js'
import { HostThemeProjection } from '../host-theme.js'
import { ManagerApp } from './ManagerApp.js'
import { createManagerMarketplaceStore } from './model/marketplace-store.js'
import type { HostManagerNavigationController } from './navigation-controller.js'
import { standaloneStartupFor } from './standalone-startup-contract.js'
import { REACT_MANAGER_STYLES } from './styles.js'
import standaloneStyle from './manager-standalone.css?inline'

/** Mount the same Manager and plugin-owned page seats without a native application anchor. */
export function installStandaloneManager(document: Document, model: ManagerModel, options: {
  readonly navigationController?: HostManagerNavigationController
  readonly pluginManagement?: PluginManagementBinding
  /** The fixed same-origin stylesheet published by the standalone service. */
  readonly standaloneStyleHref?: '/manager-host.css'
} = {}): () => void {
  if (options.standaloneStyleHref !== undefined && options.standaloneStyleHref !== '/manager-host.css') {
    throw new Error('Standalone Manager stylesheet must be the fixed same-origin asset')
  }
  const rootSeat = document.createElement('div')
  rootSeat.className = 'cxr-root'
  rootSeat.dataset.cordisxReactManager = 'true'
  rootSeat.dataset.managerSurface = 'standalone'
  const startup = options.standaloneStyleHref === undefined ? undefined : standaloneStartupFor(document)
  if (startup !== undefined && options.navigationController === undefined) {
    throw new Error('Standalone Manager navigation is unavailable')
  }
  rootSeat.hidden = startup !== undefined
  const triggerSeat = document.createElement('span')
  const style = options.standaloneStyleHref === undefined
    ? document.createElement('style')
    : document.createElement('link')
  style.id = 'cordisx-react-manager-style'
  if (options.standaloneStyleHref !== undefined) {
    ;(style as HTMLLinkElement).rel = 'stylesheet'
    ;(style as HTMLLinkElement).href = options.standaloneStyleHref
  } else style.textContent = `${REACT_MANAGER_STYLES}\n${standaloneStyle}`
  ;(document.head ?? document.documentElement).append(style)
  ;(document.body ?? document.documentElement).append(rootSeat)
  const theme = new HostThemeProjection(document)
  const detachTheme = theme.attach(rootSeat)
  const marketplace = createManagerMarketplaceStore(document, options.pluginManagement)
  const root = createRoot(rootSeat)
  let disposed = false
  let unstage: (() => void) | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    unstage?.()
    root.unmount()
    marketplace.dispose()
    detachTheme()
    theme.dispose()
    rootSeat.remove()
    style.remove()
  }
  try {
    flushSync(() =>
      root.render(
        <ManagerApp
          model={model}
          marketplace={marketplace.model}
          triggerSeat={triggerSeat}
          presentationMode="standalone"
          {...(options.navigationController === undefined
            ? {}
            : { navigationController: options.navigationController })}
          {...(options.pluginManagement === undefined ? {} : { pluginManagement: options.pluginManagement })}
        />,
      )
    )
    if (startup !== undefined) {
      const navigation = options.navigationController!
      unstage = startup.stage(route => {
        const focusWasInStartup = Boolean(document.activeElement?.closest('[data-cordisx-manager-startup]'))
        flushSync(() => navigation.openRoute(route))
        rootSeat.hidden = false
        if (focusWasInStartup) rootSeat.querySelector<HTMLElement>('.cxr-nav-destination[aria-current=page]')?.focus()
      })
    }
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
