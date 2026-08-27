import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { MarkdownDocument } from '../packages/cli/src/renderer/manager/components/MarkdownDocument.js'

describe('React Manager Markdown document', () => {
  it('sanitizes media while preserving GitHub theme pictures, images, and controlled video', async () => {
    const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="root"></div></body></html>', { url: 'https://host.invalid/' })
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      MutationObserver: globalThis.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<MarkdownDocument source={[
        '<picture>',
        '  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.example/dark.svg">',
        '  <source media="(prefers-color-scheme: light)" srcset="https://cdn.example/light.svg">',
        '  <img alt="Theme logo" src="https://cdn.example/light.svg">',
        '</picture>',
        '',
        '![Screenshot](https://cdn.example/screenshot.png)',
        '',
        '<video src="https://cdn.example/demo.webm"></video>',
        '<script>alert(1)</script>',
      ].join('\n')} />))
      const document = dom.window.document
      expect(document.querySelectorAll('picture source')).toHaveLength(2)
      expect(document.querySelector('picture source')?.getAttribute('media')).toBe('all')
      expect(document.querySelectorAll('img')).toHaveLength(2)
      expect(document.querySelector('video')?.hasAttribute('controls')).toBe(true)
      expect(document.querySelector('script')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
