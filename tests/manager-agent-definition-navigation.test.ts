import { describe, expect, it, vi } from 'vitest'
import type { ManagerSettingsNavigationItemSnapshot } from '../packages/cli/src/renderer/manager.js'
import {
  createHostManagerSelfConfigurationNavigationOptions,
  HostManagerNavigationController,
  resolveHostManagerAgentDefinitionOpenRequest,
  resolveHostManagerRouteOpenRequest,
  resolveHostManagerSelfConfigurationRoute,
} from '../packages/cli/src/renderer/manager/navigation-controller.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
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

function configurablePlugin(
  overrides: Partial<ManagerPluginSnapshot> = {},
): ManagerPluginSnapshot {
  return {
    id: 'gateway',
    source: 'file:///gateway',
    name: 'Gateway',
    inject: [],
    config: {},
    status: 'active',
    configuration: {
      namespace: 'gateway',
      schemaKind: 'schemastery',
      applies: 'live',
      writable: true,
      revision: 1,
      lastGoodRevision: 1,
      value: { endpoint: 'http://localhost' },
      fields: [{
        namespace: 'gateway',
        path: ['endpoint'],
        type: 'string',
        value: 'http://localhost',
        disabled: false,
        required: true,
      }],
      secrets: [],
    },
    ...overrides,
  }
}

function selfConfigurationModel(
  plugins: readonly ManagerPluginSnapshot[],
): Pick<ManagerModel, 'snapshot' | 'updatePluginConfig'> {
  return {
    snapshot: () => ({ plugins }) as ManagerSnapshot,
    updatePluginConfig: async () => {},
  }
}

describe('Host Manager self-configuration navigation', () => {
  it('accepts only one active, writable and actionable installed configuration', () => {
    const plugin = configurablePlugin()
    const model = selfConfigurationModel([plugin])
    expect(resolveHostManagerSelfConfigurationRoute('gateway', model)).toEqual({
      kind: 'plugin',
      pluginId: 'gateway',
      page: 'config',
    })
    expect(resolveHostManagerSelfConfigurationRoute('missing', model)).toBeUndefined()
    expect(resolveHostManagerSelfConfigurationRoute(
      'gateway',
      selfConfigurationModel([
        plugin,
        configurablePlugin({ source: 'file:///duplicate' }),
      ]),
    )).toBeUndefined()
    expect(resolveHostManagerSelfConfigurationRoute(
      'gateway',
      selfConfigurationModel([{ ...plugin, status: 'configured-disabled' }]),
    )).toBeUndefined()
    expect(resolveHostManagerSelfConfigurationRoute(
      'gateway',
      selfConfigurationModel([{
        ...plugin,
        configuration: { ...plugin.configuration, writable: false },
      }]),
    )).toBeUndefined()
    expect(resolveHostManagerSelfConfigurationRoute(
      'gateway',
      selfConfigurationModel([{
        ...plugin,
        configuration: {
          ...plugin.configuration,
          fields: plugin.configuration.fields.map(field => ({
            ...field,
            disabled: true,
          })),
        },
      }]),
    )).toBeUndefined()
    expect(resolveHostManagerSelfConfigurationRoute('gateway', {
      snapshot: model.snapshot,
    })).toBeUndefined()
  })

  it('rechecks eligibility at dispatch and throws for rejected, unbound, or disposed routes', () => {
    let plugins: readonly ManagerPluginSnapshot[] = [configurablePlugin()]
    const model: Pick<ManagerModel, 'snapshot' | 'updatePluginConfig'> = {
      snapshot: () => ({ plugins }) as ManagerSnapshot,
      updatePluginConfig: async () => {},
    }
    const controller = new HostManagerNavigationController()
    const options = createHostManagerSelfConfigurationNavigationOptions(model, controller)
    expect(options.resolve('gateway')).toBe(true)
    expect(() => options.open('gateway')).toThrow(/Manager is unavailable/)

    const listener = vi.fn()
    const dispose = controller.bind(listener)
    options.open('gateway')
    expect(listener).toHaveBeenLastCalledWith({ kind: 'plugin', pluginId: 'gateway', page: 'config' })

    plugins = [{ ...configurablePlugin(), status: 'configured-disabled' }]
    expect(() => options.open('gateway')).toThrow(/configuration is unavailable/)
    expect(listener).toHaveBeenCalledTimes(1)

    plugins = [configurablePlugin()]
    dispose()
    expect(() => options.open('gateway')).toThrow(/Manager is unavailable/)
  })
})
