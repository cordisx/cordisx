import { describe, expect, it, vi } from 'vitest'
import { mutateChannelConnectionConfiguration } from '../packages/cli/src/renderer/channel-connection-configuration.js'

describe('Host exact connection configuration writes', () => {
  it('keeps keys on ordinary updates and rejects stale, invalid or absent targets before any mutation', async () => {
    const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const other = { ref: { ...account, accountId: 'cli_other' }, secretRef: 'other', displayName: 'Other' }
    const descriptor = {
      writable: true,
      revision: 7,
      identity: {},
      scope: {},
      configuration: {
        contract: 'cordisx.channel-service-config/v2',
        schemaVersion: 2,
        connections: [{ ref: account, secretRef: 'same', displayName: 'Before' }, other],
      },
    } as never
    const mutate = vi.fn(async (_request: unknown) => ({ status: 'applied', revision: 8 }) as never)
    const input = {
      descriptor,
      account,
      patch: { displayName: 'After', selectors: ['direct', 'mentions'] },
      expectedRevision: 7,
      live: () => true,
      mutate,
    }
    expect(await mutateChannelConnectionConfiguration(input)).toMatchObject({ status: 'applied', revision: 8 })
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 7,
      configuration: {
        connections: [
          { ref: account, displayName: 'After', secretRef: 'same', selectors: ['direct', 'mentions'] },
          other,
        ],
      },
    })
    mutate.mockClear()
    expect(await mutateChannelConnectionConfiguration({ ...input, expectedRevision: 6 })).toMatchObject({
      status: 'conflict',
    })
    expect(await mutateChannelConnectionConfiguration({ ...input, patch: { displayName: '' } })).toMatchObject({
      status: 'rejected',
    })
    expect(await mutateChannelConnectionConfiguration({ ...input, account: { ...account, accountId: 'missing' } }))
      .toMatchObject({ code: 'TARGET_UNAVAILABLE' })
    expect(mutate).not.toHaveBeenCalled()
  })
})
