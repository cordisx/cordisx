import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { readServiceConfigState } from '../packages/cli/src/config/service-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')
const token = 'renderer-binding-placeholder'

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps Channel reads and configuration writes available after a coordinated plugin install',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
    })
    let pump: Promise<void> | undefined
    try {
      const alias = await bootConfiguredChannelManager(f)
      let staged: any
      pump = (async () => {
        while (true) {
          const response = await f.sessions.poll(f.invocation, 2_000) as any
          if (response.status !== 'ok') return
          const command = response.value.command
          if (!command) continue
          const payload = command.payload
          let value: unknown
          if (command.method === 'prepare') value = payload
          else if (command.method === 'stage') {
            staged = payload
            value = {
              transactionId: payload.transactionId,
              transactionEpoch: payload.transactionEpoch,
              expectedRegistryEpoch: payload.expectedRegistryEpoch,
              afterRegistryEpoch: payload.afterRegistryEpoch,
              observation: payload.candidate,
              affectedPluginIds: payload.affectedPluginIds,
            }
          } else if (command.method === 'publish') {
            value = {
              transactionId: staged.transactionId,
              transactionEpoch: staged.transactionEpoch,
              registryEpoch: staged.afterRegistryEpoch,
              active: staged.candidate,
            }
          } else if (command.method === 'complete') {
            value = {
              transactionId: staged.transactionId,
              transactionEpoch: staged.transactionEpoch,
              registryEpoch: staged.afterRegistryEpoch,
              active: staged.candidate,
              disposedAfter: staged.previous,
            }
          } else if (command.method === 'finalize') value = { transactionId: payload.transactionId }
          else throw new Error('unexpected lifecycle command')
          await f.sessions.acknowledge(f.invocation, { id: command.id, sequence: command.sequence, ok: true, value })
        }
      })()
      expect(await f.install('channel-neighbor')).toMatchObject({ outcome: 'applied', revision: 1 })
      const request = (requestId: string, operation: Record<string, unknown>) =>
        JSON.stringify({ version: 1, token, requestId, ...operation })
      expect(await f.sessions.call(f.invocation, 'channel-actions', request('after-install', { action: 'snapshot' })))
        .toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      const listed = await f.sessions.call(
        f.invocation,
        'service-config',
        request('list-after-install', {
          operation: 'list',
          pluginId: 'channel',
          scope: { profileId: f.profileId, generation: f.generation },
        }),
      ) as any
      expect(listed).toMatchObject({ status: 'ok', value: { ok: true, value: [expect.any(Object)] } })
      const descriptor = listed.value.value[0]
      expect(descriptor.identity.source).toBe(alias)
      const configuration = structuredClone(descriptor.configuration)
      configuration.connections[0].displayName = 'Updated after install'
      const saved = await f.sessions.call(
        f.invocation,
        'service-config',
        request('save-after-install', {
          operation: 'mutate',
          mutation: {
            contract: 'cordisx.service-config-mutation/v1',
            schemaVersion: 1,
            identity: descriptor.identity,
            scope: descriptor.scope,
            expectedRevision: descriptor.revision,
            configuration,
          },
        }),
      )
      expect(saved).toMatchObject({ status: 'ok', value: { value: { status: 'applied', revision: 2 } } })
      const readback = await f.sessions.call(
        f.invocation,
        'channel-actions',
        request('after-save', { action: 'snapshot' }),
      )
      expect(readback).toMatchObject({ status: 'ok', value: { value: { status: 'applied' } } })
      expect(
        await readServiceConfigState({
          profileId: f.profileId,
          pluginId: 'channel',
          serviceId: 'runtime',
          initialConfig: {},
        }, f.configPath),
      ).toMatchObject({
        revision: 2,
        config: { connections: [expect.objectContaining({ displayName: 'Updated after install' })] },
      })
      expect(JSON.stringify([listed, saved, readback])).not.toContain(f.configuredChannel!.plugin.source!)
      expect(JSON.stringify([listed, saved, readback])).not.toContain('fixture-private-reference')
    } finally {
      await f.close()
      await pump
    }
  },
  60_000,
)

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

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'limits a configured Channel form save to one existing resolved connection',
  async () => {
    const f = await fixture({
      channelArchive: archive,
      channelUiGrant: true,
      protectProfileInputs: true,
      channelServiceConfig: true,
      channelCredentials: true,
    })
    try {
      await bootConfiguredChannelManager(f)
      const request = (requestId: string, operation: Record<string, unknown>) =>
        JSON.stringify({ version: 1, token, requestId, ...operation })
      const listed = await f.sessions.call(
        f.invocation,
        'service-config',
        request('list-scoped', {
          operation: 'list',
          pluginId: 'channel',
          scope: { profileId: f.profileId, generation: f.generation },
        }),
      ) as any
      const descriptor = listed.value.value[0]
      expect(JSON.stringify(listed)).not.toContain('fixture-private-reference')
      const mutation = (configuration: unknown) => ({
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: descriptor.revision,
        configuration,
      })
      const changes: Array<(value: any) => void> = [
        value => value.connections[0].enabled = !value.connections[0].enabled,
        value => value.connections[0].transport = { mode: 'webhook', callbackAlias: 'changed' },
        value => value.connections.push(structuredClone(value.connections[0])),
        value => value.connections.splice(0, 1),
        value => value.pendingConnections[0].displayName = 'Changed pending account',
        value => value.connections[0].selectors = ['unexpected'],
        value => value.connections[0].displayName = '',
        value => {
          value.connections[0].displayName = 'Changed first'
          value.connections[1].displayName = 'Changed second'
        },
        value => value.connections[1].secretRef = 'host-secret:env/FORGED_VALUE',
      ]
      for (const [index, change] of changes.entries()) {
        const candidate = structuredClone(descriptor.configuration)
        change(candidate)
        const result = await f.sessions.call(
          f.invocation,
          'service-config',
          request(`out-of-scope-${index}`, { operation: 'mutate', mutation: mutation(candidate) }),
        )
        expect(result).toMatchObject({
          status: 'ok',
          value: { value: { status: 'rejected', error: { code: 'validation-failed' } } },
        })
      }
      const candidate = structuredClone(descriptor.configuration)
      candidate.connections[0].displayName = 'One connection updated'
      candidate.connections[0].selectors = ['direct', 'mentions']
      const saved = await f.sessions.call(
        f.invocation,
        'service-config',
        request('single-connection', { operation: 'mutate', mutation: mutation(candidate) }),
      )
      expect(saved).toMatchObject({ status: 'ok', value: { value: { status: 'applied', revision: 2 } } })
      const stale = await f.sessions.call(
        f.invocation,
        'service-config',
        request('stale-connection', { operation: 'mutate', mutation: mutation(candidate) }),
      )
      expect(stale).toMatchObject({ status: 'ok', value: { value: { status: 'conflict', revision: 2 } } })
      const stored = await readServiceConfigState({
        profileId: f.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: {},
      }, f.configPath) as any
      expect(stored).toMatchObject({
        revision: 2,
        config: {
          connections: [
            expect.objectContaining({ displayName: 'One connection updated', selectors: ['direct', 'mentions'] }),
            expect.objectContaining({ enabled: false, secretRef: 'host-secret:channel/fixture-private-reference' }),
          ],
          pendingConnections: [expect.objectContaining({ secretRef: 'host-secret:channel/fixture-private-reference' })],
        },
      })
      expect(JSON.stringify([listed, saved])).not.toContain('fixture-private-reference')
    } finally {
      await f.close()
    }
  },
  45_000,
)
