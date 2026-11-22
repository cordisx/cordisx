import { randomBytes, webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { createServiceRendererPermissionChannel } from '../packages/cli/src/cli/service-renderer-permission-channel.js'
import type {
  ManagerRendererChannel,
  ManagerRendererChannelContext,
} from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const secret = () => randomBytes(32).toString('hex')
const point = 'manager.content'

function broker(
  store: ConstructorParameters<typeof PermissionBroker>[0],
  source: string,
  moduleGeneration: string,
) {
  const identity = { id: 'channel', source }
  const value = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'fixture-owner',
  )
  value.register(
    identity,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: identity.id,
      capabilities: [],
      services: [],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration },
  )
  return { value, identity }
}

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'verifies a signed Manager decision while both renderer brokers adopt the owner readback',
  async () => {
    let f!: Awaited<ReturnType<typeof fixture>>
    let channel!: ManagerRendererChannel
    let requestContext: ManagerRendererChannelContext | undefined
    const proof = new ManagerPermissionProofAuthority({
      profileId: 'default',
      generation: 'fixture-owner',
      isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
    })
    f = await fixture({
      channelArchive: archive,
      protectProfileInputs: true,
      permissionProof: proof,
      writeDispatch: async (context, payload) => {
        requestContext = context
        return await channel.prepare(payload, context).dispatch()
      },
    })
    const secondId = secret()
    const handle = (await f.sessions.open(f.gateway, secondId))!
    const second = { gateway: f.gateway, browserSessionId: secondId, handle }
    let writer: ReturnType<typeof broker> | undefined
    let peer: ReturnType<typeof broker> | undefined
    let store: BindingPermissionPolicyStore | undefined
    const signer = await createStandalonePermissionSigner({
      rendererId: f.handle.rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto })
    const peerSigner = await createStandalonePermissionSigner({
      rendererId: handle.rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto })
    try {
      const alias = await bootConfiguredChannelManager(f, f.invocation, undefined, undefined, signer.publicKey)
      const secondAlias = await bootConfiguredChannelManager(f, second, undefined, undefined, peerSigner.publicKey)
      const generationFor = async (invocation: typeof f.invocation) => {
        const response = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
        return response.value.privateGraphs[0].moduleGeneration as string
      }
      const writerGeneration = await generationFor(f.invocation)
      const peerGeneration = await generationFor(second)
      let otherConsumersCurrent = true
      const consumers = {
        isCurrent: () => otherConsumersCurrent,
        release: () => {
          if (!otherConsumersCurrent) return false
          otherConsumersCurrent = false
          return true
        },
        fence: () => {
          otherConsumersCurrent = false
        },
      }
      channel = createServiceRendererPermissionChannel({
        profileId: f.profileId,
        configPath: f.configPath,
        bootstrap: f.bootstrap,
        proof,
        participants: f.participants,
        lifecycle: f.lifecycle,
        sessions: () => f.sessions,
        // The other-consumer fence is synthetic; production remains gated.
        reserveOtherConsumers: async () => consumers,
      })
      const identity = { id: 'channel', source: alias }
      const plan = buildDomPermissionAuthorizationPlanV3({
        planId: 'fixture-review',
        profileId: f.profileId,
        identity: { pluginId: identity.id, source: identity.source },
        binding: { operationId: 'fixture-review', runtimeGeneration: f.generation, moduleGeneration: writerGeneration },
        declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [point] } },
        policies: [],
      })
      const view = new PermissionAuthorizationViewModel(plan)
      view.select('ui.extension-points.render', 'allow-persistent')
      const decision = view.confirm()
      if (decision.status !== 'confirmed' || decision.decision.schemaVersion !== 3) {
        throw new Error('fixture decision failed')
      }
      expect(signer.noteConfirmed(
        {
          identity,
          pointId: point,
          profileId: f.profileId,
          runtimeGeneration: f.generation,
          moduleGeneration: writerGeneration,
          artifact: f.configuredChannel!.plugin.distributionArtifact!,
        },
        plan,
        decision.decision,
      )).toBe(true)
      const onUnknown = vi.fn()
      let sent: string | undefined
      globalThis.__cordisxPermissionPolicyRequestV1 = payload => {
        sent = payload
        const requestId = (JSON.parse(payload) as { requestId: string }).requestId
        void f.sessions.call(f.invocation, 'fixture-write', payload).then(result => {
          const response = result.status === 'ok' ? result.value : { requestId, ok: false }
          globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify(response))
        })
      }
      store = BindingPermissionPolicyStore.connect(STANDALONE_PERMISSION_BINDING_MARKER, [], {
        onUnknown,
        sign: signer.sign,
      })
      writer = broker(store, alias, writerGeneration)
      peer = broker(new MemoryPermissionPolicyStore(), secondAlias, peerGeneration)
      const peerPoll = f.sessions.poll(second, 10_000)
      const writerPoll = f.sessions.poll(f.invocation, 10_000)
      const saving = writer.value.setDomPolicy(writer.identity, point, 'allow-persistent')
      const adopt = async (invocation: typeof f.invocation, target: ReturnType<typeof broker>, command: any) => {
        const { requestId, origin, identity, moduleGeneration, expected, updates, candidate } = command.payload
        expect(
          await target.value.adoptStandaloneDomPolicies({
            requestId,
            origin,
            identity,
            moduleGeneration,
            expected,
            updates,
            candidate,
            onUnknown,
          }),
        ).toBe(true)
        expect(
          await f.sessions.acknowledge(invocation, {
            id: command.id,
            sequence: command.sequence,
            ok: true,
            value: {
              rendererId: invocation.handle.rendererId,
              ownerGeneration: f.generation,
              handoffId: command.payload.handoffId,
              requestId,
              moduleGeneration,
              adopted: true,
            },
          }),
        ).toEqual({ status: 'ok', value: { accepted: true } })
      }
      const peerCommand = (await peerPoll as any).value.command
      expect(peerCommand.payload.origin).toBe(false)
      await adopt(second, peer, peerCommand)
      const writerCommand = (await writerPoll as any).value.command
      expect(writerCommand.payload.origin).toBe(true)
      await adopt(f.invocation, writer, writerCommand)
      await saving
      expect(writer.value.domPolicy(writer.identity, point)).toBe('allow')
      expect(peer.value.domPolicy(peer.identity, point)).toBe('allow')
      expect((await loadHomeConfig(f.configPath)).permissions).toContainEqual(expect.objectContaining({
        key: expect.objectContaining({
          identity: { source: f.configuredChannel!.plugin.source, pluginId: 'channel' },
          scope: { extensionPoints: [point] },
        }),
        policy: 'allow-persistent',
      }))
      expect(onUnknown).not.toHaveBeenCalled()
      expect(sent).toBeDefined()
      expect(() => channel.prepare(sent, requestContext!)).toThrow('MANAGER_PERMISSION_UNAVAILABLE')
    } finally {
      signer.close()
      peerSigner.close()
      proof.close()
      writer?.value.dispose()
      peer?.value.dispose()
      store?.dispose()
      delete globalThis.__cordisxPermissionPolicyRequestV1
      delete globalThis.__cordisxPermissionPolicyReceiveV1
      await f.close()
    }
  },
  60_000,
)
