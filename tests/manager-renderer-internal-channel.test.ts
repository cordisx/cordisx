import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'

it('keeps the bootstrap channel private while requiring the authenticated renderer grant', async () => {
  const secret = () => randomBytes(32).toString('hex')
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['manager-bootstrap', { prepare: () => ({ mode: 'read', dispatch: async () => ({ current: true }) }) }],
    ]),
  })
  try {
    const browserSessionId = secret()
    const opened = await dispatchManagerRendererOperation(authority, {
      kind: 'manager-renderer',
      action: 'open',
      gateway,
      browserSessionId,
    }) as { status: string; channels: string[]; handle: { rendererId: string; grant: string; ownerGeneration: string } }
    expect(opened.channels).toEqual(['plugin-management'])
    const invocation = { gateway, browserSessionId, handle: opened.handle }
    expect(await authority.call(invocation, 'manager-bootstrap', { action: 'status' }))
      .toEqual({ status: 'ok', value: { current: true } })
    expect(
      await authority.call({ ...invocation, handle: { ...opened.handle, grant: secret() } }, 'manager-bootstrap', {}),
    )
      .toEqual({ status: 'unavailable' })
  } finally {
    authority.dispose()
  }
})

it('keeps ordinary requests available while multiple owned observations are waiting', async () => {
  const secret = () => randomBytes(32).toString('hex')
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let finish!: () => void
  const pending = new Promise<void>(resolve => {
    finish = resolve
  })
  const started = vi.fn()
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    channels: new Map([['fixture', {
      prepare: value =>
        value === 'observe'
          ? {
            mode: 'read' as const,
            channelConfigurationIndependent: true as const,
            longLivedRead: true as const,
            dispatch: async () => {
              started()
              await pending
              return 'event'
            },
          }
          : { mode: 'read' as const, dispatch: async () => 'query' },
    }]]),
  })
  const calls: Promise<unknown>[] = []
  try {
    const browserSessionId = secret()
    const handle = (await authority.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    for (let index = 0; index < 8; index++) {
      calls.push(authority.call(invocation, 'fixture', 'observe'))
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(index + 1))
    }
    expect(await authority.call(invocation, 'fixture', 'query')).toEqual({ status: 'ok', value: 'query' })
    let retired = false
    const retirement = authority.close(invocation).then(value => {
      retired = true
      return value
    })
    await Promise.resolve()
    expect(retired).toBe(false)
    finish()
    await Promise.all(calls)
    expect(await retirement).toBe(true)
  } finally {
    finish()
    await Promise.all(calls)
    authority.dispose()
  }
})
