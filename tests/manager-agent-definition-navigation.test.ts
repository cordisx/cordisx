import { describe, expect, it, vi } from 'vitest'
import type { ManagerSettingsNavigationItemSnapshot } from '../packages/cli/src/renderer/manager.js'
import {
  HostManagerNavigationController,
  resolveHostManagerAgentDefinitionOpenRequest,
  resolveHostManagerRouteOpenRequest,
} from '../packages/cli/src/renderer/manager/navigation-controller.js'
import type { ManagerContentAgentDefinitionTarget } from '../packages/cli/src/renderer/navigation.js'

function item(overrides: Partial<ManagerSettingsNavigationItemSnapshot> = {}): ManagerSettingsNavigationItemSnapshot {
  return {
    id: 'chatroom:team',
    owner: 'chatroom',
    group: 'before-settings',
    order: 10,
    disabled: false,
    title: 'Team Architecture',
    description: 'Entities',
    pageTitle: 'Team Architecture',
    pageDescription: 'Entities',
    icon: 'host:layers',
    route: { id: 'team', params: { profile: 'work', view: 'entities' } },
    ...overrides,
  }
}

function target(overrides: Partial<ManagerContentAgentDefinitionTarget> = {}): ManagerContentAgentDefinitionTarget {
  return {
    owner: 'chatroom',
    generation: { pluginId: 'chatroom', moduleGeneration: 'g1' },
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
    expect(resolveHostManagerAgentDefinitionOpenRequest(target(), [item(), item({ id: 'chatroom:duplicate' })]))
      .toBeUndefined()
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

  it('captures one Host-owned return callback without exposing a plugin route or URL', () => {
    const controller = new HostManagerNavigationController()
    const restore = vi.fn()
    const dispose = controller.bindReturnPort({
      capture: () => [{ kind: 'manager-content', id: 'chatroom:team', reference: { id: 'sessions' } }],
      restore,
    })
    const captured = controller.captureReturn()
    expect(captured).toBeTypeOf('function')
    captured?.()
    expect(restore).toHaveBeenCalledWith([{
      kind: 'manager-content',
      id: 'chatroom:team',
      reference: { id: 'sessions' },
    }])
    dispose()
    expect(controller.captureReturn()).toBeUndefined()
  })
})

it('resolves same-owner public Manager roots and parent routes without foreign or disabled fallbacks', () => {
  const root = item({ route: { id: 'shop' } })
  expect(resolveHostManagerRouteOpenRequest('chatroom', { id: 'shop' }, [root], () => undefined))
    .toEqual({ contributionId: root.id, root: { id: 'shop' }, target: { id: 'shop' } })
  expect(resolveHostManagerRouteOpenRequest('chatroom', { id: 'detail' }, [root], () => ({ id: 'shop' })))
    .toMatchObject({ root: { id: 'shop' }, target: { id: 'detail' } })
  expect(resolveHostManagerRouteOpenRequest('foreign', { id: 'shop' }, [root], () => undefined)).toBeUndefined()
  expect(resolveHostManagerRouteOpenRequest('chatroom', { id: 'shop' }, [{ ...root, disabled: true }], value => value))
    .toBeUndefined()
})

it('resolves an exact same-owner root tab without inventing a parent route', () => {
  const root = item({ route: { id: 'pet.pets' } })
  const target = { id: 'pet.shop' }
  const tabs = () => [{ id: 'pet.pets' }, target]
  expect(resolveHostManagerRouteOpenRequest('chatroom', target, [root], () => undefined, tabs))
    .toEqual({ contributionId: root.id, root: root.route, target })
  expect(
    resolveHostManagerRouteOpenRequest(
      'chatroom',
      target,
      [root, item({ id: 'another', route: { id: 'other-root' } })],
      () => undefined,
      tabs,
    ),
  ).toBeUndefined()
  expect(resolveHostManagerRouteOpenRequest('foreign', target, [root], () => undefined, tabs)).toBeUndefined()
})
