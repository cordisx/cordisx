import { describe, expect, it, vi } from 'vitest'
import type { ManagerSettingsNavigationItemSnapshot } from '../packages/cli/src/renderer/manager.js'
import {
  HostManagerNavigationController,
  resolveHostManagerAgentDefinitionOpenRequest,
} from '../packages/cli/src/renderer/manager/navigation-controller.js'
import type { ManagerContentAgentDefinitionTarget } from '../packages/cli/src/renderer/navigation.js'

function item(overrides: Partial<ManagerSettingsNavigationItemSnapshot> = {}): ManagerSettingsNavigationItemSnapshot {
  return {
    id: 'chatroom:team', owner: 'chatroom', group: 'before-settings', order: 10,
    disabled: false, title: 'Team Architecture', description: 'Entities',
    pageTitle: 'Team Architecture', pageDescription: 'Entities', icon: 'host:layers',
    route: { id: 'team', params: { profile: 'work', view: 'entities' } },
    ...overrides,
  }
}

function target(overrides: Partial<ManagerContentAgentDefinitionTarget> = {}): ManagerContentAgentDefinitionTarget {
  return {
    owner: 'chatroom', generation: { pluginId: 'chatroom', moduleGeneration: 'g1' },
    identity: { agentId: 'lead', revision: 'sha256:r1' },
    parent: { id: 'team', params: { view: 'entities', profile: 'work' } },
    route: { id: 'entity-overview', params: { entityId: 'lead' } },
    ...overrides,
  }
}

describe('Host Manager exact Agent-definition navigation', () => {
  it('matches an exact same-owner root independent of parameter property order', () => {
    expect(resolveHostManagerAgentDefinitionOpenRequest(target(), [item()])).toEqual({
      contributionId: 'chatroom:team',
      root: { id: 'team', params: { view: 'entities', profile: 'work' } },
      target: { id: 'entity-overview', params: { entityId: 'lead' } },
    })
  })

  it('fails closed for missing roots, disabled roots, cross-owner roots, and duplicate claims', () => {
    expect(resolveHostManagerAgentDefinitionOpenRequest(undefined, [item()])).toBeUndefined()
    expect(resolveHostManagerAgentDefinitionOpenRequest(target({ parent: undefined }), [item()])).toBeUndefined()
    expect(resolveHostManagerAgentDefinitionOpenRequest(target(), [item({ disabled: true })])).toBeUndefined()
    expect(resolveHostManagerAgentDefinitionOpenRequest(target(), [item({ owner: 'other' })])).toBeUndefined()
    expect(resolveHostManagerAgentDefinitionOpenRequest(target(), [item(), item({ id: 'chatroom:duplicate' })])).toBeUndefined()
  })

  it('delivers one cloned request to the single Manager modal binding', () => {
    const controller = new HostManagerNavigationController()
    const listener = vi.fn()
    const dispose = controller.bind(listener)
    expect(() => controller.bind(vi.fn())).toThrow(/already bound/)
    const request = resolveHostManagerAgentDefinitionOpenRequest(target(), [item()])!
    controller.openManagerContent(request)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]![0]).toEqual(request)
    expect(listener.mock.calls[0]![0]).not.toBe(request)
    dispose()
    expect(() => controller.openManagerContent(request)).toThrow(/unavailable/)
  })
})
