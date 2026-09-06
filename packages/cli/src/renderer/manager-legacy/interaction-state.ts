import type { CordisXPluginConsolePageV1 } from '../../contracts.js'
import type { ManagedManagerPageMount, ManagedSettingsPageMount } from '../navigation.js'

/** Installation-owned console state, shared only with the relevant controllers. */
export interface ManagerConsoleState {
  consoleQuery: string
  consoleMethod: string
  consoleKind: string
  consoleSource: string
  consolePaused: boolean
  consolePausedPage: CordisXPluginConsolePageV1 | undefined
  selectedConsoleEntry: string | undefined
}
export function createManagerConsoleState(): ManagerConsoleState {
  return {
    consoleQuery: '',
    consoleMethod: 'all',
    consoleKind: 'all',
    consoleSource: 'all',
    consolePaused: false,
    consolePausedPage: undefined,
    selectedConsoleEntry: undefined,
  }
}

/** Installation-owned source state, shared only with the relevant controllers. */
export interface ManagerSourceState {
  sourceOperationError: string | undefined
  sourceOperationDiagnostic: string | undefined
  sourceOperationNotice: string | undefined
  sourcesBusy: boolean
  sourceQuery: string
}
export function createManagerSourceState(): ManagerSourceState {
  return {
    sourceOperationError: undefined,
    sourceOperationDiagnostic: undefined,
    sourceOperationNotice: undefined,
    sourcesBusy: false,
    sourceQuery: '',
  }
}

/** Installation-owned menu state, shared only with the relevant controllers. */
export interface ManagerMenuState {
  closePluginActionMenu: (_restoreFocus?: boolean) => void
  pluginActionMenuOpen: boolean
  pluginActionMenuContainsEvent: (_event: Event) => boolean
  repositionPluginActionMenu: () => void
  pendingPluginMenuFocus: string | undefined
  pendingPluginActionFocus: { readonly pluginId: string; readonly actionId: string } | undefined
}
export function createManagerMenuState(): ManagerMenuState {
  return {
    closePluginActionMenu: (_restoreFocus = false): void => {},
    pluginActionMenuOpen: false,
    pluginActionMenuContainsEvent: (_event: Event): boolean => false,
    repositionPluginActionMenu: (): void => {},
    pendingPluginMenuFocus: undefined,
    pendingPluginActionFocus: undefined,
  }
}

/** Installation-owned settings state, shared only with the relevant controllers. */
export interface ManagerSettingsState {
  settingsRoot: HTMLDivElement | undefined
  settingsPanel: HTMLDivElement | undefined
  settingsPanelBody: HTMLDivElement | undefined
  settingsMount: ManagedSettingsPageMount | undefined
  settingsMountId: string | undefined
  settingsTransition: number
  settingsTransitioning: boolean
  settingsError: string | undefined
}
export function createManagerSettingsState(): ManagerSettingsState {
  return {
    settingsRoot: undefined,
    settingsPanel: undefined,
    settingsPanelBody: undefined,
    settingsMount: undefined,
    settingsMountId: undefined,
    settingsTransition: 0,
    settingsTransitioning: false,
    settingsError: undefined,
  }
}

/** Installation-owned content state, shared only with the relevant controllers. */
export interface ManagerContentState {
  managerContentMount: ManagedManagerPageMount | undefined
  managerContentMountId: string | undefined
  managerContentRoot: HTMLDivElement | undefined
  managerContentTransition: number
  managerContentTransitioning: boolean
  managerContentError: string | undefined
}
export function createManagerContentState(): ManagerContentState {
  return {
    managerContentMount: undefined,
    managerContentMountId: undefined,
    managerContentRoot: undefined,
    managerContentTransition: 0,
    managerContentTransitioning: false,
    managerContentError: undefined,
  }
}
