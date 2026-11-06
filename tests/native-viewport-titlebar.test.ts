import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveNativeViewportTitlebarOwner } from '../packages/cli/src/renderer/adapter/native-viewport-titlebar.js'
import { placeNativeViewportTitlebar } from './helpers/native-viewport-titlebar.js'

function fixture() {
  const document = new JSDOM('<!doctype html><body><header style="position:fixed"></header></body>').window.document
  const header = document.querySelector('header')!
  header.getClientRects = () => ({ length: 1 }) as DOMRectList
  header.getBoundingClientRect = () =>
    (
      { left: 0, top: 0, right: 1719, bottom: 44, width: 1719, height: 44 }
    ) as DOMRect
  return { document, header }
}

describe('native viewport titlebar positioning', () => {
  it('preserves the fixed header and recognizes the native absolute viewport without writes', () => {
    const { document, header } = fixture()
    expect(resolveNativeViewportTitlebarOwner(header)).toEqual({ position: 'fixed' })
    const { frame, surface } = placeNativeViewportTitlebar(header)
    const before = document.body.innerHTML
    expect(resolveNativeViewportTitlebarOwner(header)).toEqual({ position: 'absolute', frame, surface })
    expect(document.body.innerHTML).toBe(before)
  })

  it('rejects absolute content headers without the native viewport composition', () => {
    const { header } = fixture()
    header.style.position = 'absolute'
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    const { frame, surface } = placeNativeViewportTitlebar(header)
    surface.removeAttribute('data-app-shell-page-surface')
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    surface.dataset.appShellPageSurface = 'true'
    surface.style.display = 'block'
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    surface.style.display = 'contents'
    frame.style.position = 'static'
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    frame.style.position = 'relative'
    expect(resolveNativeViewportTitlebarOwner(header)).toBeDefined()
    surface.dataset.appShellHeaderPlacement = 'unrelated'
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
  })

  it('rejects a scrolled, resized, or detached viewport instead of accepting absolute positioning alone', () => {
    const { header } = fixture()
    const { frame } = placeNativeViewportTitlebar(header)
    const initial = frame.getBoundingClientRect()
    frame.getBoundingClientRect = () => ({ ...initial, top: -20, bottom: initial.bottom - 20 }) as DOMRect
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    frame.getBoundingClientRect = () => ({ ...initial, width: 800, right: 800 }) as DOMRect
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
    frame.getBoundingClientRect = () => initial
    header.remove()
    expect(resolveNativeViewportTitlebarOwner(header)).toBeUndefined()
  })
})
