import type { JSDOM } from 'jsdom'

/** Give bundle integration tests the real 26.924 Manager seat they exercise. */
export function installNativeManagerShell(dom: JSDOM): void {
  const { document } = dom.window
  const originalHeader = document.querySelector<HTMLElement>('.sidebar-header')
  if (document.getElementById('root') === null) {
    document.body.insertAdjacentHTML('afterbegin', '<div id="root"></div>')
  }
  let rail = document.querySelector<HTMLElement>('nav[data-app-navigation-rail="true"]')
  if (rail === null) {
    rail = document.createElement('nav')
    rail.dataset.appNavigationRail = 'true'
    rail.innerHTML =
      '<div><div><button data-sidebar-destination="builtin:home" aria-current="page">Home</button></div><div><button data-sidebar-destination="builtin:automations">Automations</button></div></div>'
  }
  let navigation = document.querySelector<HTMLElement>('nav[role="navigation"][aria-label="Home"]')
  if (navigation === null) {
    navigation = document.createElement('nav')
    navigation.setAttribute('role', 'navigation')
    navigation.setAttribute('aria-label', 'Home')
    navigation.innerHTML = '<div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div>'
  }
  if (originalHeader !== null && !navigation.contains(originalHeader)) {
    navigation.querySelector('.sidebar-header')?.replaceWith(originalHeader)
  }
  const aside = document.createElement('aside')
  aside.dataset.appShellLeftPanelAppearance = 'default'
  aside.append(rail, navigation)
  aside.insertAdjacentHTML(
    'beforeend',
    '<div data-native-manager-resizer><div role="separator" aria-orientation="vertical"></div></div>',
  )
  document.body.append(aside)
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <header data-app-shell-titlebar="true" style="position:fixed;pointer-events:none">
      <div data-app-shell-header-slot="start"><button data-native-back style="pointer-events:auto">Back</button><button data-native-forward style="pointer-events:auto">Forward</button></div>
      <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface" style="pointer-events:none">
        <div data-app-shell-titlebar-slot="main" data-app-shell-focus-area="main">Native title</div>
      </div>
      <div data-app-shell-header-slot="end"><button data-native-window-action style="pointer-events:auto">Window</button></div>
    </header>
  `,
  )
  let main = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')
  if (main === null) {
    main = document.createElement('main')
    main.dataset.appShellMainContentLayout = 'default'
    document.body.append(main)
  }
  let frame = main.querySelector<HTMLElement>(':scope > [data-app-shell-thread-edge-divider]')
  if (frame === null) {
    frame = document.createElement('div')
    frame.dataset.appShellThreadEdgeDivider = 'false'
    const focus = document.createElement('div')
    focus.dataset.appShellFocusArea = 'main'
    focus.replaceChildren(...main.childNodes)
    frame.append(focus)
    main.append(frame)
  }
  if (frame.querySelector('[data-app-shell-main-content-top-fade]') === null) {
    frame.insertAdjacentHTML('afterbegin', '<div data-app-shell-main-content-top-fade="true"></div>')
  }
  if (frame.querySelector('[data-app-shell-focus-area="main"]') === null) {
    frame.insertAdjacentHTML('beforeend', '<div data-app-shell-focus-area="main">Native content</div>')
  }
  const router = {
    state: { location: { pathname: '/', search: '', hash: '', key: 'native-home' }, historyAction: 'POP' },
    subscribe: (_listener: () => void) => () => {},
  }
  Object.defineProperty(document.getElementById('root')!, '__reactContainer$fixture', {
    configurable: true,
    enumerable: true,
    value: { child: { memoizedProps: { value: { router } } } },
  })
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const geometry = new Map<Element, DOMRect>([
    [rail, rect(0, 44, 52, 800)],
    [navigation, rect(52, 44, 238, 800)],
    [document.querySelector('[data-native-manager-resizer]')!, rect(282, 44, 16, 800)],
    [main, rect(290, 44, 1000, 800)],
    [frame, rect(290, 44, 1000, 800)],
    [document.querySelector('header[data-app-shell-titlebar]')!, rect(0, 0, 1290, 44)],
    [document.querySelector('[data-app-shell-main-titlebar]')!, rect(290, 0, 1000, 44)],
    [document.querySelector('[data-app-shell-header-slot="start"]')!, rect(0, 0, 290, 44)],
    [document.querySelector('[data-app-shell-titlebar-slot="main"]')!, rect(290, 0, 964, 44)],
    [document.querySelector('[data-app-shell-header-slot="end"]')!, rect(1254, 0, 36, 44)],
    [document.querySelector('[data-native-back]')!, rect(88, 8, 28, 28)],
    [document.querySelector('[data-native-forward]')!, rect(122, 8, 28, 28)],
    [document.querySelector('[data-native-window-action]')!, rect(1260, 8, 28, 28)],
  ])
  const nativeRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function(this: HTMLElement) {
      const fixed = geometry.get(this)
      if (fixed !== undefined) return fixed
      if (this.hasAttribute('data-cordisx-manager-titlebar-seat')) {
        const parentLeft = this.style.position === 'absolute'
          ? this.parentElement?.getBoundingClientRect().left ?? 0
          : 0
        return rect(
          parentLeft + (Number.parseFloat(this.style.left) || 0),
          0,
          Number.parseFloat(this.style.width) || 0,
          44,
        )
      }
      if (this.hasAttribute('data-cordisx-manager-sidebar-resizer')) return rect(285, 44, 10, 800)
      return nativeRect.call(this)
    },
  })
  const header = document.querySelector('header[data-app-shell-titlebar]')!
  const controls = document.querySelectorAll('[data-native-back], [data-native-forward], [data-native-window-action]')
  const nativeStyle = dom.window.getComputedStyle.bind(dom.window)
  Object.defineProperty(dom.window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      const style = nativeStyle(element)
      const appRegion = element === header ? 'drag' : [...controls].includes(element) ? 'no-drag' : ''
      Object.defineProperty(style, 'webkitAppRegion', { value: appRegion, configurable: true })
      return style
    },
  })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })
}
