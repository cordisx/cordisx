import { expect, it } from 'vitest'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  type PermissionPolicyStore,
} from '../../packages/cli/src/renderer/platform.js'
import { broker, certification, digest, identity, legacyPrompt, manifest } from './permission-certified-dom.fixtures.js'

export function registerCertificationTests() {
  it('does not expose a point-policy batch before durable acknowledgement', async () => {
    const backing = new MemoryPermissionPolicyStore()
    let deferredWrite: Readonly<{ resolve: () => void; reject: (error: Error) => void }> | undefined
    let deferPersistence = false
    const store: PermissionPolicyStore = {
      read: () => backing.read(),
      write: records => backing.write(records),
      readV3: () => backing.readV3(),
      writeV3: records => {
        if (!deferPersistence) return backing.writeV3(records)
        return new Promise<void>((resolve, reject) => {
          deferredWrite = Object.freeze({ resolve, reject })
        }).then(() => backing.writeV3(records))
      },
    }
    const value = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      100,
      'work',
      'runtime-1',
    )
    const unregister = value.register(
      identity,
      manifest(),
      { pluginId: identity.id, moduleGeneration: 'module-batch' },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    const points = ['sidebar.navigation.items', 'main'] as const
    await value.setDomPolicies(identity, points.map(pointId => ({ pointId, policy: 'deny-persistent' as const })))
    let changes = 0
    const unsubscribe = value.subscribe(() => {
      changes += 1
    })
    deferPersistence = true
    const update = value.setDomPolicies(
      identity,
      points.map(pointId => ({ pointId, policy: 'allow-persistent' as const })),
    )
    await Promise.resolve()
    expect(deferredWrite).toBeDefined()
    expect(points.map(pointId => value.domPolicy(identity, pointId))).toEqual(['deny', 'deny'])
    expect(points.map(pointId => value.domAccess(identity, pointId))).toEqual([
      expect.objectContaining({ authorized: false, state: 'denied', policy: 'deny' }),
      expect.objectContaining({ authorized: false, state: 'denied', policy: 'deny' }),
    ])
    expect(backing.readV3().map(record => record.policy)).toEqual(['deny-persistent', 'deny-persistent'])
    expect(changes).toBe(0)
    deferredWrite!.resolve()
    await update
    expect(points.map(pointId => value.domPolicy(identity, pointId))).toEqual(['allow', 'allow'])
    expect(backing.readV3().map(record => record.policy)).toEqual(['allow-persistent', 'allow-persistent'])
    expect(changes).toBe(1)
    unsubscribe()
    unregister()
  })

  it('keeps the prior live policy when durable acknowledgement fails', async () => {
    const backing = new MemoryPermissionPolicyStore()
    let rejectWrite: ((error: Error) => void) | undefined
    let deferPersistence = false
    const store: PermissionPolicyStore = {
      read: () => backing.read(),
      write: records => backing.write(records),
      readV3: () => backing.readV3(),
      writeV3: records => {
        if (!deferPersistence) return backing.writeV3(records)
        return new Promise<void>((_resolve, reject) => {
          rejectWrite = reject
        })
      },
    }
    const value = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date('2026-08-30T12:00:00.000Z'),
      100,
      'work',
      'runtime-1',
    )
    const unregister = value.register(
      identity,
      manifest(),
      { pluginId: identity.id, moduleGeneration: 'module-batch' },
      undefined,
      { version: '1.2.3', integrity: digest },
    )
    const points = ['sidebar.navigation.items', 'main'] as const
    await value.setDomPolicies(identity, points.map(pointId => ({ pointId, policy: 'deny-persistent' as const })))
    let changes = 0
    const unsubscribe = value.subscribe(() => {
      changes += 1
    })
    deferPersistence = true
    const update = value.setDomPolicies(
      identity,
      points.map(pointId => ({ pointId, policy: 'allow-persistent' as const })),
    )
    await Promise.resolve()
    rejectWrite!(new Error('profile ledger unavailable'))
    await expect(update).rejects.toThrow('profile ledger unavailable')
    expect(points.map(pointId => value.domPolicy(identity, pointId))).toEqual(['deny', 'deny'])
    expect(backing.readV3().map(record => record.policy)).toEqual(['deny-persistent', 'deny-persistent'])
    expect(changes).toBe(0)
    unsubscribe()
    unregister()
  })

  it.each(
    [
      ['ordinary', false, false, 1, 'explicit-user'],
      ['certified-only', true, false, 0, 'certified-implicit'],
      ['official-only', false, true, 1, 'explicit-user'],
      ['official-and-certified', true, true, 0, 'certified-implicit'],
    ] as const,
  )('keeps the %s state independent across trust dimensions', async (_state, certified, _official, prompts, origin) => {
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

  it.each(
    [
      ['ordinary', undefined],
      ['certified-only', certification()],
      ['official-only', undefined],
      ['official-and-certified', certification()],
    ] as const,
  )('never lets the %s state bypass a non-DOM prompt', async (_state, certified) => {
    const context = broker({
      ...(certified === undefined ? {} : { certified }),
      capabilities: [{ name: 'models.read', required: false, scope: { providers: ['codex'] } }],
    })
    await expect(context.value.authorize(identity, 'models.read', { providerId: 'codex' })).resolves.toMatchObject({
      ok: true,
    })
    expect(context.nonDomPrompts()).toBe(1)
  })

  it('binds auto approval to exact artifact evidence and rejects malicious self-claims', async () => {
    const exact = broker({ certified: certification() })
    await exact.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(exact.domPrompts()).toBe(0)

    const mismatched = broker({})
    expect(() =>
      mismatched.value.replaceCertifiedPermissionSnapshot({
        revision: 1,
        projections: [certification({ integrity: `sha256:${'b'.repeat(64)}` })],
      })
    ).toThrow(/invalid projection/)
    await mismatched.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(mismatched.domPrompts()).toBe(1)

    const forgedFingerprint = broker({})
    expect(() =>
      forgedFingerprint.value.replaceCertifiedPermissionSnapshot({
        revision: 1,
        projections: [certification({ fingerprint: `sha256:${'c'.repeat(64)}` })],
      })
    ).toThrow(/invalid projection/)
    await forgedFingerprint.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(forgedFingerprint.domPrompts()).toBe(1)

    expect(() =>
      normalizePluginManifest({
        ...manifest(),
        certified: true,
        official: true,
      }, identity.id)
    ).toThrow(/unsupported|unknown/i)

    const injected = broker({})
    injected.unregister()
    if (false) {
      // @ts-expect-error Plugin registration artifacts cannot carry trust projections.
      injected.value.register(identity, manifest(), { pluginId: identity.id }, undefined, {
        version: '1.2.3',
        integrity: digest,
        certification: certification(),
      })
    }
    const maliciousArtifact = {
      version: '1.2.3',
      integrity: digest,
      certification: certification(),
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
    await expect(context.value.requestDomAccess(identity, 'sidebar.footer.menu')).resolves.toMatchObject({
      authorized: true,
    })
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({ authorized: true })

    context.value.replaceCertifiedPermissionSnapshot({ revision: 2, projections: [] })
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: false,
      state: 'pending',
    })
    await context.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(context.domPrompts()).toBe(1)

    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    expect(context.domPrompts()).toBe(2)
    expect(context.value.snapshots().filter(item => item.capability === 'ui.extension-points.render')).toHaveLength(2)

    context.unregister()
    expect(context.value.domAccess(identity, 'sidebar.footer.menu')).toMatchObject({
      authorized: false,
      state: 'denied',
    })

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
    await expect(first.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({
      authorized: true,
    })
    // Certified implicit approval does not create a persistent policy, so the user can still set an exact deny.
    await first.value.setDomPolicy(identity, 'workspace.toolbar.items', 'deny-persistent')
    await expect(first.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({
      authorized: false,
      policy: 'deny',
    })

    const sameProfile = broker({
      certified: certification(),
      store,
      generation: 'runtime-2',
      moduleGeneration: 'module-2',
    })
    await expect(sameProfile.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({
      authorized: false,
      policy: 'deny',
    })
    const otherProfile = broker({
      certified: certification(),
      store,
      profile: 'other',
      generation: 'runtime-3',
      moduleGeneration: 'module-3',
    })
    await expect(otherProfile.value.requestDomAccess(identity, 'workspace.toolbar.items')).resolves.toMatchObject({
      authorized: true,
    })
  })

  it('keeps allow-once leases exact when another point policy changes', async () => {
    const context = broker({})
    await context.value.requestDomAccess(identity, 'workspace.toolbar.items')
    await context.value.requestDomAccess(identity, 'sidebar.footer.menu')
    expect(context.domPrompts()).toBe(2)

    await context.value.setDomPolicy(identity, 'workspace.toolbar.items', 'deny-persistent')
    expect(context.value.domAccess(identity, 'workspace.toolbar.items')).toMatchObject({
      authorized: false,
      policy: 'deny',
    })
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
}
