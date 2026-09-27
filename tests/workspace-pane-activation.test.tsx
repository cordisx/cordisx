import React, { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspacePaneActivation } from '../packages/cli/src/renderer/manager/use-workspace-pane-activation.js'
import { reactManagerFixture } from './helpers/react-manager.js'

function rail(document: Document, destination: string): HTMLElement {
  const node = document.createElement('nav')
  node.dataset.appNavigationRail = 'true'
  node.innerHTML = `<button data-sidebar-destination="builtin:home">Home</button>
    <button data-sidebar-destination="builtin:automations">Automations</button>`
  const selected = node.querySelector(`[data-sidebar-destination="${destination}"]`)!
  selected.setAttribute('aria-current', 'page')
  selected.setAttribute('data-selected', '')
  return node
}

describe('workspace pane activation', () => {
  it('uses the current connected rail and cancels a destination change during seat wait', async () => {
    const fixture = reactManagerFixture()
    const { document, dom } = fixture
    let current = rail(document, 'builtin:home')
    document.body.append(current)
    let ready = false
    const activatePane = vi.fn(() => ready)
    function Harness() {
      const [open, setOpen] = useState(false)
      const activation = useWorkspacePaneActivation({
        document,
        activatePane,
        titlebarSeat: document.createElement('div'),
        onOpened: () => setOpen(true),
        onUnavailable: () => {},
      })
      return <button id="open" data-open={open} onClick={activation.open}>Open</button>
    }
    try {
      await fixture.render(<Harness />)
      await fixture.click('#open')
      expect(activatePane).toHaveBeenCalledOnce()
      const other = rail(document, 'builtin:automations')
      current.replaceWith(other)
      current = other
      await act(async () => {
        ready = true
        await new Promise(resolve => dom.window.setTimeout(resolve, 120))
      })
      expect(fixture.element('#open').getAttribute('data-open')).toBe('false')
      expect(activatePane).toHaveBeenCalledOnce()

      const home = rail(document, 'builtin:home')
      current.replaceWith(home)
      current = home
      ready = false
      await fixture.click('#open')
      const refreshedHome = rail(document, 'builtin:home')
      current.replaceWith(refreshedHome)
      await act(async () => await new Promise(resolve => dom.window.setTimeout(resolve, 2_200)))
      ready = true
      await act(async () => await new Promise(resolve => dom.window.setTimeout(resolve, 120)))
      expect(fixture.element('#open').getAttribute('data-open')).toBe('true')
    } finally {
      await fixture.dispose()
    }
  })
})
