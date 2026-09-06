import { managerCopy } from '.././ui-copy.js'
import { LocalTabIcon, ManagerTab } from './model.js'
import { LocalizedTab } from './presentation.js'

export interface ChromeDependencies {
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  trigger: HTMLButtonElement
  dialog: HTMLElement
  nav: HTMLElement
  close: HTMLButtonElement
  navButtons: Map<string, HTMLButtonElement>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createChrome(dependencies: ChromeDependencies) {
  let primaryChromeLocale: string | undefined
  const syncPrimaryChrome = (locale: string): void => {
    if (primaryChromeLocale === locale) return
    primaryChromeLocale = locale
    const labels: Readonly<Record<ManagerTab, string>> = {
      plugins: dependencies.copy('manager.nav.plugins'),
      'extension-points': dependencies.copy('manager.nav.extension-points'),
      routes: dependencies.copy('manager.nav.routes'),
      marketplace: dependencies.copy('manager.nav.marketplace'),
      settings: dependencies.copy('manager.nav.plugins'),
      about: dependencies.copy('manager.nav.about'),
    }
    const setAttribute = (element: Element, name: string, value: string): void => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value)
    }
    const setText = (element: Element | null, value: string): void => {
      if (element?.textContent !== value) element?.replaceChildren(value)
    }
    setAttribute(dependencies.trigger, 'aria-label', dependencies.copy('manager.trigger.manage'))
    if (dependencies.trigger.title !== dependencies.copy('manager.trigger.manage')) {
      dependencies.trigger.title = dependencies.copy('manager.trigger.manage')
    }
    setAttribute(dependencies.dialog, 'aria-label', dependencies.copy('manager.dialog'))
    setAttribute(dependencies.nav, 'aria-label', dependencies.copy('manager.navigation'))
    setAttribute(dependencies.close, 'aria-label', dependencies.copy('manager.close'))
    for (const [id, label] of Object.entries(labels)) {
      setText(dependencies.navButtons.get(id)?.querySelector('.cxm-nav-label') ?? null, label)
    }
  }

  const localizeTabs = <T extends string>(
    items: readonly LocalizedTab<T>[],
  ): readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[] => (
    items.map(item => ({ id: item.id, label: dependencies.copy(item.copyKey), icon: item.icon }))
  )
  return { syncPrimaryChrome, localizeTabs }
}
