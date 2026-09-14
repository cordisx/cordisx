import { expect, it, vi } from 'vitest'
import type { RuntimeClosureScope } from '../packages/cli/src/renderer/runtime-closure-scope.js'
import {
  developmentReloadAvailable,
  requestRuntimePluginLifecycle,
} from '../packages/cli/src/renderer/runtime-development-reload.js'

function fixture() {
  const reload = vi.fn(async (_id: string) => undefined)
  const request = vi.fn(async () => ({ outcome: 'applied' }))
  const controller = { status: 'active', item: { development: { origin: 'local-dev' } } }
  const metadata: { developmentReloadPlugin?: typeof reload } = { developmentReloadPlugin: reload }
  const scope = {
    metadata: () => metadata,
    activeController: () => (id: string) => id === 'demo' ? controller : undefined,
    lifecycleBridge: () => ({ request }),
    currentActivation: { profileId: 'development', runtimeGeneration: 'runtime', revision: 3 },
  } as unknown as RuntimeClosureScope
  return { scope, controller, metadata, request, reload }
}

it('uses the callback only for an active selected local-development reload', async () => {
  const { scope, reload, request } = fixture()
  expect(developmentReloadAvailable(scope, 'demo')).toBe(true)
  expect(await requestRuntimePluginLifecycle(scope, { kind: 'reload', pluginId: 'demo' })).toMatchObject({
    outcome: 'applied',
    operation: 'reload',
    scope: 'plugin-generation',
    affectedPluginIds: ['demo'],
    revision: 3,
  })
  expect(reload).toHaveBeenCalledWith('demo')
  expect(request).not.toHaveBeenCalled()
})

it('preserves the package bridge for unknown ids, inactive plugins and other operations', async () => {
  const { scope, controller, reload, request } = fixture()
  await requestRuntimePluginLifecycle(scope, { kind: 'reload', pluginId: 'unknown' })
  controller.status = 'failed'
  expect(developmentReloadAvailable(scope, 'demo')).toBe(false)
  await requestRuntimePluginLifecycle(scope, { kind: 'reload', pluginId: 'demo' })
  await requestRuntimePluginLifecycle(scope, { kind: 'enable', pluginId: 'demo' })
  expect(request).toHaveBeenCalledTimes(3)
  expect(reload).not.toHaveBeenCalled()
})

it('does not advertise development reload when no Vite callback exists', () => {
  const { scope, metadata } = fixture()
  delete metadata.developmentReloadPlugin
  expect(developmentReloadAvailable(scope, 'demo')).toBe(false)
})

it('reports a failed Vite reload instead of fabricating an applied lifecycle result', async () => {
  const { scope, reload } = fixture()
  reload.mockRejectedValueOnce(new Error('Vite plugin rollback failed; updates paused'))
  expect(await requestRuntimePluginLifecycle(scope, { kind: 'reload', pluginId: 'demo' })).toMatchObject({
    outcome: 'rejected',
    error: { code: 'activation-failed', message: 'Vite plugin rollback failed; updates paused' },
  })
})
