import { Context } from '@deepseek-ai/cordis'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXNavigationCollectionSnapshot } from '../packages/cli/src/contracts.js'
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
    const leadAvatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' })
    let state: CordisXNavigationCollectionSnapshot = {
      revision: 1,
      items: [
        {
          id: 'older', label: { key: 'older', fallback: 'Older' }, route: { id: 'room', params: { roomId: 'older' } }, order: 20,
          leadingVisual: { kind: 'room-composite-avatar', participants: [] },
        },
        {
          id: 'latest', label: { key: 'latest', fallback: 'Latest' }, route: { id: 'room', params: { roomId: 'latest' } }, order: 10,
          leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'lead', avatar: leadAvatar }] },
        },
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
    const latestId = service.snapshot().find(item => (item.item as { label: { fallback?: string } }).label.fallback === 'Latest')!.qualifiedId
    const latestVisual = service.navigationCollectionLeadingVisual(latestId)!
    expect(latestVisual).toEqual({ kind: 'room-composite-avatar', participants: [{ participantId: 'lead', avatar: leadAvatar }] })
    expect(Object.isFrozen(latestVisual)).toBe(true)
    expect(Object.isFrozen(latestVisual.participants)).toBe(true)
    expect(Object.isFrozen(latestVisual.participants[0])).toBe(true)

    ;(state.items[0]!.label as { fallback: string }).fallback = 'Caller mutation'
    ;(state.items[1]!.leadingVisual!.participants[0] as { participantId: string }).participantId = 'mutated'
    expect((service.snapshot()[1]!.item as { label: { fallback: string } }).label.fallback).toBe('Older')
    expect(service.navigationCollectionLeadingVisual(latestId)?.participants[0]?.participantId).toBe('lead')
    let publications = 0
    const unsubscribe = service.subscribeInternal(() => { publications += 1 })
    state = {
      revision: 2,
      items: [
        {
          id: 'new-room', label: { key: 'new-room', fallback: 'New room' }, route: { id: 'room', params: { roomId: 'new-room' } }, order: 0,
          leadingVisual: { kind: 'room-composite-avatar', participants: [] },
        },
        {
          id: 'latest', label: { key: 'latest', fallback: 'Latest' }, route: { id: 'room', params: { roomId: 'latest' } }, order: 10,
          leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'lead', avatar: leadAvatar }] },
        },
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

    state = {
      revision: 3,
      items: [{
        id: 'unsafe', label: { key: 'unsafe', fallback: 'Unsafe' }, route: { id: 'room', params: { roomId: 'unsafe' } }, order: 0,
        leadingVisual: {
          kind: 'room-composite-avatar',
          participants: [{ participantId: 'unsafe', avatar: { kind: 'asset', ref: 'https://unsafe.invalid/avatar.png' } as never }],
        },
      }],
    }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenLastCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual(['New room', 'Latest'])
    expect(service.navigationCollectionLeadingVisual(latestId)?.participants[0]?.participantId).toBe('lead')

    state = {
      revision: 3,
      items: [{
        id: 'oversized', label: { key: 'oversized', fallback: 'Oversized' }, route: { id: 'room', params: { roomId: 'oversized' } }, order: 0,
        leadingVisual: {
          kind: 'room-composite-avatar',
          participants: Array.from({ length: 17 }, (_, index) => ({ participantId: `participant-${index}` })),
        },
      }],
    }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenLastCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual(['New room', 'Latest'])

    state = {
      revision: 3,
      items: [{
        id: 'duplicate', label: { key: 'duplicate', fallback: 'Duplicate' }, route: { id: 'room', params: { roomId: 'duplicate' } }, order: 0,
        leadingVisual: {
          kind: 'room-composite-avatar',
          participants: [{ participantId: 'same' }, { participantId: 'same' }],
        },
      }],
    }
    for (const listener of [...listeners]) listener()
    expect(error).toHaveBeenLastCalledWith('[cordisx] navigation collection update failed', expect.any(Error))
    expect(service.snapshot().map(item => (item.item as { label: { fallback: string } }).label.fallback)).toEqual(['New room', 'Latest'])
    error.mockRestore()

    await plugin.dispose()
    expect(service.snapshot()).toEqual([])
    expect(service.navigationCollectionGroupsSnapshot()).toEqual([])
    expect(service.navigationCollectionLeadingVisual(latestId)).toBeUndefined()
    expect(listeners.size).toBe(0)
    expect(sourceDisposed).toBe(true)
    unsubscribe()
    await serviceFiber.dispose()
  })

  it('keeps identical collection item and room ids isolated by exact owner-qualified row identity', async () => {
    const ctx = new Context()
    const serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    const service = ctx.slots as CordisXSlotService
    service.setResolvers({ command: () => true, route: () => true })
    const mount = (owner: string, participantId: string) => ctx.extend({ [CORDISX_PLUGIN_ID]: owner }).plugin({
      inject: ['slots'],
      apply(pluginCtx: Context) {
        pluginCtx.slots.registerCollection({
          name: 'sidebar.navigation.items', id: 'rooms',
          group: { id: 'rooms', label: { key: 'rooms', fallback: 'Rooms' } },
        }, {
          snapshot: () => ({
            revision: 1,
            items: [{
              id: 'same-room', label: { key: 'same-room', fallback: 'Same room' }, order: 0,
              route: { id: 'room', params: { roomId: 'same-room' } },
              leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId }] },
            }],
          }),
          subscribe: () => () => undefined,
        })
      },
    })
    const first = mount('chatroom-a', 'lead-a')
    const second = mount('chatroom-b', 'lead-b')
    await Promise.all([first, second])
    const firstRow = service.snapshot().find(row => row.owner === 'chatroom-a')!
    const secondRow = service.snapshot().find(row => row.owner === 'chatroom-b')!
    expect(firstRow.qualifiedId).not.toBe(secondRow.qualifiedId)
    expect(service.navigationCollectionLeadingVisual(firstRow.qualifiedId)?.participants[0]?.participantId).toBe('lead-a')
    expect(service.navigationCollectionLeadingVisual(secondRow.qualifiedId)?.participants[0]?.participantId).toBe('lead-b')

    await first.dispose()
    expect(service.navigationCollectionLeadingVisual(firstRow.qualifiedId)).toBeUndefined()
    expect(service.navigationCollectionLeadingVisual(secondRow.qualifiedId)?.participants[0]?.participantId).toBe('lead-b')
    await second.dispose()
    await serviceFiber.dispose()
  })
})
