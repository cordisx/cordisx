import { describe, expect, it, vi } from 'vitest'
import { ChannelCredentialDraftBroker } from '../packages/cli/src/launcher/channel-credential-drafts.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'

const ref = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test' }
function fixture() {
  const values = new Map<string, string>()
  const backend = {
    read: vi.fn(async () => {
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
  const store = new LauncherSecretStore({ platform: 'darwin', backend })
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
    mutate: vi.fn(async () => ({ status: 'applied', revision: 1 })),
  }
  const validateCredentials = vi.fn(async () => {})
  const broker = new ChannelCredentialDraftBroker({
    profileId: 'test',
    store,
    service: service as never,
    discoverTenant: vi.fn(async () => 'test'),
    validateCredentials,
  })
  const capture = (owner = 'owner') =>
    broker.handle({ operation: 'capture', owner, purpose: 'create', account: ref, secret: 'test-only' }, 'document')
  return { broker, service, backend, values, capture, validateCredentials }
}
describe('Host-owned credential draft transactions', () => {
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
      expect(f.backend.upsert).not.toHaveBeenCalled()
      expect(f.service.mutate).not.toHaveBeenCalled()
    } finally {
      await f.broker.dispose()
    }
  })
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
