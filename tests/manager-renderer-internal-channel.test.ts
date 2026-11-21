import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
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
