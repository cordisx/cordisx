import { describe, expect, it, vi } from 'vitest'
import type { HostNavigationCollectionAction } from '../packages/cli/src/renderer/host-ui/NavigationCollectionActions.js'
import { SelectedNavigationActionRegistry } from '../packages/cli/src/renderer/selected-navigation-actions.js'

function action(id: string): HostNavigationCollectionAction {
  return {
    id,
    label: id,
    ariaLabel: id,
    placement: 'overflow',
    tone: 'neutral',
    pressed: false,
    disabled: false,
    success: 'done',
    failure: 'failed',
    invoke: async () => undefined,
  }
}

describe('SelectedNavigationActionRegistry', () => {
  it('publishes only one exact same-owner route and fails closed on ambiguity or disposal', () => {
    const registry = new SelectedNavigationActionRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const actions = [action('pin')]
    const selected = {
      owner: 'chatroom',
      itemId: 'chatroom:rooms:room-1',
      route: { id: 'room', params: { roomId: 'room-1' } },
      actions,
    } as const
    registry.replace([selected])
    expect(registry.selected('chatroom', { id: 'room', params: { roomId: 'room-1' } })?.actions).toBe(actions)
    expect(registry.isSelected('chatroom', selected.itemId, selected.route)).toBe(true)
    expect(registry.selected('foreign', selected.route)).toBeUndefined()
    expect(registry.selected('chatroom', { id: 'room', params: { roomId: 'room-2' } })).toBeUndefined()

    registry.replace([
      selected,
      { ...selected, itemId: 'chatroom:rooms:duplicate', actions: [action('archive')] },
    ])
    expect(registry.selected('chatroom', selected.route)).toBeUndefined()
    expect(registry.isSelected('chatroom', selected.itemId, selected.route)).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    registry.dispose()
    registry.replace([selected])
    expect(registry.selected('chatroom', selected.route)).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
