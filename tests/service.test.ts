import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXNavigationCollectionSnapshotV3, RasterImageSnapshotV1 } from '../packages/cli/src/contracts.js'
import { CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CordisXSlotService } from '../packages/cli/src/renderer/surfaces.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const raster = (data = PNG): RasterImageSnapshotV1 => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
  contract: 'cordisx.raster-image-snapshot/v1',
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  data,
  width: 1,
  height: 1,
})
const visual = () => ({ kind: 'image' as const, image: raster() })

describe('CordisXSlotService', () => {
  it('owns a structured snapshot handle on the calling plugin fiber', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    const plugin = ctx.extend({ [CORDISX_PLUGIN_ID]: 'demo' }).plugin({
      inject: ['slots'],
      apply(pluginCtx: Context) {
        pluginCtx.slots.inject('sidebar.footer.before-control', () =>
          pluginCtx.slots.register({
            name: 'sidebar.footer.before-control',
            id: 'owned',
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
    expect(() => (ctx.slots.inject as (name: string, setup: () => void) => unknown)('shell.overlay', () => {})).toThrow(
      /direct-DOM slots were removed/,
    )
    await serviceFiber.dispose()
  })

  it('atomically projects generic collection images and fences invalid, stale, or late updates', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    let state: CordisXNavigationCollectionSnapshotV3 = {
      revision: 1,
      items: [
        {
          id: 'older',
          label: { key: 'older', fallback: 'Older' },
          route: { id: 'item', params: { id: 'older' } },
          order: 20,
          leadingVisual: visual(),
        },
        {
          id: 'latest',
          label: { key: 'latest', fallback: 'Latest' },
          route: { id: 'item', params: { id: 'latest' } },
          order: 10,
          leadingVisual: visual(),
        },
      ],
    }
    const listeners = new Set<() => void>()
    let sourceDisposed = false
    const plugin = ctx.extend({ [CORDISX_PLUGIN_ID]: 'demo' }).plugin({
      inject: ['slots'],
      apply(pluginCtx: Context) {
        pluginCtx.slots.registerCollection({
          name: 'sidebar.navigation.items',
          id: 'items',
          contract: 'cordisx.navigation-collection/v3',
          group: { id: 'items', label: { key: 'items', fallback: 'Items' }, order: 20 },
        }, {
          snapshot: () => state,
          subscribe: listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          dispose: () => {
            sourceDisposed = true
          },
        })
      },
    })
    await plugin
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual([
      'Latest',
      'Older',
    ])
    const latestId =
      service.snapshot().find(item => (item.item as { label: { fallback?: string } }).label.fallback === 'Latest')!
        .qualifiedId
    const accepted = service.navigationCollectionLeadingVisual(latestId)!
    expect(accepted).toEqual(visual())
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.image)).toBe(true)
    ;(state.items[1]!.leadingVisual!.image as { data: string }).data = 'mutated'
    expect(service.navigationCollectionLeadingVisual(latestId)?.image.data).toBe(PNG)

    let publications = 0
    const unsubscribe = service.subscribeInternal(() => {
      publications += 1
    })
    state = {
      revision: 2,
      items: [
        {
          id: 'new',
          label: { key: 'new', fallback: 'New' },
          route: { id: 'item', params: { id: 'new' } },
          order: 0,
          leadingVisual: visual(),
        },
        {
          id: 'latest',
          label: { key: 'latest', fallback: 'Latest' },
          route: { id: 'item', params: { id: 'latest' } },
          order: 10,
          leadingVisual: visual(),
        },
      ],
    }
    for (const listener of [...listeners]) listener()
    expect(publications).toBe(1)

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    state = {
      revision: 3,
      items: [{
        id: 'unsafe',
        label: { key: 'unsafe', fallback: 'Unsafe' },
        route: { id: 'item' },
        order: 0,
        leadingVisual: { kind: 'image', image: raster('PHN2Zy8+') },
      }],
    }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual([
      'New',
      'Latest',
    ])

    state = { revision: 2, items: [] }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenLastCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot()).toHaveLength(2)
    error.mockRestore()

    await plugin.dispose()
    for (const listener of [...listeners]) listener()
    expect(service.snapshot()).toEqual([])
    expect(service.navigationCollectionLeadingVisual(latestId)).toBeUndefined()
    expect(listeners.size).toBe(0)
    expect(sourceDisposed).toBe(true)
    unsubscribe()
    await serviceFiber.dispose()
  })

  it('isolates identical collection item ids by exact owner-qualified identity', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    const mount = (owner: string) =>
      ctx.extend({ [CORDISX_PLUGIN_ID]: owner }).plugin({
        inject: ['slots'],
        apply(pluginCtx: Context) {
          pluginCtx.slots.registerCollection({
            name: 'sidebar.navigation.items',
            id: 'items',
            contract: 'cordisx.navigation-collection/v3',
            group: { id: 'items', label: { key: 'items', fallback: 'Items' } },
          }, {
            snapshot: () => ({
              revision: 1,
              items: [{
                id: 'same',
                label: { key: 'same', fallback: 'Same' },
                order: 0,
                route: { id: 'item' },
                leadingVisual: visual(),
              }],
            }),
            subscribe: () => () => undefined,
          })
        },
      })
    const first = mount('demo-a')
    const second = mount('demo-b')
    await Promise.all([first, second])
    const firstRow = service.snapshot().find(row => row.owner === 'demo-a')!
    const secondRow = service.snapshot().find(row => row.owner === 'demo-b')!
    expect(firstRow.qualifiedId).not.toBe(secondRow.qualifiedId)
    expect(service.navigationCollectionLeadingVisual(firstRow.qualifiedId)?.image.data).toBe(PNG)
    expect(service.navigationCollectionLeadingVisual(secondRow.qualifiedId)?.image.data).toBe(PNG)
    await first.dispose()
    expect(service.navigationCollectionLeadingVisual(firstRow.qualifiedId)).toBeUndefined()
    expect(service.navigationCollectionLeadingVisual(secondRow.qualifiedId)?.image.data).toBe(PNG)
    await second.dispose()
    await serviceFiber.dispose()
  })
})
