import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { projectNativePageHeaderLayout } from '../packages/cli/src/renderer/adapter/page-header-layout.js'
import { createPageHeaderChrome } from '../packages/cli/src/renderer/page-header-chrome.js'

function rect(x: number, width: number, height = 46): DOMRect {
  return { x, y: 0, left: x, top: 0, width, height, right: x + width, bottom: height, toJSON: () => ({}) } as DOMRect
}
describe('native page header layout projection', () => {
  it('aligns against fractional main origin and native typography while the title group is empty', () => {
    const dom = new JSDOM(`<body>
      <header data-app-shell-application-menu-bar><button data-app-shell-sidebar-trigger><svg></svg></button></header>
      <div data-testid="app-shell-header-context-menu-surface" style="padding-left:8px;column-gap:6px;line-height:24px">
        <div class="text-base" style="font-size:14px;font-weight:500;font-family:system-ui"></div>
      </div><main><section></section></main></body>`)
    const document = dom.window.document
    const main = document.querySelector('main')!
    const layer = document.querySelector('section')!
    const surface = document.querySelector<HTMLElement>('[data-testid]')!
    let origin = 240.5
    main.getBoundingClientRect = () => rect(origin, 1200)
    surface.getBoundingClientRect = () => rect(origin - .5, 1100)
    document.querySelector('button')!.getBoundingClientRect = () => rect(88, 28, 28)
    document.querySelector('svg')!.getBoundingClientRect = () => rect(94, 16, 16)
    projectNativePageHeaderLayout(document, main, layer)
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-leading-inset')).toBe('7.5px')
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-action-size')).toBe('28px')
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-title-gap')).toBe('6px')
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-title-font-size')).toBe('14px')
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-title-font-weight')).toBe('500')
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-title-line-height')).toBe('24px')
    origin = 320.5
    projectNativePageHeaderLayout(document, main, layer)
    expect(layer.style.getPropertyValue('--cordisx-page-chrome-leading-inset')).toBe('7.5px')
    const { chrome, title } = createPageHeaderChrome(layer)
    expect(layer.style.getPropertyValue('--cordisx-page-title-inset')).toContain('calc(')
    expect(chrome.style.borderBottomWidth).toBe('')
    expect(chrome.style.boxShadow).toContain('inset')
    expect(title.style.lineHeight).toContain('--cordisx-page-chrome-title-line-height')
    dom.window.close()
  })
})
