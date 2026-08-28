import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  DomOutletController,
  ReasoningIntensityProjection,
  ReasoningIntensityNativeVisibility,
  SessionBackdropProjection,
  resolveReasoningIntensityRange,
} from '../packages/cli/src/renderer/adapter.js'

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

  it('honors an explicit body portal and keeps one geometry observer for the same anchor', () => {
    const dom = new JSDOM('<body><main id="anchor" style="position:relative"><div id="native">native</div></main></body>')
    let notifyResize: (() => void) | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    const ResizeObserver = vi.fn(function (callback: () => void) {
      notifyResize = callback
      return { observe, disconnect }
    })
    Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: ResizeObserver })
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
    expect(ResizeObserver).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(1)
    notifyResize?.()
    expect(ResizeObserver).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
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
  it('keeps native styles for overlay and restores a hide-native lease', () => {
    const dom = new JSDOM('<body><input id="range" type="range" min="0" max="4" value="2" style="opacity:.7;accent-color:blue"></body>')
    const range = dom.window.document.getElementById('range') as HTMLInputElement
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
      x: 1, y: 2, left: 1, top: 2, right: 201, bottom: 42, width: 200, height: 40, toJSON: () => ({}),
    })
    const localized = (key: string) => ({ key, fallback: key })
    const projection = new ReasoningIntensityProjection(dom.window.document)
    projection.update(range, {
      variant: 'imperium', title: localized('Intensity'), stages: [
        { label: localized('Low'), material: 'plastic' }, { label: localized('High'), material: 'gold' },
      ],
    }, 'Intensity', ['Low', 'High'], false)
    expect(range.style).toMatchObject({ opacity: '0.7', accentColor: 'blue' })
    projection.dispose()

    const visibility = new ReasoningIntensityNativeVisibility()
    visibility.update(range, true)
    expect(range.style).toMatchObject({ opacity: '0', accentColor: 'transparent' })
    visibility.dispose()
    expect(range.style).toMatchObject({ opacity: '0.7', accentColor: 'blue' })
    expect(range.dataset.cordisxReasoningNative).toBeUndefined()
    dom.window.close()
  })

  it('adapts the current Radix power slider without replacing its native value authority', () => {
    const dom = new JSDOM(`<body><div role="menu"><div data-model-picker-power-slider style="height:40px"><span data-orientation="horizontal"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1" aria-label="Intensity"></span></span></div></div></body>`)
    const native = dom.window.document.querySelector<HTMLElement>('[role="slider"]')!
    const visibleRect = { x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 60, width: 300, height: 40, toJSON: () => ({}) }
    vi.spyOn(native, 'getBoundingClientRect').mockReturnValue(visibleRect)
    vi.spyOn(native, 'getClientRects').mockReturnValue({ 0: visibleRect, length: 1, item: () => visibleRect } as DOMRectList)
    let rightKeys = 0
    native.addEventListener('keydown', event => { if (event.key === 'ArrowRight') rightKeys += 1 })

    const range = resolveReasoningIntensityRange(dom.window.document, 'session')!
    expect(range).toMatchObject({ min: '0', max: '4', step: '1', value: '1' })
    expect(range.dataset.cordisxReasoningProxy).toBe('true')
    expect(dom.window.document.querySelector<HTMLElement>('[data-model-picker-power-slider]')?.style.height).toBe('32px')
    expect(dom.window.document.querySelector<HTMLElement>('[role="menu"]')?.style.width).toBe('300px')

    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({ ...visibleRect, right: 298, bottom: 52, width: 288, height: 32 })
    const projection = new ReasoningIntensityProjection(dom.window.document)
    const text = (key: string) => ({ key, fallback: key })
    projection.update(range, {
      variant: 'imperium', motion: 'ascension', title: text('Intensity'), stages: [
        { label: text('Plastic'), material: 'plastic' }, { label: text('Bronze'), material: 'bronze' },
        { label: text('Steel'), material: 'steel' }, { label: text('Silver'), material: 'silver' },
        { label: text('Gold'), material: 'gold' },
      ],
    }, 'Intensity', ['Plastic', 'Bronze', 'Steel', 'Silver', 'Gold'])
    range.value = '4'
    range.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expect(rightKeys).toBe(3)
    expect(dom.window.document.querySelector<HTMLElement>('.cordisx-reasoning-thumb')?.style.left).toBe('264px')

    projection.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-reasoning-proxy]')).toBeNull()
    expect(dom.window.document.querySelector<HTMLElement>('[data-model-picker-power-slider]')?.style.height).toBe('40px')
    expect(dom.window.document.querySelector<HTMLElement>('[role="menu"]')?.style.width).toBe('')
    dom.window.close()
  })

  it('adapts the current native reasoning menu into a reversible range', () => {
    const dom = new JSDOM(`<body><div role="menu" id="menu"><div id="items">
      <div>Reasoning intensity</div>
      <div role="menuitem">Low</div><div role="menuitem">Medium</div>
      <div role="menuitem">High<svg></svg></div><div role="menuitem">Extra high</div>
      <div role="menuitem">Extra high<span>Faster usage</span></div>
    </div></div></body>`)
    const menu = dom.window.document.getElementById('menu') as HTMLElement
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const visibleRect = {
      x: 20, y: 30, left: 20, top: 30, right: 220, bottom: 230,
      width: 200, height: 200, toJSON: () => ({}),
    }
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(visibleRect)
    vi.spyOn(menu, 'getClientRects').mockReturnValue({ 0: visibleRect, length: 1, item: () => visibleRect } as DOMRectList)
    for (const item of items) {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(visibleRect)
      vi.spyOn(item, 'getClientRects').mockReturnValue({ 0: visibleRect, length: 1, item: () => visibleRect } as DOMRectList)
    }
    const selected = vi.spyOn(items[4]!, 'click')

    const range = resolveReasoningIntensityRange(dom.window.document, 'session')!
    expect(range).toMatchObject({ min: '0', max: '4', step: '1', value: '2' })
    expect(menu.style).toMatchObject({ width: '300px', minWidth: '300px' })
    expect(items.every(item => item.style.display === 'none')).toBe(true)
    vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
      x: 30, y: 50, left: 30, top: 50, right: 318, bottom: 82,
      width: 288, height: 32, toJSON: () => ({}),
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
    range.value = '4'
    range.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    range.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expect(selected).toHaveBeenCalledOnce()
    expect(dom.window.document.querySelector<HTMLElement>('.cordisx-reasoning-intensity')?.dataset.material).toBe('gold')

    projection.dispose()
    expect(items.every(item => item.style.display === '')).toBe(true)
    expect(menu.style.width).toBe('')
    expect(menu.dataset.cordisxReasoningMenu).toBeUndefined()
    dom.window.close()
  })

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

describe('SessionBackdropProjection', () => {
  it('follows the native range, retains the last stage after the menu closes, and removes cleanly', () => {
    const dom = new JSDOM('<body><div id="root"><main id="main-surface" style="isolation:auto"><div data-app-shell-main-content-layout="thread-edge-scroll"></div><div id="native-content"></div><input id="range" type="range" min="0" max="4" value="0"></main></div></body>')
    const range = dom.window.document.getElementById('range') as HTMLInputElement
    const projection = new SessionBackdropProjection(dom.window.document)
    const text = (key: string) => ({ key, fallback: key })
    const portrait = (data: string, key: string) => ({ mediaType: 'image/png' as const, data, alt: text(key) })
    const presentation = {
      variant: 'imperium' as const, driver: 'reasoning-intensity' as const, motion: 'ascension' as const,
      stages: [
        { material: 'plastic' as const, ambience: 'dormant' as const, portrait: portrait('cGxhc3RpYw==', 'plastic') },
        { material: 'gold' as const, ambience: 'imperial' as const, portrait: portrait('Z29sZA==', 'gold') },
      ],
    }
    projection.update('session-a', range, presentation, ['Plastic portrait', 'Gold portrait'])
    const root = dom.window.document.querySelector<HTMLElement>('.cordisx-session-backdrop')!
    const host = dom.window.document.getElementById('main-surface')!
    expect(root.parentElement).toBe(host)
    expect(host.firstElementChild).toBe(root)
    expect(host.style.isolation).toBe('isolate')
    expect(root.dataset).toMatchObject({ material: 'plastic', ambience: 'dormant', stage: '0', peak: 'false', portrait: 'true', effects: 'true' })
    expect(root.style.pointerEvents).toBe('')
    expect(root.getAttribute('aria-hidden')).toBe('true')

    range.value = '4'
    range.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(root.dataset).toMatchObject({ material: 'gold', ambience: 'imperial', stage: '1', peak: 'true', portraitLabel: 'Gold portrait' })
    expect(root.querySelector<HTMLImageElement>('img[data-active="true"]')?.src).toBe('data:image/png;base64,Z29sZA==')

    projection.update('session-a', undefined, presentation, ['Plastic portrait', 'Gold portrait'])
    expect(root.dataset.stage).toBe('1')
    projection.dispose()
    expect(root.isConnected).toBe(false)
    expect(host.style.isolation).toBe('auto')
    dom.window.close()
  })

  it('mounts only the backdrop layers requested by the structured presentation', () => {
    const dom = new JSDOM('<body><div id="root"><main><div data-app-shell-main-content-layout="thread-edge-scroll"></div></main></div></body>')
    const projection = new SessionBackdropProjection(dom.window.document)
    const text = (key: string) => ({ key, fallback: key })
    const stages = [
      { material: 'plastic' as const, ambience: 'dormant' as const, portrait: { mediaType: 'image/png' as const, data: 'cGxhc3RpYw==', alt: text('plastic') } },
      { material: 'gold' as const, ambience: 'imperial' as const, portrait: { mediaType: 'image/png' as const, data: 'Z29sZA==', alt: text('gold') } },
    ]

    projection.update('session-a', undefined, {
      variant: 'imperium', driver: 'reasoning-intensity', layers: { portrait: false, effects: true }, stages,
    }, ['Plastic portrait', 'Gold portrait'])
    const root = dom.window.document.querySelector<HTMLElement>('.cordisx-session-backdrop')!
    expect(root.dataset).toMatchObject({ portrait: 'false', effects: 'true' })
    expect(root.querySelector('.cordisx-session-backdrop-architecture')).not.toBeNull()
    expect(root.querySelector('.cordisx-session-backdrop-glow')).not.toBeNull()
    expect(root.querySelector('.cordisx-session-backdrop-portrait')).toBeNull()

    projection.update('session-a', undefined, {
      variant: 'imperium', driver: 'reasoning-intensity', layers: { portrait: true, effects: false }, stages,
    }, ['Plastic portrait', 'Gold portrait'])
    expect(root.dataset).toMatchObject({ portrait: 'true', effects: 'false' })
    expect(root.querySelector('.cordisx-session-backdrop-architecture')).toBeNull()
    expect(root.querySelector('.cordisx-session-backdrop-glow')).toBeNull()
    expect(root.querySelectorAll('.cordisx-session-backdrop-portrait')).toHaveLength(2)

    projection.dispose()
    dom.window.close()
  })
})
