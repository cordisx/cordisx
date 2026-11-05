import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneModelProviderDisplay, modelProviderDisplays } from '../packages/cli/src/model-provider-display.js'
import { modelProviderDisplayExpression } from '../packages/cli/src/renderer/adapter/model-provider-display.js'
import { createTerminalProviderAuthority } from '../packages/cli/src/launcher/terminal-provider.js'
import { RemoteTerminalProviderClient } from '../packages/cli/src/launcher/remote-terminal-provider-client.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const display = {
  providerId: 'example-service',
  title: 'Example service',
  icon: {
    kind: 'raster-image',
    image: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
      contract: 'cordisx.raster-image-snapshot/v1',
      schemaVersion: 1,
      mediaType: 'image/png',
      encoding: 'base64',
      data: PNG,
      width: 1,
      height: 1,
    },
  },
} as const
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('owner selector presentation forwarding', () => {
  it('detaches bounded artwork and rejects raw URLs, wrong identity and ambiguous duplicates', () => {
    const clone = cloneModelProviderDisplay(display)
    expect(clone.icon).toEqual(display.icon)
    expect(clone.icon).not.toBe(display.icon)
    expect(Object.isFrozen(clone)).toBe(true)
    expect(modelProviderDisplays([
      display,
      display,
      { ...display, providerId: 'other', icon: 'https://example.com/icon.png' },
      { ...display, providerId: 'third', token: 'not-allowed' },
    ])).toEqual([])
    expect(() => cloneModelProviderDisplay({ ...display, title: '\n' })).toThrow()
  })

  it('reads the actual mounted registry through a serialized probe and fences its runtime generation', () => {
    const dom = new JSDOM(
      '<!doctype html><html data-cordisx-ready="true"><body><div class="cxmp-selector"></div></body></html>',
      { runScripts: 'outside-only' },
    )
    cleanups.push(() => dom.window.close())
    let generation = 'generation-one'
    Object.assign(dom.window, {
      __cordisxRuntime: { activePluginGeneration: () => ({ profileId: 'work', runtimeGeneration: generation }) },
    })
    const node = dom.window.document.querySelector('.cxmp-selector')!
    Object.assign(node, {
      __reactFiber$test: {
        return: { memoizedProps: { registry: { snapshot: () => ({ providers: [display] }) }, transport: {} } },
      },
    })
    const expression = modelProviderDisplayExpression({ profileId: 'work', runtimeGeneration: 'generation-one' })
    expect(dom.window.eval(expression)).toEqual([display])
    generation = 'generation-two'
    expect(dom.window.eval(expression)).toEqual([])
    generation = 'generation-one'
    dom.window.document.documentElement.dataset.cordisxReady = 'false'
    expect(dom.window.eval(expression)).toEqual([])
  })

  it('does not choose an ambiguous registry when two different selector owners are mounted', () => {
    const dom = new JSDOM(
      '<!doctype html><html data-cordisx-ready="true"><body><div class="cxmp-selector"></div><div class="cxmp-selector"></div></body></html>',
      { runScripts: 'outside-only' },
    )
    cleanups.push(() => dom.window.close())
    Object.assign(dom.window, {
      __cordisxRuntime: { activePluginGeneration: () => ({ profileId: 'work', runtimeGeneration: 'one' }) },
    })
    for (const node of dom.window.document.querySelectorAll('.cxmp-selector')) {
      Object.assign(node, {
        __reactFiber$test: {
          memoizedProps: { registry: { snapshot: () => ({ providers: [display] }) }, transport: {} },
        },
      })
    }
    expect(dom.window.eval(modelProviderDisplayExpression())).toEqual([])
  })

  it('carries a generic plugin icon over authority, remote catalog and renderer while preserving remote ownership', async () => {
    let current = [cloneModelProviderDisplay(display)]
    let available = true
    const prepare = vi.fn(async () => {
      throw new Error('No credentials during discovery')
    })
    const authority = createTerminalProviderAuthority({
      catalog: async () =>
        available
          ? [{
            providerId: display.providerId,
            pluginId: 'actual-plugin',
            models: [{ id: 'model', label: 'Model', aliases: [] }],
          }]
          : [],
      display: async () => current,
      owns: id => id === display.providerId,
      resolve: () => {
        throw new Error('No service session during discovery')
      },
      credentials: { prepare, close: async () => undefined },
    })
    cleanups.push(() => authority.close())
    const remote = new RemoteTerminalProviderClient({ homeDir: '/not-used', profileId: 'work' }, {
      connect: async () => request => authority.request(request),
    })
    cleanups.push(() => remote.close())
    const registry = new ModelProviderRegistry(remote.catalog)
    cleanups.push(() => registry.dispose())
    await remote.refresh()
    const rows = await remote.catalog()
    expect(rows[0]).toMatchObject({
      providerId: display.providerId,
      pluginId: 'remote-terminal-provider',
      managementOwner: 'remote',
      display,
    })
    await registry.refresh()
    expect(registry.snapshot().providers[0]).toMatchObject({ title: display.title, icon: display.icon })
    expect(prepare).not.toHaveBeenCalled()
    current = [
      cloneModelProviderDisplay({ ...display, title: 'Changed', icon: 'host:info', selectorBrand: 'deepseek' }),
    ]
    await remote.refresh()
    await registry.refresh()
    expect(registry.snapshot().providers[0]).toMatchObject({
      title: 'Changed',
      icon: 'host:info',
      selectorBrand: 'deepseek',
    })
    available = false
    await remote.refresh()
    await registry.refresh()
    expect(registry.snapshot().providers).toEqual([])
  })

  it('keeps legacy fallback when presentation is missing or unavailable and never leaks a mismatched id', async () => {
    const remote = new RemoteTerminalProviderClient({ homeDir: '/not-used', profileId: 'work' }, {
      connect: async () => async () => ({
        kind: 'list',
        providers: [{
          providerId: 'legacy',
          title: 'Legacy',
          managed: true,
          models: [{ id: 'm', label: 'M' }],
          display,
        }],
      }),
    })
    cleanups.push(() => remote.close())
    const registry = new ModelProviderRegistry(remote.catalog)
    cleanups.push(() => registry.dispose())
    await remote.refresh()
    await registry.refresh()
    expect((await remote.catalog())[0]).not.toHaveProperty('display')
    expect(registry.snapshot().providers[0]).toMatchObject({
      providerId: 'legacy',
      title: 'Legacy',
      icon: 'host:settings',
    })
  })

  it('retains local owner presentation and explicit override precedence above remote display', async () => {
    const registry = new ModelProviderRegistry(
      async () => [{
        providerId: display.providerId,
        pluginId: 'local-plugin',
        display: cloneModelProviderDisplay(display),
        selectorBrand: { brand: 'generic', source: 'override' },
        models: [],
      }],
    )
    cleanups.push(() => registry.dispose())
    const local = registry.bind('local-plugin', 'local-generation', () => true)
    cleanups.push(() => local.dispose())
    local.facade.present({ providerId: display.providerId, title: 'Local presentation', icon: 'host:info' })
    await registry.refresh()
    expect(registry.snapshot().providers[0]).toMatchObject({
      title: 'Local presentation',
      icon: 'host:info',
      selectorBrand: 'generic',
    })
    local.dispose()
    expect(registry.snapshot().providers[0]).toMatchObject({
      title: display.title,
      icon: display.icon,
      selectorBrand: 'generic',
    })
  })
})
