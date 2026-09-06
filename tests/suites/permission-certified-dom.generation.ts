import { Context } from '@deepseek-ai/cordis'
import { act } from 'react'
import { reactManagerFixture } from '../helpers/react-manager.js'
import { expect, it } from 'vitest'
import { CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 } from '../../packages/cli/src/contracts.js'
import {
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV3,
} from '../../packages/cli/src/permission-contracts.js'
import { sha256Hex } from '../../packages/cli/src/permission-model-v2.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../../packages/cli/src/renderer/extension-points.js'
import { GenerationVisibilityCoordinator } from '../../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../../packages/cli/src/renderer/ownership.js'
import {
  BrowserPermissionAuthorizationPromptV2,
  MemoryPermissionPolicyStore,
  PermissionBroker,
  type PermissionPolicyStore,
} from '../../packages/cli/src/renderer/platform.js'
import {
  broker,
  certification,
  digest,
  explicitV2,
  explicitV3,
  identity,
  legacyPrompt,
  manifest,
} from './permission-certified-dom.fixtures.js'

export function registerGenerationTests() {
  it('isolates pending review and audit provenance across active and candidate module generations', async () => {
    const oldDigest = `sha256:${'d'.repeat(64)}` as const
    const activation = (revision: number, moduleGeneration: string, artifactDigest: `sha256:${string}`) => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: revision === 1 ? 'active' as const : 'candidate' as const,
      ...(revision === 1 ? {} : { transactionId: 'update-certified-dom' }),
      profileId: 'work',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: identity.id,
        version: '1.2.3',
        digest: artifactDigest,
        moduleGeneration,
        enabled: true,
        dependencies: [],
      }],
    })
    const previous = activation(1, 'module-1', oldDigest)
    const next = activation(2, 'module-2', digest)
    const visibility = new GenerationVisibilityCoordinator(previous)
    const prompted: CordisXPermissionAuthorizationPlanV3[] = []
    const value = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      100,
      'work',
      'runtime-1',
      visibility,
      undefined,
      {
        request: async plan => explicitV2(plan),
        requestV3: async plan => {
          prompted.push(plan)
          return explicitV3(plan, 'allow-once')
        },
      },
    )
    const unregisterActive = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-1',
      },
      undefined,
      { version: '1.2.3', integrity: oldDigest },
    )
    const handle = visibility.begin('update-certified-dom', previous, next)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_GENERATION]: 'module-2',
      ...visibility.context(handle, identity.id),
    })
    const candidateView = visibility.view(candidateContext)
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    const unregisterCandidate = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-2',
        transactionId: handle.transactionId,
        transactionEpoch: handle.transactionEpoch,
      },
      candidateView,
      { version: '1.2.3', integrity: digest },
    )

    expect(value.domAccess(identity, 'main', candidateView)).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'pending' })
    const activeBeforeReview = value.snapshots().find(item => item.scope.extensionPoints?.[0] === 'main')
    expect(activeBeforeReview).toMatchObject({ scope: { extensionPoints: ['main'] } })
    expect(activeBeforeReview).not.toHaveProperty('authorizationOrigin')

    await expect(value.reviewPendingDomAccess(identity, 'module-1')).resolves.toContainEqual(expect.objectContaining({
      authorized: true,
      authorizationOrigin: 'explicit-user',
    }))
    expect(prompted[0]?.binding.moduleGeneration).toBe('module-1')
    expect(value.snapshots()).toContainEqual(expect.objectContaining({
      scope: { extensionPoints: ['main'] },
      authorizationOrigin: 'explicit-user',
    }))

    unregisterCandidate()
    expect(value.snapshots()).toContainEqual(expect.objectContaining({
      scope: { extensionPoints: ['main'] },
      authorizationOrigin: 'explicit-user',
    }))
    unregisterActive()
  })

  it('does not resurrect an old Certified lease when a published update is revoked before rollback', async () => {
    const newDigest = `sha256:${'e'.repeat(64)}` as const
    const activation = (revision: number, moduleGeneration: string, artifactDigest: `sha256:${string}`) => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: revision === 1 ? 'active' as const : 'candidate' as const,
      ...(revision === 1 ? {} : { transactionId: 'rollback-certified-dom' }),
      profileId: 'work',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: identity.id,
        version: '1.2.3',
        digest: artifactDigest,
        moduleGeneration,
        enabled: true,
        dependencies: [],
      }],
    })
    const previous = activation(1, 'module-1', digest)
    const next = activation(2, 'module-2', newDigest)
    const visibility = new GenerationVisibilityCoordinator(previous)
    const prompted: CordisXPermissionAuthorizationPlanV3[] = []
    const value = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      100,
      'work',
      'runtime-1',
      visibility,
      undefined,
      {
        request: async plan => explicitV2(plan),
        requestV3: async plan => {
          prompted.push(plan)
          return explicitV3(plan, 'allow-once')
        },
      },
    )
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    const unregisterOld = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-1',
      },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    expect(value.domAccess(identity, 'main')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })

    const handle = visibility.begin('rollback-certified-dom', previous, next)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_GENERATION]: 'module-2',
      ...visibility.context(handle, identity.id),
    })
    const candidateView = visibility.view(candidateContext)
    const unregisterNew = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-2',
        transactionId: handle.transactionId,
        transactionEpoch: handle.transactionEpoch,
      },
      candidateView,
      { version: '1.2.3', integrity: newDigest },
    )
    expect(value.domAccess(identity, 'main', candidateView)).toMatchObject({ authorized: false, state: 'pending' })

    const publication = visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'pending' })
    value.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    visibility.rollback(publication)

    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'pending' })
    expect(value.snapshots().filter(item => item.scope.extensionPoints?.[0] === 'main'))
      .not.toContainEqual(expect.objectContaining({ authorizationOrigin: 'certified-implicit' }))
    await expect(value.requestDomAccess(identity, 'main')).resolves.toMatchObject({
      authorized: true,
      authorizationOrigin: 'explicit-user',
    })
    expect(prompted).toHaveLength(1)
    expect(prompted[0]?.binding.moduleGeneration).toBe('module-1')

    unregisterNew()
    unregisterOld()
  })

  it('rejects an in-flight DOM decision after its module generation is unregistered', async () => {
    let requestedPlan: CordisXPermissionAuthorizationPlanV3 | undefined
    let resolveDecision: ((decision: CordisXPermissionAuthorizationDecisionV3) => void) | undefined
    const value = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      1_000,
      'work',
      'runtime-1',
      undefined,
      undefined,
      {
        request: async plan => explicitV2(plan),
        requestV3: async plan => {
          requestedPlan = plan
          return await new Promise(resolve => {
            resolveDecision = resolve
          })
        },
      },
    )
    const unregister = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-stale',
      },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    const pending = value.requestDomAccess(identity, 'main')
    await Promise.resolve()
    expect(requestedPlan).toBeDefined()

    unregister()
    resolveDecision?.(explicitV3(requestedPlan!, 'allow-persistent'))
    await expect(pending).resolves.toMatchObject({
      authorized: false,
      state: 'denied',
      reason: 'permission.generation-invalidated',
    })
    expect(value.snapshots()).toEqual([])
  })

  it('never grants a stale generation when persistent policy storage resolves after unload', async () => {
    let markPersistStarted: (() => void) | undefined
    const persistStarted = new Promise<void>(resolve => {
      markPersistStarted = resolve
    })
    let releasePersist: (() => void) | undefined
    const persistRelease = new Promise<void>(resolve => {
      releasePersist = resolve
    })
    let persisted: readonly unknown[] = []
    const store: PermissionPolicyStore = {
      read: () => [],
      write: () => {},
      readV3: () => [],
      writeV3: async records => {
        markPersistStarted?.()
        await persistRelease
        persisted = records
      },
    }
    const value = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      1_000,
      'work',
      'runtime-1',
      undefined,
      undefined,
      {
        request: async plan => explicitV2(plan),
        requestV3: async plan => explicitV3(plan, 'allow-persistent'),
      },
    )
    const unregister = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-persist-stale',
      },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    const pending = value.requestDomAccess(identity, 'main')
    await persistStarted

    unregister()
    releasePersist?.()
    await expect(pending).resolves.toMatchObject({
      authorized: false,
      state: 'denied',
      reason: 'permission.generation-invalidated',
    })
    expect(persisted).toHaveLength(1)
    expect(value.domPolicy(identity, 'main')).toBe('allow')
    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'denied' })
    expect(value.snapshots()).toEqual([])
  })

  it('fails closed when a Host audit observer unloads the generation reentrantly', async () => {
    let unregister = (): void => {}
    const value = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      1_000,
      'work',
      'runtime-1',
      undefined,
      { permission: () => unregister() },
      {
        request: async plan => explicitV2(plan),
        requestV3: async plan => explicitV3(plan, 'allow-once'),
      },
    )
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    unregister = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-observer-stale',
      },
      undefined,
      { version: '1.2.3', integrity: digest },
    )

    await expect(value.requestDomAccess(identity, 'main')).resolves.toMatchObject({
      authorized: false,
      state: 'denied',
      reason: 'permission.generation-invalidated',
    })
    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'denied' })
    expect(value.snapshots()).toEqual([])
  })

  it('removes the exact Host DOM review overlay immediately when its generation unloads', async () => {
    const fixture = reactManagerFixture()
    const instance = fixture.dom
    instance.window.document.documentElement.className = 'electron-light'
    const prompt = new BrowserPermissionAuthorizationPromptV2(instance.window.document)
    const value = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      1_000,
      'work',
      'runtime-1',
      undefined,
      undefined,
      prompt,
    )
    const unregister = value.register(
      identity,
      manifest(),
      {
        pluginId: identity.id,
        moduleGeneration: 'module-dialog-stale',
      },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    try {
      let pending!: ReturnType<PermissionBroker['requestDomAccess']>
      await act(async () => {
        pending = value.requestDomAccess(identity, 'main')
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(instance.window.document.querySelector('[data-permission-authorization]')).not.toBeNull()
      await act(async () => {
        unregister()
        expect(instance.window.document.querySelector('[data-permission-authorization]')).toBeNull()
      })
      await expect(pending).resolves.toMatchObject({
        authorized: false,
        state: 'denied',
        reason: 'permission.generation-invalidated',
      })
    } finally {
      await act(async () => value.dispose())
      await fixture.dispose()
    }
  })

  it('expires a certified lease and falls back to explicit review', async () => {
    let now = new Date('2026-08-30T12:00:00.000Z')
    const context = broker({ certified: certification(), now: () => now })
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.domPrompts()).toBe(0)
    now = new Date('2026-10-01T00:00:00.000Z')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      state: 'pending',
    })
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.domPrompts()).toBe(1)
  })

  it('actively retires an expired certification without waiting for another access', async () => {
    const base = certification()
    const generatedAt = new Date(Date.now() - 1_000).toISOString()
    const payload = {
      source: base.source,
      pluginId: base.pluginId,
      version: base.version,
      integrity: base.integrity,
      reviewPolicy: base.reviewPolicy,
      reviewedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 250).toISOString(),
      evidence: base.evidence,
      feed: { ...base.feed, generatedAt },
    }
    const expiring: CordisXCertifiedPermissionProjectionV1 = {
      ...base,
      ...payload,
      fingerprint: `sha256:${sha256Hex(JSON.stringify(payload))}`,
      revision: generatedAt,
    }
    const context = broker({ certified: expiring, now: () => new Date() })
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.value.snapshots()).toContainEqual(expect.objectContaining({
      authorizationOrigin: 'certified-implicit',
      certification: expect.objectContaining({ fingerprint: expiring.fingerprint }),
    }))

    for (
      let attempt = 0;
      attempt < 100 && context.value.snapshots().some(item => item.certification !== undefined);
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(context.value.snapshots().find(item => item.capability === 'ui.extension-points.render')).not.toHaveProperty(
      'certification',
    )
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      state: 'pending',
    })
  })

  it('makes the legacy extension-point broker a descriptor gate over PermissionBroker authority only', async () => {
    const context = broker({})
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const legacyStore = new MemoryExtensionPointPolicyStore([{
      $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
      schemaVersion: 1,
      identity: { source: identity.source, pluginId: identity.id, pointId: 'workspace.toolbar.items' },
      policy: 'deny',
    }])
    const points = new ExtensionPointPolicyBroker(descriptors, legacyStore, 'runtime-1', undefined, {
      access: (owner, pointId, view) => context.value.domAccess(owner, pointId, view),
      policy: (owner, pointId) => context.value.domPolicy(owner, pointId),
      policies: () => context.value.domPolicies(),
    })
    points.register(identity, { pluginId: identity.id, moduleGeneration: 'module-1' })

    expect(points.decision(identity.id, 'workspace.toolbar.items', 'surface')).toMatchObject({
      authorized: false,
      policy: 'inherit',
      reason: 'permission.review-pending',
    })
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(points.decision(identity.id, 'workspace.toolbar.items', 'surface')).toMatchObject({
      authorized: true,
      policy: 'inherit',
    })
    expect(() => points.setPolicy(identity, 'workspace.toolbar.items', 'deny')).toThrow(/PermissionBroker owns/)
    expect(legacyStore.records[0]?.policy).toBe('deny')
  })

  it('keeps adapter availability orthogonal to the exact broker grant', async () => {
    const context = broker({ certified: certification() })
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const points = new ExtensionPointPolicyBroker(
      descriptors,
      new MemoryExtensionPointPolicyStore(),
      'runtime-1',
      undefined,
      {
        access: (owner, pointId, view) => context.value.domAccess(owner, pointId, view),
        policy: (owner, pointId) => context.value.domPolicy(owner, pointId),
        policies: () => context.value.domPolicies(),
      },
    )
    points.register(identity, { pluginId: identity.id, moduleGeneration: 'module-1' })

    expect(points.decision(identity.id, 'sidebar.workspace.menu', 'surface')).toMatchObject({
      authorized: false,
      policy: 'inherit',
      reason: 'extension point sidebar.workspace.menu adapter support is unverified',
    })
    expect(context.value.domAccess(identity, 'sidebar.workspace.menu')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
    expect(context.value.snapshots()).toContainEqual(expect.objectContaining({
      capability: 'ui.extension-points.render',
      scope: { extensionPoints: ['sidebar.workspace.menu'] },
      authorizationOrigin: 'certified-implicit',
    }))
    // A valid grant never turns an unavailable adapter into a renderable point.
    expect(points.decision(identity.id, 'sidebar.workspace.menu', 'surface')).toMatchObject({
      authorized: false,
      reason: 'extension point sidebar.workspace.menu adapter support is unverified',
    })
  })
}
