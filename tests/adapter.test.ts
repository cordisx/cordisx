import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { DomOutletController } from '../packages/cli/src/renderer/adapter.js'

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('DomOutletController', () => {
  it('re-inserts the same CordisX layer after a same-context React anchor replacement', async () => {
    const dom = new JSDOM('<body><main id="anchor" style="position:relative"><div id="native">native</div></main></body>')
    let contextKey = 'main:project'
    const controller = new DomOutletController(dom.window.document, 'main', 'absolute', () => {
      const anchor = dom.window.document.getElementById('anchor')
      return anchor === null ? undefined : { anchor, contextKey }
    })
    controller.show()
    const first = controller.getSnapshot()
    const layer = first.container!
    const native = dom.window.document.getElementById('native')!
    const nativeParent = native.parentElement
    expect(layer.parentElement?.id).toBe('anchor')
    expect(first).toMatchObject({ available: true, contextKey: 'main:project', placement: 'absolute' })
    expect(layer.style.inset).toBe('0')
    expect(native.parentElement).toBe(nativeParent)
    expect(dom.window.getComputedStyle(native).display).not.toBe('none')

    const replacement = dom.window.document.createElement('main')
    replacement.id = 'anchor'
    replacement.style.position = 'relative'
    dom.window.document.getElementById('anchor')?.replaceWith(replacement)
    await settle()
    expect(controller.getSnapshot().container).toBe(layer)
    expect(layer.parentElement).toBe(replacement)

    contextKey = 'main:other-project'
    replacement.append(dom.window.document.createElement('span'))
    await settle()
    expect(controller.getSnapshot().contextKey).toBe('main:other-project')
    controller.dispose()
    expect(layer.isConnected).toBe(false)
    dom.window.close()
  })

  it('falls back to a body portal and tracks geometry without changing native layout styles', () => {
    const dom = new JSDOM('<body><main id="anchor"><div id="native">native</div></main></body>')
    const anchor = dom.window.document.getElementById('anchor')!
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200, toJSON: () => ({}),
    })
    const controller = new DomOutletController(dom.window.document, 'custom.panel', 'absolute', () => ({ anchor, contextKey: 'panel:one' }))
    controller.show()
    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ placement: 'portal', contextKey: 'panel:one' })
    expect(snapshot.container?.parentElement).toBe(dom.window.document.body)
    expect(snapshot.container?.style.cssText).toContain('left: 10px')
    expect(anchor.style.position).toBe('')
    expect(anchor.contains(dom.window.document.getElementById('native'))).toBe(true)
    controller.dispose()
    dom.window.close()
  })
})
