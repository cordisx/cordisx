import { randomBytes, webcrypto } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createServiceRendererModels } from '../packages/cli/src/cli/service-renderer-models.js'
import { createServiceRendererPermissionOnce } from '../packages/cli/src/cli/service-renderer-permission-once.js'
import type { ManagerRendererChannel } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { loadStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CordisXOwnerDocumentBroker } from '../packages/cli/src/renderer/owner-documents.js'
import { BrowserPermissionOnceBinding } from '../packages/cli/src/renderer/permission-once-binding.js'
import { BrowserPlatformModelsBridge } from '../packages/cli/src/renderer/platform-models-binding.js'
import {
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  UnavailablePlatformAdapter,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'
import { standalonePermissionPrompt } from '../packages/cli/src/renderer/standalone-runtime-prompt.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

it('routes a verified installed plugin model request to the one service catalog', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>
  let channel!: ManagerRendererChannel
  const proof = new ManagerPermissionProofAuthority({
    profileId: 'default',
    generation: 'fixture-owner',
    isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
  })
  f = await fixture({
    optionalModelsPlugin: true,
    installedPermissionPolicy: true,
    browserManagement: true,
    coordinateLifecycle: true,
    protectProfileInputs: true,
    permissionProof: proof,
    writeDispatch: async (context, payload) => await channel.prepare(payload, context).dispatch(),
  })
  const signer = await createStandalonePermissionSigner({
    rendererId: f.handle.rendererId,
    profileId: f.profileId,
    generation: f.generation,
  }, { crypto: webcrypto as unknown as Crypto })
  let once: BrowserPermissionOnceBinding | undefined
  let broker: PermissionBroker | undefined
  let documents: CordisXOwnerDocumentBroker | undefined
  let fiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    const prepared = await f.sessions.call(f.invocation, 'manager-bootstrap', { action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    const graph = prepared.value.privateGraphs[0]
    const baseUrl = `http://127.0.0.1:43123/api/renderer/graphs/${randomBytes(32).toString('hex')}/`
    const result = await f.sessions.call(f.invocation, 'manager-bootstrap', {
      action: 'complete',
      managerOrigin: 'http://127.0.0.1:43123',
      permissionPublicKey: signer.publicKey,
      graphs: [{
        leaseId: randomBytes(32).toString('hex'),
        pluginId: graph.pluginId,
        moduleGeneration: graph.moduleGeneration,
        baseUrl,
        entryUrl: baseUrl + graph.entryUrl.slice(graph.baseUrl.length),
        initialStyleUrls: graph.initialStyleUrls.map((url: string) => baseUrl + url.slice(graph.baseUrl.length)),
      }],
    }) as any
    expect(result.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(result.value.bundle)
    const match = /ownerDocumentBindings\s*:\s*(\[[^\]]*\])/u.exec(bytes.toString('utf8'))
    if (!match) throw new Error('fixture owner bindings missing')
    const object = /\{([^{}]*)\}/u.exec(match[1]!)?.[1]
    const field = (name: string) => new RegExp(`(?:"${name}"|${name})\\s*:\\s*"([^"]+)"`, 'u').exec(object ?? '')?.[1]
    const bindings = [{
      source: field('source')!,
      pluginId: field('pluginId')!,
      moduleGeneration: field('moduleGeneration')!,
      token: field('token')!,
    }]
    bytes.fill(0)
    const binding = bindings.find(item => item.pluginId === 'permission-v4')!
    const identity = { id: binding.pluginId, source: binding.source }
    const poll = f.sessions.poll(f.invocation, 3000)
    const admitting = f.sessions.admit(f.invocation)
    const command = (await poll as any).value.command
    expect(
      await f.sessions.acknowledge(f.invocation, {
        id: command.id,
        sequence: command.sequence,
        ok: true,
        value: { active: command.payload.active, registryEpoch: command.payload.registryEpoch },
      }),
    ).toMatchObject({ status: 'ok' })
    expect(await admitting).toMatchObject({ status: 'ok', value: { admitted: true } })
    const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
    const onceChannel = createServiceRendererPermissionOnce({
      homeDir: f.homeDir,
      profileId: f.profileId,
      bootstrap: f.bootstrap,
      proof,
      journal,
    })
    const modelsChannel = createServiceRendererModels({
      homeDir: f.homeDir,
      profileId: f.profileId,
      documents: f.bootstrap.documentAuthority()!,
      bootstrap: f.bootstrap,
      catalog: async () => [
        { providerId: 'codex', pluginId: 'fixture', models: [{ id: 'model-a', label: 'Model A', aliases: [] }] },
        { providerId: 'other', pluginId: 'fixture', models: [{ id: 'model-b', label: 'Model B', aliases: [] }] },
      ],
    })
    const forward = (target: ManagerRendererChannel, receive: (payload: string) => void) => (payload: string) => {
      const requestId = (JSON.parse(payload) as { requestId: string }).requestId
      channel = target
      void f.sessions.call(f.invocation, 'fixture-write', payload).then(response =>
        receive(JSON.stringify(
          response.status === 'ok' ? response.value : { requestId, ok: false },
        ))
      )
    }
    globalThis.__cordisxPermissionOnceRequestV1 = forward(
      onceChannel,
      value => globalThis.__cordisxPermissionOnceReceiveV1?.(value),
    )
    globalThis.__cordisxPlatformModelsRequestV1 = forward(
      modelsChannel,
      value => globalThis.__cordisxPlatformModelsReceiveV1?.(value),
    )
    once = BrowserPermissionOnceBinding.connect(STANDALONE_PERMISSION_BINDING_MARKER)
    const modelBridge = BrowserPlatformModelsBridge.connect()
    expect(once).toBeDefined()
    expect(modelBridge).toBeDefined()
    documents = new CordisXOwnerDocumentBroker(undefined, bindings, modelBridge)
    const prompt = standalonePermissionPrompt({
      request: async plan => {
        const view = new PermissionAuthorizationViewModel(plan)
        view.select('models.read', 'allow-once')
        const choice = view.confirm()
        return choice.status === 'confirmed' && choice.decision.schemaVersion === 2 ? choice.decision : undefined
      },
    }, { isReviewing: () => false, dispose() {}, cancelV3() {}, isDomLeaseVisible: () => true } as never)
    prompt.bindRuntimeDecision(async (plan, decision, artifact) =>
      await once!.authorizeWebRuntime(signer, artifact, plan, decision)
    )
    broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      30_000,
      f.profileId,
      f.generation,
      undefined,
      undefined,
      prompt,
    )
    const installed = f.lifecycle.snapshot().active.plugins.find(item => item.id === identity.id)!
    const staged = await loadStagedPluginPackage(f.homeDir, installed.digest)
    broker.register(
      identity,
      normalizePluginManifest(staged.manifest.runtimeManifest, identity.id),
      { pluginId: identity.id, moduleGeneration: binding.moduleGeneration },
      undefined,
      { version: staged.manifest.version, integrity: staged.artifactIntegrity ?? staged.digest },
    )
    const root = new Context()
    let consumed = ''
    fiber = root.plugin(CordisXPlatformService, {
      adapter: new UnavailablePlatformAdapter(),
      broker,
      listOwnerModels: async (owner, generation, requestId, input) => {
        consumed = requestId
        return await documents!.listModels(owner, generation, requestId, input)
      },
    })
    await fiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    const models = await ctx.platform.models.list({ providerIds: ['codex'] })
    expect(models).toMatchObject({
      ok: true,
      value: { models: [{ ref: { providerId: 'codex', modelId: 'model-a' } }] },
    })
    expect(consumed).not.toBe('')
    expect(await documents.listModels(identity, binding.moduleGeneration, consumed, { providerIds: ['codex'] }))
      .toMatchObject({ ok: false })
  } finally {
    await fiber?.dispose()
    broker?.dispose()
    documents?.dispose()
    once?.dispose()
    delete globalThis.__cordisxPermissionOnceRequestV1
    delete globalThis.__cordisxPermissionOnceReceiveV1
    delete globalThis.__cordisxPlatformModelsRequestV1
    delete globalThis.__cordisxPlatformModelsReceiveV1
    signer.close()
    proof.close()
    await f.close()
  }
}, 60_000)
