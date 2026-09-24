import { describe, expect, it, vi } from 'vitest'
import {
  channelKeychainReference,
  createMacOSKeychainBackend,
  type LauncherKeychainBackend,
  LauncherKeychainError,
  LauncherSecretStore,
  runKeychainHelperProcess,
} from '../packages/cli/src/launcher/secret-store.js'
import { resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'

class MemoryKeychain implements LauncherKeychainBackend {
  readonly values = new Map<string, string>()
  private key(service: string, account: string): string {
    return `${service}\u0000${account}`
  }
  async read(service: string, account: string): Promise<string> {
    const value = this.values.get(this.key(service, account))
    if (value === undefined) throw new LauncherKeychainError('MISSING')
    return value
  }
  async upsert(service: string, account: string, value: string): Promise<void> {
    this.values.set(this.key(service, account), value)
  }
  async remove(service: string, account: string): Promise<void> {
    this.values.delete(this.key(service, account))
  }
  async status(service: string, account: string): Promise<'set' | 'unset'> {
    return this.values.has(this.key(service, account)) ? 'set' : 'unset'
  }
}

describe('launcher Host-private channel secret store', () => {
  it('can deny Keychain authentication UI for hidden startup access', async () => {
    const invoke = vi.fn(async operation => Buffer.from(operation === 'status' ? 'unset' : 'fixture-secret'))
    const backend = createMacOSKeychainBackend({ allowAuthenticationUI: false, timeoutMs: 10_000, invoke })
    await expect(backend.status('fixture-service', 'fixture-account')).resolves.toBe('unset')
    await expect(backend.read('fixture-service', 'fixture-account')).resolves.toBe('fixture-secret')
    await backend.upsert('fixture-service', 'fixture-account', 'new-fixture-secret')
    await backend.remove('fixture-service', 'fixture-account')
    expect(invoke.mock.calls.map(call => [call[0], call[4], call[5]])).toEqual([
      ['status', false, 10_000],
      ['read', false, 10_000],
      ['set', false, 10_000],
      ['remove', false, 10_000],
    ])
  })

  it('terminates a timed-out Keychain helper before rejecting', async () => {
    const startedAt = Date.now()
    await expect(runKeychainHelperProcess(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));setInterval(()=>{},1000)",
      ],
      undefined,
      200,
    )).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
  })

  it('writes, resolves, replaces and deletes with no secret/ref in renderer-safe results', async () => {
    const backend = new MemoryKeychain()
    const store = new LauncherSecretStore({ platform: 'darwin', backend })
    const capture = store.beginCapture({ profileId: 'work', connectionId: 'feishu-prod' })
    const reference = store.referenceFor(capture.captureId)!
    expect(reference).toBe('keychain:cordisx/channel/work/feishu-prod')
    expect(await store.status(capture.captureId)).toMatchObject({ state: 'unset', operationToken: expect.any(String) })

    const first = await store.capture({ captureId: capture.captureId, secret: 'first-test-secret' })
    expect(first).toMatchObject({ state: 'set', operationToken: expect.any(String) })
    expect(JSON.stringify(first)).not.toContain('first-test-secret')
    expect(JSON.stringify(first)).not.toContain(reference)
    await expect(resolveLauncherSecret(reference, { platform: 'darwin', keychainBackend: backend })).resolves.toBe(
      'first-test-secret',
    )

    await expect(store.capture({ captureId: capture.captureId, secret: 'rotated-test-secret' })).resolves.toMatchObject(
      { state: 'set' },
    )
    await expect(resolveLauncherSecret(reference, { platform: 'darwin', keychainBackend: backend })).resolves.toBe(
      'rotated-test-secret',
    )
    expect(await store.remove(capture.captureId)).toMatchObject({ state: 'unset' })
    expect(await store.remove(capture.captureId)).toMatchObject({ state: 'unset' })
    await expect(resolveLauncherSecret(reference, { platform: 'darwin', keychainBackend: backend }))
      .rejects.toMatchObject({ code: 'SECRET_MISSING' })
  })

  it('is honestly unavailable on non-macOS and rejects unknown capture authority', async () => {
    const store = new LauncherSecretStore({ platform: 'linux' })
    const capture = store.beginCapture({ profileId: 'work', connectionId: 'feishu-prod' })
    await expect(store.capture({ captureId: capture.captureId, secret: 'test-secret' })).resolves.toMatchObject({
      state: 'unavailable',
    })
    await expect(store.status(capture.captureId)).resolves.toMatchObject({ state: 'unavailable' })
    await expect(store.remove(capture.captureId)).resolves.toMatchObject({ state: 'unavailable' })
    expect(store.referenceFor('not-a-valid-capture-id')).toBeUndefined()
  })

  it('uses the exact opaque channel ref shape and refuses unsafe identity segments', () => {
    expect(channelKeychainReference({ profileId: 'default', connectionId: 'lark_a' }))
      .toBe('keychain:cordisx/channel/default/lark_a')
    expect(() => channelKeychainReference({ profileId: '../unsafe', connectionId: 'lark' })).toThrow(
      'invalid secret profile id',
    )
    expect(() => channelKeychainReference({ profileId: 'default', connectionId: 'lark/unsafe' })).toThrow(
      'invalid secret connection id',
    )
  })
})
