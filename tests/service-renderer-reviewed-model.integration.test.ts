import { webcrypto } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createServiceRendererLifecycleReview } from '../packages/cli/src/cli/service-renderer-lifecycle-review.js'
import { createServiceRendererModels } from '../packages/cli/src/cli/service-renderer-models.js'
import type { ManagerRendererChannel } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { BrowserPlatformModelsBridge } from '../packages/cli/src/renderer/platform-models-binding.js'
import { CordisXOwnerDocumentBroker } from '../packages/cli/src/renderer/owner-documents.js'
import {
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  UnavailablePlatformAdapter,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'
import type { DeferredPermissionDecision } from '../packages/cli/src/permission-deferral.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { localPackageV5 } from './suites/plugin-lifecycle.fixtures.js'

it('hands a reviewed model grant to the exact Web lifecycle candidate before publication', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>
  let modelChannel!: ManagerRendererChannel
  let action!: (context: any, payload: any) => Promise<unknown>
  const proof = new ManagerPermissionProofAuthority({
    profileId: 'default',
    generation: 'fixture-owner',
    isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
  })
  f = await fixture({
    protectProfileInputs: true,
    permissionProof: proof,
    installedPermissionPolicy: true,
    browserManagement: true,
    coordinateLifecycle: true,
    writeDispatch: async (context, payload) => await action(context, payload),
    extraChannels: () => [['fixture-models', {
      prepare: (payload, context) => modelChannel.prepare(payload, context),
    }]],
  })
  const signer = await createStandalonePermissionSigner({
    rendererId: f.handle.rendererId,
    profileId: f.profileId,
    generation: f.generation,
  }, { crypto: webcrypto as unknown as Crypto })
  const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
  try {
    expect((await f.call({ action: 'prepare' }) as any).status).toBe('ok')
    expect(
      (await f.call({
        action: 'complete',
        managerOrigin: 'http://127.0.0.1:43123',
        graphs: [],
        permissionPublicKey: signer.publicKey,
      }) as any).status,
    ).toBe('ok')
    const firstPoll = f.sessions.poll(f.invocation, 3000)
    const admission = f.sessions.admit(f.invocation)
    const synchronize = (await firstPoll as any).value.command
    await f.sessions.acknowledge(f.invocation, {
      id: synchronize.id,
      sequence: synchronize.sequence,
      ok: true,
      value: { active: synchronize.payload.active, registryEpoch: synchronize.payload.registryEpoch },
    })
    expect(await admission).toMatchObject({ status: 'ok', value: { admitted: true } })

    const staged = await f.coordinator.stagePackageSource({
      kind: 'local-directory',
      location: pathToFileURL(await localPackageV5(f.root, false, false)).href,
    })
    const candidate = await f.coordinator.inspectStagedPackage(staged, 'inspect-model')
    const ownerPlan = (await f.coordinator.permissionReviewPlanV7({
      requestId: 'review-model',
      profileId: f.profileId,
      runtimeGeneration: f.generation,
      expectedRevision: 0,
      target: { kind: 'candidate', candidateId: candidate.candidateId! },
    }))!
    const intent = {
      kind: 'plugin-plan-marketplace' as const,
      pluginId: staged.manifest.id,
      sourceUrl: 'https://example.test/catalog',
      version: staged.manifest.version,
      expectedCanonicalSource: staged.identitySource,
      expectedArtifactIntegrity: staged.digest,
    }
    const management = f.management!
    const reviewer = createServiceRendererLifecycleReview({
      homeDir: f.homeDir,
      profileId: f.profileId,
      generation: f.generation,
      coordinator: f.coordinator,
      journal,
      proof,
      bootstrap: f.bootstrap,
      service: management,
    })
    action = async (context, payload) => {
      if (payload.kind === 'issue') {
        const snapshot = await management.query()
        return await f.bootstrap.managementEntry(context)!.restricted!.plans.issueReview({
          intent,
          managementRevision: snapshot.revision,
          activationRevision: snapshot.activationRevision,
          ownerPlan,
        })
      }
      return await reviewer(payload.operation, 'apply-model', context)
    }
    const issuedResponse = await f.sessions.call(f.invocation, 'fixture-write', { kind: 'issue' }) as any
    expect(issuedResponse.status).toBe('ok')
    const issued = issuedResponse.value
    expect(issued?.plan).toBeDefined()
    const item = issued.plan.declarations.find((value: any) => value.decisionRequired)
    const decision: DeferredPermissionDecision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
      schemaVersion: 7,
      origin: 'explicit-user',
      planId: issued.plan.planId,
      operation: issued.plan.operation,
      profileId: issued.plan.profileId,
      identity: issued.plan.identity,
      binding: issued.plan.binding,
      decisions: [{
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: 'allow-once',
      }],
    }
    const signed = await signer.signLifecycle('apply-model', issued.token, issued.plan, decision)
    modelChannel = createServiceRendererModels({
      homeDir: f.homeDir,
      profileId: f.profileId,
      bootstrap: f.bootstrap,
      documents: f.bootstrap.documentAuthority()!,
      catalog: async () => [{
        providerId: 'codex',
        pluginId: 'fixture',
        models: [{ id: 'model-a', label: 'A', aliases: [] }],
      }],
    })
    let done = false
    const applying = f.sessions.call(f.invocation, 'fixture-write', {
      kind: 'apply',
      operation: { kind: 'plugin-review-apply', reviewToken: issued.token, decision, proof: signed },
    }).finally(() => {
      done = true
    })
    let stagedCommand: any
    let observedModel = false
    for (let count = 0; count < 12 && !done; count++) {
      const response = await f.sessions.poll(f.invocation, 1000) as any
      const command = response.value?.command
      if (!command) continue
      const payload = command.payload
      let value: unknown
      if (command.method === 'prepare') value = payload
      else if (command.method === 'stage') {
        stagedCommand = payload
        const binding = payload.ownerDocumentBindings.find((entry: any) => entry.pluginId === staged.manifest.id)
        const identity = { id: binding.pluginId, source: binding.source }
        globalThis.__cordisxPlatformModelsRequestV1 = request => {
          const requestId = (JSON.parse(request) as { requestId: string }).requestId
          void f.sessions.call(f.invocation, 'fixture-models', request).then(reply =>
            globalThis.__cordisxPlatformModelsReceiveV1?.(JSON.stringify(
              reply.status === 'ok' ? reply.value : { requestId, ok: false },
            ))
          )
        }
        const bridge = BrowserPlatformModelsBridge.connect()!
        const documents = new CordisXOwnerDocumentBroker(undefined, [binding], bridge)
        const broker = new PermissionBroker(
          new MemoryPermissionPolicyStore(),
          { request: async () => 'deny' },
          () => new Date(),
          30_000,
          f.profileId,
          f.generation,
        )
        const root = new Context()
        let authorizationRequestId = ''
        const fiber = root.plugin(CordisXPlatformService, {
          adapter: new UnavailablePlatformAdapter(),
          broker,
          listOwnerModels: async (owner, generation, requestId, input) => {
            authorizationRequestId = requestId
            return await documents.listModels(owner, generation, requestId, input)
          },
        })
        try {
          broker.register(
            identity,
            normalizePluginManifest(payload.package.manifest.runtimeManifest, identity.id),
            { pluginId: identity.id, moduleGeneration: binding.moduleGeneration },
            undefined,
            { version: staged.manifest.version, integrity: staged.artifactIntegrity ?? staged.digest },
          )
          await broker.authorizeActivationV7(identity, payload.authorizationDecision, 'install')
          await fiber
          const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
          expect(await ctx.platform.models.list({ providerIds: ['codex'] })).toMatchObject({
            ok: true,
            value: { models: [{ ref: { providerId: 'codex', modelId: 'model-a' } }] },
          })
          expect(await documents.listModels(identity, binding.moduleGeneration, authorizationRequestId, {}))
            .toMatchObject({ ok: false })
        } finally {
          await fiber.dispose()
          broker.dispose()
          documents.dispose()
          delete globalThis.__cordisxPlatformModelsRequestV1
          delete globalThis.__cordisxPlatformModelsReceiveV1
        }
        observedModel = true
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
          transactionId: stagedCommand.transactionId,
          transactionEpoch: stagedCommand.transactionEpoch,
          registryEpoch: stagedCommand.afterRegistryEpoch,
          active: stagedCommand.candidate,
          retiring: stagedCommand.previous,
          notificationErrors: [],
        }
      } else if (command.method === 'complete') {
        value = {
          transactionId: stagedCommand.transactionId,
          transactionEpoch: stagedCommand.transactionEpoch,
          registryEpoch: stagedCommand.afterRegistryEpoch,
          active: stagedCommand.candidate,
          disposedAfter: stagedCommand.previous,
        }
      } else if (command.method === 'finalize') value = { transactionId: payload.transactionId }
      else throw new Error(`unexpected lifecycle command: ${command.method}`)
      const acknowledgment = await f.sessions.acknowledge(f.invocation, {
        id: command.id,
        sequence: command.sequence,
        ok: true,
        value,
      })
      expect(acknowledgment).toMatchObject({ status: 'ok' })
    }
    expect(await applying).toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'applied' } } })
    expect(observedModel).toBe(true)
    expect(await journal.recentLifecycle({ id: staged.manifest.id, source: staged.identitySource })).toMatchObject([{
      client: 'web',
      operation: 'install',
      committedAt: expect.any(String),
    }])
  } finally {
    signer.close()
    proof.close()
    await f.close()
  }
}, 60_000)
