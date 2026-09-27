import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { readNativeRailSelection } from '../packages/cli/src/renderer/adapter/native-rail-selection-probe.js'

function attachFiber(button: HTMLButtonElement, selected: boolean): void {
  const destination = button.getAttribute('data-sidebar-destination')!
  Object.defineProperty(button, '__reactFiber$fixture', {
    configurable: true,
    enumerable: true,
    value: {
      memoizedProps: selected ? { 'data-selected': '' } : {},
      return: {
        memoizedProps: {
          'data-sidebar-destination': destination,
          selected,
          ...(selected ? { 'aria-current': 'page' } : {}),
        },
      },
    },
  })
}

describe('read-only native rail selection probe', () => {
  it('reads the exact selected React owner after Host clears its DOM markers', () => {
    const dom = new JSDOM(`<!doctype html><body><nav data-app-navigation-rail="true">
      <button data-sidebar-destination="builtin:home" aria-current="page" data-selected="">Home</button>
      <button data-sidebar-destination="builtin:automations">Automations</button>
    </nav></body>`)
    const rail = dom.window.document.querySelector<HTMLElement>('nav')!
    const [home, automations] = [...rail.querySelectorAll<HTMLButtonElement>('button')]
    attachFiber(home!, true)
    attachFiber(automations!, false)
    expect(readNativeRailSelection(rail)).toBe(home)
    home!.removeAttribute('aria-current')
    home!.removeAttribute('data-selected')
    expect(readNativeRailSelection(rail)).toBe(home)
    attachFiber(home!, false)
    attachFiber(automations!, true)
    expect(readNativeRailSelection(rail)).toBe(automations)
    rail.remove()
    expect(readNativeRailSelection(rail)).toBeUndefined()
    dom.window.close()
  })

  it('rejects duplicate or mismatched native selection props', () => {
    const dom = new JSDOM(`<!doctype html><body><nav data-app-navigation-rail="true">
      <button data-sidebar-destination="builtin:home">Home</button>
      <button data-sidebar-destination="builtin:automations">Automations</button>
    </nav></body>`)
    const rail = dom.window.document.querySelector<HTMLElement>('nav')!
    const [home, automations] = [...rail.querySelectorAll<HTMLButtonElement>('button')]
    attachFiber(home!, true)
    attachFiber(automations!, true)
    expect(readNativeRailSelection(rail)).toBeUndefined()
    attachFiber(automations!, false)
    automations!.setAttribute('data-sidebar-destination', 'foreign')
    expect(readNativeRailSelection(rail)).toBeUndefined()
    dom.window.close()
  })
})
