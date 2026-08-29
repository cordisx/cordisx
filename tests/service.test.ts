import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CordisXSlotService } from '../packages/cli/src/renderer/surfaces.js'

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

  it('atomically projects a fiber-owned navigation collection and fences stale or late updates', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    let state = {
      revision: 1,
      items: [
        { id: 'older', label: { key: 'older', fallback: 'Older' }, route: { id: 'room', params: { roomId: 'older' } }, order: 20 },
        { id: 'latest', label: { key: 'latest', fallback: 'Latest' }, route: { id: 'room', params: { roomId: 'latest' } }, order: 10 },
      ],
    }
    const listeners = new Set<() => void>()
    let sourceDisposed = false
    const pluginContext = ctx.extend({ [CORDISX_PLUGIN_ID]: 'chatroom' })
    const plugin = pluginContext.plugin({
      inject: ['slots'],
      apply(pluginCtx: Context) {
        pluginCtx.slots.registerCollection({
          name: 'sidebar.navigation.items', id: 'rooms',
          group: { id: 'rooms', label: { key: 'rooms', fallback: 'Rooms' }, order: 20 },
        }, {
          snapshot: () => state,
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
          dispose: () => { sourceDisposed = true },
        })
      },
    })
    await plugin
    expect(service.navigationCollectionGroupsSnapshot()).toEqual([expect.objectContaining({
      owner: 'chatroom', id: 'rooms', label: { key: 'rooms', fallback: 'Rooms' }, order: 20,
    })])
    expect(service.snapshot().map(item => ({
      group: item.group,
      label: (item.item as { label: { fallback: string } }).label.fallback,
      route: (item.item as { route: unknown }).route,
    }))).toEqual([
      { group: 'navcol.1', label: 'Latest', route: { id: 'room', params: { roomId: 'latest' } } },
      { group: 'navcol.1', label: 'Older', route: { id: 'room', params: { roomId: 'older' } } },
    ])

    state.items[0]!.label.fallback = 'Caller mutation'
    expect((service.snapshot()[1]!.item as { label: { fallback: string } }).label.fallback).toBe('Older')
    let publications = 0
    const unsubscribe = service.subscribeInternal(() => { publications += 1 })
    state = {
      revision: 2,
      items: [
        { id: 'new-room', label: { key: 'new-room', fallback: 'New room' }, route: { id: 'room', params: { roomId: 'new-room' } }, order: 0 },
        { id: 'latest', label: { key: 'latest', fallback: 'Latest' }, route: { id: 'room', params: { roomId: 'latest' } }, order: 10 },
      ],
    }
    for (const listener of [...listeners]) listener()
    expect(publications).toBe(1)
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual(['New room', 'Latest'])

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    state = {
      revision: 2,
      items: [{ id: 'forged', label: { key: 'forged', fallback: 'Forged' }, route: { id: 'room', params: { roomId: 'forged' } }, order: 0 }],
    }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual(['New room', 'Latest'])
    error.mockRestore()

    await plugin.dispose()
    expect(service.snapshot()).toEqual([])
    expect(service.navigationCollectionGroupsSnapshot()).toEqual([])
    expect(listeners.size).toBe(0)
    expect(sourceDisposed).toBe(true)
    unsubscribe()
    await serviceFiber.dispose()
  })
})
