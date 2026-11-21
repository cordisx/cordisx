import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')
const token = 'renderer-binding-placeholder'

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'hands a committed service configuration to both admitted Managers before acknowledging the write',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
    })
    const secondId = secret()
    const handle = (await f.sessions.open(f.gateway, secondId))!
    const second = { gateway: f.gateway, browserSessionId: secondId, handle }
    try {
      const alias = await bootConfiguredChannelManager(f)
      const otherAlias = await bootConfiguredChannelManager(f, second)
      expect(otherAlias).not.toBe(alias)
      const request = (requestId: string, operation: Record<string, unknown>) =>
        JSON.stringify({ version: 1, token, requestId, ...operation })
      const listed = await f.sessions.call(
        f.invocation,
        'service-config',
        request('list', {
          operation: 'list',
          pluginId: 'channel',
          scope: { profileId: f.profileId, generation: f.generation },
        }),
      ) as any
      expect(listed).toMatchObject({ status: 'ok', value: { ok: true, value: [expect.any(Object)] } })
      const descriptor = listed.value.value[0]
      expect(descriptor).toMatchObject({ identity: { source: alias, pluginId: 'channel', serviceId: 'runtime' } })
      expect(JSON.stringify(listed)).not.toContain(f.configuredChannel!.plugin.source!)
      expect(JSON.stringify(listed)).not.toContain('fixture-private-reference')
      const configuration = structuredClone(descriptor.configuration)
      configuration.connections[0].displayName = 'Updated from first'
      const mutation = {
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: descriptor.revision,
        configuration,
      }
      const save = (requestId: string) =>
        f.sessions.call(
          f.invocation,
          'service-config',
          request(requestId, {
            operation: 'mutate',
            mutation,
          }),
        )
      const polling = f.sessions.poll(second, 3_000)
      let settled = false
      const saving = save('save').then(value => {
        settled = true
        return value
      })
      const command = (await polling as any).value.command
      expect(command).toMatchObject({
        method: 'channel-configuration',
        payload: {
          rendererId: handle.rendererId,
          ownerGeneration: f.generation,
          revision: 2,
          projection: {
            accounts: expect.arrayContaining([expect.objectContaining({ displayName: 'Updated from first' })]),
          },
        },
      })
      expect(JSON.stringify(command)).not.toContain('fixture-private-reference')
      expect(JSON.stringify(command)).not.toContain(f.configuredChannel!.plugin.source!)
      expect(settled).toBe(false)
      expect(
        await f.sessions.acknowledge(second, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { rendererId: handle.rendererId, ownerGeneration: f.generation, revision: 2, adopted: true },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      const saved = await saving
      expect(saved).toMatchObject({ status: 'ok', value: { value: { status: 'applied', revision: 2 } } })
      expect(await f.call({ action: 'status' })).toMatchObject({ status: 'ok', value: { current: true } })
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
        .toMatchObject({ status: 'ok', value: { current: true } })
      expect(JSON.stringify(saved)).not.toContain(f.configuredChannel!.plugin.source!)
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
        config: {
          connections: [expect.objectContaining({ displayName: 'Updated from first' })],
          pendingConnections: [expect.objectContaining({ secretRef: 'host-secret:channel/fixture-private-reference' })],
        },
      })
      expect(await f.sessions.call(f.invocation, 'channel-actions', request('after-save', { action: 'snapshot' })))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(await f.sessions.call(second, 'channel-actions', request('other-after-save', { action: 'snapshot' })))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      const forged = {
        ...mutation,
        identity: { ...mutation.identity, source: otherAlias },
        expectedRevision: 2,
      }
      expect(
        await f.sessions.call(
          f.invocation,
          'service-config',
          request('other-alias', {
            operation: 'mutate',
            mutation: forged,
          }),
        ),
      ).toEqual({ status: 'unknown' })
      expect(
        await readServiceConfigState({
          profileId: f.profileId,
          pluginId: 'channel',
          serviceId: 'runtime',
          initialConfig: {},
        }, f.configPath),
      ).toMatchObject({ revision: 2, lastGoodRevision: 2 })
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux').each(
  [
    'unadmitted',
    'disconnect-after-commit',
  ] as const,
)('keeps the configuration fenced when a second Manager is %s', async scenario => {
  const f = await fixture({
    channelArchive: archive,
    channelUiGrant: true,
    protectProfileInputs: true,
    channelServiceConfig: true,
  })
  const secondId = secret()
  const handle = (await f.sessions.open(f.gateway, secondId))!
  const second = { gateway: f.gateway, browserSessionId: secondId, handle }
  try {
    await bootConfiguredChannelManager(f)
    if (scenario === 'disconnect-after-commit') await bootConfiguredChannelManager(f, second)
    const request = (requestId: string, operation: Record<string, unknown>) =>
      JSON.stringify({ version: 1, token, requestId, ...operation })
    const listed = await f.sessions.call(
      f.invocation,
      'service-config',
      request('list', {
        operation: 'list',
        pluginId: 'channel',
        scope: { profileId: f.profileId, generation: f.generation },
      }),
    ) as any
    const descriptor = listed.value.value[0]
    const configuration = structuredClone(descriptor.configuration)
    configuration.connections[0].displayName = 'New name'
    const mutation = {
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: descriptor.identity,
      scope: descriptor.scope,
      expectedRevision: descriptor.revision,
      configuration,
    }
    const polling = scenario === 'disconnect-after-commit' ? f.sessions.poll(second, 3_000) : undefined
    const saving = f.sessions.call(f.invocation, 'service-config', request('save', { operation: 'mutate', mutation }))
    if (polling) {
      const command = (await polling as any).value.command
      expect(command.method).toBe('channel-configuration')
      await f.sessions.close(second)
      expect(await saving).toEqual({ status: 'unknown' })
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
    } else {
      expect(await saving).toMatchObject({ status: 'ok', value: { value: { status: 'rejected' } } })
      expect(await f.call({ action: 'status' })).toMatchObject({ status: 'ok', value: { current: true } })
    }
    const state = await readServiceConfigState({
      profileId: f.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: {},
    }, f.configPath)
    expect(state.revision).toBe(scenario === 'unadmitted' ? 1 : 2)
  } finally {
    await f.close()
  }
}, 30_000)
