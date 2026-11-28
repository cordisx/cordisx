import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { createManagerRendererManagementChannel } from '../packages/cli/src/cli/manager-renderer-management.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

const secret = () => randomBytes(32).toString('hex')
const payload = (operation: unknown) =>
  JSON.stringify({
    version: 1,
    requestId: secret(),
    token: 'renderer-token',
    profileId: 'fixture',
    operation,
  })

it('permits mutations only for an admitted renderer and fences a lost write', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => {
    finish = resolve
  })
  const service = {
    query: vi.fn(async () => ({ profileId: 'fixture' })),
    plan: vi.fn(async () => ({ status: 'planned' })),
    execute: vi.fn(async () => await pending),
  } as unknown as PluginManagementService
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['plugin-management', createManagerRendererManagementChannel(service)]]),
    participant: {
      create({ handle, browserSessionId }) {
        return new ManagerRendererCommandPeer({
          scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'fixture', generation: 'generation' },
          identity: {
            appId: 'codex',
            adapterId: 'manager',
            rendererId: handle.rendererId,
            pid: gateway.pid,
            processStartedAt: gateway.processStartedAt,
          },
          sessionId: browserSessionId,
        })
      },
      attach: async () => {},
    },
  })
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    expect(await authority.call(invocation, 'plugin-management', payload({ kind: 'query' }))).toMatchObject({
      status: 'ok',
      value: { ok: true, value: { profileId: 'fixture' } },
    })
    expect(await authority.call(invocation, 'plugin-management', payload({ kind: 'query', extra: true })))
      .toEqual({ status: 'unavailable' })
    const plan = { kind: 'plan', request: { kind: 'plugin-enable', pluginId: 'demo' } }
    expect(await authority.call(invocation, 'plugin-management', payload(plan))).toEqual({ status: 'unavailable' })
    expect(service.plan).not.toHaveBeenCalled()
    expect(await authority.admit(invocation)).toMatchObject({ status: 'ok' })
    expect(await authority.call(invocation, 'plugin-management', payload(plan))).toMatchObject({
      status: 'ok',
      value: { ok: true, value: { status: 'planned' } },
    })
    const write = authority.call(
      invocation,
      'plugin-management',
      payload({
        kind: 'execute',
        request: { kind: 'plugin-enable', pluginId: 'demo' },
        expectedRevision: 1,
      }),
    )
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalledOnce())
    const closing = authority.close(invocation)
    finish({ status: 'applied' })
    expect(await write).toEqual({ status: 'unknown' })
    expect(await closing).toBe(false)
    expect(service.execute).toHaveBeenCalledOnce()
  } finally {
    authority.dispose()
  }
})

it('routes a lifecycle review as a write only for an admitted renderer', async () => {
  const review = vi.fn(async (_operation, requestId) => ({ requestId, ok: true, value: { status: 'applied' } }))
  const channel = createManagerRendererManagementChannel({} as PluginManagementService, undefined, review)
  const context = {
    profileId: 'fixture',
    rendererId: secret(),
    ownerGeneration: 'generation',
    signal: new AbortController().signal,
    admitted: true,
  }
  const token = 'renderer-review-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const operation = { kind: 'plugin-review-apply', reviewToken: token, decision: {}, proof: {} }
  const prepared = channel.prepare(payload(operation), context)
  expect(prepared.mode).toBe('write')
  expect(await prepared.dispatch()).toMatchObject({ ok: true, value: { status: 'applied' } })
  expect(review).toHaveBeenCalledOnce()
  expect(() => channel.prepare(payload(operation), { ...context, admitted: false })).toThrow()
  expect(() => channel.prepare(payload({ ...operation, extra: true }), context)).toThrow()
})
