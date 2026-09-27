import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { readNativeSidebarMinimum } from '../packages/cli/src/renderer/adapter/native-sidebar-minimum.js'

function fixture(minimumWidth?: number, currentTotal = 290) {
  const dom = new JSDOM(
    `<!doctype html><body><aside data-app-shell-left-panel-appearance="default">
    <nav data-app-navigation-rail="true"></nav><nav role="navigation"></nav>
    <div id="resizer"><div role="separator" aria-orientation="vertical"></div></div>
  </aside></body>`,
    { url: 'https://codex.local/' },
  )
  const { document } = dom.window
  const aside = document.querySelector<HTMLElement>('aside')!
  const rail = document.querySelector<HTMLElement>('[data-app-navigation-rail]')!
  const navigation = document.querySelector<HTMLElement>('nav[role="navigation"]')!
  const resizer = document.getElementById('resizer')!
  const rect = (x: number, width: number): DOMRect =>
    ({ x, left: x, right: x + width, y: 44, top: 44, bottom: 900, width, height: 856 }) as DOMRect
  aside.getBoundingClientRect = () => rect(0, currentTotal)
  rail.getBoundingClientRect = () => rect(0, 52)
  navigation.getBoundingClientRect = () => rect(52, currentTotal - 52)
  resizer.getBoundingClientRect = () => rect(currentTotal - 8, 16)
  if (minimumWidth !== undefined) {
    Object.defineProperty(aside, '__reactFiber$fixture', {
      enumerable: true,
      configurable: true,
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {},
          return: {
            memoizedProps: { minimumWidth },
            return: null,
          },
        },
      },
    })
  }
  return {
    dom,
    document,
    aside,
    rail,
    navigation,
    resizer,
    read: () =>
      readNativeSidebarMinimum({
        document,
        aside,
        rail,
        navigation,
        resizer,
      }),
  }
}

describe('native sidebar expanded minimum', () => {
  it('uses the unique native controller total width minus the measured rail', () => {
    const first = fixture(290)
    expect(first.read()).toEqual({ width: 238, source: 'native-controller' })
    first.dom.window.close()
    const other = fixture(240)
    expect(other.read()).toEqual({ width: 188, source: 'native-controller' })
    other.dom.window.close()
    const stale = fixture(290, 232)
    expect(stale.read()).toEqual({ width: 238, source: 'native-controller' })
    stale.dom.window.close()
  })

  it('uses a bounded native style preference or current expanded width when controller is unavailable', () => {
    const styled = fixture()
    styled.aside.style.setProperty('--codex-sidebar-preferred-width', '290px')
    expect(styled.read()).toEqual({ width: 238, source: 'native-style' })
    styled.dom.window.close()
    const staleStyle = fixture(undefined, 232)
    staleStyle.aside.style.setProperty('--codex-sidebar-preferred-width', '290px')
    expect(staleStyle.read()).toEqual({ width: 238, source: 'native-style' })
    staleStyle.dom.window.close()
    const current = fixture()
    expect(current.read()).toEqual({ width: 238, source: 'current-native' })
    current.rail.remove()
    expect(current.read()).toEqual({ width: 180, source: 'host-floor' })
    current.dom.window.close()
  })
})
