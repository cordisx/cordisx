import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveSidebarNavigationParent } from '../packages/cli/src/renderer/adapter/dom.js'

function fixture(markup: string): JSDOM {
  const dom = new JSDOM(markup)
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  return dom
}

describe('native sidebar navigation seat', () => {
  it('finds the 26.924 action stack beside the section-only scroll region', () => {
    const dom = fixture(`<aside>
      <nav role="navigation">
        <div style="display:flex;flex-direction:column">
          <div style="display:flex"><button>Mode</button><button>Search</button></div>
          <div id="actions" style="display:flex;flex-direction:column"><button>New</button><button>Explore</button></div>
        </div>
        <div data-app-action-sidebar-scroll>
          <section data-app-action-sidebar-section><button>Recents</button></section>
          <section data-app-action-sidebar-section><button>Projects</button></section>
        </div>
      </nav>
    </aside>`)
    const document = dom.window.document
    const sidebar = document.querySelector<HTMLElement>('[data-app-action-sidebar-scroll]')!
    const actions = document.querySelector<HTMLElement>('#actions')!
    expect(resolveSidebarNavigationParent(document, sidebar)).toBe(actions)
    const nativeButtons = [...actions.querySelectorAll('button')]
    const pluginRoot = document.createElement('div')
    pluginRoot.dataset.cordisxSurfaceHost = 'sidebar.navigation'
    actions.append(pluginRoot)
    expect(resolveSidebarNavigationParent(document, sidebar)).toBe(actions)
    expect([...actions.querySelectorAll('button')]).toEqual(nativeButtons)
    expect(sidebar.querySelector('[data-cordisx-surface-host]')).toBeNull()
    dom.window.close()
  })

  it('fails closed when the native header has more than one vertical action stack', () => {
    const dom = fixture(`<nav role="navigation">
      <div><div style="display:flex;flex-direction:column"><button>First</button></div>
        <div style="display:grid;flex-direction:column"><button>Second</button></div></div>
      <div data-app-action-sidebar-scroll><section data-app-action-sidebar-section><button>Recents</button></section></div>
    </nav>`)
    const document = dom.window.document
    expect(resolveSidebarNavigationParent(
      document,
      document.querySelector<HTMLElement>(
        '[data-app-action-sidebar-scroll]',
      )!,
    )).toBeUndefined()
    dom.window.close()
  })

  it('keeps the existing action stack inside a legacy scroll region', () => {
    const dom = fixture(`<aside><div data-app-action-sidebar-scroll>
      <div id="actions" style="display:flex;flex-direction:column"><button>New</button><button>Explore</button></div>
      <section data-app-action-sidebar-section><button>Recents</button></section>
    </div></aside>`)
    const document = dom.window.document
    expect(resolveSidebarNavigationParent(
      document,
      document.querySelector<HTMLElement>(
        '[data-app-action-sidebar-scroll]',
      )!,
    )).toBe(document.querySelector('#actions'))
    dom.window.close()
  })
})
