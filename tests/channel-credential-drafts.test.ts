import { describe, expect, it, vi } from 'vitest'
import { ChannelCredentialDraftBroker } from '../packages/cli/src/launcher/channel-credential-drafts.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'

const ref = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test' }
const pending = {
  account: { adapterId: 'feishu', accountId: 'cli_test' },
  adapterKind: 'feishu',
  secretRef: 'keychain:cordisx/channel/test/draft-existing',
  displayName: 'Pending',
}
function fixture(options: { silentRead?: boolean } = {}) {
  const values = new Map<string, string>()
  const backend = {
    read: vi.fn(async (_service: string, _account: string) => {
      throw new Error('old credentials must not be read')
    }),
    upsert: vi.fn(async (service: string, account: string, value: string) => {
      values.set(service + '/' + account, value)
    }),
    remove: vi.fn(async (service: string, account: string) => {
      values.delete(service + '/' + account)
    }),
    status: vi.fn(async () => 'set' as const),
  }
  const silentReadBackend = { read: vi.fn(async () => 'pending-test-secret') }
  const store = new LauncherSecretStore({
    platform: 'darwin',
    backend,
    ...(options.silentRead ? { silentReadBackend } : {}),
  })
  const descriptor = {
    contract: 'cordisx.service-config-descriptor/v1',
    schemaVersion: 1,
    identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
    scope: { profileId: 'test', generation: '1' },
    revision: 0,
    writable: true,
    configuration: { contract: 'cordisx.channel-service-config/v2', schemaVersion: 2, connections: [] },
  }
  const service = {
    descriptor: vi.fn(async () => descriptor),
    privateConfiguration: vi.fn(async () => ({
      revision: descriptor.revision,
      configuration: descriptor.configuration,
    })),
    mutate: vi.fn(async () => ({ status: 'applied', revision: 1 })),
  }
  const validateCredentials = vi.fn(async () => {})
  const discoverTenant = vi.fn(async () => 'test')
  const broker = new ChannelCredentialDraftBroker({
    profileId: 'test',
    store,
    service: service as never,
    discoverTenant,
    validateCredentials,
  })
  const capture = (owner = 'owner') =>
    broker.handle({ operation: 'capture', owner, purpose: 'create', account: ref, secret: 'test-only' }, 'document')
  return { broker, store, service, backend, silentReadBackend, values, capture, validateCredentials, discoverTenant }
}
async function setPending(f: ReturnType<typeof fixture>) {
  const descriptor = await f.service.descriptor()
  descriptor.configuration = {
    contract: 'cordisx.channel-service-config/v3',
    schemaVersion: 3,
    connections: [],
    pendingConnections: [pending],
  } as typeof descriptor.configuration
}
describe('Host-owned credential draft transactions', () => {
  it('does not write a credential when its crash-recovery intent cannot be persisted', async () => {
    const f = fixture()
    const recordDraft = vi.fn(async () => {
      expect(f.backend.upsert).not.toHaveBeenCalled()
      throw new Error('journal unavailable')
    })
    const broker = new ChannelCredentialDraftBroker({
      profileId: 'test',
      store: f.store,
      service: f.service as never,
      validateCredentials: f.validateCredentials,
      discoverTenant: f.discoverTenant,
      recordDraft,
    })
    try {
      const result = await broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'create',
        account: ref,
        secret: 'synthetic-secret',
        expectedRevision: 0,
      }, 'document')
      expect(result).toEqual({ status: 'unavailable', code: 'DRAFT_JOURNAL_UNAVAILABLE' })
      expect(recordDraft).toHaveBeenCalledOnce()
      expect(f.backend.upsert).not.toHaveBeenCalled()
    } finally {
      await broker.dispose()
      await f.broker.dispose()
    }
  })
  it.each(['', 'test'])(
    'bounds a stalled optional lookup with tenant %s and still captures credentials',
    async tenantId => {
      vi.useFakeTimers()
      const f = fixture()
      f.discoverTenant.mockImplementationOnce(async () => await new Promise<string>(() => {}))
      try {
        const result = f.broker.handle({
          operation: 'capture',
          owner: 'owner',
          purpose: 'create',
          account: { ...ref, tenantId },
          secret: 'test-only',
        }, 'document')
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(result).resolves.toMatchObject({ status: 'applied', ref: { ...ref, tenantId } })
      } finally {
        await f.broker.dispose()
        vi.useRealTimers()
      }
    },
  )
  it('accepts a manually supplied pending tenant without prompting when silent reading is unavailable', async () => {
    const f = fixture()
    await setPending(f)
    try {
      const result = await f.broker.handle({
        operation: 'resolve-tenant',
        owner: 'owner',
        account: { ...ref, tenantId: '' },
        tenantId: 'manual-tenant',
        expectedRevision: 0,
      }, 'document')
      expect(result).toMatchObject({ status: 'applied', ref: { ...ref, tenantId: 'manual-tenant' } })
      const mutation = (f.service.mutate.mock.calls[0] as unknown as [{
        configuration: {
          connections: Array<{ secretRef: string }>
        }
      }])[0]
      expect(mutation.configuration.connections[0]!.secretRef).toBe(pending.secretRef)
      expect(f.backend.read).not.toHaveBeenCalled()
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.discoverTenant).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('rejects a mismatched pending tenant when a silent credential lookup succeeds', async () => {
    const f = fixture({ silentRead: true })
    await setPending(f)
    try {
      const result = await f.broker.handle({
        operation: 'resolve-tenant',
        owner: 'owner',
        account: { ...ref, tenantId: '' },
        tenantId: 'wrong-tenant',
        expectedRevision: 0,
      }, 'document')
      expect(result).toEqual({ status: 'rejected', code: 'TENANT_MISMATCH' })
      expect(f.silentReadBackend.read).toHaveBeenCalledOnce()
      expect(f.backend.read).not.toHaveBeenCalled()
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('keeps a matching pending credential and permits manual fallback after an unavailable lookup', async () => {
    for (const mode of ['match', 'lookup-unavailable', 'secret-unavailable'] as const) {
      const f = fixture({ silentRead: true })
      await setPending(f)
      if (mode === 'lookup-unavailable') {
        f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
      }
      if (mode === 'secret-unavailable') f.silentReadBackend.read.mockRejectedValueOnce(new Error('unavailable'))
      try {
        const result = await f.broker.handle({
          operation: 'resolve-tenant',
          owner: 'owner',
          account: { ...ref, tenantId: '' },
          tenantId: mode === 'match' ? ref.tenantId : 'manual-tenant',
          expectedRevision: 0,
        }, 'document')
        expect(result).toMatchObject({ status: 'applied' })
        expect(f.silentReadBackend.read).toHaveBeenCalledOnce()
        expect(f.discoverTenant).toHaveBeenCalledTimes(mode === 'secret-unavailable' ? 0 : 1)
        expect(f.backend.read).not.toHaveBeenCalled()
        expect(f.backend.upsert).not.toHaveBeenCalled()
        expect(f.service.mutate).toHaveBeenCalledOnce()
        expect(JSON.stringify(result)).not.toMatch(/pending-test-secret|keychain:/)
      } finally {
        await f.broker.dispose()
      }
    }
  })
  it('bounds a stalled silent lookup and retains the pending manual fallback', async () => {
    vi.useFakeTimers()
    const f = fixture({ silentRead: true })
    await setPending(f)
    let finish!: (secret: string) => void, started!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    f.silentReadBackend.read.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>(resolve => {
        finish = resolve
      })
    })
    try {
      const result = f.broker.handle({
        operation: 'resolve-tenant',
        owner: 'owner',
        account: { ...ref, tenantId: '' },
        tenantId: 'manual-tenant',
        expectedRevision: 0,
      }, 'document')
      await entered
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(result).resolves.toMatchObject({ status: 'applied', ref: { ...ref, tenantId: 'manual-tenant' } })
      finish('pending-test-secret')
      await vi.advanceTimersByTimeAsync(0)
      expect(f.discoverTenant).not.toHaveBeenCalled()
      expect(f.backend.read).not.toHaveBeenCalled()
      expect(f.backend.upsert).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
      vi.useRealTimers()
    }
  })
  it('does not start a tenant lookup or mutate a pending connection after its document retires', async () => {
    const f = fixture({ silentRead: true })
    await setPending(f)
    let finish!: (secret: string) => void, started!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    f.silentReadBackend.read.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>(resolve => {
        finish = resolve
      })
    })
    try {
      const result = f.broker.handle({
        operation: 'resolve-tenant',
        owner: 'owner',
        account: { ...ref, tenantId: '' },
        tenantId: 'manual-tenant',
        expectedRevision: 0,
      }, 'document')
      await entered
      const retire = f.broker.retireDocument('document')
      finish('pending-test-secret')
      await expect(result).resolves.toEqual({ status: 'rejected', code: 'STALE_GENERATION' })
      await retire
      expect(f.discoverTenant).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('saves authenticated credentials when lookup fails and resolves later without rotating them', async () => {
    const f = fixture()
    f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
    f.backend.read.mockImplementation(async (service, account) => f.values.get(`${service}/${account}`)!)
    try {
      const account = { ...ref, tenantId: '' }
      const captured = await f.broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'create',
        account,
        secret: 'test-only',
      }, 'document')
      expect(captured).toMatchObject({ status: 'applied', ref: account })
      const committed = await f.broker.handle({
        operation: 'commit',
        owner: 'owner',
        draftId: captured.draftId,
        draft: { displayName: 'Pending', selectors: ['direct'] },
      }, 'document')
      expect(committed.status).toBe('applied')
      type Saved = {
        schemaVersion: number
        connections: Array<Record<string, unknown>>
        pendingConnections: Array<{ secretRef: string }>
      }
      const request = f.service.mutate.mock.calls[0] as unknown as [{ configuration: Saved }]
      const saved = request[0].configuration
      expect(saved).toMatchObject({
        schemaVersion: 3,
        connections: [],
        pendingConnections: [{
          account: {
            adapterId: 'feishu',
            accountId: 'cli_test',
          },
        }],
      })
      const secretRef = saved.pendingConnections[0].secretRef
      const descriptor = await f.service.descriptor()
      descriptor.configuration = saved as typeof descriptor.configuration
      descriptor.revision = 1
      await expect(
        f.broker.handle({
          operation: 'resolve-tenant',
          owner: 'owner',
          account,
          expectedRevision: 0,
          tenantId: 'manual',
        }, 'document'),
      ).resolves.toMatchObject({ status: 'conflict' })
      f.discoverTenant.mockRejectedValueOnce(new Error('TENANT_DISCOVERY_PERMISSION_DENIED'))
      const resolve = { operation: 'resolve-tenant', owner: 'owner', account, expectedRevision: 1 }
      await expect(f.broker.handle(resolve, 'document')).resolves.toMatchObject({
        code: 'TENANT_DISCOVERY_PERMISSION_DENIED',
      })
      expect(f.service.mutate).toHaveBeenCalledTimes(1)
      await expect(f.broker.handle(resolve, 'document')).resolves.toMatchObject({ status: 'applied', ref })
      const resolved = (f.service.mutate.mock.calls[1] as unknown as [{ configuration: Saved }])[0].configuration
      expect(resolved.pendingConnections).toEqual([])
      expect(resolved.connections).toMatchObject([{ ref, secretRef, displayName: 'Pending', selectors: ['direct'] }])
      expect(f.backend.upsert).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(committed)).not.toMatch(/keychain:|test-only/)
    } finally {
      await f.broker.dispose()
    }
  })
  it('rejects invalid credentials before storing them even when a tenant key was supplied', async () => {
    const f = fixture()
    f.validateCredentials.mockRejectedValueOnce(new Error('CREDENTIAL_VALIDATION_FAILED'))
    try {
      await expect(f.capture()).resolves.toMatchObject({ status: 'rejected', code: 'CREDENTIAL_VALIDATION_FAILED' })
      expect(f.validateCredentials).toHaveBeenCalledWith({
        adapterId: ref.adapterId,
        accountId: ref.accountId,
        secret: 'test-only',
      })
      expect(f.discoverTenant).not.toHaveBeenCalled()
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('rejects a manually entered tenant that disagrees with authenticated discovery before saving credentials', async () => {
    const f = fixture()
    f.discoverTenant.mockResolvedValueOnce('different-tenant')
    try {
      await expect(f.capture()).resolves.toEqual({ status: 'rejected', code: 'TENANT_MISMATCH' })
      expect(f.discoverTenant).toHaveBeenCalledWith({
        adapterId: ref.adapterId,
        accountId: ref.accountId,
        secret: 'test-only',
      })
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
      expect(f.values.size).toBe(0)
    } finally {
      await f.broker.dispose()
    }
  })
  it('does not save credentials if the document retires during a manual tenant lookup', async () => {
    const f = fixture()
    let finish!: (tenantId: string) => void, started!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    f.discoverTenant.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>(resolve => {
        finish = resolve
      })
    })
    try {
      const capture = f.capture()
      await entered
      const retire = f.broker.retireDocument('document')
      finish('different-tenant')
      await expect(capture).resolves.toEqual({ status: 'rejected', code: 'STALE_GENERATION' })
      await retire
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('accepts a manually entered tenant when authenticated discovery agrees', async () => {
    const f = fixture()
    try {
      const captured = await f.capture()
      expect(captured).toMatchObject({ status: 'applied', ref })
      expect(f.discoverTenant).toHaveBeenCalledOnce()
      expect(f.backend.upsert).toHaveBeenCalledOnce()
      await expect(f.broker.handle({
        operation: 'commit',
        owner: 'owner',
        draftId: captured.draftId,
        draft: { displayName: 'Test' },
      }, 'document')).resolves.toMatchObject({ status: 'applied', ref })
    } finally {
      await f.broker.dispose()
    }
  })
  it.each(['TENANT_DISCOVERY_PERMISSION_DENIED', 'TENANT_DISCOVERY_FAILED'])(
    'keeps the manual tenant fallback when discovery returns %s',
    async code => {
      const f = fixture()
      f.discoverTenant.mockRejectedValueOnce(new Error(code))
      try {
        await expect(f.capture()).resolves.toMatchObject({ status: 'applied', ref })
        expect(f.discoverTenant).toHaveBeenCalledOnce()
        expect(f.backend.upsert).toHaveBeenCalledOnce()
      } finally {
        await f.broker.dispose()
      }
    },
  )
  it('rotates the key and connection settings in one CAS while preserving unrelated connection bytes', async () => {
    const f = fixture()
    const descriptor = await f.service.descriptor()
    const other = {
      ref: { ...ref, accountId: 'cli_other' },
      displayName: 'Other',
      selectors: ['direct'],
      secretRef: 'opaque-other',
    }
    descriptor.configuration.connections = [{
      ref,
      displayName: 'Original',
      selectors: ['direct'],
      secretRef: 'opaque-old',
    }, other] as never
    try {
      const stale = await f.broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'rotate',
        account: ref,
        secret: 'test-only',
        expectedRevision: 1,
      }, 'document')
      expect(stale).toMatchObject({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(f.backend.upsert).not.toHaveBeenCalled()
      const captured = await f.broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'rotate',
        account: ref,
        secret: 'test-only',
        expectedRevision: 0,
      }, 'document')
      expect(f.discoverTenant).not.toHaveBeenCalled()
      const draft = { displayName: 'Updated', selectors: ['direct', 'mentions'] }
      expect(
        await f.broker.handle({ operation: 'commit', owner: 'owner', draftId: captured.draftId, draft }, 'document'),
      ).toMatchObject({ status: 'applied' })
      expect(f.service.mutate).toHaveBeenCalledOnce()
      const config =
        (f.service.mutate.mock.calls[0] as unknown as [{ configuration: { connections: Record<string, unknown>[] } }])[
          0
        ].configuration
      expect(config.connections[0]).toMatchObject({ ...draft, ref })
      expect(config.connections[0]!.secretRef).not.toBe('opaque-old')
      expect(config.connections[1]).toEqual(other)
      expect(f.backend.read).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('creates privately, rejects another owner and reports actual commit without projecting a key', async () => {
    const f = fixture()
    try {
      const captured = await f.capture()
      expect(captured).toMatchObject({ status: 'applied', ref })
      expect(JSON.stringify(captured)).not.toMatch(/keychain:|test-only/)
      const draft = { displayName: 'Test', selectors: ['direct', 'mentions'] }
      await expect(
        f.broker.handle({ operation: 'commit', owner: 'other', draftId: captured.draftId, draft }, 'document'),
      ).resolves.toMatchObject({ status: 'rejected' })
      await expect(
        f.broker.handle({ operation: 'commit', owner: 'owner', draftId: captured.draftId, draft }, 'document'),
      ).resolves.toMatchObject({ status: 'applied' })
      expect(f.service.mutate).toHaveBeenCalledTimes(1)
      expect(f.values.size).toBe(1)
      expect(f.backend.read).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('retiring a document during Keychain capture prevents the configuration effect and cleans the capture', async () => {
    const f = fixture()
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    f.backend.upsert.mockImplementationOnce(async (service, account, value) => {
      f.values.set(service + '/' + account, value)
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    try {
      const capture = f.capture()
      await started
      const retire = f.broker.retireDocument('document')
      release()
      await expect(capture).resolves.toMatchObject({ status: 'rejected' })
      await retire
      expect(f.values.size).toBe(0)
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
  it('retains cleanup authority when Keychain deletion fails, then removes the same capture on retry', async () => {
    const f = fixture()
    try {
      const captured = await f.capture()
      f.backend.remove.mockRejectedValueOnce(new Error('temporarily unavailable'))
      const request = { operation: 'discard', owner: 'owner', draftId: captured.draftId }
      await expect(f.broker.handle(request, 'document')).resolves.toMatchObject({
        status: 'unavailable',
        code: 'CREDENTIAL_CLEANUP_UNAVAILABLE',
      })
      expect(f.values.size).toBe(1)
      await expect(f.broker.handle(request, 'document')).resolves.toMatchObject({ status: 'applied' })
      expect(f.values.size).toBe(0)
    } finally {
      await f.broker.dispose()
    }
  })
})
