import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { DomOutletController, ReasoningIntensityProjection } from '../packages/cli/src/renderer/adapter.js'

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
    expect(layer.style.inset).toBe('auto')
    expect(layer.style.left).toBe('0px')
    expect(layer.style.top).toBe('0px')
    expect(layer.style.right).toBe('0px')
    expect(layer.style.bottom).toBe('0px')
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

  it('honors an explicit body portal and tracks geometry without changing positioned native layout styles', () => {
    const dom = new JSDOM('<body><main id="anchor" style="position:relative"><div id="native">native</div></main></body>')
    const anchor = dom.window.document.getElementById('anchor')!
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200, toJSON: () => ({}),
    })
    const controller = new DomOutletController(dom.window.document, 'custom.panel', 'portal', () => ({ anchor, contextKey: 'panel:one' }))
    controller.show()
    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ placement: 'portal', contextKey: 'panel:one' })
    expect(snapshot.container?.parentElement).toBe(dom.window.document.body)
    expect(snapshot.container?.style.cssText).toContain('left: 10px')
    expect(anchor.style.position).toBe('relative')
    expect(anchor.contains(dom.window.document.getElementById('native'))).toBe(true)
    controller.dispose()
    dom.window.close()
  })

  it('applies safe insets without changing the native anchor geometry', () => {
    const dom = new JSDOM('<body><main id="anchor" style="position:relative"><div id="native">native</div></main></body>')
    const anchor = dom.window.document.getElementById('anchor')!
    const controller = new DomOutletController(dom.window.document, 'main', 'absolute', () => ({
      anchor,
      contextKey: 'main:safe',
      insets: { top: 46, right: 3, bottom: 2, left: 1 },
    }))
    controller.show()
    const layer = controller.getSnapshot().container!
    expect(layer.style).toMatchObject({ top: '46px', right: '3px', bottom: '2px', left: '1px' })
    expect(anchor.style.position).toBe('relative')
    expect(anchor.firstElementChild?.id).toBe('native')
    expect(dom.window.getComputedStyle(anchor.firstElementChild!).display).not.toBe('none')
    controller.dispose()
    dom.window.close()
  })
})

describe('ReasoningIntensityProjection', () => {
  it('keeps the native range interactive, animates its projection, and restores styles on cleanup', () => {
    const dom = new JSDOM('<body><input id="range" type="range" min="0" max="4" value="0" style="opacity:.8;accent-color:red"></body>')
    const range = dom.window.document.getElementById('range') as HTMLInputElement
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
      x: 20, y: 30, left: 20, top: 30, right: 420, bottom: 78, width: 400, height: 48, toJSON: () => ({}),
    })
    const projection = new ReasoningIntensityProjection(dom.window.document)
    const localized = (key: string) => ({ key, fallback: key })
    projection.update(range, {
      variant: 'imperium', motion: 'ascension', title: localized('Intensity'), stages: [
        { label: localized('Plastic'), material: 'plastic' },
        { label: localized('Bronze'), material: 'bronze' },
        { label: localized('Steel'), material: 'steel' },
        { label: localized('Silver'), material: 'silver' },
        { label: localized('Gold'), material: 'gold' },
      ],
    }, 'Intensity', ['Plastic', 'Bronze', 'Steel', 'Silver', 'Gold'])

    const root = dom.window.document.querySelector<HTMLElement>('.cordisx-reasoning-intensity')!
    expect(range.style.opacity).toBe('0')
    expect(range.style.pointerEvents).toBe('')
    expect(root.style).toMatchObject({ left: '20px', top: '30px', width: '400px', height: '48px' })
    expect(root.dataset.material).toBe('plastic')
    expect(root.dataset.peak).toBe('false')

    range.value = '4'
    range.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(root.dataset.material).toBe('gold')
    expect(root.dataset.peak).toBe('true')
    expect(root.querySelector<HTMLElement>('.cordisx-reasoning-fill')?.style.width).toBe('100%')
    expect(root.querySelectorAll('.cordisx-reasoning-particles i')).toHaveLength(14)

    projection.dispose()
    expect(range.style.opacity).toBe('0.8')
    expect(range.style.accentColor).toBe('red')
    expect(range.dataset.cordisxReasoningNative).toBeUndefined()
    expect(root.isConnected).toBe(false)
    dom.window.close()
  })
})
