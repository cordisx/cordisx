import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../packages/cli/src/renderer/manager-content-config-form.tsx', () => ({
  mountManagerContentConfigForm: (container: HTMLElement) => {
    const body = container.ownerDocument.createElement('div')
    body.dataset.managerContentConfigHost = 'true'
    container.append(body)
    return () => body.remove()
  },
}))
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXLocalizationSeat,
} from '../packages/cli/src/contracts.js'
import { PluginConfigurationRegistry } from '../packages/cli/src/renderer/configuration.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import type { CordisXI18nService, LocalizationEffectOwner } from '../packages/cli/src/renderer/i18n.js'
import { ManagerContentConfigAuthority } from '../packages/cli/src/renderer/manager-content-config.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import { TestCodexRouteHistory } from './helpers/codex-route-history.js'

const previous = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

function fakeI18n(): CordisXI18nService {
  return {
    getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 0 }),
    resolveFor(_owner: string, message: { key: string; fallback?: string }) {
      return { text: message.fallback ?? message.key, namespace: 'chatroom', key: message.key }
    },
    clearDiagnosticSite() {}, subscribeInternal: () => () => {},
    seatFor(owner: string, namespace: string | undefined, own: LocalizationEffectOwner): CordisXLocalizationSeat {
      return {
        namespace: `${owner}:${namespace ?? owner}`, t: key => String(key),
        message: (key, params) => ({ key, ...(params === undefined ? {} : { params }) }),
        getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 0 }),
        subscribe: listener => own(() => { void listener; return () => {} }),
        effect: setup => own(() => setup({ locale: 'en', direction: 'ltr', version: 0 })),
        bindText: () => own(() => () => {}), bindAttribute: () => own(() => () => {}),
      }
    },
  } as unknown as CordisXI18nService
}

describe('Manager navigation v4 Host config body', () => {
  it('replaces the plugin page body and closes the exact binding on declaration disposal', async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="manager"></main></body></html>', { url: 'https://host.test/' })
    Object.assign(globalThis, {
      window: dom.window, document: dom.window.document,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: false,
    })
    const activation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, schemaVersion: 1 as const, recordKind: 'active' as const,
      profileId: 'default', revision: 1, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{ id: 'chatroom', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` as const, moduleGeneration: 'chatroom-g1', enabled: true, dependencies: [] }],
    }
    const visibility = new GenerationVisibilityCoordinator(activation)
    const configuration = new PluginConfigurationRegistry(visibility)
    configuration.register({
      identity: { id: 'chatroom', source: 'file:///chatroom.ts' }, moduleGeneration: 'chatroom-g1',
      schema: Schema.object({ shortcutPolicy: Schema.union([Schema.const('enter'), Schema.const('mod-enter')]).default('enter') }),
      applies: 'live', raw: {}, revision: 0, writable: true,
    })
    const authority = new ManagerContentConfigAuthority({
      configuration, profileId: 'default', runtimeGeneration: 'runtime-1', locale: () => 'en',
      update: async (owner, revision, operations) => {
        const candidate = configuration.stage(owner, revision, operations)
        configuration.commit(owner, revision + 1, candidate)
      },
    })
    const pages = new PageRegistry(visibility)
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory(), new HostContextStore())
    outlets.declare({
      schemaVersion: 1, id: 'manager.content', authority: 'host-adapter', scope: 'manager',
      preferredPlacement: 'absolute', contextPolicy: 'generation', presentationGroup: 'manager',
    }, {
      getSnapshot: () => ({ available: true, container: dom.window.document.getElementById('manager')!, placement: 'absolute' }),
      subscribe: () => () => {}, show: () => {}, hide: () => {},
    }, value => value.startsWith('/manager/extensions/'))
    navigation.setManagerContentConfigFactory(input => authority.bind(input))
    const context = new Context().extend({ [CORDISX_PLUGIN_ID]: 'chatroom', [CORDISX_PLUGIN_GENERATION]: 'chatroom-g1' })
    const pluginMount = vi.fn(() => () => {})
    pages.register(context, {
      $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'settings',
      title: { key: 'settings.title', fallback: 'Settings' },
      description: { key: 'settings.description', fallback: 'Chat settings' },
      icon: 'host:settings', chrome: 'standard',
    }, pluginMount)
    navigation.register(context, {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'settings',
      path: '/manager/extensions/chatroom/settings', outlet: 'manager.content', page: 'settings',
      title: { key: 'settings.title', fallback: 'Settings' },
      description: { key: 'settings.description', fallback: 'Chat settings' },
    })
    expect(() => navigation.managerContent.register(context, {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v3.schema.json',
      schemaVersion: 4, id: 'wrong-schema', route: { id: 'settings' }, header: { title: { kind: 'route' } },
    } as never)).toThrow('unsupported schema tuple')
    let source = undefined as ReturnType<ManagerContentConfigAuthority['bind']> | undefined
    navigation.setManagerContentConfigFactory.bind // retains the exact public Host seam in coverage
    // The first factory is authoritative; capture through the declaration record.
    const unregister = navigation.managerContent.register(context, {
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4, schemaVersion: 4,
      id: 'settings', route: { id: 'settings' }, header: { title: { kind: 'route' } },
      body: {
        kind: 'plugin-config-form', namespace: 'chatroom',
        defaultMaterialization: { mode: 'missing-only', fields: [{ path: ['shortcutPolicy'], value: 'enter' }] },
      },
    })
    source = navigation.managerContent.resolve('chatroom', { id: 'settings' })?.config
    expect(source).toBeDefined()
    expect(navigation.managerContentPresentation('chatroom', { id: 'settings' })?.config?.source.binding.namespace).toBe('chatroom')

    const container = dom.window.document.getElementById('manager')!
    const mount = await navigation.mountManagerContent('chatroom', { id: 'settings' }, 'chatroom:settings', container)
    expect(pluginMount).not.toHaveBeenCalled()
    expect(container.querySelector('[data-manager-content-config-host="true"]')).not.toBeNull()
    expect(configuration.descriptor('chatroom', 'en')).toMatchObject({ revision: 0, value: {} })

    const subscribed = await source!.source.subscribe(0)
    expect(subscribed.status).toBe('subscribed')
    unregister()
    if (subscribed.status === 'subscribed') {
      await expect(subscribed.subscription.closed).resolves.toMatchObject({ code: 'declaration-replaced' })
    }
    await mount.dispose()
    await navigation.dispose(); pages.dispose(); outlets.dispose(); configuration.dispose(); authority.dispose()
    await new Promise(resolve => setImmediate(resolve))
    dom.window.close()
  })
})
