import { expect, it, vi } from 'vitest'
import { mountStartupPlugins, PluginActivationFailure } from '../packages/cli/src/renderer/runtime-startup-plugins.js'
import type { PluginController } from '../packages/cli/src/renderer/runtime-shared.js'

function controller(status = 'active'): PluginController {
  return { status } as PluginController
}

it('continues only after a cleaned-up activation failure and keeps its failed status', async () => {
  const failed = controller(), healthy = controller(), blocked = controller('blocked')
  const cause = new Error('plugin dependencies are unavailable: managedServices')
  const mount = vi.fn(async item => {
    if (item === failed) {
      item.status = 'failed'
      item.error = cause.message
      throw new PluginActivationFailure(cause)
    }
  })
  await mountStartupPlugins([failed, healthy, blocked], mount)
  expect(mount.mock.calls.map(([item]) => item)).toEqual([failed, healthy])
  expect(failed).toMatchObject({ status: 'failed', error: cause.message })
  expect(new PluginActivationFailure(cause).cause).toBe(cause)
})

it.each(['host setup failed', 'plugin cleanup failed'])(
  'propagates %s instead of claiming readiness',
  async message => {
    const error = new Error(message)
    const mount = vi.fn(async () => {
      throw error
    })
    await expect(mountStartupPlugins([controller(), controller()], mount)).rejects.toBe(error)
    expect(mount).toHaveBeenCalledTimes(1)
  },
)

it('does not swallow cancellation during plugin activation', async () => {
  const abort = new AbortController()
  const error = new Error('startup canceled')
  const mount = vi.fn(async () => {
    abort.abort(error)
    throw new PluginActivationFailure(error)
  })
  await expect(mountStartupPlugins([controller(), controller()], mount, abort.signal)).rejects.toBe(error)
  expect(mount).toHaveBeenCalledTimes(1)
})
