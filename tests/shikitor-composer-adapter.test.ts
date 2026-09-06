import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import type { Shikitor } from '@shikitor/core'
import { syncNativeTextRendering } from '../packages/cli/src/renderer/host-ui/conversation/ShikitorComposerAdapter.js'

describe('Shikitor composer native-text mode', () => {
  it('shows the resident textarea only for less-dom and clears it for projection modes', () => {
    const dom = new JSDOM('<textarea></textarea>')
    const input = dom.window.document.querySelector('textarea')!
    const element = dom.window.document.createElement('div')
    const editor = { element } as Shikitor

    element.dataset.shikitorRenderMode = 'less-dom'
    syncNativeTextRendering(input, editor)
    expect(input.dataset.cordisxShikitorNativeText).toBe('true')

    element.dataset.shikitorRenderMode = 'projection-dom'
    syncNativeTextRendering(input, editor)
    expect(input.hasAttribute('data-cordisx-shikitor-native-text')).toBe(false)
  })
})
