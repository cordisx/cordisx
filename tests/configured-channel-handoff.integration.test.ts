import { expect, it } from 'vitest'
import { createConfiguredChannelOwner } from '../packages/cli/src/cli/configured-channel-owner.js'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { channelConfigurationApi } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'hands an originating Manager from the old Channel view to a committed service generation',
  async () => {
    let f!: Awaited<ReturnType<typeof fixture>>
    let commit!: () => Promise<import('../packages/cli/src/launcher/service-config.js').HostServiceConfigMutationResult>
    f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      writeDispatch: async () => {
        const fence = await fenceManagerOrigin({
          sessions: f.sessions,
          participants: f.participants,
          lifecycle: f.lifecycle,
        })
        try {
          const result = await f.bootstrap.mutateConfiguredChannel(fence, commit)
          if (!fence.release()) throw new Error('owner handoff was not confirmed')
          return result
        } catch (error) {
          fence.fence()
          throw error
        }
      },
    })
    const channel = f.configuredChannel!
    const authority = createConfiguredChannelOwner({
      homeDir: f.homeDir,
      configPath: f.configPath,
      profileId: f.profileId,
      plugin: channel.plugin,
      service: channel.service,
      ownerCurrent: () => true,
    })!
    const api = channelConfigurationApi({
      token: 'a'.repeat(64),
      profileId: f.profileId,
      generation: f.generation,
      configPath: f.configPath,
      plugin: channel.plugin,
      service: channel.service,
      persistence: authority.persistence,
    })
    try {
      await bootConfiguredChannelManager(f)
      let forgedWriteDispatched = false
      await expect(f.bootstrap.mutateConfiguredChannel({
        rendererId: f.handle.rendererId,
        isCurrent: () => true,
        release: () => true,
        fence: () => {},
      }, async () => {
        forgedWriteDispatched = true
        throw new Error('forged write dispatched')
      })).rejects.toThrow('renderer-configured-channel-unavailable')
      expect(forgedWriteDispatched).toBe(false)
      const snapshot = (requestId: string) =>
        JSON.stringify({
          version: 1,
          token: 'renderer-binding-placeholder',
          requestId,
          action: 'snapshot',
        })
      expect(await f.sessions.call(f.invocation, 'channel-actions', snapshot('before')))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      const descriptor = await api.descriptor()
      const candidate = structuredClone(descriptor.configuration) as { connections: Array<{ enabled: boolean }> }
      candidate.connections[0]!.enabled = false
      const mutation = {
        contract: 'cordisx.service-config-mutation/v1' as const,
        schemaVersion: 1 as const,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: descriptor.revision,
        configuration: candidate,
      }
      commit = async () => {
        const result = await authority.withOwner(async () => await api.mutate(mutation))
        if (!result) throw new Error('owner unavailable')
        return result
      }
      const generation = channel.service.generation()
      expect(await f.sessions.call(f.invocation, 'fixture-write', {}))
        .toMatchObject({ status: 'ok', value: { status: 'applied', revision: 2 } })
      expect(channel.service.generation()).not.toBe(generation)
      expect(await f.call({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
      const observed = await f.sessions.call(f.invocation, 'channel-actions', snapshot('after'))
      expect(observed).toMatchObject({
        status: 'ok',
        value: {
          value: {
            status: 'applied',
            projection: {
              accounts: [expect.objectContaining({
                connectionState: 'stopped',
              })],
            },
          },
        },
      })
      expect(JSON.stringify(observed)).not.toContain('fixture-private-reference')
      expect(
        await readServiceConfigState({
          profileId: f.profileId,
          pluginId: 'channel',
          serviceId: 'runtime',
          initialConfig: {},
        }, f.configPath),
      ).toMatchObject({
        revision: 2,
        lastGoodRevision: 2,
        config: { connections: [expect.objectContaining({ enabled: false })] },
      })
      // A stale CAS fails without replacing or revoking the newly current view.
      expect(await f.sessions.call(f.invocation, 'fixture-write', {}))
        .toMatchObject({ status: 'ok', value: { status: 'conflict', revision: 2 } })
      expect(await f.sessions.call(f.invocation, 'channel-actions', snapshot('after-conflict')))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
    } finally {
      api.dispose()
      await f.close()
    }
  },
  30_000,
)
