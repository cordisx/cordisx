import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  type CordisXCapabilityDeclarationV4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionAuthorizationPlanV5,
  type CordisXPluginManifestV5,
} from '../packages/cli/src/permission-contracts.js'
import { sha256Hex } from '../packages/cli/src/permission-model-v2.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import {
  MemoryPermissionPolicyStore,
  PermissionBroker,
  normalizePluginManifest,
  type PermissionAuthorizationPromptV2,
  type PermissionPolicyStore,
} from '../packages/cli/src/renderer/platform.js'
import type { PluginConsolePermissionObserver } from '../packages/cli/src/renderer/plugin-console.js'

const identity = { source: 'https://plugins.example/host-dom', id: 'host-dom' } as const
const digest = `sha256:${'a'.repeat(64)}` as const
const require = createRequire(import.meta.url)
const protocolRoot = path.resolve(path.dirname(require.resolve('@cordisx/protocol/host-dom/v1')), '..')

async function formalPermissionV4Validators(): Promise<{
  manifest: ValidateFunction
  plan: ValidateFunction
  decision: ValidateFunction
}> {
  const names = [
    'channel-common.v1.schema.json',
    'extension-point-common.v1.schema.json',
    'host-dom-common.v1.schema.json',
    'marketplace-certified-permission-projection.v1.schema.json',
    'permission-authorization-decision.v4.schema.json',
    'permission-authorization-plan.v5.schema.json',
    'permission-common.v4.schema.json',
    'platform-model.v1.schema.json',
    'platform-session.v1.schema.json',
    'plugin-lifecycle-common.v1.schema.json',
    'plugin-manifest.v4.schema.json',
    'plugin-manifest.v5.schema.json',
    'ui-common.v1.schema.json',
  ]
  const schemas = await Promise.all(names.map(async name => (
    JSON.parse(await readFile(path.join(protocolRoot, 'schemas', name), 'utf8')) as object
  )))
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const schema of schemas) ajv.addSchema(schema)
  const get = (name: string) => ajv.getSchema(`https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/${name}`)!
  return {
    manifest: get('plugin-manifest.v5.schema.json'),
    plan: get('permission-authorization-plan.v5.schema.json'),
    decision: get('permission-authorization-decision.v4.schema.json'),
  }
}

function expectFormal(validator: ValidateFunction, value: unknown): void {
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true)
}

function declaration(
  name: CordisXCapabilityDeclarationV4['name'],
  required: boolean,
  scope: CordisXCapabilityDeclarationV4['scope'],
): CordisXCapabilityDeclarationV4 {
  return {
    name,
    required,
    rationale: {
      title: { key: `${name}.title`, fallback: `Use ${name}` },
      description: { key: `${name}.description`, fallback: `The feature requires ${name}.` },
      feature: { key: `${name}.feature`, fallback: 'Host UI feature' },
      deniedBehavior: { key: `${name}.denied`, fallback: 'The feature stays unavailable.' },
    },
    security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
    scope,
  }
}

function manifest(capabilities: readonly CordisXCapabilityDeclarationV4[]): CordisXPluginManifestV5 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
    schemaVersion: 5,
    id: identity.id,
    capabilities,
    services: [],
  }, identity.id) as CordisXPluginManifestV5
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
    evidence: { kind: 'protected-marketplace-review' as const, reference: 'https://github.com/cordisx/marketplace/pull/123' },
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

function decisionV2(plan: CordisXPermissionAuthorizationPlanV2): CordisXPermissionAuthorizationDecisionV2 {
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

function decisionV4(
  plan: CordisXPermissionAuthorizationPlanV4 | CordisXPermissionAuthorizationPlanV5,
  selected: CordisXPermissionAuthorizationDecisionV4['decisions'][number]['decision'] = 'allow-once',
): CordisXPermissionAuthorizationDecisionV4 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
    schemaVersion: 4,
    origin: 'explicit-user',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: selected,
    })),
  }
}

function setup(input: {
  readonly certified?: CordisXCertifiedPermissionProjectionV1
  readonly store?: PermissionPolicyStore
  readonly moduleGeneration?: string
  readonly capabilities?: readonly CordisXCapabilityDeclarationV4[]
  readonly choice?: CordisXPermissionAuthorizationDecisionV4['decisions'][number]['decision']
  readonly onAudit?: (broker: PermissionBroker) => void
  readonly requestV4?: PermissionAuthorizationPromptV2['requestV4']
  readonly cancelV4?: PermissionAuthorizationPromptV2['cancelV4']
}) {
  let hostDomPrompts = 0
  let nonDomPrompts = 0
  const prompt: PermissionAuthorizationPromptV2 = {
    request: async plan => { nonDomPrompts += 1; return decisionV2(plan) },
    requestV4: async (plan, requestIdentity) => {
      hostDomPrompts += 1
      return input.requestV4 === undefined
        ? decisionV4(plan, input.choice)
        : await input.requestV4(plan, requestIdentity)
    },
    ...(input.cancelV4 === undefined ? {} : { cancelV4: input.cancelV4 }),
  }
  let broker!: PermissionBroker
  const observer: PluginConsolePermissionObserver | undefined = input.onAudit === undefined ? undefined : {
    permission: () => input.onAudit!(broker),
  }
  broker = new PermissionBroker(
    input.store ?? new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date('2026-08-30T12:00:00.000Z'),
    100,
    'work',
    'runtime-1',
    undefined,
    observer,
    prompt,
  )
  if (input.certified !== undefined) {
    broker.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [input.certified] })
  }
  const unregister = broker.register(
    identity,
    manifest(input.capabilities ?? [
      declaration('ui.host-dom.read', false, { rootIds: ['app.shell'], operations: ['inspect-structure', 'read-text'] }),
      declaration('ui.host-dom.modify', false, { rootIds: ['app.shell'], operations: ['set-text', 'focus'] }),
    ]),
    { pluginId: identity.id, moduleGeneration: input.moduleGeneration ?? 'module-1' },
    undefined,
    { version: '1.2.3', integrity: digest },
  )
  return { broker, unregister, hostDomPrompts: () => hostDomPrompts, nonDomPrompts: () => nonDomPrompts }
}

describe('manifest-v5 Host DOM permission model', () => {
  it('emits manifest, plan, and decision values accepted by the pinned formal Protocol schemas', async () => {
    const validators = await formalPermissionV4Validators()
    const normalizedManifest = manifest([
      declaration('models.read', false, { providers: ['codex'] }),
      declaration('ui.host-dom.read', false, { rootIds: ['app.shell'], operations: ['inspect-structure', 'read-text'] }),
    ])
    expectFormal(validators.manifest, normalizedManifest)
    const context = setup({ certified: certification(), capabilities: normalizedManifest.capabilities })
    const plan = context.broker.authorizationPlanV4(identity)!
    expectFormal(validators.plan, plan)
    expectFormal(validators.decision, decisionV4(plan))
  })

  it.each([
    ['ordinary', false, false, 2, 'explicit-user'],
    ['certified-only', true, false, 0, 'certified-implicit'],
    ['official-only', false, true, 2, 'explicit-user'],
    ['official-and-certified', true, true, 0, 'certified-implicit'],
  ] as const)('keeps the %s state composable without letting Official authorize', async (_state, certified, _official, promptCount, origin) => {
    // Official is intentionally absent from the Broker API and cannot affect either capability.
    const context = setup({ ...(certified ? { certified: certification() } : {}) })
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text']))
      .resolves.toMatchObject({ authorized: true, authorizationOrigin: origin })
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.modify', 'app.shell', ['focus']))
      .resolves.toMatchObject({ authorized: true, authorizationOrigin: origin })
    expect(context.hostDomPrompts()).toBe(promptCount)
    expect(context.broker.snapshots().filter(item => item.authorizationOrigin === origin)).toHaveLength(2)
  })

  it.each([
    ['ordinary', undefined, 1, undefined],
    ['certified-only', certification(), 0, 'certified-implicit'],
    ['official-only', undefined, 1, undefined],
    ['official-and-certified', certification(), 0, 'certified-implicit'],
  ] as const)('auto-authorizes declared non-DOM access only for the %s state', async (_state, certified, prompts, origin) => {
    const context = setup({
      ...(certified === undefined ? {} : { certified }),
      capabilities: [declaration('models.read', false, { providers: ['codex'] })],
    })
    await expect(context.broker.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({ ok: true })
    expect(context.nonDomPrompts()).toBe(prompts)
    expect(context.broker.snapshots().find(item => item.capability === 'models.read')?.authorizationOrigin).toBe(origin)
  })

  it('binds Certified auto approval to the exact Marketplace artifact', async () => {
    const mismatch = setup({})
    expect(() => mismatch.broker.replaceCertifiedPermissionSnapshot({
      revision: 1,
      projections: [certification({ integrity: `sha256:${'b'.repeat(64)}` })],
    })).toThrow(/invalid projection/)
    await mismatch.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    expect(mismatch.hostDomPrompts()).toBe(1)

    const forged = setup({})
    expect(() => forged.broker.replaceCertifiedPermissionSnapshot({
      revision: 1,
      projections: [certification({ fingerprint: `sha256:${'c'.repeat(64)}` })],
    })).toThrow(/invalid projection/)
    await forged.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    expect(forged.hostDomPrompts()).toBe(1)

  })

  it('keeps repeated Certified non-DOM calls dialog-free and restores normal review after source metadata removal', async () => {
    const exact = certification()
    const context = setup({
      certified: exact,
      capabilities: [declaration('models.read', false, { providers: ['codex'] })],
    })
    const plan = context.broker.authorizationPlanV4(identity)!
    expect(plan).toMatchObject({ schemaVersion: 5 })
    expect(plan.declarations).toEqual([expect.objectContaining({
      capability: 'models.read', authorizationMode: 'certified-implicit', decisionRequired: false,
      resourceClass: 'non-dom', certifiedImplicitApproval: false,
      certification: expect.objectContaining({ fingerprint: exact.fingerprint }),
    })])
    await context.broker.authorizeActivationV4(identity, decisionV4(plan))
    await expect(context.broker.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({ ok: true })
    await expect(context.broker.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({ ok: true })
    expect(context.nonDomPrompts()).toBe(0)
    expect(context.broker.snapshots()).toContainEqual(expect.objectContaining({
      capability: 'models.read',
      authorizationOrigin: 'certified-implicit',
      authorizationReason: 'Marketplace Certified source metadata auto-authorized by the Host',
      certification: expect.objectContaining({ fingerprint: exact.fingerprint }),
    }))

    context.broker.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    expect(context.broker.snapshots().find(item => item.capability === 'models.read')?.authorizationOrigin).toBeUndefined()
    await expect(context.broker.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({ ok: true })
    expect(context.nonDomPrompts()).toBe(1)
  })

  it('lets exact persistent deny override certification and forbids persistent modify allow', async () => {
    const context = setup({ certified: certification() })
    await context.broker.setHostDomPolicy(identity, 'ui.host-dom.read', 'deny-persistent')
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text']))
      .resolves.toMatchObject({ authorized: false, policy: 'deny', reason: 'permission.denied-persistent' })
    expect(context.hostDomPrompts()).toBe(0)
    await expect(context.broker.setHostDomPolicy(identity, 'ui.host-dom.modify', 'allow-persistent'))
      .rejects.toThrow(/does not permit persistent allow/)
  })

  it('lets an exact persistent non-DOM deny override Marketplace Certified metadata', async () => {
    const context = setup({
      certified: certification(),
      capabilities: [declaration('models.read', true, { providers: ['codex'] })],
    })
    await context.broker.setPolicyV2(identity, 'models.read', 'deny-persistent')
    expect(context.broker.authorizationPlanV4(identity)?.declarations[0]).toMatchObject({
      authorizationMode: 'persistent-policy', policy: 'deny-persistent', decisionRequired: false,
    })
    await expect(context.broker.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({
      ok: false, error: { code: 'permission-denied' },
    })
    expect(context.nonDomPrompts()).toBe(0)
  })

  it('rejects root/operation widening and invalidates Certified leases on refresh and generation unload', async () => {
    const context = setup({ certified: certification() })
    const allowed = await context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    expect(allowed).toMatchObject({ authorized: true, authorizationOrigin: 'certified-implicit' })
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'manager.surface', ['read-text']))
      .resolves.toMatchObject({ authorized: false, reason: 'permission.scope-denied' })
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-attributes']))
      .resolves.toMatchObject({ authorized: false, reason: 'permission.scope-denied' })

    context.broker.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    expect(context.broker.isHostDomLeaseActive(identity, allowed.lease!.leaseId)).toBe(false)
    await context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    expect(context.hostDomPrompts()).toBe(1)
    context.unregister()
    expect(context.broker.isHostDomLeaseActive(identity, allowed.lease!.leaseId)).toBe(false)
    expect(context.broker.snapshots()).toEqual([])
  })

  it('projects the Certified auto approval reason and evidence for Manager audit', async () => {
    const exact = certification()
    const context = setup({ certified: exact })
    await context.broker.authorizeHostDom(identity, 'ui.host-dom.modify', 'app.shell', ['focus'])
    expect(context.broker.snapshots()).toContainEqual(expect.objectContaining({
      capability: 'ui.host-dom.modify',
      authorizationOrigin: 'certified-implicit',
      authorizationReason: 'Exact Certified artifact auto-approved by the Host catalog',
      certification: expect.objectContaining({ fingerprint: exact.fingerprint, revision: exact.revision }),
    }))
  })

  it.each(['certified', 'explicit'] as const)('fails closed when a reentrant audit observer invalidates a %s grant', async origin => {
    let invalidated = false
    const context = setup({
      ...(origin === 'certified' ? { certified: certification() } : {}),
      onAudit: broker => {
        if (invalidated) return
        invalidated = true
        if (origin === 'certified') broker.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
        else broker.clearOnce(identity)
      },
    })
    await expect(context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text']))
      .resolves.toMatchObject({ authorized: false, state: 'denied', reason: 'permission.grant-invalidated' })
    expect(context.broker.snapshots().find(item => item.capability === 'ui.host-dom.read')?.authorizationOrigin)
      .toBeUndefined()
  })

  it('uses unique plan ids and cancels every pending prompt when the generation unloads', async () => {
    const plans: CordisXPermissionAuthorizationPlanV4[] = []
    const cancelled: string[] = []
    const context = setup({
      requestV4: async plan => await new Promise(resolve => { plans.push(plan); void resolve }),
      cancelV4: planId => { cancelled.push(planId) },
    })
    const first = context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    const second = context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    await Promise.resolve()
    expect(plans).toHaveLength(2)
    expect(new Set(plans.map(plan => plan.planId)).size).toBe(2)
    context.unregister()
    await expect(first).resolves.toMatchObject({ authorized: false, reason: 'permission.generation-invalidated' })
    await expect(second).resolves.toMatchObject({ authorized: false, reason: 'permission.generation-invalidated' })
    expect(new Set(cancelled)).toEqual(new Set(plans.map(plan => plan.planId)))
  })

  it('cancels a pending prompt when an exact persistent deny arrives', async () => {
    const context = setup({ requestV4: async () => await new Promise(() => {}) })
    const pending = context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    await Promise.resolve()
    await context.broker.setHostDomPolicy(identity, 'ui.host-dom.read', 'deny-persistent')
    await expect(pending).resolves.toMatchObject({ authorized: false, reason: 'permission.denied-persistent', policy: 'deny' })
  })

  it('revokes an already issued concurrent lease when another prompt commits persistent deny', async () => {
    const plans: CordisXPermissionAuthorizationPlanV4[] = []
    const resolvers: Array<(decision: CordisXPermissionAuthorizationDecisionV4) => void> = []
    const context = setup({
      requestV4: async plan => await new Promise(resolve => { plans.push(plan); resolvers.push(resolve) }),
    })
    const denying = context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    const allowing = context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    await Promise.resolve()
    resolvers[1]!(decisionV4(plans[1]!, 'allow-once'))
    const granted = await allowing
    expect(granted).toMatchObject({ authorized: true })
    resolvers[0]!(decisionV4(plans[0]!, 'deny-persistent'))
    await expect(denying).resolves.toMatchObject({ authorized: false, policy: 'deny' })
    expect(context.broker.isHostDomLeaseActive(identity, granted.lease!.leaseId)).toBe(false)
  })

  it('clears a lease minted from an optimistic policy when persistence rolls back', async () => {
    let rejectWrite: ((error: Error) => void) | undefined
    const backing = new MemoryPermissionPolicyStore()
    const store: PermissionPolicyStore = {
      read: () => backing.read(),
      readV2: () => backing.readV2(),
      readV3: () => backing.readV3(),
      readV4: () => backing.readV4(),
      write: records => backing.write(records),
      writeV2: records => backing.writeV2(records),
      writeV3: records => backing.writeV3(records),
      writeV4: async () => await new Promise<void>((_resolve, reject) => { rejectWrite = reject }),
    }
    const context = setup({ store })
    const persistence = context.broker.setHostDomPolicy(identity, 'ui.host-dom.read', 'allow-persistent')
    await Promise.resolve()
    const granted = await context.broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'])
    expect(granted).toMatchObject({ authorized: true, policy: 'allow' })
    rejectWrite!(new Error('disk full'))
    await expect(persistence).rejects.toThrow('disk full')
    expect(context.broker.isHostDomLeaseActive(identity, granted.lease!.leaseId)).toBe(false)
  })

  it('keeps the new generation audit when the retiring generation unregisters', async () => {
    const activation = (revision: number, moduleGeneration: string) => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: revision === 1 ? 'active' as const : 'candidate' as const,
      ...(revision === 1 ? {} : { transactionId: 'host-dom-update' }),
      profileId: 'work',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{ id: identity.id, version: '1.2.3', digest, moduleGeneration, enabled: true, dependencies: [] }],
    })
    const previous = activation(1, 'module-1')
    const next = activation(2, 'module-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date('2026-08-30T12:00:00.000Z'),
      100,
      'work',
      'runtime-1',
      visibility,
      undefined,
      { request: async plan => decisionV2(plan), requestV4: async plan => decisionV4(plan) },
    )
    broker.replaceCertifiedPermissionSnapshot({ revision: 1, projections: [certification()] })
    const unregisterOld = broker.register(identity, manifest([
      declaration('ui.host-dom.read', false, { rootIds: ['app.shell'], operations: ['read-text'] }),
    ]), { pluginId: identity.id, moduleGeneration: 'module-1' }, undefined, { version: '1.2.3', integrity: digest })
    const handle = visibility.begin('host-dom-update', previous, next)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_GENERATION]: 'module-2',
      ...visibility.context(handle, identity.id),
    })
    const candidateView = visibility.view(candidateContext)
    const unregisterNew = broker.register(identity, manifest([
      declaration('ui.host-dom.read', false, { rootIds: ['app.shell'], operations: ['read-text'] }),
    ]), {
      pluginId: identity.id,
      moduleGeneration: 'module-2',
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
    }, candidateView, { version: '1.2.3', integrity: digest })
    await expect(broker.authorizeHostDom(identity, 'ui.host-dom.read', 'app.shell', ['read-text'], candidateView))
      .resolves.toMatchObject({ authorized: true, authorizationOrigin: 'certified-implicit' })
    const publication = visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(broker.snapshots()).toContainEqual(expect.objectContaining({
      capability: 'ui.host-dom.read', authorizationOrigin: 'certified-implicit',
    }))
    unregisterOld()
    expect(broker.snapshots()).toContainEqual(expect.objectContaining({
      capability: 'ui.host-dom.read',
      authorizationOrigin: 'certified-implicit',
      authorizationReason: 'Exact Certified artifact auto-approved by the Host catalog',
    }))
    visibility.completeLastGood(publication)
    unregisterNew()
  })
})
import { Context } from '@deepseek-ai/cordis'
