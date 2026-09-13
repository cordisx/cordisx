import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { isolateRuntimeOwnerServices } from '../packages/cli/src/renderer/runtime-owner-context.js'
import { createPluginHttpClients } from '../packages/cli/src/renderer/plugin-http.js'
import type { LocalWorkSettlementV1 } from '@cordisx/protocol/local-work-settlement/v1'

it('isolates real Cordis settlement registrations and disposal across two mounted owners', async () => {
  const root = new Context()
  const ownerA = isolateRuntimeOwnerServices(root)
  const ownerB = isolateRuntimeOwnerServices(root)
  const callsA = vi.fn(async () => ({ status: 'unavailable', code: 'connection-unavailable' }))
  const callsB = vi.fn(async () => ({ status: 'unavailable', code: 'connection-unavailable' }))
  const make = (request: typeof callsA) =>
    createPluginHttpClients({
      active: () => true,
      authorizeWork: async () => true,
      principal: { token: 'private-principal' } as never,
      bridge: { request } as never,
    })
  const a = make(callsA), b = make(callsB)
  const closeA = ownerA.reflect.provide('workSettlement', a.workSettlement)
  const closeB = ownerB.reflect.provide('workSettlement', b.workSettlement)
  const binding = {
    origin: 'http://127.0.0.1:3000',
    sourceId: 's',
    instanceId: 'i',
    audience: 'local-work-income',
  } as const
  const serviceA = ownerA.get('workSettlement') as LocalWorkSettlementV1
  const serviceB = ownerB.get('workSettlement') as LocalWorkSettlementV1
  expect(root.get('workSettlement')).toBeUndefined()
  await serviceA.settle(binding)
  expect(callsA).toHaveBeenCalledTimes(1)
  expect(callsB).not.toHaveBeenCalled()
  a.http.dispose()
  await closeA()
  expect(ownerA.get('workSettlement')).toBeUndefined()
  expect(await serviceA.settle(binding)).toMatchObject({ code: 'stale-generation' })
  await serviceB.settle(binding)
  expect(callsB).toHaveBeenCalledTimes(1)
  expect(callsB.mock.calls[0]).toEqual([
    'private-principal',
    expect.objectContaining({ operation: 'plugin-http-settle-local-work' }),
    35_000,
  ])
  b.http.dispose()
  await closeB()
})
