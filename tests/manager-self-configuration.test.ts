import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { CordisXManagerSelfConfigurationService } from '../packages/cli/src/renderer/manager-self-configuration.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

it('opens only the current calling plugin configuration and fails closed across lifecycle changes', async () => {
  const context = new Context()
  let available = true
  let caller: ReturnType<Context['extend']> | undefined
  const resolve = vi.fn(() => {
    if (resolve.mock.calls.length === 2) void caller?.dispose()
    return available
  })
  const open = vi.fn()
  const service = context.plugin(CordisXManagerSelfConfigurationService, { resolve, open })
  await service

  let manager!: typeof context.manager
  caller = context.extend({
    [CORDISX_PLUGIN_ID]: 'gateway',
    [CORDISX_PLUGIN_SOURCE]: 'file:///gateway',
    [CORDISX_PLUGIN_GENERATION]: 'gateway-g1',
  })
  const consumer = caller.plugin(Object.assign((ctx: Context) => {
    manager = ctx.manager
  }, { inject: ['manager'] }))
  await consumer

  expect(await manager.openOwnPluginConfiguration()).toBe('opened')
  expect(resolve).toHaveBeenCalledExactlyOnceWith('gateway')
  expect(open).toHaveBeenCalledExactlyOnceWith('gateway')

  expect(await manager.openOwnPluginConfiguration()).toBe('unavailable')
  expect(open).toHaveBeenCalledTimes(1)

  await service.dispose()
  expect(await manager.openOwnPluginConfiguration()).toBe('unavailable')
})

it('does not report opened for ineligible or rejecting Manager receivers', async () => {
  const context = new Context()
  let available = false
  const open = vi.fn(() => {
    throw new Error('Manager receiver unavailable')
  })
  const service = context.plugin(CordisXManagerSelfConfigurationService, {
    resolve: () => available,
    open,
  })
  await service
  let manager!: typeof context.manager
  const caller = context.extend({
    [CORDISX_PLUGIN_ID]: 'gateway',
    [CORDISX_PLUGIN_SOURCE]: 'file:///gateway',
    [CORDISX_PLUGIN_GENERATION]: 'gateway-g1',
  }).plugin(Object.assign((ctx: Context) => {
    manager = ctx.manager
  }, { inject: ['manager'] }))
  await caller

  expect(await manager.openOwnPluginConfiguration()).toBe('unavailable')
  expect(open).not.toHaveBeenCalled()
  available = true
  expect(await manager.openOwnPluginConfiguration()).toBe('unavailable')
  expect(open).toHaveBeenCalledExactlyOnceWith('gateway')
})
