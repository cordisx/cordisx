import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { persistPermissionPoliciesIfUnchanged } from '../packages/cli/src/launcher/permission-rpc.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../packages/cli/src/permission-persistence.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')

async function setup() {
  let f!: Awaited<ReturnType<typeof fixture>>
  let projected!: CordisXPersistedPermissionPolicyRecord
  let consumersCurrent = true
  const consumers = {
    isCurrent: () => consumersCurrent,
    release: vi.fn(() => {
      if (!consumersCurrent) return false
      consumersCurrent = false
      return true
    }),
    fence: vi.fn(() => consumersCurrent = false),
  }
  f = await fixture({
    channelArchive: archive,
    channelUiGrant: true,
    protectProfileInputs: true,
    writeDispatch: async context => {
      const expected = f.bootstrap.permissionSnapshot(context)
      const updates = f.bootstrap.resolvePermissionPolicies([projected], context)
      const origin = await fenceManagerOrigin({
        sessions: f.sessions,
        participants: f.participants,
        lifecycle: f.lifecycle,
        allowAdditionalManagers: true,
      })
      try {
        const barrier = await f.bootstrap.reservePermissionPolicy(
          origin,
          context,
          'request-1',
          expected,
          updates,
          consumers,
        )
        const result = await barrier.run(async () =>
          await persistPermissionPoliciesIfUnchanged({
            configPath: f.configPath,
            profileId: f.profileId,
            expected,
            assertCurrent: () => {
              if (!barrier.isCurrent()) throw new Error('fixture policy reservation is stale')
            },
          }, updates)
        )
        if (!await barrier.complete(result.policies)) throw new Error('fixture handoff was not confirmed')
        return { status: 'applied' }
      } catch (error) {
        origin.fence()
        throw error
      }
    },
  })
  const secondId = secret()
  const handle = (await f.sessions.open(f.gateway, secondId))!
  const second = { gateway: f.gateway, browserSessionId: secondId, handle }
  const alias = await bootConfiguredChannelManager(f)
  const secondAlias = await bootConfiguredChannelManager(f, second)
  const [record] = exactDomPermissionPolicies(f.profileId, [{
    id: 'channel',
    entry: '/fixture.js',
    pointIds: ['manager.content'],
  }])
  projected = {
    ...record!,
    key: { ...record!.key, identity: { ...record!.key.identity, source: alias } },
    policy: 'deny-persistent',
  }
  return { f, second, alias, secondAlias, consumers }
}

async function acknowledge(
  f: Awaited<ReturnType<typeof fixture>>,
  invocation: typeof f.invocation,
  command: any,
  moduleGeneration = command.payload.moduleGeneration,
) {
  return await f.sessions.acknowledge(invocation, {
    id: command.id,
    sequence: command.sequence,
    ok: true,
    value: {
      rendererId: invocation.handle.rendererId,
      ownerGeneration: f.generation,
      handoffId: command.payload.handoffId,
      requestId: command.payload.requestId,
      moduleGeneration,
      adopted: true,
    },
  })
}

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'holds the owner write until both Managers confirm their own policy projections',
  async () => {
    const { f, second, alias, secondAlias, consumers } = await setup()
    try {
      let writerOffered = false
      const writerPoll = f.sessions.poll(f.invocation, 10_000).then(value => {
        writerOffered = true
        return value as any
      })
      const peerPoll = f.sessions.poll(second, 10_000)
      let settled = false
      const saving = f.sessions.call(f.invocation, 'fixture-write', {}).then(value => {
        settled = true
        return value
      })
      const peer = (await peerPoll as any).value.command
      expect(peer).toMatchObject({
        method: 'permission-policy',
        payload: {
          rendererId: second.handle.rendererId,
          identity: { id: 'channel', source: secondAlias },
          candidate: expect.arrayContaining([expect.objectContaining({ policy: 'deny-persistent' })]),
        },
      })
      expect(JSON.stringify(peer)).not.toContain(f.configuredChannel!.plugin.source!)
      expect(writerOffered).toBe(false)
      expect(settled).toBe(false)
      expect(await acknowledge(f, second, peer)).toEqual({ status: 'ok', value: { accepted: true } })
      const writer = (await writerPoll).value.command
      expect(writer).toMatchObject({ method: 'permission-policy', payload: { identity: { source: alias } } })
      expect(writer.payload.moduleGeneration).not.toBe(peer.payload.moduleGeneration)
      expect(settled).toBe(false)
      expect(await acknowledge(f, f.invocation, writer)).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await saving).toEqual({ status: 'ok', value: { status: 'applied' } })
      expect(consumers.release).toHaveBeenCalledOnce()
      expect(consumers.fence).not.toHaveBeenCalled()
      expect(await f.call({ action: 'status' })).toMatchObject({ status: 'ok', value: { current: true } })
      expect(await f.sessions.call(second, 'manager-bootstrap', { action: 'status' }))
        .toMatchObject({ status: 'ok', value: { current: true } })
      const policies = (await loadHomeConfig(f.configPath)).permissions
      expect(policies).toContainEqual(expect.objectContaining({
        key: expect.objectContaining({
          identity: { source: f.configuredChannel!.plugin.source, pluginId: 'channel' },
          scope: { extensionPoints: ['manager.content'] },
        }),
        policy: 'deny-persistent',
      }))
    } finally {
      await f.close()
    }
  },
  60_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences the cohort when a peer gives an incorrect receipt after the owner write',
  async () => {
    const { f, second, consumers } = await setup()
    try {
      const polling = f.sessions.poll(second, 10_000)
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      const peer = (await polling as any).value.command
      expect(peer.method).toBe('permission-policy')
      expect(await acknowledge(f, second, peer, 'stale-generation'))
        .toEqual({ status: 'ok', value: { accepted: true } })
      expect(await saving).toEqual({ status: 'unknown' })
      expect(consumers.fence).toHaveBeenCalled()
      expect(consumers.release).not.toHaveBeenCalled()
      expect(f.participants.ownerPeers()).toEqual([])
      const policies = (await loadHomeConfig(f.configPath)).permissions
      expect(policies.some(policy => policy.key.identity.pluginId === 'channel' && policy.policy === 'deny-persistent'))
        .toBe(true)
    } finally {
      await f.close()
    }
  },
  60_000,
)
