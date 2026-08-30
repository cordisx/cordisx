import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPluginManifestV4,
} from '../packages/cli/src/permission-contracts.js'
import { sha256Hex } from '../packages/cli/src/permission-model-v2.js'
import {
  MemoryPermissionPolicyStore,
  BrowserPermissionAuthorizationPromptV2,
  PermissionBroker,
  normalizePluginManifest,
  type PermissionAuthorizationPromptV2,
  type PermissionPolicyStore,
  type PermissionPrompt,
} from '../packages/cli/src/renderer/platform.js'
import {
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'
import { CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 } from '../packages/cli/src/contracts.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
} from '../packages/cli/src/renderer/ownership.js'

const identity = { source: 'https://plugins.example/certified-dom', id: 'certified-dom' } as const
const digest = `sha256:${'a'.repeat(64)}` as const
const legacyPrompt: PermissionPrompt = { request: async () => 'deny' }

function manifest(capabilities: CordisXPluginManifestV4['capabilities'] = []): CordisXPluginManifestV4 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: identity.id,
    capabilities,
    services: [],
  }, identity.id) as CordisXPluginManifestV4
}

function certification(overrides: Partial<CordisXCertifiedPermissionProjectionV1> = {}): CordisXCertifiedPermissionProjectionV1 {
  const payload = {
    source: identity.source,
    pluginId: identity.id,
    version: '1.2.3',
    integrity: digest,
    reviewPolicy: { id: 'cordisx-marketplace-review' as const, version: '1.0.0' },
    reviewedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    evidence: {
      kind: 'protected-marketplace-review' as const,
      reference: 'https://github.com/cordisx/marketplace/pull/123',
    },
    feed: {
      generatedAt: '2026-08-30T00:00:00.000Z',
      root: 'https://marketplace.example/feed.json',
      authority: 'cordisx.marketplace.codeowners/v1' as const,
    },
  }
  return {
    $schema: CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
    schemaVersion: 1,
    kind: 'cordisx-certified-permission-eligibility',
    status: 'active',
    ...payload,
    fingerprint: `sha256:${sha256Hex(JSON.stringify(payload))}`,
    revision: payload.feed.generatedAt,
    ...overrides,
  }
}

function explicitV3(plan: CordisXPermissionAuthorizationPlanV3, choice: CordisXPermissionAuthorizationDecisionV3['decisions'][number]['decision']): CordisXPermissionAuthorizationDecisionV3 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
    schemaVersion: 3,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: choice,
    })),
  }
}

function explicitV2(plan: CordisXPermissionAuthorizationPlanV2): CordisXPermissionAuthorizationDecisionV2 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once',
    })),
  }
}

function broker(input: {
  readonly certified?: CordisXCertifiedPermissionProjectionV1
  readonly domChoice?: CordisXPermissionAuthorizationDecisionV3['decisions'][number]['decision']
  readonly store?: MemoryPermissionPolicyStore
  readonly profile?: string
  readonly generation?: string
  readonly moduleGeneration?: string
  readonly capabilities?: CordisXPluginManifestV4['capabilities']
  readonly now?: () => Date
}) {
  let domPrompts = 0
  let nonDomPrompts = 0
  const prompt: PermissionAuthorizationPromptV2 = {
    request: async (plan) => { nonDomPrompts += 1; return explicitV2(plan) },
    requestV3: async (plan) => { domPrompts += 1; return explicitV3(plan, input.domChoice ?? 'allow-once') },
  }
  const value = new PermissionBroker(
    input.store ?? new MemoryPermissionPolicyStore(),
    legacyPrompt,
    input.now ?? (() => new Date('2026-08-30T12:00:00.000Z')),
    100,
    input.profile ?? 'work',
    input.generation ?? 'runtime-1',
    undefined,
    undefined,
    prompt,
  )
  if (input.certified !== undefined) {
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [input.certified] })
  }
  const unregister = value.register(
    identity,
    manifest(input.capabilities),
    { pluginId: identity.id, moduleGeneration: input.moduleGeneration ?? 'module-1' },
    undefined,
    { version: '1.2.3', integrity: digest },
  )
  return { value, unregister, domPrompts: () => domPrompts, nonDomPrompts: () => nonDomPrompts }
}

describe('certified DOM authorization through the single PermissionBroker', () => {
  it.each([
    ['ordinary', false, false, 1, 'explicit-user'],
    ['certified-only', true, false, 0, 'certified-implicit'],
    ['official-only', false, true, 1, 'explicit-user'],
    ['official-and-certified', true, true, 0, 'certified-implicit'],
  ] as const)('keeps the %s state independent across trust dimensions', async (_state, certified, _official, prompts, origin) => {
    // Official is deliberately absent from every PermissionBroker input.
    const context = broker({ ...(certified ? { certified: certification() } : {}) })
    await expect(context.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({
      authorized: true,
      authorizationOrigin: origin,
    })
    expect(context.domPrompts()).toBe(prompts)
    expect(context.value.snapshots().find(item => item.scope.extensionPoints?.[0] === 'workspace.toolbar.items'))
      .toMatchObject({ authorizationOrigin: origin })
  })

  it.each([
    ['ordinary', undefined],
    ['certified-only', certification()],
    ['official-only', undefined],
    ['official-and-certified', certification()],
  ] as const)('never lets the %s state bypass a non-DOM prompt', async (_state, certified) => {
    const context = broker({
      ...(certified === undefined ? {} : { certified }),
      capabilities: [{ name: 'models.read', required: false, scope: { providers: ['codex'] } }],
    })
    await expect(context.value.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({ ok: true })
    expect(context.nonDomPrompts()).toBe(1)
  })

  it('binds auto approval to exact artifact evidence and rejects malicious self-claims', async () => {
    const exact = broker({ certified: certification() })
    await exact.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(exact.domPrompts()).toBe(0)

    const mismatched = broker({})
    expect(() => mismatched.value.replaceCertifiedPermissionSnapshot({
      revision: 1,
      projections: [certification({ integrity: `sha256:${'b'.repeat(64)}` })],
    })).toThrow(/invalid projection/)
    await mismatched.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(mismatched.domPrompts()).toBe(1)

    const forgedFingerprint = broker({})
    expect(() => forgedFingerprint.value.replaceCertifiedPermissionSnapshot({
      revision: 1,
      projections: [certification({ fingerprint: `sha256:${'c'.repeat(64)}` })],
    })).toThrow(/invalid projection/)
    await forgedFingerprint.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(forgedFingerprint.domPrompts()).toBe(1)

    expect(() => normalizePluginManifest({
      ...manifest(),
      certified: true,
      official: true,
    }, identity.id)).toThrow(/unsupported|unknown/i)

    const injected = broker({})
    injected.unregister()
    if (false) {
      // @ts-expect-error Plugin registration artifacts cannot carry trust projections.
      injected.value.register(identity, manifest(), { pluginId: identity.id }, undefined, {
        version: '1.2.3', integrity: digest, certification: certification(),
      })
    }
    const maliciousArtifact = {
      version: '1.2.3', integrity: digest, certification: certification(),
    } as unknown as { readonly version: string; readonly integrity: `sha256:${string}` }
    const unregisterInjected = injected.value.register(
      identity,
      manifest(),
      { pluginId: identity.id, moduleGeneration: 'module-injected' },
      undefined,
      maliciousArtifact,
    )
    expect(injected.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      state: 'pending',
    })
    unregisterInjected()
  })

  it('atomically replaces exact Certified projections and rejects revision replay or equivocation', () => {
    const context = broker({})
    const exact = certification()

    context.value.replaceCertifiedPermissionSnapshot({ revision: 4, projections: [exact] })
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
    expect(context.domPrompts()).toBe(0)

    expect(() => context.value.replaceCertifiedPermissionSnapshot({ revision: 3, projections: [exact] }))
      .toThrow(/revision regressed/)
    expect(() => context.value.replaceCertifiedPermissionSnapshot({ revision: 4, projections: [] }))
      .toThrow(/equivocated/)
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
  })

  it('clears Certified leases and permits only the identical same-revision snapshot to restore the channel', () => {
    const context = broker({})
    const snapshot = { revision: 7, projections: [certification()] } as const

    context.value.replaceCertifiedPermissionSnapshot(snapshot)
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })

    context.value.clearCertifiedPermissionSnapshot()
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: false,
      state: 'pending',
    })
    expect(context.value.snapshots().find(item => item.scope.extensionPoints?.[0] === 'sidebar.footer.menu'))
      .not.toHaveProperty('certification')

    context.value.replaceCertifiedPermissionSnapshot(snapshot)
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
    expect(() => context.value.replaceCertifiedPermissionSnapshot({ revision: 7, projections: [] }))
      .toThrow(/equivocated/)
  })

  it('keeps an exact persistent deny authoritative across snapshot clear and restore', async () => {
    const context = broker({})
    const snapshot = { revision: 9, projections: [certification()] } as const
    context.value.replaceCertifiedPermissionSnapshot(snapshot)

    await context.value.setDomPolicy(identity, 'workspace.toolbar.items', 'deny-persistent')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      policy: 'deny',
      reason: 'permission.denied-persistent',
    })

    context.value.clearCertifiedPermissionSnapshot()
    context.value.replaceCertifiedPermissionSnapshot(snapshot)
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      policy: 'deny',
      reason: 'permission.denied-persistent',
    })
    expect(context.domPrompts()).toBe(0)
  })

  it('invalidates leases on trust refresh, scope change, generation replacement, and unload', async () => {
    const context = broker({ certified: certification() })
    await expect(context.value.requestDomAccess(identity, 'sidebar.footer.menu')).resolves.toMatchObject({ authorized: true })
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({ authorized: true })

    context.value.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({ authorized: false, state: 'pending' })
    await context.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(context.domPrompts()).toBe(1)

    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.domPrompts()).toBe(2)
    expect(context.value.snapshots().filter(item => item.capability === 'ui.extension-points.render')).toHaveLength(2)

    context.unregister()
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({ authorized: false, state: 'denied' })

    const replacement = broker({ certified: certification(), generation: 'runtime-2', moduleGeneration: 'module-2' })
    expect(replacement.value.snapshots().filter(item => item.capability === 'ui.extension-points.render')).toEqual([])
    expect(replacement.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'certified-implicit',
    })
  })

  it('keeps persistent deny and profile-scoped policy authoritative over certification', async () => {
    const store = new MemoryPermissionPolicyStore()
    const first = broker({ certified: certification(), store, domChoice: 'deny-persistent' })
    await expect(first.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({ authorized: true })
    // Certified implicit approval does not create a persistent policy, so the user can still set an exact deny.
    await first.value.setDomPolicy(identity, 'workspace.toolbar.items', 'deny-persistent')
    await expect(first.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({ authorized: false, policy: 'deny' })

    const sameProfile = broker({ certified: certification(), store, generation: 'runtime-2', moduleGeneration: 'module-2' })
    await expect(sameProfile.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({ authorized: false, policy: 'deny' })
    const otherProfile = broker({ certified: certification(), store, profile: 'other', generation: 'runtime-3', moduleGeneration: 'module-3' })
    await expect(otherProfile.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({ authorized: true })
  })

  it('keeps allow-once leases exact when another point policy changes', async () => {
    const context = broker({})
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    await context.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(context.domPrompts()).toBe(2)

    await context.value.setDomPolicy(identity, 'workspace.toolbar.items', 'deny-persistent')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({ authorized: false, policy: 'deny' })
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'explicit-user',
    })
  })

  it('keeps explicit-user DOM provenance across unrelated certification refreshes', async () => {
    const context = broker({})
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.value.snapshots()).toContainEqual(expect.objectContaining({
      scope: { extensionPoints: ['workspace.toolbar.items'] },
      authorizationOrigin: 'explicit-user',
    }))

    context.value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: true,
      authorizationOrigin: 'explicit-user',
    })
    expect(context.value.snapshots()).toContainEqual(expect.objectContaining({
      scope: { extensionPoints: ['workspace.toolbar.items'] },
      authorizationOrigin: 'explicit-user',
    }))

    context.value.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    expect(context.value.snapshots()).toContainEqual(expect.objectContaining({
      scope: { extensionPoints: ['workspace.toolbar.items'] },
      authorizationOrigin: 'explicit-user',
    }))
  })

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
        requestV3: async plan => { prompted.push(plan); return explicitV3(plan, 'allow-once') },
      },
    )
    const unregisterActive = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-1',
    }, undefined, { version: '1.2.3', integrity: oldDigest })
    const handle = visibility.begin('update-certified-dom', previous, next)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_GENERATION]: 'module-2',
      ...visibility.context(handle, identity.id),
    })
    const candidateView = visibility.view(candidateContext)
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    const unregisterCandidate = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-2',
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
    }, candidateView, { version: '1.2.3', integrity: digest })

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
        requestV3: async plan => { prompted.push(plan); return explicitV3(plan, 'allow-once') },
      },
    )
    value.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    const unregisterOld = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-1',
    }, undefined, { version: '1.2.3', integrity: digest })
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
    const unregisterNew = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-2',
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
    }, candidateView, { version: '1.2.3', integrity: newDigest })
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
          return await new Promise(resolve => { resolveDecision = resolve })
        },
      },
    )
    const unregister = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-stale',
    }, undefined, { version: '1.2.3', integrity: digest })
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
    const persistStarted = new Promise<void>(resolve => { markPersistStarted = resolve })
    let releasePersist: (() => void) | undefined
    const persistRelease = new Promise<void>(resolve => { releasePersist = resolve })
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
    const unregister = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-persist-stale',
    }, undefined, { version: '1.2.3', integrity: digest })
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
    unregister = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-observer-stale',
    }, undefined, { version: '1.2.3', integrity: digest })

    await expect(value.requestDomAccess(identity, 'main')).resolves.toMatchObject({
      authorized: false,
      state: 'denied',
      reason: 'permission.generation-invalidated',
    })
    expect(value.domAccess(identity, 'main')).toMatchObject({ authorized: false, state: 'denied' })
    expect(value.snapshots()).toEqual([])
  })

  it('removes the exact Host DOM review overlay immediately when its generation unloads', async () => {
    const instance = new JSDOM('<!doctype html><html class="electron-light"><body></body></html>', {
      pretendToBeVisual: true,
    })
    Object.defineProperty(instance.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
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
    const unregister = value.register(identity, manifest(), {
      pluginId: identity.id,
      moduleGeneration: 'module-dialog-stale',
    }, undefined, { version: '1.2.3', integrity: digest })
    const pending = value.requestDomAccess(identity, 'main')
    await Promise.resolve()
    await Promise.resolve()
    expect(instance.window.document.querySelector('[data-permission-authorization]')).not.toBeNull()

    unregister()
    expect(instance.window.document.querySelector('[data-permission-authorization]')).toBeNull()
    await expect(pending).resolves.toMatchObject({
      authorized: false,
      state: 'denied',
      reason: 'permission.generation-invalidated',
    })
    value.dispose()
    instance.window.close()
  })

  it('expires a certified lease and falls back to explicit review', async () => {
    let now = new Date('2026-08-30T12:00:00.000Z')
    const context = broker({ certified: certification(), now: () => now })
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.domPrompts()).toBe(0)
    now = new Date('2026-10-01T00:00:00.000Z')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({ authorized: false, state: 'pending' })
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

    for (let attempt = 0; attempt < 100 && context.value.snapshots().some(item => item.certification !== undefined); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(context.value.snapshots().find(item => item.capability === 'ui.extension-points.render')).not.toHaveProperty('certification')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({ authorized: false, state: 'pending' })
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
    const points = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore(), 'runtime-1', undefined, {
      access: (owner, pointId, view) => context.value.domAccess(owner, pointId, view),
      policy: (owner, pointId) => context.value.domPolicy(owner, pointId),
      policies: () => context.value.domPolicies(),
    })
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
})
