import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CORDISX_PLUGIN_ID } from '../src/renderer/ownership.js'
import { CordisXSlotService } from '../src/renderer/surfaces.js'

describe('CordisXSlotService', () => {
  it('owns a structured snapshot handle on the calling plugin fiber', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    const pluginContext = ctx.extend({ [CORDISX_PLUGIN_ID]: 'demo' })
    const plugin = pluginContext.plugin({
      inject: ['slots'],
      apply(pluginCtx: Context) {
        pluginCtx.slots.inject('sidebar.footer.before-control', () => pluginCtx.slots.register({
          name: 'sidebar.footer.before-control', id: 'owned',
        }, { label: { key: 'owned' }, command: { id: 'open' } }))
      },
    })
    await plugin
    expect(service.snapshot()).toEqual([expect.objectContaining({ owner: 'demo', id: 'owned', valid: true })])

    await plugin.dispose()
    expect(service.snapshot()).toEqual([])
    await serviceFiber.dispose()
  })

  it('rejects every retired free-DOM slot name', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    expect(() => (ctx.slots.inject as (name: string, setup: () => void) => unknown)('shell.overlay', () => {})).toThrow(/direct-DOM slots were removed/)
    await serviceFiber.dispose()
  })
})
