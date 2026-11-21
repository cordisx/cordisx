import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')
const token = 'renderer-binding-placeholder'

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'maps the owner identity for a Manager service write and preserves other open Managers',
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
      configuration.connections[0].enabled = false
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
      expect(await save('busy')).toMatchObject({ status: 'ok', value: { value: { status: 'rejected' } } })
      expect(await f.call({ action: 'status' })).toMatchObject({ status: 'ok', value: { current: true } })
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
        .toMatchObject({ status: 'ok', value: { current: true } })
      expect(await f.sessions.close(second)).toBe(true)
      const saved = await save('save')
      expect(saved).toMatchObject({ status: 'ok', value: { value: { status: 'applied', revision: 2 } } })
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
          connections: [expect.objectContaining({ enabled: false })],
          pendingConnections: [expect.objectContaining({ secretRef: 'host-secret:channel/fixture-private-reference' })],
        },
      })
      expect(await f.sessions.call(f.invocation, 'channel-actions', request('after-save', { action: 'snapshot' })))
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
