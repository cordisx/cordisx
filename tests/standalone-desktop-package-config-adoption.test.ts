import Schema from '@deepseek-ai/schemastery'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginConfigurationRegistry } from '../packages/cli/src/renderer/configuration.js'
import { adoptStandaloneDesktopPackageConfig } from '../packages/cli/src/renderer/standalone-desktop-package-config-adoption.js'
import { BrowserStandaloneDesktopPackageConfigBridge } from '../packages/cli/src/renderer/standalone-desktop-package-config-binding.js'

const update = {
  requestId: 'other-page',
  pluginId: 'demo',
  expectedRevision: 1,
  revision: 2,
  origin: false,
  operations: [{ op: 'set' as const, path: ['label'], value: 'new' }],
  value: { label: 'new' },
}

function fixture(operation: Promise<unknown> = Promise.resolve()) {
  const bridge = new BrowserStandaloneDesktopPackageConfigBridge('renderer-binding-placeholder')
  const registry = new PluginConfigurationRegistry()
  registry.register({
    identity: { id: 'demo', source: 'https://example.test/demo' },
    schema: Schema.object({ label: Schema.string() }),
    applies: 'live',
    raw: { label: 'old' },
    revision: 1,
    writable: true,
  })
  const watcher = vi.fn()
  registry.watch('demo', watcher)
  const metadata = {
    hostKind: 'standalone',
    standaloneDesktopPackageConfig: { token: 'renderer-binding-placeholder', plugins: ['demo'] },
  }
  const notify = vi.fn()
  const scope = {
    disposed: false,
    metadata: () => metadata,
    standaloneDesktopPackageConfigBridge: () => bridge,
    operation,
    configuration: () => registry,
    activeController: () => (id: string) => id === 'demo' ? {} : undefined,
    notify: () => notify,
  }
  return { bridge, registry, scope, watcher, notify }
}

afterEach(() => {
  globalThis.__cordisxDesktopPackageConfigRequestV1 = undefined
  globalThis.__cordisxDesktopPackageConfigReceiveV1 = undefined
})

it('adopts a confirmed peer value in the live registry and notifies the plugin', async () => {
  const f = fixture()
  try {
    expect(await adoptStandaloneDesktopPackageConfig(f.scope as never, update)).toBe(true)
    expect(f.registry.descriptor('demo', 'en')).toMatchObject({ revision: 2, value: { label: 'new' } })
    expect(f.watcher).toHaveBeenCalledExactlyOnceWith({ label: 'new' })
    expect(f.notify).toHaveBeenCalledOnce()
    expect(await adoptStandaloneDesktopPackageConfig(f.scope as never, update)).toBe(false)
  } finally {
    f.bridge.dispose()
    f.registry.dispose()
  }
})

it('rejects a peer value that does not match the locally validated operations', async () => {
  const f = fixture()
  try {
    expect(await adoptStandaloneDesktopPackageConfig(f.scope as never, { ...update, value: { label: 'other' } }))
      .toBe(false)
    expect(f.registry.descriptor('demo', 'en')).toMatchObject({ revision: 1, value: { label: 'old' } })
    expect(f.watcher).not.toHaveBeenCalled()
  } finally {
    f.bridge.dispose()
    f.registry.dispose()
  }
})

it('blocks a new local save while earlier local work drains for peer adoption', async () => {
  let finish!: () => void
  const waiting = new Promise<void>(resolve => finish = resolve)
  const f = fixture(waiting)
  const send = vi.fn()
  globalThis.__cordisxDesktopPackageConfigRequestV1 = send
  try {
    const adopting = adoptStandaloneDesktopPackageConfig(f.scope as never, update)
    await expect(f.bridge.request('demo', 1, update.operations, { raw: update.value, value: update.value }, () => {}))
      .rejects.toThrow('configuration is unavailable')
    expect(send).not.toHaveBeenCalled()
    finish()
    expect(await adopting).toBe(true)
  } finally {
    finish()
    f.bridge.dispose()
    f.registry.dispose()
  }
})
