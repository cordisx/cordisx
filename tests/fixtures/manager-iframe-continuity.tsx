import { installReactCordisXManager } from '../../packages/cli/src/renderer/manager/install.js'
import type { ManagerModel } from '../../packages/cli/src/renderer/manager.js'
import { installNativeManagerShell } from './native-manager-shell.js'

const model: ManagerModel = {
  snapshot: () => ({
    version: 'iframe-continuity-fixture',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    permissions: [],
    platform: {
      hostId: 'test',
      hostName: 'test',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
  }),
  subscribe: () => () => {},
  setPluginBlocked: async () => {},
  setPermissionPolicy: async () => {},
}

const element = (selector: string) => document.querySelector<HTMLElement>(selector)!
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect
const setRect = (node: Element, bounds: DOMRect) => {
  node.getClientRects = () => ({ length: 1 }) as DOMRectList
  Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => bounds })
}
const source = {
  snapshot: () => ({ available: true, key: 'same-page', nativeLocation: { pathname: '/', search: '', hash: '' } }),
  subscribe: () => () => {},
}
let frame: HTMLIFrameElement
let originalDocument: Document
let dispose: (() => void) | undefined
let loads = 0

/** Synthetic native geometry; a real browser supplies the iframe browsing-context lifecycle. */
export async function start() {
  const nativeStyle = window.getComputedStyle.bind(window)
  installNativeManagerShell({ window } as Parameters<typeof installNativeManagerShell>[0])
  // The shared Node fixture annotates computed styles. A browser's declaration
  // is read-only, so use actual CSS app regions for the browser lifecycle test.
  window.getComputedStyle = nativeStyle
  const main = element('[data-app-shell-main-content-layout]')
  main.dataset.appShellWorkspaceLayout = 'split'
  const header = element('header[data-app-shell-titlebar]')
  header.style.setProperty('-webkit-app-region', 'drag')
  for (const button of header.querySelectorAll<HTMLElement>('button')) {
    button.style.setProperty('-webkit-app-region', 'no-drag')
  }
  header.dataset.appShellHeaderLayout = 'default'
  const shell = document.createElement('div')
  shell.dataset.appShellUnifiedTabStrip = 'true'
  shell.dataset.appShellCompactPageGutter = 'true'
  shell.dataset.appShellHeaderPlacement = 'titlebar'
  header.replaceWith(shell)
  shell.append(header)
  const title = element('[data-app-shell-titlebar-slot="main"]')
  const obstacle = document.createElement('div')
  obstacle.dataset.appShellHeaderObstacle = 'true'
  title.replaceWith(obstacle)
  obstacle.append(title)
  const aside = element('aside[data-app-shell-left-panel-appearance]')
  const sidebar = document.createElement('div')
  sidebar.id = 'app-shell-sidebar'
  const list = document.createElement('div')
  list.id = 'collapsed-list'
  list.append(element('nav[role="navigation"][aria-label="Home"]'))
  sidebar.append(element('nav[data-app-navigation-rail]'), list)
  aside.prepend(sidebar)
  const toggle = document.createElement('button')
  toggle.dataset.appShellSidebarTrigger = 'true'
  toggle.setAttribute('aria-controls', 'app-shell-sidebar')
  toggle.setAttribute('aria-expanded', 'true')
  toggle.style.pointerEvents = 'auto'
  toggle.style.setProperty('-webkit-app-region', 'no-drag')
  element('[data-app-shell-header-slot="start"]').append(toggle)
  setRect(toggle, rect(156, 8, 28, 28))
  for (const node of document.querySelectorAll<HTMLElement>('nav,button')) {
    node.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  const panel = document.createElement('div')
  panel.setAttribute('role', 'tabpanel')
  panel.dataset.appShellTabPanelController = 'right'
  panel.dataset.tabId = 'browser'
  panel.innerHTML = '<iframe src="about:blank"></iframe>'
  document.body.append(panel)
  setRect(panel, rect(850, 44, 869, 800))
  setRect(header, rect(0, 0, 1719, 44))
  setRect(element('[data-app-shell-header-slot="end"]'), rect(850, 0, 869, 44))
  setRect(element('[data-native-manager-resizer]'), rect(282, 44, 16, 800))
  setLayout(true)
  replaceRightTab()
  dispose = installReactCordisXManager(document, model, { presentationMode: 'workspace', nativeRouteHistory: source })
  element('[data-cordisx-manager-trigger]').click()
  await settle()
  frame = document.createElement('iframe')
  frame.addEventListener('load', () => loads++)
  await new Promise<void>(resolve => {
    frame.addEventListener('load', () => resolve(), { once: true })
    frame.src = '/embedded'
    element('[data-cordisx-react-manager]').append(frame)
  })
  originalDocument = frame.contentDocument!
  originalDocument.querySelector<HTMLInputElement>('input')!.value = 'retained iframe draft'
  return state()
}

function setLayout(expanded: boolean) {
  const left = expanded ? 290 : 52
  const width = 850 - left
  setRect(element('aside[data-app-shell-left-panel-appearance]'), rect(0, 44, left, 800))
  setRect(element('nav[role="navigation"][aria-label="Home"]'), rect(expanded ? 52 : 36, 44, 238, 800))
  setRect(element('[data-app-shell-main-content-layout]'), rect(left, 44, width, 800))
  setRect(element('[data-app-shell-thread-edge-divider]'), rect(left, 44, width, 800))
  setRect(element('[data-app-shell-header-slot="start"]'), rect(0, 0, expanded ? 290 : 190, 44))
  setRect(element('[data-app-shell-main-titlebar]'), rect(left, 0, width, 44))
  setRect(element('[data-app-shell-titlebar-slot="main"]'), rect(left, 0, width - 6, 44))
}

export function replaceRightTab() {
  element('[data-app-shell-header-slot="end"]').innerHTML =
    '<div data-app-shell-tab-controller="right" data-tab-id="browser"><button role="tab" aria-selected="true" style="pointer-events:auto">Browser</button></div>'
  setRect(element('[data-app-shell-tab-controller]'), rect(854, 6, 240, 32))
  setRect(element('[role="tab"]'), rect(854, 6, 210, 32))
  element('[role="tab"]').style.setProperty('-webkit-app-region', 'no-drag')
}

export function toggleSidebar(expanded: boolean) {
  element('[data-app-shell-sidebar-trigger]').setAttribute('aria-expanded', String(expanded))
  element('#collapsed-list').toggleAttribute('data-sidebar-collapsed', !expanded)
  setLayout(expanded)
}

export function state() {
  const sidebar = element('[data-cordisx-manager-sidebar-root]')
  return {
    open: document.querySelector('[data-cordisx-manager-pane="true"]') !== null,
    loads,
    sameDocument: frame?.contentDocument === originalDocument,
    draft: frame?.contentDocument?.querySelector<HTMLInputElement>('input')?.value,
    sidebarHidden: sidebar?.hidden,
    sidebarDisplay: sidebar === null ? undefined : window.getComputedStyle(sidebar).display,
  }
}

export async function settle() {
  await new Promise(resolve => setTimeout(resolve, 80))
}
export function stop() {
  dispose?.()
  dispose = undefined
}
