import { describe, expect, it } from 'vitest'
import { ServiceRendererLifecycleProjection } from '../packages/cli/src/cli/service-renderer-lifecycle-projection.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 } from '../packages/cli/src/usage-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'
import { permissionSecurityFingerprint } from '../packages/cli/src/permission-model-v2.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const alias = (char: string) => `https://renderer.cordisx.invalid/plugin/${char.repeat(64)}`
const provider = {
  id: 'provider',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}` as const,
  moduleGeneration: 'provider-1',
  enabled: true,
  dependencies: [],
  canonicalSource: 'https://example.test/provider',
}
const extra = {
  id: 'extra',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}` as const,
  moduleGeneration: 'extra-1',
  enabled: true,
  dependencies: [],
  canonicalSource: 'https://example.test/extra',
}
const previous: CordisXPluginActivationRecordV1 = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1,
  recordKind: 'active',
  profileId: 'default',
  revision: 3,
  lastGoodRevision: 3,
  runtimeGeneration: 'generation',
  plugins: [provider],
}
const candidate: CordisXPluginActivationRecordV1 = {
  ...previous,
  recordKind: 'candidate',
  transactionId: 'change-1',
  revision: 4,
  plugins: [provider, extra],
}

function setup(first = '1', second = '2') {
  const firstAlias = alias(first)
  const secondAlias = alias(second)
  const rendererPrevious = { ...previous, plugins: [{ ...provider, canonicalSource: firstAlias }] }
  const rendererCandidate = {
    ...candidate,
    plugins: [{ ...provider, canonicalSource: firstAlias }, { ...extra, canonicalSource: secondAlias }],
  }
  const identities = new Map([
    [firstAlias, { pluginId: provider.id, source: provider.canonicalSource, digest: provider.digest }],
    [secondAlias, { pluginId: extra.id, source: extra.canonicalSource, digest: extra.digest }],
  ])
  let live = true
  const projection = new ServiceRendererLifecycleProjection({
    owner: { active: previous, registryEpoch: 7 },
    renderer: { active: rendererPrevious, registryEpoch: 7 },
    rendererId: 'seat',
    current: () => live,
    resolve: (value, id) => {
      const found = identities.get(value)
      if (!found || found.pluginId !== id) throw new Error('unknown owner-issued alias')
      return found
    },
  })
  const sync = projection.project('synchronize', { active: previous, registryEpoch: 7 })
  expect(sync.receipt!(sync.payload)).toEqual({ active: previous, registryEpoch: 7 })
  const offer = () =>
    projection.offer({
      transactionId: 'change-1',
      targetId: 'extra',
      affectedPluginIds: ['extra'],
      previous,
      candidate,
      projectedCandidate: rendererCandidate,
    })
  const prepare = () => {
    const value = { transactionId: 'change-1', transactionEpoch: 'change-1:epoch', expectedRegistryEpoch: 7 }
    const command = projection.project('prepare', value)
    expect(command.receipt!(command.payload)).toEqual(value)
  }
  const stage = (extra: Record<string, unknown> = {}) => {
    const value = {
      rendererId: 'seat',
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      operation: 'install',
      targetId: 'extra',
      affectedPluginIds: ['extra'],
      previous: rendererPrevious,
      candidate: rendererCandidate,
      privateGraphs: [],
      ...extra,
    }
    return projection.project('stage', value)
  }
  const stagedReceipt = {
    transactionId: 'change-1',
    transactionEpoch: 'change-1:epoch',
    expectedRegistryEpoch: 7,
    afterRegistryEpoch: 8,
    affectedPluginIds: ['extra'],
    observation: rendererCandidate,
  }
  return {
    projection,
    rendererPrevious,
    rendererCandidate,
    offer,
    prepare,
    stage,
    stagedReceipt,
    stop: () => live = false,
  }
}

it('accepts only owner-issued document grants for the exact candidate generation', () => {
  const grant = { source: alias('2'), pluginId: 'extra', moduleGeneration: 'extra-1', token: 'c'.repeat(64) }
  const valid = setup()
  valid.offer()
  valid.prepare()
  expect(valid.stage({ ownerDocumentBindings: [grant] }).payload).toMatchObject({ ownerDocumentBindings: [grant] })
  for (
    const bad of [
      { ...grant, source: 'https://example.test/extra' },
      { ...grant, source: alias('1') },
      { ...grant, moduleGeneration: 'old' },
      { ...grant, token: 'short' },
      { ...grant, extra: true },
    ]
  ) {
    const rejected = setup()
    rejected.offer()
    rejected.prepare()
    expect(() => rejected.stage({ ownerDocumentBindings: [bad] })).toThrow()
  }
})

describe('owner-scoped lifecycle identity observations', () => {
  it('accepts the same affected plugins in execution order without accepting a different impact', () => {
    const ownerActive = { ...previous, plugins: [provider, extra] }
    const rendererActive = {
      ...ownerActive,
      plugins: [{ ...provider, canonicalSource: alias('1') }, { ...extra, canonicalSource: alias('2') }],
    }
    const ownerCandidate: CordisXPluginActivationRecordV1 = {
      ...ownerActive,
      recordKind: 'candidate',
      transactionId: 'disable-1',
      revision: 4,
      plugins: ownerActive.plugins.map(item => ({ ...item, enabled: false })),
    }
    const rendererCandidate = {
      ...ownerCandidate,
      plugins: rendererActive.plugins.map(item => ({ ...item, enabled: false })),
    }
    const make = () => {
      const projection = new ServiceRendererLifecycleProjection({
        owner: { active: ownerActive, registryEpoch: 7 },
        renderer: { active: rendererActive, registryEpoch: 7 },
        rendererId: 'seat',
        current: () => true,
        resolve: (value, id) => {
          const item = value === alias('1') && id === provider.id ? provider : value === alias('2') && id === extra.id
            ? extra
            : undefined
          if (!item) throw new Error('unknown owner-issued alias')
          return { source: item.canonicalSource, digest: item.digest }
        },
      })
      const sync = projection.project('synchronize', { active: ownerActive, registryEpoch: 7 })
      sync.receipt!(sync.payload)
      projection.offer({
        transactionId: 'disable-1',
        targetId: 'provider',
        affectedPluginIds: ['provider', 'extra'],
        previous: ownerActive,
        candidate: ownerCandidate,
        projectedCandidate: rendererCandidate,
      })
      const prepare = projection.project('prepare', {
        transactionId: 'disable-1',
        transactionEpoch: 'disable-1:epoch',
        expectedRegistryEpoch: 7,
      })
      prepare.receipt!(prepare.payload)
      return projection
    }
    const stage = (affectedPluginIds: string[]) => ({
      rendererId: 'seat',
      transactionId: 'disable-1',
      transactionEpoch: 'disable-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      operation: 'disable',
      targetId: 'provider',
      affectedPluginIds,
      previous: rendererActive,
      candidate: rendererCandidate,
      privateGraphs: [],
    })
    const affected = ['extra', 'provider']
    const command = make().project('stage', stage(affected))
    const receipt = {
      transactionId: 'disable-1',
      transactionEpoch: 'disable-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      affectedPluginIds: affected,
      observation: rendererCandidate,
    }
    expect(command.receipt!(receipt)).toEqual({ ...receipt, observation: ownerCandidate })
    const wrongReceiptOrder = make().project('stage', stage(affected))
    expect(() => wrongReceiptOrder.receipt!({ ...receipt, affectedPluginIds: ['provider', 'extra'] }))
      .toThrow('renderer-identity-receipt-invalid')
    for (const invalid of [['provider', 'provider'], ['provider'], ['provider', 'other']]) {
      expect(() => make().project('stage', stage(invalid))).toThrow('renderer-identity-lifecycle-unavailable')
    }
  })

  it('includes unchanged dependents in the owner-computed impact when enabling a plugin', () => {
    const disabledProvider = { ...provider, enabled: false }
    const disabledDependent = {
      ...extra,
      enabled: false,
      dependencies: [{ id: provider.id, version: provider.version }],
    }
    const ownerActive = { ...previous, plugins: [disabledProvider, disabledDependent] }
    const rendererActive = {
      ...ownerActive,
      plugins: [
        { ...disabledProvider, canonicalSource: alias('1') },
        { ...disabledDependent, canonicalSource: alias('2') },
      ],
    }
    const ownerCandidate: CordisXPluginActivationRecordV1 = {
      ...ownerActive,
      recordKind: 'candidate',
      transactionId: 'enable-1',
      revision: 4,
      plugins: [{ ...disabledProvider, enabled: true, moduleGeneration: 'provider-2' }, disabledDependent],
    }
    const rendererCandidate = {
      ...ownerCandidate,
      plugins: [
        { ...ownerCandidate.plugins[0]!, canonicalSource: alias('1') },
        { ...disabledDependent, canonicalSource: alias('2') },
      ],
    }
    const make = () => {
      const projection = new ServiceRendererLifecycleProjection({
        owner: { active: ownerActive, registryEpoch: 7 },
        renderer: { active: rendererActive, registryEpoch: 7 },
        rendererId: 'seat',
        current: () => true,
        resolve: (value, id) => {
          const item = value === alias('1') && id === provider.id ? provider : value === alias('2') && id === extra.id
            ? extra
            : undefined
          if (!item) throw new Error('unknown owner-issued alias')
          return { source: item.canonicalSource, digest: item.digest }
        },
      })
      const sync = projection.project('synchronize', { active: ownerActive, registryEpoch: 7 })
      sync.receipt!(sync.payload)
      return projection
    }
    const offer = (affectedPluginIds: string[]) => ({
      transactionId: 'enable-1',
      targetId: 'provider',
      affectedPluginIds,
      previous: ownerActive,
      candidate: ownerCandidate,
      projectedCandidate: rendererCandidate,
    })
    const projection = make()
    projection.offer(offer(['extra', 'provider']))
    const prepare = projection.project('prepare', {
      transactionId: 'enable-1',
      transactionEpoch: 'enable-1:epoch',
      expectedRegistryEpoch: 7,
    })
    prepare.receipt!(prepare.payload)
    const command = projection.project('stage', {
      rendererId: 'seat',
      transactionId: 'enable-1',
      transactionEpoch: 'enable-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      operation: 'enable',
      targetId: 'provider',
      affectedPluginIds: ['extra', 'provider'],
      previous: rendererActive,
      candidate: rendererCandidate,
      privateGraphs: [],
    })
    const receipt = {
      transactionId: 'enable-1',
      transactionEpoch: 'enable-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      affectedPluginIds: ['extra', 'provider'],
      observation: rendererCandidate,
    }
    expect(command.receipt!(receipt)).toEqual({ ...receipt, observation: ownerCandidate })
    expect(() => make().offer(offer(['provider']))).toThrow('renderer-identity-lifecycle-unavailable')
    expect(() => make().offer(offer(['extra', 'provider', 'other'])))
      .toThrow('renderer-identity-lifecycle-unavailable')
  })

  it('maps the confirmed stage, publication and cleanup back to the owner and advances the snapshot', () => {
    const f = setup()
    expect(f.projection.confirmedSnapshot()).toEqual({ active: previous, registryEpoch: 7 })
    f.offer()
    expect(f.projection.confirmedSnapshot()).toBeUndefined()
    f.prepare()
    expect(f.projection.discard('change-1')).toBe(false)
    const stage = f.stage()
    expect(JSON.stringify(stage.payload)).not.toContain(provider.canonicalSource)
    expect(stage.receipt!(f.stagedReceipt)).toEqual({ ...f.stagedReceipt, observation: candidate })
    const publish = f.projection.project('publish', { transactionId: 'change-1' })
    const projectedPublication = {
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      registryEpoch: 8,
      active: f.rendererCandidate,
      retiring: f.rendererPrevious,
      notificationErrors: [],
    }
    expect(publish.receipt!(projectedPublication)).toEqual({
      ...projectedPublication,
      active: candidate,
      retiring: previous,
    })
    const complete = f.projection.project('complete', { transactionId: 'change-1' })
    const projectedCleanup = {
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      registryEpoch: 8,
      active: f.rendererCandidate,
      disposedAfter: f.rendererPrevious,
    }
    expect(complete.receipt!(projectedCleanup)).toEqual({
      ...projectedCleanup,
      active: candidate,
      disposedAfter: previous,
    })
    const finalize = f.projection.project('finalize', { transactionId: 'change-1' })
    expect(finalize.receipt!(finalize.payload)).toEqual({ transactionId: 'change-1' })
    const { transactionId: _id, ...ownerActive } = candidate
    const { transactionId: _rendererId, ...rendererActive } = f.rendererCandidate
    void _id
    void _rendererId
    const next = { active: { ...ownerActive, recordKind: 'active', lastGoodRevision: 4 }, registryEpoch: 8 }
    expect(f.projection.confirmedSnapshot()).toEqual(next)
    const sync = f.projection.project('synchronize', next)
    expect(sync.payload).toEqual({
      active: { ...rendererActive, recordKind: 'active', lastGoodRevision: 4 },
      registryEpoch: 8,
    })
    expect(sync.receipt!(sync.payload)).toEqual(next)
  })

  it('projects rollback and the durable recovery revision without exposing another page identity', () => {
    const f = setup()
    f.offer()
    f.prepare()
    f.stage().receipt!(f.stagedReceipt)
    const expected = {
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      registryEpoch: 9,
      active: previous,
      disposedAfter: candidate,
    }
    const rollback = f.projection.project('rollback', { transactionId: 'change-1', expected })
    expect(rollback.payload).toEqual({
      transactionId: 'change-1',
      expected: { ...expected, active: f.rendererPrevious, disposedAfter: f.rendererCandidate },
    })
    expect(rollback.receipt!((rollback.payload as any).expected)).toEqual(expected)
    const recovered = { active: { ...previous, revision: 5, lastGoodRevision: 3 }, registryEpoch: 9 }
    const sync = f.projection.project('synchronize', recovered)
    expect(sync.payload).toEqual({
      active: { ...f.rendererPrevious, revision: 5, lastGoodRevision: 3 },
      registryEpoch: 9,
    })
    expect(sync.receipt!(sync.payload)).toEqual(recovered)
  })

  it('rejects a receipt from a different renderer before the owner advances', () => {
    const first = setup('1', '2')
    const second = setup('3', '4')
    first.offer()
    first.prepare()
    const stage = first.stage()
    expect(() => stage.receipt!({ ...first.stagedReceipt, observation: second.rendererCandidate }))
      .toThrow('renderer-identity-receipt-invalid')
    expect(() => first.projection.project('publish', { transactionId: 'change-1' }))
      .toThrow('renderer-identity-lifecycle-unavailable')
  })

  it('rejects source or permission data that was not projected for the candidate', () => {
    const f = setup()
    f.offer()
    f.prepare()
    const payload = {
      rendererId: 'seat',
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      operation: 'install',
      targetId: 'extra',
      affectedPluginIds: ['extra'],
      previous: f.rendererPrevious,
      candidate: f.rendererCandidate,
      privateGraphs: [],
      package: {
        digest: extra.digest,
        identitySource: alias('2'),
        manifest: {
          id: extra.id,
          version: extra.version,
          canonicalSource: alias('2'),
          runtimeManifest: {
            $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
            schemaVersion: 1,
            id: extra.id,
            capabilities: [],
          },
        },
      },
      authorizationDecision: { schemaVersion: 1, identity: { pluginId: extra.id, source: alias('2') }, decisions: [] },
    }
    expect(() =>
      f.projection.project('stage', {
        ...payload,
        package: { ...payload.package, identitySource: extra.canonicalSource },
      })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    expect(() =>
      f.projection.project('stage', {
        ...payload,
        authorizationDecision: { ...payload.authorizationDecision, decisions: [{ decision: 'allow' }] },
      })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    expect(() =>
      f.projection.project('stage', {
        ...payload,
        package: { ...payload.package, identitySource: alias('f') },
      })
    ).toThrow()
    const stage = f.projection.project('stage', payload)
    expect(stage.receipt!(f.stagedReceipt)).toMatchObject({ observation: candidate })

    const modern = setup()
    modern.offer()
    modern.prepare()
    const decision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
      schemaVersion: 7,
      origin: 'host-no-decision',
      planId: `${candidate.runtimeGeneration}:${extra.id}`,
      operation: 'install',
      profileId: candidate.profileId,
      identity: { pluginId: extra.id, source: alias('2') },
      binding: {
        operationId: `review:${'c'.repeat(64)}`,
        runtimeGeneration: candidate.runtimeGeneration,
        moduleGeneration: extra.moduleGeneration,
        requestId: candidate.transactionId,
      },
      decisions: [],
    }
    for (
      const invalid of [
        { ...decision, origin: 'explicit-user' },
        { ...decision, decisions: [{ decision: 'allow' }] },
        { ...decision, identity: { ...decision.identity, source: alias('1') } },
        { ...decision, binding: { ...decision.binding, requestId: 'another-transaction' } },
        { ...decision, binding: { ...decision.binding, moduleGeneration: 'another-generation' } },
        { ...decision, $schema: 'unknown' },
        { ...decision, extra: 'unexpected' },
      ]
    ) {
      expect(() => modern.projection.project('stage', { ...payload, authorizationDecision: invalid }))
        .toThrow()
    }
    expect(() =>
      modern.projection.project('stage', { ...payload, package: undefined, authorizationDecision: decision })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    const accepted = modern.projection.project('stage', { ...payload, authorizationDecision: decision })
    expect(accepted.receipt!(modern.stagedReceipt)).toMatchObject({ observation: candidate })
  })

  it('rejects stale, unissued and incomplete candidates before any command is dispatched', () => {
    const f = setup()
    const invalid = {
      ...f.rendererCandidate,
      plugins: [{ ...provider, canonicalSource: alias('f') }, f.rendererCandidate.plugins[1]!],
    }
    expect(() =>
      f.projection.offer({
        transactionId: 'change-1',
        targetId: 'extra',
        affectedPluginIds: ['extra'],
        previous,
        candidate,
        projectedCandidate: invalid,
      })
    ).toThrow()
    expect(() =>
      f.projection.offer({
        transactionId: 'change-1',
        targetId: 'extra',
        affectedPluginIds: ['provider'],
        previous,
        candidate,
        projectedCandidate: f.rendererCandidate,
      })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    f.offer()
    expect(() =>
      f.projection.project('prepare', {
        transactionId: 'change-1',
        transactionEpoch: 'change-1:epoch',
        expectedRegistryEpoch: 8,
      })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    f.stop()
    expect(() => f.projection.project('prepare', {})).toThrow('renderer-identity-lifecycle-unavailable')
  })

  it('projects an owner-verified visual candidate without accepting other capabilities', () => {
    const f = setup()
    f.offer()
    f.prepare()
    const runtime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
      schemaVersion: 11,
      id: extra.id,
      name: 'Visual fixture',
      services: [],
      capabilities: [
        { name: 'ui.extension-points.render', required: true, scope: { extensionPoints: ['composer.frame.overlay'] } },
        { name: 'usage.read', required: false, scope: { profile: 'current' } },
      ],
    }
    const payload = {
      rendererId: 'seat',
      transactionId: 'change-1',
      transactionEpoch: 'change-1:epoch',
      expectedRegistryEpoch: 7,
      afterRegistryEpoch: 8,
      operation: 'install',
      targetId: 'extra',
      affectedPluginIds: ['extra'],
      previous: f.rendererPrevious,
      candidate: f.rendererCandidate,
      privateGraphs: [],
      package: {
        digest: extra.digest,
        identitySource: alias('2'),
        manifest: { id: extra.id, version: extra.version, canonicalSource: alias('2'), runtimeManifest: runtime },
      },
      authorizationDecision: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
        schemaVersion: 7,
        origin: 'host-no-decision',
        planId: `${candidate.runtimeGeneration}:${extra.id}`,
        operation: 'install',
        profileId: candidate.profileId,
        identity: { pluginId: extra.id, source: alias('2') },
        binding: {
          operationId: `review:${'c'.repeat(64)}`,
          runtimeGeneration: candidate.runtimeGeneration,
          moduleGeneration: extra.moduleGeneration,
          requestId: candidate.transactionId,
        },
        decisions: [],
      },
    }
    const changed = (capabilities: unknown[]) => ({
      ...payload,
      package: {
        ...payload.package,
        manifest: { ...payload.package.manifest, runtimeManifest: { ...runtime, capabilities } },
      },
    })
    expect(() =>
      f.projection.project('stage', changed([{ name: 'usage.read', required: true, scope: { profile: 'current' } }]))
    )
      .toThrow('renderer-identity-lifecycle-unavailable')
    const requiredModel = setup()
    requiredModel.offer()
    requiredModel.prepare()
    const requiredModelStage = requiredModel.projection.project(
      'stage',
      changed([{ name: 'models.read', required: true, scope: {} }]),
    )
    expect(requiredModelStage.receipt!(requiredModel.stagedReceipt)).toMatchObject({ observation: candidate })
    const models = setup()
    models.offer()
    models.prepare()
    const modelStage = models.projection.project(
      'stage',
      changed([{ name: 'models.read', required: false, scope: {} }]),
    )
    expect(modelStage.receipt!(models.stagedReceipt)).toMatchObject({ observation: candidate })
    const session = setup()
    session.offer()
    session.prepare()
    const sessionRuntime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: extra.id,
      services: [],
      capabilities: [{ name: 'sessions.get', required: false, scope: {} }],
    }
    const sessionStage = {
      ...payload,
      package: {
        ...payload.package,
        manifest: { ...payload.package.manifest, runtimeManifest: sessionRuntime },
      },
    }
    expect(() =>
      session.projection.project('stage', {
        ...sessionStage,
        package: {
          ...sessionStage.package,
          manifest: {
            ...sessionStage.package.manifest,
            runtimeManifest: { ...sessionRuntime, capabilities: [{ name: 'sessions.get', required: true, scope: {} }] },
          },
        },
      })
    ).toThrow('renderer-identity-lifecycle-unavailable')
    const acceptedSession = session.projection.project('stage', sessionStage)
    expect(acceptedSession.receipt!(session.stagedReceipt)).toMatchObject({ observation: candidate })
    const stage = f.projection.project('stage', payload)
    expect(stage.receipt!(f.stagedReceipt)).toMatchObject({ observation: candidate })
  })

  it('projects only the exact one-time model choice for the current candidate', () => {
    const declaration = { name: 'models.read' as const, required: true, scope: { providers: ['codex'] } }
    const runtime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: extra.id,
      services: [],
      capabilities: [declaration],
    }
    const choice = {
      capability: declaration.name,
      scope: declaration.scope,
      securityFingerprint: permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, declaration),
      decision: 'allow-once',
    }
    const decision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
      schemaVersion: 7,
      origin: 'explicit-user',
      planId: `${candidate.runtimeGeneration}:${extra.id}`,
      operation: 'install',
      profileId: candidate.profileId,
      identity: { pluginId: extra.id, source: alias('2') },
      binding: {
        operationId: `review:${'c'.repeat(64)}`,
        runtimeGeneration: candidate.runtimeGeneration,
        moduleGeneration: extra.moduleGeneration,
        requestId: candidate.transactionId,
      },
      decisions: [choice],
    }
    const pkg = {
      digest: extra.digest,
      identitySource: alias('2'),
      manifest: {
        id: extra.id,
        version: extra.version,
        canonicalSource: alias('2'),
        runtimeManifest: runtime,
      },
    }
    for (
      const bad of [
        { ...choice, scope: { providers: ['other'] } },
        { ...choice, securityFingerprint: 'forged' },
        { ...choice, decision: 'allow-persistent' },
        { ...choice, capability: 'tasks.create' },
        { ...choice, extra: true },
      ]
    ) {
      const f = setup()
      f.offer()
      f.prepare()
      expect(() => f.stage({ package: pkg, authorizationDecision: { ...decision, decisions: [bad] } })).toThrow()
    }
    const valid = setup()
    valid.offer()
    valid.prepare()
    const result = valid.stage({ package: pkg, authorizationDecision: decision })
    expect(result.receipt!(valid.stagedReceipt)).toMatchObject({ observation: candidate })
  })
})
