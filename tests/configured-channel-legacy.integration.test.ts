import { expect, it } from 'vitest'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_LEGACY_CHANNEL_ARCHIVE_FIXTURE
const token = 'renderer-binding-placeholder'

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps the legacy Channel read-only even when the owner has configuration bridges',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
      channelCredentials: true,
    })
    try {
      await bootConfiguredChannelManager(f, f.invocation, false, false)
      const request = (requestId: string, operation: Record<string, unknown>) =>
        JSON.stringify({ version: 1, token, requestId, ...operation })
      expect(await f.sessions.call(f.invocation, 'channel-actions', request('snapshot', { action: 'snapshot' })))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(
        await f.sessions.call(
          f.invocation,
          'service-config',
          request('list', {
            operation: 'list',
            pluginId: 'channel',
            scope: { profileId: f.profileId, generation: f.generation },
          }),
        ),
      ).toEqual({ status: 'unavailable' })
      expect(
        await f.sessions.call(
          f.invocation,
          'channel-credentials',
          JSON.stringify({
            version: 2,
            token,
            requestId: 'capture',
            operation: 'capture',
            owner: 'fixture-form',
            purpose: 'rotate',
            account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture-tenant' },
            secret: 'synthetic-fixture-value',
            expectedRevision: 1,
          }),
        ),
      ).toEqual({ status: 'unknown' })
      expect(f.credentialValues.size).toBe(0)
    } finally {
      await f.close()
    }
  },
  30_000,
)
