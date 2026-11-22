import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { persistPermissionPoliciesIfUnchanged } from '../packages/cli/src/launcher/permission-rpc.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../packages/cli/src/permission-persistence.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'
import type { ServiceRendererPermissionConsumerFence } from '../packages/cli/src/cli/service-renderer-permission-handoff.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')
type Adoption = Parameters<ServiceRendererPermissionConsumerFence['adopt']>[0]
const adoptionReceipt = (input: Adoption) => ({
  profileId: input.profileId,
  ownerGeneration: input.ownerGeneration,
  requestId: input.requestId,
  adopted: true,
  candidate: input.candidate,
})

async function setup() {
  let f!: Awaited<ReturnType<typeof fixture>>
  let projected!: CordisXPersistedPermissionPolicyRecord
  let consumersCurrent = true
  const consumers = {
    isCurrent: () => consumersCurrent,
    adopt: vi.fn(async (input: Adoption, _signal: AbortSignal) => adoptionReceipt(input)),
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
      expect(consumers.adopt).toHaveBeenCalledOnce()
      expect(consumers.adopt.mock.calls[0]![1].aborted).toBe(false)
      expect(consumers.adopt.mock.calls[0]![0]).toMatchObject({
        profileId: f.profileId,
        ownerGeneration: f.generation,
        requestId: 'request-1',
        updates: [expect.objectContaining({ policy: 'deny-persistent' })],
      })
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
  'waits for non-Manager consumers to adopt the persisted policy before offering it to Managers',
  async () => {
    const { f, second, consumers } = await setup()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => entered = resolve)
    const waiting = new Promise<void>(resolve => release = resolve)
    consumers.adopt.mockImplementation(async input => {
      entered()
      await waiting
      return adoptionReceipt(input)
    })
    try {
      let offered = false
      const peerPoll = f.sessions.poll(second, 10_000).then(value => {
        offered = true
        return value as any
      })
      const writerPoll = f.sessions.poll(f.invocation, 10_000)
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      await started
      expect((await loadHomeConfig(f.configPath)).permissions).toContainEqual(expect.objectContaining({
        policy: 'deny-persistent',
      }))
      expect(offered).toBe(false)
      expect(consumers.release).not.toHaveBeenCalled()
      release()
      const peer = (await peerPoll).value.command
      expect(await acknowledge(f, second, peer)).toEqual({ status: 'ok', value: { accepted: true } })
      const writer = (await writerPoll as any).value.command
      expect(await acknowledge(f, f.invocation, writer)).toEqual({ status: 'ok', value: { accepted: true } })
      expect(await saving).toEqual({ status: 'ok', value: { status: 'applied' } })
      expect(consumers.release).toHaveBeenCalledOnce()
    } finally {
      release()
      await f.close()
    }
  },
  60_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'cancels a pending non-Manager adoption when the writing page disconnects',
  async () => {
    const { f, consumers } = await setup()
    let release!: () => void
    let entered!: () => void
    let aborted = false
    const started = new Promise<void>(resolve => entered = resolve)
    const waiting = new Promise<void>(resolve => release = resolve)
    consumers.adopt.mockImplementation(async (input, signal) => {
      signal.addEventListener('abort', () => aborted = true, { once: true })
      entered()
      await waiting
      return adoptionReceipt(input)
    })
    try {
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      await started
      const closing = f.sessions.close(f.invocation)
      expect(await saving).toEqual({ status: 'unknown' })
      expect(await closing).toBe(false)
      expect(aborted).toBe(true)
      expect(consumers.fence).toHaveBeenCalled()
      release()
      await Promise.resolve()
      expect(consumers.release).not.toHaveBeenCalled()
    } finally {
      release()
      await f.close()
    }
  },
  60_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences all participants when a non-Manager reports a stale policy readback',
  async () => {
    const { f, consumers } = await setup()
    consumers.adopt.mockImplementation(async input => ({ ...adoptionReceipt(input), candidate: input.expected }))
    try {
      expect(await f.sessions.call(f.invocation, 'fixture-write', {})).toEqual({ status: 'unknown' })
      expect(consumers.adopt).toHaveBeenCalledOnce()
      expect(consumers.fence).toHaveBeenCalled()
      expect(consumers.release).not.toHaveBeenCalled()
      expect(f.participants.ownerPeers()).toEqual([])
      expect((await loadHomeConfig(f.configPath)).permissions).toContainEqual(expect.objectContaining({
        policy: 'deny-persistent',
      }))
    } finally {
      await f.close()
    }
  },
  60_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'keeps non-Manager consumers fenced when Channel release is not confirmed',
  async () => {
    const { f, second, consumers } = await setup()
    const bridge = f.channelBridge!
    const suspend = bridge.suspendAll.bind(bridge)
    vi.spyOn(bridge, 'suspendAll').mockImplementation(async (ids, timeout) => {
      const reservation = await suspend(ids, timeout)
      return { ...reservation, release: () => false }
    })
    try {
      const peerPoll = f.sessions.poll(second, 10_000)
      const writerPoll = f.sessions.poll(f.invocation, 10_000)
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      await acknowledge(f, second, (await peerPoll as any).value.command)
      await acknowledge(f, f.invocation, (await writerPoll as any).value.command)
      expect(await saving).toEqual({ status: 'unknown' })
      expect(consumers.adopt).toHaveBeenCalledOnce()
      expect(consumers.release).not.toHaveBeenCalled()
      expect(consumers.fence).toHaveBeenCalled()
      expect(f.participants.ownerPeers()).toEqual([])
    } finally {
      await f.close()
    }
  },
  60_000,
)

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'requires reconciliation if the last consumer cannot release after the owner write',
  async () => {
    const { f, second, consumers } = await setup()
    consumers.release.mockReturnValueOnce(false)
    try {
      const peerPoll = f.sessions.poll(second, 10_000)
      const writerPoll = f.sessions.poll(f.invocation, 10_000)
      const saving = f.sessions.call(f.invocation, 'fixture-write', {})
      await acknowledge(f, second, (await peerPoll as any).value.command)
      await acknowledge(f, f.invocation, (await writerPoll as any).value.command)
      expect(await saving).toEqual({ status: 'unknown' })
      expect(consumers.release).toHaveBeenCalledOnce()
      expect(consumers.fence).toHaveBeenCalled()
      expect((await loadHomeConfig(f.configPath)).permissions).toContainEqual(expect.objectContaining({
        policy: 'deny-persistent',
      }))
      expect(f.lifecycle.requiresReconciliation).toBe(true)
      expect(() => f.lifecycle.snapshot()).toThrow('service renderer lifecycle is unavailable')
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
