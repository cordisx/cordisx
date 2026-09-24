import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedProviderOwner } from '../packages/cli/src/launcher/model-catalog/managed-provider-owner.js'
import { createManagedProviderApi } from '../packages/cli/src/launcher/model-catalog/managed-provider-api.js'
import { builtinDiscoveryRegistry } from '../packages/cli/src/launcher/model-catalog/builtin-registry.js'
import {
  createMacOSKeychainBackend,
  type LauncherKeychainBackend,
  LauncherKeychainError,
  runKeychainHelperProcess,
} from '../packages/cli/src/launcher/secret-store.js'
import { resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'

class Keychain implements LauncherKeychainBackend {
  values = new Map<string, string>()
  failDelete = false
  failRecordWrite = false
  async read(service: string, account: string) {
    const value = this.values.get(`${service}/${account}`)
    if (value === undefined) throw new LauncherKeychainError('MISSING')
    return value
  }
  async status(service: string, account: string): Promise<'set' | 'unset'> {
    return this.values.has(`${service}/${account}`) ? 'set' : 'unset'
  }
  async upsert(service: string, account: string, value: string) {
    if (this.failRecordWrite && account !== 'index') throw new Error('fixture-secret write failure')
    this.values.set(`${service}/${account}`, value)
  }
  async remove(service: string, account: string) {
    if (this.failDelete) throw new Error('fixture-secret must not escape')
    this.values.delete(`${service}/${account}`)
  }
}
const settings = {
  title: 'DeepSeek',
  endpoint: 'https://api.deepseek.com',
  protocol: 'chat-completions',
  discoveryEnabled: true,
  strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60_000 },
  supplement: [],
}
const operation = { origin: 'https://api.deepseek.com', method: 'GET' as const, path: '/models' as const }
const signal = () => new AbortController().signal

describe('Host-owned managed Provider credentials', () => {
  const homes: string[] = [], owners: ManagedProviderOwner[] = []
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close()
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })
  const setup = async (keychain = new Keychain()) => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'provider-owner-'))
    homes.push(homeDir)
    const fetcher = vi.fn(async () =>
      Response.json({ object: 'list', data: [{ id: 'listed', object: 'model', owned_by: 'deepseek' }] })
    )
    const options = { homeDir, profileId: 'test', keychain, fetcher }
    const owner = await ManagedProviderOwner.open(options)
    owners.push(owner)
    return { owner, options, keychain, fetcher }
  }

  it('waits on the initial Keychain status before opening the owner', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => release = resolve)
    const keychain = new Keychain()
    keychain.status = async () => {
      await blocked
      return 'unset'
    }
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'provider-owner-blocked-'))
    homes.push(homeDir)
    let settled = false
    const opening = ManagedProviderOwner.open({ homeDir, profileId: 'test', keychain }).finally(() => settled = true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    release()
    const owner = await opening
    owners.push(owner)
  })

  it('releases the owner lock after a bounded Keychain failure so startup can retry', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'provider-owner-timeout-'))
    homes.push(homeDir)
    const storedKeychain = new Keychain()
    const initial = await ManagedProviderOwner.open({ homeDir, profileId: 'test', keychain: storedKeychain })
    const view = await initial.save({ settings }, async () => 'fixture-secret')
    await initial.close()
    const keychain = createMacOSKeychainBackend({
      timeoutMs: 20,
      invoke: async () =>
        await runKeychainHelperProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, 20),
    })
    await expect(ManagedProviderOwner.open({ homeDir, profileId: 'test', keychain })).rejects.toThrow(
      'credential-unavailable',
    )
    const retried = await ManagedProviderOwner.open({ homeDir, profileId: 'test', keychain: storedKeychain })
    owners.push(retried)
    expect(retried.snapshot()).toEqual([view])
  })

  it('persists only in Keychain, restarts with stable scope, and exposes no raw credential', async () => {
    const { owner, options, keychain, fetcher } = await setup()
    const view = await owner.save({ settings }, async () => 'fixture-secret')
    expect(JSON.stringify(owner)).toBe('{}')
    expect(JSON.stringify(view)).not.toMatch(/fixture-secret|credentialRef/)
    const connection = owner.connection(view.id)!
    expect(connection).not.toHaveProperty('bearer')
    const models = await builtinDiscoveryRegistry().resolve(connection).discover(connection, signal())
    expect(models.map(model => model.id)).toEqual(['listed'])
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: 'Bearer fixture-secret' },
      }),
    )
    expect((await stat(path.join(options.homeDir, 'state/host-provider-owners/test.lock'))).mode & 0o777).toBe(0o700)
    expect(await readdir(path.join(options.homeDir, 'state/host-provider-owners'))).toEqual(['test.lock'])
    await owner.close()
    expect(connection.current()).toBe(false)
    const reopened = await ManagedProviderOwner.open(options)
    owners.push(reopened)
    expect(reopened.snapshot()).toEqual([view])
    expect(keychain.values.size).toBe(2)
  })

  it('rotates scope and leases, rejects stale writes, and deletes the credential', async () => {
    const { owner, keychain } = await setup()
    const first = await owner.save({ settings }, async () => 'fixture-first')
    const old = owner.connection(first.id)!
    const second = await owner.save(
      { id: first.id, expectedRevision: first.revision, settings },
      async () => 'fixture-second',
    )
    expect(second.scopeRevision).not.toBe(first.scopeRevision)
    expect(second.credentialRevision).not.toBe(first.credentialRevision)
    await expect(old.request(operation, signal())).rejects.toThrow('cancelled')
    await expect(owner.save({ id: first.id, expectedRevision: first.revision, settings })).rejects.toThrow(
      'source-invalid',
    )
    expect([...keychain.values.values()].join()).not.toContain('fixture-first')
    await owner.remove(second.id, second.revision)
    expect(owner.snapshot()).toEqual([])
    expect([...keychain.values.values()].join()).not.toContain('fixture-second')
  })

  it('fences exact operation, explicit opt-in, owner lock and foreign keychain edits', async () => {
    const { owner, options, keychain, fetcher } = await setup()
    await expect(ManagedProviderOwner.open(options)).rejects.toThrow('credential-unavailable')
    const first = await owner.save({ settings }, async () => 'fixture-secret')
    const connection = owner.connection(first.id)!
    await expect(connection.request({ ...operation, origin: 'https://other.invalid' }, signal())).rejects.toThrow(
      'permission',
    )
    expect(fetcher).not.toHaveBeenCalled()
    const disabled = await owner.save({
      id: first.id,
      expectedRevision: first.revision,
      settings: { ...settings, discoveryEnabled: false },
    })
    expect(owner.connection(disabled.id)).toBeUndefined()
    const index = [...keychain.values.keys()].find(key => key.endsWith('/index'))!
    keychain.values.set(index, '{}')
    await expect(owner.save({ id: disabled.id, expectedRevision: disabled.revision, settings })).rejects.toThrow(
      'credential-unavailable',
    )
    expect(owner.snapshot()).toEqual([])
  })

  it('derives the models request capability from each saved official connection', async () => {
    const { owner, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(Response.json({
      data: [{
        id: 'openai/o4-mini',
        name: 'OpenAI: o4-mini',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
      }],
      total_count: 1,
      links: { next: null },
    }))
    const view = await owner.save({
      settings: {
        ...settings,
        title: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1',
      },
    }, async () => 'openrouter-fixture-secret')
    const connection = owner.connection(view.id)!
    const models = await builtinDiscoveryRegistry().resolve(connection).discover(connection, signal())
    expect(models.map(model => model.id)).toEqual(['openai/o4-mini'])
    expect(fetcher).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: 'Bearer openrouter-fixture-secret' },
      }),
    )
    await expect(connection.request(operation, signal())).rejects.toThrow('permission')
  })

  it('retries physical deletion after restart without resurrecting the removed connection', async () => {
    const { owner, options, keychain } = await setup()
    const view = await owner.save({ settings }, async () => 'fixture-secret')
    keychain.failDelete = true
    await expect(owner.remove(view.id, view.revision)).rejects.toThrow('credential-unavailable')
    expect(owner.snapshot()).toEqual([])
    await owner.close()
    keychain.failDelete = false
    const reopened = await ManagedProviderOwner.open(options)
    owners.push(reopened)
    expect(reopened.snapshot()).toEqual([])
    expect(keychain.values.size).toBe(1)
  })

  it('uses Host capture and denies renderer secrets, stale generations and revoked grants', async () => {
    const { owner } = await setup()
    let allowed = true
    const capture = vi.fn(async () => 'fixture-secret')
    const api = createManagedProviderApi({ owner, generation: 'launch-1', authorized: () => allowed, capture })
    const request = { generation: 'launch-1', settings, replaceCredential: true }
    await expect(api.save({ ...request, secret: 'renderer-secret' })).rejects.toThrow('source-invalid')
    await expect(api.save({ ...request, generation: 'old' })).rejects.toThrow('permission')
    expect(capture).not.toHaveBeenCalled()
    const result = await api.save(request)
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    allowed = false
    await expect(api.remove({ generation: 'launch-1', id: result.id, expectedRevision: result.revision })).rejects
      .toThrow('permission')
    expect(owner.snapshot()).toHaveLength(1)
  })

  it('does not expose the Host namespace through the generic secret resolver', async () => {
    const read = vi.fn(async () => 'fixture-secret')
    await expect(resolveLauncherSecret('keychain:cordisx/host-provider/v1/scope/ref', {
      platform: 'darwin',
      keychainBackend: { read },
    })).rejects.toThrow('SECRET_REF_INVALID')
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps supplements only within the credential scope and honors manual/disabled discovery', async () => {
    const { owner, fetcher } = await setup()
    const first = await owner.save({ settings }, async () => 'fixture-secret')
    const augmented = await owner.save({
      id: first.id,
      expectedRevision: first.revision,
      settings: { ...settings, supplement: [{ id: 'user-model' }] },
    })
    expect(augmented.scopeRevision).toBe(first.scopeRevision)
    await expect(
      owner.save(
        { id: augmented.id, expectedRevision: augmented.revision, settings: augmented.settings },
        async () => 'new-secret',
      ),
    ).rejects.toThrow('source-invalid')
    const manual = await owner.save({
      id: augmented.id,
      expectedRevision: augmented.revision,
      settings: { ...settings, strategy: { kind: 'manual', ids: ['manual'] } },
    })
    expect(owner.connection(manual.id)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('revokes a response still streaming when credentials are deleted', async () => {
    const { owner, fetcher } = await setup()
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    const cancel = vi.fn()
    fetcher.mockImplementationOnce(async () => {
      started()
      return new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } })
    })
    const first = await owner.save({ settings }, async () => 'fixture-secret')
    const request = owner.connection(first.id)!.request(operation, signal())
    const rejected = expect(request).rejects.toThrow('cancelled')
    await ready
    await owner.remove(first.id, first.revision)
    await rejected
    expect(cancel).toHaveBeenCalled()
  })

  it('cancels an uncooperative Host prompt on disposal without persisting its secret', async () => {
    const { owner, keychain } = await setup()
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    const pending = owner.save({ settings }, () => {
      started()
      return new Promise<string>(() => {})
    })
    const rejected = expect(pending).rejects.toThrow('credential-unavailable')
    await ready
    await owner.close()
    await rejected
    expect(keychain.values.size).toBe(1)
  })

  it('recovers a journaled failed record write and preserves the previous binding', async () => {
    const { owner, options, keychain } = await setup()
    const first = await owner.save({ settings }, async () => 'fixture-first')
    keychain.failRecordWrite = true
    await expect(owner.save({ id: first.id, expectedRevision: first.revision, settings }, async () => 'fixture-second'))
      .rejects.toThrow('credential-unavailable')
    expect(owner.snapshot()).toEqual([first])
    await owner.close()
    keychain.failRecordWrite = false
    const reopened = await ManagedProviderOwner.open(options)
    owners.push(reopened)
    expect(reopened.snapshot()).toEqual([first])
    expect(keychain.values.size).toBe(2)
  })

  it('checks management authority again after a Host prompt completes', async () => {
    const { owner, keychain } = await setup()
    let allowed = true
    const api = createManagedProviderApi({
      owner,
      generation: 'launch',
      authorized: () => allowed,
      capture: async () => {
        allowed = false
        return 'fixture-secret'
      },
    })
    await expect(api.save({ generation: 'launch', settings, replaceCredential: true })).rejects.toThrow('permission')
    expect(owner.snapshot()).toEqual([])
    expect(keychain.values.size).toBe(1)
  })

  it('rejects untrusted adapter names, credential references, scripts and unsafe endpoints', async () => {
    const { owner } = await setup()
    const capture = vi.fn(async () => 'fixture-secret')
    for (
      const candidate of [
        { ...settings, credentialRef: 'keychain:foreign/key' },
        { ...settings, endpoint: 'https://key@api.deepseek.com' },
        { ...settings, strategy: { kind: 'auto', adapter: 'plugin-adapter' } },
        { ...settings, strategy: { kind: 'script', commandRef: 'anything' } },
      ]
    ) await expect(owner.save({ settings: candidate }, capture)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })
})
