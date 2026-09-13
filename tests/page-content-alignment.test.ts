import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { projectPageContentAlignment } from '../packages/cli/src/renderer/page-content-alignment.js'

test('projects fractional borders, root padding and changing header anchors; cancels after disposal', () => {
  const dom = new JSDOM('<div id="content"><div id="leading"></div><div id="title"></div><div id="body"></div></div>')
  const window = dom.window
  const document = window.document
  const content = document.getElementById('content')!
  const body = document.getElementById('body')!
  const leading = document.getElementById('leading')!
  const title = document.getElementById('title')!
  let refresh: () => void = () => {}
  const disconnect = vi.fn()
  Object.assign(window, {
    ResizeObserver: class {
      constructor(callback: () => void) {
        refresh = callback
      }
      observe() {}
      disconnect = disconnect
    },
  })
  let frame: FrameRequestCallback | undefined
  window.requestAnimationFrame = callback => {
    frame = callback
    return 1
  }
  window.cancelAnimationFrame = () => {
    frame = undefined
  }
  let titleLeft = 282
  let leadingLeft = 248
  body.style.cssText = 'border-left:0.5px solid;padding-left:16px'
  body.getBoundingClientRect = () => ({ left: 240, width: 500 } as DOMRect)
  leading.getBoundingClientRect = () => ({ left: leadingLeft, width: 28 } as DOMRect)
  title.getBoundingClientRect = () => ({ left: titleLeft, width: 100 } as DOMRect)
  const dispose = projectPageContentAlignment(content, body, { leading, title })
  frame?.(0)
  expect(body.style.getPropertyValue('--cordisx-page-content-title-inset')).toBe('25.5px')
  expect(body.style.getPropertyValue('--cordisx-page-content-leading-center')).toBe('5.5px')
  body.style.paddingLeft = '0px'
  titleLeft = 270
  leadingLeft = 236
  refresh()
  frame?.(0)
  expect(body.style.getPropertyValue('--cordisx-page-content-title-inset')).toBe('29.5px')
  expect(body.style.getPropertyValue('--cordisx-page-content-leading-center')).toBe('9.5px')
  refresh()
  dispose()
  expect(frame).toBeUndefined()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(body.style.getPropertyValue('--cordisx-page-content-title-inset')).toBe('')
  refresh()
  expect(frame).toBeUndefined()
  dom.window.close()
})
