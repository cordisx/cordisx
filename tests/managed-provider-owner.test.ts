import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedProviderOwner } from '../packages/cli/src/launcher/model-catalog/managed-provider-owner.js'
import { createManagedProviderApi } from '../packages/cli/src/launcher/model-catalog/managed-provider-api.js'
import { builtinDiscoveryRegistry } from '../packages/cli/src/launcher/model-catalog/builtin-registry.js'
import { type LauncherKeychainBackend, LauncherKeychainError } from '../packages/cli/src/launcher/secret-store.js'
import { resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'
import { createDefaultHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'

class Keychain implements LauncherKeychainBackend {
  values = new Map<string, string>()
  calls = 0
  async read(service: string, account: string) {
    this.calls++
    const value = this.values.get(`${service}/${account}`)
    if (value === undefined) throw new LauncherKeychainError('MISSING')
    return value
  }
  async status(service: string, account: string): Promise<'set' | 'unset'> {
    this.calls++
    return this.values.has(`${service}/${account}`) ? 'set' : 'unset'
  }
  async upsert(service: string, account: string, value: string) {
    this.calls++
    this.values.set(`${service}/${account}`, value)
  }
  async remove(service: string, account: string) {
    this.calls++
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
    const config = createDefaultHomeConfig()
    await writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        ...config,
        apps: {
          codex: {
            defaultProfile: 'test',
            profiles: { test: { displayName: 'Test', dataMode: 'shared' } },
          },
        },
      }),
      { mode: 0o600 },
    )
    const fetcher = vi.fn(async () =>
      Response.json({ object: 'list', data: [{ id: 'listed', object: 'model', owned_by: 'deepseek' }] })
    )
    const options = { homeDir, profileId: 'test', keychain, fetcher }
    const owner = await ManagedProviderOwner.open(options)
    owners.push(owner)
    return { owner, options, keychain, fetcher }
  }

  it('persists in private profile config, restarts with stable scope, and exposes no raw credential', async () => {
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
    const configPath = path.join(options.homeDir, 'config.json')
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(configPath, 'utf8')).toContain('fixture-secret')
    await owner.close()
    expect(connection.current()).toBe(false)
    const reopened = await ManagedProviderOwner.open(options)
    owners.push(reopened)
    expect(reopened.snapshot()).toEqual([view])
    expect(keychain.calls).toBe(0)
  })

  it('rotates scope and leases, rejects stale writes, and deletes the credential', async () => {
    const { owner, options, keychain } = await setup()
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
    await owner.remove(second.id, second.revision)
    expect(owner.snapshot()).toEqual([])
    expect(await readFile(path.join(options.homeDir, 'config.json'), 'utf8')).not.toContain('fixture-second')
    expect(keychain.calls).toBe(0)
  })

  it('fences exact operation, explicit opt-in, owner lock and foreign managed-record edits', async () => {
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
    await updateHomeConfigAtomic(config => ({
      ...config,
      apps: {
        ...config.apps,
        codex: {
          ...config.apps.codex!,
          profiles: {
            ...config.apps.codex!.profiles,
            test: { ...config.apps.codex!.profiles.test!, managedProviders: [] },
          },
        },
      },
    }), { configPath: path.join(options.homeDir, 'config.json') })
    await expect(owner.save({ id: disabled.id, expectedRevision: disabled.revision, settings })).rejects.toThrow(
      'credential-unavailable',
    )
    expect(owner.snapshot()).toEqual([])
    expect(keychain.calls).toBe(0)
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

  it('preserves unrelated concurrent configuration edits', async () => {
    const { owner, options, keychain } = await setup()
    const view = await owner.save({ settings }, async () => 'fixture-secret')
    await updateHomeConfigAtomic(config => ({
      ...config,
      apps: {
        ...config.apps,
        codex: {
          ...config.apps.codex!,
          profiles: {
            ...config.apps.codex!.profiles,
            test: { ...config.apps.codex!.profiles.test!, displayName: 'Changed elsewhere' },
          },
        },
      },
    }), { configPath: path.join(options.homeDir, 'config.json') })
    await owner.save({ id: view.id, expectedRevision: view.revision, settings: { ...settings, title: 'Updated' } })
    expect(JSON.parse(await readFile(path.join(options.homeDir, 'config.json'), 'utf8')).apps.codex.profiles.test)
      .toMatchObject({ displayName: 'Changed elsewhere', managedProviders: [{ secret: 'fixture-secret' }] })
    expect(keychain.calls).toBe(0)
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
    const { owner, keychain, options } = await setup()
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
    expect(await readFile(path.join(options.homeDir, 'config.json'), 'utf8')).not.toContain('fixture-secret')
    expect(keychain.calls).toBe(0)
  })

  it('does not overwrite malformed configuration and leaves legacy Keychain records untouched', async () => {
    const keychain = new Keychain()
    keychain.values.set('cordisx/host-provider/v1/legacy/index', 'legacy-record')
    const { owner, options } = await setup(keychain)
    await owner.close()
    const configPath = path.join(options.homeDir, 'config.json')
    await writeFile(configPath, '{ invalid', { mode: 0o600 })
    await expect(ManagedProviderOwner.open(options)).rejects.toThrow('invalid JSON in home config')
    expect(await readFile(configPath, 'utf8')).toBe('{ invalid')
    expect(keychain.calls).toBe(0)
    expect(keychain.values.get('cordisx/host-provider/v1/legacy/index')).toBe('legacy-record')
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
    expect(keychain.calls).toBe(0)
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
