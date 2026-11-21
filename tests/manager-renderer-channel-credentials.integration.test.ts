import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const token = 'renderer-binding-placeholder'
const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture-tenant' }
const envelope = (requestId: string, operation: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 2, token, requestId, operation, owner: 'fixture-form', ...fields })
const options = {
  channelArchive: archive,
  channelUiGrant: true,
  protectProfileInputs: true,
  channelServiceConfig: true,
  channelCredentials: true,
}

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps a credential draft private and coordinates its commit with the originating Manager',
  async () => {
    const f = await fixture(options)
    const secondId = randomBytes(32).toString('hex')
    const second = {
      gateway: f.gateway,
      browserSessionId: secondId,
      handle: (await f.sessions.open(f.gateway, secondId))!,
    }
    try {
      await bootConfiguredChannelManager(f)
      await bootConfiguredChannelManager(f, second)
      const call = (requestId: string, operation: string, fields: Record<string, unknown> = {}) =>
        f.sessions.call(f.invocation, 'channel-credentials', envelope(requestId, operation, fields))
      const captured = await call('capture', 'capture', {
        purpose: 'rotate',
        account,
        secret: 'synthetic-fixture-value',
        expectedRevision: 1,
      }) as any
      expect(captured).toMatchObject({
        status: 'ok',
        value: { ok: true, value: { status: 'applied', code: 'CAPTURED', ref: account } },
      })
      expect(JSON.stringify(captured)).not.toMatch(/synthetic-fixture-value|secretRef|fixture-private-reference/)
      const draftId = captured.value.value.draftId
      expect(f.credentialValues.size).toBe(1)
      expect(await f.sessions.call(second, 'channel-credentials', envelope('other-session', 'discard', { draftId })))
        .toMatchObject({ status: 'ok', value: { value: { status: 'unavailable', code: 'DRAFT_UNAVAILABLE' } } })
      expect(f.credentialValues.size).toBe(1)
      const polling = f.sessions.poll(second, 10_000)
      const pending = call('commit', 'commit', {
        draftId,
        draft: { displayName: 'Updated', selectors: ['direct'] },
      })
      const command = (await polling as any).value.command
      expect(command).toMatchObject({ method: 'channel-configuration', payload: { revision: 2 } })
      expect(JSON.stringify(command)).not.toMatch(/synthetic-fixture-value|secretRef|fixture-private-reference/)
      expect(
        await f.sessions.acknowledge(second, {
          id: command.id,
          sequence: command.sequence,
          ok: true,
          value: { rendererId: second.handle.rendererId, ownerGeneration: f.generation, revision: 2, adopted: true },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      const committed = await pending as any
      expect(committed).toMatchObject({
        status: 'ok',
        value: { ok: true, value: { status: 'applied', code: 'APPLIED' } },
      })
      expect(JSON.stringify(committed)).not.toMatch(/synthetic-fixture-value|secretRef|fixture-private-reference/)
      expect(committed.value.value.projection.service).toMatchObject({
        revision: 2,
        lastGoodRevision: 2,
        writable: true,
      })
      const stored = await readServiceConfigState({
        profileId: f.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, f.configPath) as any
      const connection = stored.config.connections.find((item: any) => item.ref.adapterId === 'feishu')
      expect(stored).toMatchObject({ revision: 2, lastGoodRevision: 2 })
      expect(connection).toMatchObject({ displayName: 'Updated', selectors: ['direct'] })
      expect(connection.secretRef).not.toBe('host-secret:channel/fixture-private-reference')
      expect(f.credentialValues.size).toBe(1)
      expect(
        await f.sessions.call(
          f.invocation,
          'channel-actions',
          JSON.stringify({
            version: 1,
            token,
            requestId: 'after-commit',
            action: 'snapshot',
          }),
        ),
      ).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'retires uncommitted private drafts before confirming the Manager closed',
  async () => {
    const f = await fixture(options)
    try {
      await bootConfiguredChannelManager(f)
      const captured = await f.sessions.call(
        f.invocation,
        'channel-credentials',
        envelope('capture', 'capture', {
          purpose: 'rotate',
          account,
          secret: 'synthetic-fixture-value',
          expectedRevision: 1,
        }),
      )
      expect(captured).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(f.credentialValues.size).toBe(1)
      expect(await f.sessions.close(f.invocation)).toBe(true)
      expect(f.credentialValues.size).toBe(0)
    } finally {
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'waits for an interrupted capture and fences its uncertain result',
  async () => {
    let started!: () => void
    let release!: () => void
    const validationStarted = new Promise<void>(resolve => started = resolve)
    const validationReleased = new Promise<void>(resolve => release = resolve)
    const f = await fixture({
      ...options,
      channelCredentialValidate: async () => {
        started()
        await validationReleased
      },
    })
    try {
      await bootConfiguredChannelManager(f)
      const pending = f.sessions.call(
        f.invocation,
        'channel-credentials',
        envelope('capture', 'capture', {
          purpose: 'rotate',
          account,
          secret: 'synthetic-fixture-value',
          expectedRevision: 1,
        }),
      )
      await validationStarted
      let closed = false
      const retirement = f.sessions.close(f.invocation).then(result => {
        closed = true
        return result
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      release()
      expect(await pending).toEqual({ status: 'unknown' })
      expect(await retirement).toBe(false)
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
      expect(f.credentialValues.size).toBe(0)
    } finally {
      release()
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences the owner when private draft cleanup cannot be confirmed',
  async () => {
    const f = await fixture({ ...options, channelCredentialCleanupFails: true })
    try {
      await bootConfiguredChannelManager(f)
      const captured = await f.sessions.call(
        f.invocation,
        'channel-credentials',
        envelope('capture', 'capture', {
          purpose: 'rotate',
          account,
          secret: 'synthetic-fixture-value',
          expectedRevision: 1,
        }),
      )
      expect(captured).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(await f.sessions.close(f.invocation)).toBe(false)
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
      expect(f.credentialValues.size).toBe(1)
    } finally {
      f.setCredentialCleanupFailure(false)
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences an explicit discard when private cleanup fails',
  async () => {
    const f = await fixture({ ...options, channelCredentialCleanupFails: true })
    try {
      await bootConfiguredChannelManager(f)
      const captured = await f.sessions.call(
        f.invocation,
        'channel-credentials',
        envelope('capture', 'capture', {
          purpose: 'rotate',
          account,
          secret: 'synthetic-fixture-value',
          expectedRevision: 1,
        }),
      ) as any
      const draftId = captured.value.value.draftId
      expect(await f.sessions.call(f.invocation, 'channel-credentials', envelope('discard', 'discard', { draftId })))
        .toEqual({ status: 'unknown' })
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
      expect(f.credentialValues.size).toBe(1)
    } finally {
      f.setCredentialCleanupFailure(false)
      await f.close()
    }
  },
  45_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'does not report success or remove a committed credential when its receipt is lost',
  async () => {
    const f = await fixture({ ...options, channelCredentialCommitUnknown: true })
    try {
      await bootConfiguredChannelManager(f)
      const captured = await f.sessions.call(
        f.invocation,
        'channel-credentials',
        envelope('capture', 'capture', {
          purpose: 'rotate',
          account,
          secret: 'synthetic-fixture-value',
          expectedRevision: 1,
        }),
      ) as any
      expect(
        await f.sessions.call(
          f.invocation,
          'channel-credentials',
          envelope('commit', 'commit', { draftId: captured.value.value.draftId }),
        ),
      ).toEqual({ status: 'unknown' })
      const stored = await readServiceConfigState({
        profileId: f.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, f.configPath)
      expect(stored).toMatchObject({ revision: 2, lastGoodRevision: 2 })
      expect(f.credentialValues.size).toBe(1)
      expect(f.sessions.mutationAvailability()).toBe('unavailable')
    } finally {
      await f.close()
    }
  },
  45_000,
)
