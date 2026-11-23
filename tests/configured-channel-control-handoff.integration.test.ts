import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const token = 'renderer-binding-placeholder'
const secret = () => randomBytes(32).toString('hex')
const envelope = (requestId: string, fields: Record<string, unknown>) =>
  JSON.stringify({ version: 1, token, requestId, ...fields })

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'coordinates connection enablement with every admitted Manager',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
      channelControls: true,
    })
    const browserSessionId = secret()
    const handle = (await f.sessions.open(f.gateway, browserSessionId))!
    const second = { gateway: f.gateway, browserSessionId, handle }
    try {
      await bootConfiguredChannelManager(f)
      await bootConfiguredChannelManager(f, second)
      const listed = await f.sessions.call(
        f.invocation,
        'service-config',
        envelope('list-control', {
          operation: 'list',
          pluginId: 'channel',
          scope: { profileId: f.profileId, generation: f.generation },
        }),
      ) as any
      const descriptor = listed.value.value[0]
      const ref = descriptor.configuration.connections[0].ref
      const control = (requestId: string, action: string, expectedRevision: number) =>
        f.sessions.call(
          f.invocation,
          'channel-actions',
          envelope(requestId, { action, ref, expectedRevision }),
        )
      const polling = f.sessions.poll(second, 5_000)
      let settled = false
      const changing = control('disable', 'disable', descriptor.revision).then(value => {
        settled = true
        return value
      })
      const command = (await polling as any).value.command
      expect(command).toMatchObject({ method: 'channel-configuration', payload: { revision: 2 } })
      expect(settled).toBe(false)
      expect(
        await f.sessions.acknowledge(second, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { rendererId: handle.rendererId, ownerGeneration: f.generation, revision: 2, adopted: true },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      const result = await changing
      expect(result).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(result).toMatchObject({
        value: { value: { channelProjection: { service: { connectionControl: 'enable-disable', revision: 2 } } } },
      })
      expect(JSON.stringify(result)).not.toContain('fixture-private-reference')
      const stale = await control('stale-enable', 'enable', descriptor.revision)
      expect(stale).toMatchObject({
        status: 'ok',
        value: { value: { status: 'unavailable', code: 'REVISION_CONFLICT' } },
      })
      const firstPolling = f.sessions.poll(f.invocation, 5_000)
      const enabling = f.sessions.call(
        second,
        'channel-actions',
        envelope('enable', { action: 'enable', ref, expectedRevision: 2 }),
      )
      const firstCommand = (await firstPolling as any).value.command
      expect(firstCommand).toMatchObject({ method: 'channel-configuration', payload: { revision: 3 } })
      expect(
        await f.sessions.acknowledge(f.invocation, {
          id: firstCommand.id,
          sequence: firstCommand.sequence,
          ok: true,
          value: {
            rendererId: f.invocation.handle.rendererId,
            ownerGeneration: f.generation,
            revision: 3,
            adopted: true,
          },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await enabling).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      const stored = await readServiceConfigState({
        profileId: f.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, f.configPath) as any
      expect(stored).toMatchObject({ revision: 3, config: { connections: [{ enabled: true }] } })
      expect(stored.config.pendingConnections[0].secretRef).toBe('host-secret:channel/fixture-private-reference')
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux').each(
  [
    'unadmitted',
    'disconnect-after-commit',
  ] as const,
)('keeps connection controls fenced when a second Manager is %s', async scenario => {
  const f = await fixture({
    channelArchive: archive,
    channelUiGrant: true,
    protectProfileInputs: true,
    channelServiceConfig: true,
    channelControls: true,
  })
  const browserSessionId = secret()
  const handle = (await f.sessions.open(f.gateway, browserSessionId))!
  const second = { gateway: f.gateway, browserSessionId, handle }
  try {
    await bootConfiguredChannelManager(f)
    if (scenario === 'disconnect-after-commit') await bootConfiguredChannelManager(f, second)
    const listed = await f.sessions.call(
      f.invocation,
      'service-config',
      envelope('list-control', {
        operation: 'list',
        pluginId: 'channel',
        scope: { profileId: f.profileId, generation: f.generation },
      }),
    ) as any
    const descriptor = listed.value.value[0]
    const polling = scenario === 'disconnect-after-commit' ? f.sessions.poll(second, 5_000) : undefined
    const changing = f.sessions.call(
      f.invocation,
      'channel-actions',
      envelope('disable', {
        action: 'disable',
        ref: descriptor.configuration.connections[0].ref,
        expectedRevision: descriptor.revision,
      }),
    )
    if (polling) {
      const command = (await polling as any).value.command
      expect(command).toMatchObject({ method: 'channel-configuration', payload: { revision: 2 } })
      await f.sessions.close(second)
      expect(await changing).toEqual({ status: 'unknown' })
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
    } else {
      expect(await changing).toMatchObject({
        status: 'ok',
        value: { value: { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' } },
      })
    }
    const stored = await readServiceConfigState({
      profileId: f.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: {},
    }, f.configPath)
    expect(stored.revision).toBe(scenario === 'unadmitted' ? 1 : 2)
  } finally {
    await f.close()
  }
}, 45_000)
