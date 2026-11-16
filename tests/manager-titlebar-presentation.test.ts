import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { managerTitlebarPresentationRight } from '../packages/cli/src/renderer/adapter/manager-titlebar-presentation.js'

describe('Manager titlebar presentation boundary', () => {
  it('reclaims measured page actions without crossing the native end boundary', () => {
    const document = new JSDOM('<header><div id="slot"></div><div id="actions"><button>Share</button></div></header>', {
      url: 'https://example.test/',
    }).window.document
    const header = document.querySelector('header')!
    const slot = document.querySelector<HTMLElement>('#slot')!
    const actions = document.querySelector<HTMLElement>('#actions')!
    const button = actions.querySelector('button')!
    const rect = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 40, width: right - left, height: 40 }) as DOMRect
    header.getBoundingClientRect = () => rect(0, 300)
    actions.getBoundingClientRect = () => rect(180, 260)
    button.getBoundingClientRect = () => rect(190, 250)
    expect(managerTitlebarPresentationRight(header, slot, [actions], 170, 240)).toBe(240)

    const other = document.createElement('button')
    other.getBoundingClientRect = () => rect(220, 230)
    header.append(other)
    expect(managerTitlebarPresentationRight(header, slot, [actions], 170, 240)).toBe(170)
    other.remove()
    button.getBoundingClientRect = () => rect(0, 0)
    expect(managerTitlebarPresentationRight(header, slot, [actions], 170, 240)).toBe(170)
  })
})
