import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { CordisXSlotService } from '../src/renderer/service.js'

describe('CordisXSlotService', () => {
  it('owns a DSH-style slot registration on the calling plugin fiber', async () => {
    const dom = new JSDOM(`
      <html><head></head><body>
        <header class="app-header-tint"><div class="ms-auto flex items-center"></div></header>
      </body></html>
    `)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value: () => ({ length: 1 }),
    })
    vi.stubGlobal('document', dom.window.document)

    const ctx = new Context()
    const service = ctx.plugin(CordisXSlotService)
    let disposals = 0

    try {
      await service
      const plugin = ctx.plugin({
        inject: ['slots'],
        apply(pluginCtx: Context) {
          pluginCtx.slots.inject('header.actions', () => pluginCtx.slots.register({
            name: 'header.actions',
            id: 'fiber-owned',
          }, ({ container }) => {
            container.textContent = 'mounted'
            return () => { disposals += 1 }
          }))
        },
      })

      await plugin
      expect(dom.window.document.querySelector('[data-cordisx-contribution="fiber-owned"]')?.textContent).toBe('mounted')

      await plugin.dispose()
      expect(dom.window.document.querySelector('[data-cordisx-contribution="fiber-owned"]')).toBeNull()
      expect(disposals).toBe(1)
      expect(dom.window.document.getElementById('cordisx-base-style')).not.toBeNull()
    } finally {
      await service.dispose()
      vi.unstubAllGlobals()
      dom.window.close()
    }
  })
})
