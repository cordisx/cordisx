import { type CordisXIconToken } from '../../contracts.js'
import { createHostSurfaceIcon, type ManagerIconToken } from '.././icons.js'
import { create } from './dom.js'
import type { ManagerSettingsState } from './interaction-state.js'
import { ManagerModel, ManagerRouteState, ManagerSettingsTabSnapshot, ManagerSnapshot } from './model.js'
import { CORDISX_BUILTIN_MANAGER_SETTINGS_TABS, MANAGER_SETTINGS_FALLBACK } from './presentation.js'

export interface SettingsDependencies {
  model: ManagerModel
  activePrimary: (route?: ManagerRouteState) => string
  routeState: ManagerRouteState
  document: Document
  routeKey: (route: ManagerRouteState) => string
  navigationHistory: ManagerRouteState[]
  renderContent: () => void
  currentSettingsTab: () => string
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  content: HTMLDivElement
  settingsState: Pick<
    ManagerSettingsState,
    | 'settingsMount'
    | 'settingsMountId'
    | 'settingsTransition'
    | 'settingsError'
    | 'settingsTransitioning'
    | 'settingsRoot'
    | 'settingsPanel'
    | 'settingsPanelBody'
  >
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createSettings(dependencies: SettingsDependencies) {
  const settingsTabs = (snapshot: ManagerSnapshot): readonly ManagerSettingsTabSnapshot[] => (
    snapshot.settingsTabs ?? CORDISX_BUILTIN_MANAGER_SETTINGS_TABS
  )

  const stopSettingsContent = async (): Promise<void> => {
    const mount = dependencies.settingsState.settingsMount
    const mountId = dependencies.settingsState.settingsMountId
    dependencies.settingsState.settingsMount = undefined
    dependencies.settingsState.settingsMountId = undefined
    if (mount === undefined && mountId === undefined) return
    mount?.abort()
    if (dependencies.model.closeSettingsTabContent !== undefined) await dependencies.model.closeSettingsTabContent()
    else await mount?.dispose()
  }

  const resetSettings = async (): Promise<void> => {
    dependencies.settingsState.settingsTransition += 1
    if (
      dependencies.settingsState.settingsMount === undefined && dependencies.settingsState.settingsMountId === undefined
    ) {
      if (dependencies.activePrimary() === 'settings') {
        dependencies.routeState = { kind: 'primary', primary: 'settings' }
      }
      dependencies.settingsState.settingsError = undefined
      dependencies.settingsState.settingsTransitioning = false
      dependencies.settingsState.settingsRoot = undefined
      dependencies.settingsState.settingsPanel = undefined
      dependencies.settingsState.settingsPanelBody = undefined
      return
    }
    dependencies.settingsState.settingsTransitioning = true
    try {
      await stopSettingsContent()
    } finally {
      if (dependencies.activePrimary() === 'settings') {
        dependencies.routeState = { kind: 'primary', primary: 'settings' }
      }
      dependencies.settingsState.settingsError = undefined
      dependencies.settingsState.settingsTransitioning = false
      dependencies.settingsState.settingsRoot = undefined
      dependencies.settingsState.settingsPanel = undefined
      dependencies.settingsState.settingsPanelBody = undefined
    }
  }

  const focusSettingsTab = (id: string): void => {
    const button = [...dependencies.document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')]
      .find(candidate => candidate.dataset.settingsTab === id)
    button?.focus()
  }

  const activateSettingsTab = async (id: string, restoreFocus: boolean, recordHistory = true): Promise<void> => {
    const tab = settingsTabs(dependencies.model.snapshot()).find(candidate => candidate.id === id)
    if (tab === undefined || tab.disabled || dependencies.settingsState.settingsTransitioning) return
    const previousRoute = dependencies.routeState
    const nextRoute: ManagerRouteState = { kind: 'settings', tabId: id }
    if (
      dependencies.routeKey(previousRoute) === dependencies.routeKey(nextRoute)
      && (tab.builtin || dependencies.settingsState.settingsMountId === id)
    ) {
      if (restoreFocus) focusSettingsTab(id)
      return
    }
    if (recordHistory && dependencies.routeKey(previousRoute) !== dependencies.routeKey(nextRoute)) {
      dependencies.navigationHistory.push(previousRoute)
    }
    const token = ++dependencies.settingsState.settingsTransition
    dependencies.settingsState.settingsTransitioning = true
    dependencies.settingsState.settingsMount?.abort()
    try {
      await stopSettingsContent()
      if (token !== dependencies.settingsState.settingsTransition) return
      dependencies.routeState = nextRoute
      dependencies.settingsState.settingsError = undefined
      dependencies.settingsState.settingsTransitioning = false
      dependencies.renderContent()
      if (!tab.builtin) {
        if (
          dependencies.model.mountSettingsTab === undefined
          || dependencies.settingsState.settingsPanelBody === undefined
        ) {
          throw new Error('manager settings page mount is unavailable')
        }
        dependencies.settingsState.settingsPanel?.setAttribute('aria-busy', 'true')
        dependencies.settingsState.settingsPanelBody.replaceChildren()
        dependencies.settingsState.settingsMountId = id
        const mount = await dependencies.model.mountSettingsTab(id, dependencies.settingsState.settingsPanelBody)
        if (token !== dependencies.settingsState.settingsTransition || dependencies.currentSettingsTab() !== id) {
          mount.abort()
          await mount.dispose()
          return
        }
        dependencies.settingsState.settingsMount = mount
        dependencies.settingsState.settingsMountId = id
        dependencies.settingsState.settingsPanel?.removeAttribute('aria-busy')
      }
      if (restoreFocus) focusSettingsTab(id)
    } catch (error) {
      if (token !== dependencies.settingsState.settingsTransition) return
      dependencies.settingsState.settingsMount?.abort()
      await stopSettingsContent().catch(() => {})
      dependencies.settingsState.settingsError = error instanceof Error ? error.message : String(error)
      dependencies.routeState = { kind: 'settings', tabId: MANAGER_SETTINGS_FALLBACK }
      dependencies.settingsState.settingsTransitioning = false
      dependencies.renderContent()
      if (restoreFocus) focusSettingsTab(MANAGER_SETTINGS_FALLBACK)
    }
  }

  const renderSettings = (snapshot: ManagerSnapshot): void => {
    dependencies.setHeading('配置', snapshot, { icon: 'settings' })
    const items = settingsTabs(snapshot)
    const settingsTab = dependencies.currentSettingsTab()
    const active = items.find(item => item.id === settingsTab)
    if ((active === undefined || active.disabled) && !dependencies.settingsState.settingsTransitioning) {
      dependencies.settingsState.settingsTransition += 1
      dependencies.settingsState.settingsTransitioning = true
      dependencies.settingsState.settingsMount?.abort()
      void stopSettingsContent().catch(error => {
        dependencies.settingsState.settingsError = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        dependencies.routeState = { kind: 'settings', tabId: MANAGER_SETTINGS_FALLBACK }
        dependencies.settingsState.settingsTransitioning = false
        dependencies.renderContent()
      })
      return
    }

    if (dependencies.settingsState.settingsRoot === undefined || !dependencies.settingsState.settingsRoot.isConnected) {
      dependencies.settingsState.settingsRoot = create(dependencies.document, 'div', 'cxm-settings-root')
      dependencies.settingsState.settingsRoot.dataset.settingsRoot = 'true'
      const tabs = create(dependencies.document, 'div', 'cxm-tabs')
      tabs.dataset.settingsTablist = 'true'
      const panel = create(dependencies.document, 'div', 'cxm-settings-panel')
      panel.id = 'cordisx-manager-settings-panel'
      panel.setAttribute('role', 'tabpanel')
      panel.tabIndex = 0
      const body = create(dependencies.document, 'div', 'cxm-settings-panel-body')
      body.dataset.settingsPanelBody = 'true'
      panel.append(body)
      dependencies.settingsState.settingsRoot.append(tabs, panel)
      dependencies.content.append(dependencies.settingsState.settingsRoot)
      dependencies.settingsState.settingsPanel = panel
      dependencies.settingsState.settingsPanelBody = body
    }

    const tablist = dependencies.settingsState.settingsRoot.querySelector<HTMLElement>('[data-settings-tablist]')!
    const focusedTabId = dependencies.document.activeElement instanceof dependencies.document.defaultView!.HTMLElement
      ? dependencies.document.activeElement.dataset.settingsTab
      : undefined
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('aria-label', 'CordisX 配置标签页')
    tablist.setAttribute('aria-orientation', 'horizontal')
    tablist.replaceChildren()
    const enabled = items.filter(item => !item.disabled)
    for (const item of items) {
      const button = create(dependencies.document, 'button', 'cxm-tab')
      button.type = 'button'
      button.id = `cordisx-manager-settings-tab-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
      button.dataset.settingsTab = item.id
      button.dataset.settingsOwner = item.owner
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', 'cordisx-manager-settings-panel')
      button.setAttribute('aria-selected', String(item.id === settingsTab))
      button.tabIndex = item.id === settingsTab ? 0 : -1
      button.disabled = item.disabled
      if (item.disabled) button.setAttribute('aria-disabled', 'true')
      if (item.disabledReason !== undefined) button.title = item.disabledReason
      const visibleContent = create(dependencies.document, 'span', 'cxm-tab-content')
      const icon = createHostSurfaceIcon(dependencies.document, item.icon)
      icon.classList.add('cxm-tab-icon', 'cxm-settings-tab-icon')
      visibleContent.append(icon, create(dependencies.document, 'span', undefined, item.title))
      button.append(visibleContent)
      button.addEventListener('click', () => {
        void activateSettingsTab(item.id, true)
      })
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void activateSettingsTab(item.id, true)
          return
        }
        const current = enabled.findIndex(candidate => candidate.id === item.id)
        let next: ManagerSettingsTabSnapshot | undefined
        if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length]
        if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length]
        if (event.key === 'Home') next = enabled[0]
        if (event.key === 'End') next = enabled.at(-1)
        if (next === undefined) return
        event.preventDefault()
        void activateSettingsTab(next.id, true)
      })
      tablist.append(button)
    }
    const activeButton = tablist.querySelector<HTMLButtonElement>(`[data-settings-tab="${settingsTab}"]`)
    if (activeButton !== null) {
      dependencies.settingsState.settingsPanel?.setAttribute('aria-labelledby', activeButton.id)
    }
    if (focusedTabId !== undefined) {
      tablist.querySelector<HTMLButtonElement>(`[data-settings-tab="${focusedTabId}"]`)?.focus()
    }

    if (
      dependencies.settingsState.settingsPanelBody === undefined
      || dependencies.settingsState.settingsMountId === settingsTab
    ) return
    dependencies.settingsState.settingsPanelBody.replaceChildren()
    dependencies.settingsState.settingsPanel?.removeAttribute('aria-busy')
    if (!settingsTab.startsWith('host:')) {
      dependencies.settingsState.settingsPanel?.setAttribute('aria-busy', 'true')
      dependencies.settingsState.settingsPanelBody.append(
        create(
          dependencies.document,
          'div',
          'cxm-notice',
          dependencies.settingsState.settingsTransitioning ? '正在切换配置页面…' : '正在加载插件配置页面…',
        ),
      )
    }
    if (dependencies.settingsState.settingsError !== undefined) {
      dependencies.settingsState.settingsPanelBody.append(
        create(
          dependencies.document,
          'div',
          'cxm-error',
          `插件配置页面错误：${dependencies.settingsState.settingsError}`,
        ),
      )
    }
  }

  const disposeSettingsForRouteChange = async (): Promise<void> => {
    dependencies.settingsState.settingsTransition += 1
    dependencies.settingsState.settingsTransitioning = true
    dependencies.settingsState.settingsMount?.abort()
    try {
      await stopSettingsContent()
    } finally {
      dependencies.settingsState.settingsTransitioning = false
      dependencies.settingsState.settingsError = undefined
      dependencies.settingsState.settingsRoot = undefined
      dependencies.settingsState.settingsPanel = undefined
      dependencies.settingsState.settingsPanelBody = undefined
    }
  }
  return { stopSettingsContent, resetSettings, activateSettingsTab, disposeSettingsForRouteChange }
}
