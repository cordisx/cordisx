import { describe, expect, it, vi } from 'vitest'
import { mutateChannelConnectionConfiguration } from '../packages/cli/src/renderer/channel-connection-configuration.js'
import { createChannelHostServiceConfigContract } from '../packages/channel-runtime/src/config.js'
import { isManagerChannelFormMutation } from '../packages/cli/src/cli/manager-channel-config-scope.js'

describe('Host exact connection configuration writes', () => {
  it('upgrades a v1 configuration on save while preserving unrelated connections and private references', async () => {
    const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const other = { adapterId: 'feishu', accountId: 'cli_other', tenantId: 'fixture' }
    const connection = (ref: typeof account) => ({
      ref,
      adapterKind: 'feishu',
      enabled: true,
      transport: { mode: 'websocket' },
    })
    const stored = {
      contract: 'cordisx.channel-service-config/v1',
      schemaVersion: 1,
      connections: [
        { ...connection(account), secretRef: 'host-secret:env/FIXTURE_ONE' },
        { ...connection(other), secretRef: 'host-secret:env/FIXTURE_TWO' },
      ],
    }
    const descriptor = {
      writable: true,
      revision: 7,
      identity: {},
      scope: {},
      configuration: { ...stored, connections: [connection(account), connection(other)] },
    } as never
    const mutate = vi.fn(async (_request: unknown) => ({ status: 'applied', revision: 8 }) as never)
    expect(
      await mutateChannelConnectionConfiguration({
        descriptor,
        account,
        patch: { displayName: 'After', selectors: ['direct'] },
        expectedRevision: 7,
        live: () => true,
        mutate,
      }),
    ).toMatchObject({ status: 'applied', revision: 8 })
    const candidate = (mutate.mock.calls[0]![0] as { configuration: unknown }).configuration
    expect(isManagerChannelFormMutation((descriptor as { readonly configuration: unknown }).configuration, candidate))
      .toBe(true)
    expect(candidate).toMatchObject({
      contract: 'cordisx.channel-service-config/v2',
      schemaVersion: 2,
      connections: [{ displayName: 'After', selectors: ['direct'] }, connection(other)],
    })
    const contract = createChannelHostServiceConfigContract({
      source: 'file:///channel',
      pluginId: 'channel',
      serviceId: 'runtime',
    })
    expect(contract.normalizeMutation(candidate, stored)).toMatchObject({
      schemaVersion: 2,
      connections: [
        {
          ...connection(account),
          secretRef: 'host-secret:env/FIXTURE_ONE',
          displayName: 'After',
          selectors: ['direct'],
        },
        { ...connection(other), secretRef: 'host-secret:env/FIXTURE_TWO' },
      ],
    })
  })

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
    const inUse = vi.fn(async () => ({ status: 'rejected', error: { code: 'stale-generation' } }) as never)
    expect(await mutateChannelConnectionConfiguration({ ...input, mutate: inUse })).toMatchObject({
      status: 'rejected',
      code: 'CONFIGURATION_UNAVAILABLE',
    })
  })
})
