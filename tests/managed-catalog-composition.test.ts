import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import { NativeCatalogManagement } from '../packages/cli/src/launcher/model-catalog/native-catalog-management.js'
import type { LauncherKeychainBackend } from '../packages/cli/src/launcher/secret-store.js'
import type { CatalogConnectionSettings } from '../packages/cli/src/model-catalog-management.js'
import { PluginPreferenceAuthority } from '../packages/cli/src/model-catalog/plugin-preference-authority.js'
import { createNativeProviderCredentialBroker } from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { output, scriptFixture } from './script-source-helpers.js'

class Keychain implements LauncherKeychainBackend {
  values = new Map<string, string>()
  calls = 0
  async read(service: string, account: string) {
    this.calls++
    const value = this.values.get(`${service}/${account}`)
    if (!value) throw Error()
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
  title: 'Fixture',
  endpoint: 'https://fixture.invalid/v1',
  protocol: 'responses' as const,
  discoveryEnabled: false,
  strategy: { kind: 'manual' as const, ids: ['b', 'a'] },
}
function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => resolve = done)
  return { promise, resolve }
}

describe('managed catalog production owner', () => {
  const owners: ManagedCatalogComposition[] = [], homes: string[] = []
  afterEach(async () => {
    for (const owner of owners) await owner.close()
    for (const home of homes) await rm(home, { recursive: true, force: true })
  })
  async function setup() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'managed-catalog-'))
    homes.push(homeDir)
    const config = createDefaultHomeConfig()
    await writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        ...config,
        apps: {
          codex: {
            defaultProfile: 'fixture',
            profiles: { fixture: { displayName: 'Fixture', dataMode: 'shared' } },
          },
        },
      }),
      { mode: 0o600 },
    )
    const keychain = new Keychain()
    const options = {
      homeDir,
      profileId: 'fixture',
      keychain,
      responsesAvailable: true,
      capture: async () => 'fixture-provider-secret',
      fetcher: vi.fn(async () =>
        Response.json({ object: 'list', data: [{ object: 'model', id: 'discovered', owned_by: 'fixture' }] })
      ),
    }
    const owner = await ManagedCatalogComposition.open(options)
    owners.push(owner)
    return { owner, options, keychain }
  }
  async function create(owner: ManagedCatalogComposition, candidate: CatalogConnectionSettings = settings) {
    expect((await owner.command({ operation: 'createConnection', settings: candidate }, () => true)).status).toBe(
      'applied',
    )
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(2))
    return owner.snapshot().views[0]!
  }
  function scope(owner: ManagedCatalogComposition) {
    const view = owner.snapshot().views[0]!
    return { bindingRef: view.bindingRef, scopeRevision: view.scopeRevision, expectedRevision: view.revision }
  }
  const statePath = (homeDir: string) => path.join(homeDir, 'state/host-provider-owners/fixture.lock.state.v2.json')

  it('atomically retains manual model names through restart, label-only edits and connection scope changes', async () => {
    const { owner, options } = await setup()
    const models = [{ id: 'b', label: 'Beta' }, { id: 'a', label: 'Alpha', protocolCapabilities: { responses: true } }]
    await create(owner, { ...settings, models })
    expect(owner.snapshot().views[0]?.rows.map(row => [row.id, row.label])).toEqual([['a', 'Alpha'], ['b', 'Beta']])
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows).toHaveLength(2))
    expect(reopened.snapshot().views[0]?.connection?.models).toEqual(
      [...models].sort((a, b) => a.id.localeCompare(b.id)),
    )
    const initialRevision = reopened.snapshot().views[0]!.revision
    const renamed = [{ id: 'b', label: 'Beta renamed' }, models[1]!]
    expect(await reopened.command({ ...scope(reopened), operation: 'editManual', models: renamed }, () => true))
      .toMatchObject({ status: 'applied' })
    expect(reopened.snapshot().views[0]!.revision).not.toBe(initialRevision)
    await vi.waitFor(() =>
      expect(reopened.snapshot().views[0]?.rows.find(row => row.id === 'b')?.label).toBe('Beta renamed')
    )
    expect(
      await reopened.command({
        ...scope(reopened),
        operation: 'updateConnection',
        settings: { ...settings, endpoint: 'https://other.invalid/v1' },
      }, () => true),
    ).toMatchObject({ status: 'applied' })
    expect(reopened.snapshot().views[0]?.connection?.models).toEqual(
      [...renamed].sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(await reopened.command({ ...scope(reopened), operation: 'requestCredentialReplacement' }, () => true))
      .toMatchObject({ status: 'applied' })
    expect(reopened.snapshot().views[0]?.connection?.models).toEqual(
      [...renamed].sort((a, b) => a.id.localeCompare(b.id)),
    )
    const configBefore = await readFile(path.join(options.homeDir, 'config.json'), 'utf8')
    expect(
      await reopened.command({
        operation: 'createConnection',
        settings: { ...settings, models: [{ id: 'outside', label: 'Invalid' }] },
      }, () => true),
    ).toMatchObject({ status: 'rejected' })
    expect(await readFile(path.join(options.homeDir, 'config.json'), 'utf8')).toBe(configBefore)
    await reopened.close()
    const again = await ManagedCatalogComposition.open(options)
    owners.push(again)
    await vi.waitFor(() => expect(again.snapshot().views[0]?.rows).toHaveLength(2))
    expect(again.snapshot().views[0]?.rows.find(row => row.id === 'b')?.label).toBe('Beta renamed')
  })

  it('routes only Responses, keeps credentials private, and applies block/pin without membership elevation', async () => {
    const { owner, options, keychain } = await setup()
    const view = await create(owner)
    expect(view).toMatchObject({ providerFavorite: false })
    expect(view.preferenceCapabilities).toEqual([
      'setProviderFavorite',
      'setOverlay',
      'resetOrder',
      'restoreBlocked',
    ])
    expect(owner.admits(view.providerId, 'a')).toBe(true)
    const session = await owner.nativeConnection(view.providerId)
    expect(session.value.endpoint).toMatchObject({
      origin: 'https://fixture.invalid',
      apiPath: '/v1',
      auth: { token: 'fixture-provider-secret' },
    })
    expect(JSON.stringify(owner.snapshot())).not.toContain('fixture-provider-secret')
    const stale = scope(owner)
    expect((await owner.command({ ...stale, operation: 'setOverlay', modelId: 'a', blocked: true }, () => true)).status)
      .toBe('applied')
    expect(owner.admits(view.providerId, 'a')).toBe(false)
    expect((await owner.command({ ...stale, operation: 'setOverlay', modelId: 'b', pinned: true }, () => true)).code)
      .toBe('conflict')
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', pinned: true }, () => true)
    const entries = owner.preferenceStore.read(view.bindingRef, view.scopeRevision).entries
    expect(
      await owner.command({ ...scope(owner), operation: 'setProviderFavorite', favorite: 'yes' } as never, () => true),
    )
      .toMatchObject({ status: 'rejected', code: 'source-invalid' })
    expect(
      await owner.command(
        { ...scope(owner), operation: 'setProviderFavorite', favorite: true, extra: true } as never,
        () => true,
      ),
    )
      .toMatchObject({ status: 'rejected', code: 'source-invalid' })
    expect(await owner.command({ ...stale, operation: 'setProviderFavorite', favorite: true }, () => true))
      .toMatchObject({ status: 'conflict', code: 'conflict' })
    expect(
      (await owner.command({ ...scope(owner), operation: 'setProviderFavorite', favorite: true }, () => true)).status,
    )
      .toBe('applied')
    expect(owner.preferenceStore.read(view.bindingRef, view.scopeRevision).entries).toEqual(entries)
    await owner.command({ ...scope(owner), operation: 'resetOrder' }, () => true)
    expect(owner.snapshot().views[0]).toMatchObject({ providerFavorite: true })
    expect(owner.admits(view.providerId, 'a')).toBe(false)
    expect(options.fetcher).not.toHaveBeenCalled()
    const file = statePath(options.homeDir)
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, modelPreferences: { schemaVersion: 3 } })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows).toHaveLength(2))
    expect(reopened.snapshot().views[0]?.providerFavorite).toBe(true)
    expect(reopened.admits(view.providerId, 'a')).toBe(false)
    expect(keychain.calls).toBe(0)
  })

  it('projects selected managed connections into non-secret provider sync definitions', async () => {
    const { owner } = await setup()
    const view = await create(owner)
    const connectionId = `cx-connection-${view.bindingRef}`

    expect(owner.providerSyncConnections(new Set([connectionId, 'cx-connection-0123456789abcdef']))).toEqual([
      expect.objectContaining({
        connectionId,
        title: 'Fixture',
        endpoint: 'https://fixture.invalid/v1',
        protocol: 'responses',
        credential: expect.objectContaining({ secretRef: connectionId }),
        models: { ids: ['a', 'b'], completeness: 'complete' },
        enabled: true,
      }),
    ])
    expect(JSON.stringify(owner.providerSyncConnections(new Set([connectionId]))))
      .not.toContain('fixture-provider-secret')
  })

  it('retains chat-completions catalog rows but never admits them to native Responses routing', async () => {
    const { owner } = await setup()
    const view = await create(owner, { ...settings, protocol: 'chat-completions' })
    expect(view.rows).toHaveLength(2)
    expect(view.selectableCount).toBe(0)
    expect(owner.admits(view.providerId, 'a')).toBe(false)
    await expect(owner.nativeConnection(view.providerId)).rejects.toThrow('unsupported')
  })

  it('discovers opted-in auto asynchronously and restores only the scoped cache while paused', async () => {
    const { owner, options } = await setup()
    await owner.command({
      operation: 'createConnection',
      settings: {
        ...settings,
        endpoint: 'https://api.deepseek.com',
        protocol: 'responses',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows[0]?.id).toBe('discovered'))
    await owner.command({ ...scope(owner), operation: 'setAutoPaused', paused: true }, () => true)
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'discovered', pinned: true }, () => true)
    await owner.close()
    options.fetcher.mockClear()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.snapshot().views[0]?.rows[0]?.id).toBe('discovered')
    expect(reopened.snapshot().views[0]?.freshness).toBe('stale')
    expect(options.fetcher).not.toHaveBeenCalled()
  })

  it('rejects unauthorized commands without invoking capture', async () => {
    const { owner } = await setup()
    expect(await owner.command({ operation: 'createConnection', settings }, () => false)).toMatchObject({
      code: 'permission',
    })
    expect(owner.snapshot().views).toEqual([])
  })

  it('delivers only fixture keys to the native helper and revokes its old scope after replacement', async () => {
    const { owner } = await setup()
    const view = await create(owner)
    const broker = createNativeProviderCredentialBroker({ resolve: id => owner.nativeConnection(id) })
    try {
      const lease = await broker.prepare(view.providerId)
      if (lease.scheme !== 'bearer') throw Error('expected fixture bearer')
      expect(JSON.stringify(lease)).not.toContain('fixture-provider-secret')
      const run = () => promisify(execFile)(lease.auth.command, [...lease.auth.args], { cwd: lease.auth.cwd })
      expect((await run()).stdout).toBe('fixture-provider-secret')
      expect((await owner.command({ ...scope(owner), operation: 'requestCredentialReplacement' }, () => true)).status)
        .toBe('applied')
      await expect(run()).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' })
      lease.dispose()
    } finally {
      await broker.close()
    }
  })

  it('uses adapter Responses capability for exact official models and preserves it in the scoped cache', async () => {
    const { owner, options } = await setup()
    options.fetcher.mockResolvedValueOnce(
      Response.json({
        object: 'list',
        data: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'unknown'].map(id => ({
          id,
          object: 'model',
          owned_by: 'deepseek',
        })),
      }),
    )
    await owner.command({
      operation: 'createConnection',
      settings: {
        ...settings,
        endpoint: 'https://api.deepseek.com',
        protocol: 'responses',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'only', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(4))
    expect(owner.catalog()[0]?.models.map(row => row.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    const session = await owner.nativeConnection(owner.snapshot().views[0]!.providerId)
    expect(session.value.endpoint).toMatchObject({ origin: 'https://api.deepseek.com', apiPath: '/' })
    await owner.command({ ...scope(owner), operation: 'setAutoPaused', paused: true }, () => true)
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.catalog()[0]?.models.map(row => row.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })

  it('keeps automatic capability unknown until an exact scoped user declaration overrides it', async () => {
    const { owner, options } = await setup()
    await owner.command({
      operation: 'createConnection',
      settings: {
        ...settings,
        endpoint: 'https://api.deepseek.com',
        protocol: 'responses',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows[0]?.id).toBe('discovered'))
    expect(owner.snapshot().views[0]?.rows[0]).toMatchObject({
      selectable: false,
      reason: 'unconfirmed',
      provenance: ['auto'],
    })

    expect(
      (await owner.command({
        ...scope(owner),
        operation: 'editSupplement',
        models: [
          { id: 'discovered', label: 'Renamed', protocolCapabilities: { responses: true } },
          { id: 'manual-only' },
        ],
      }, () => true)).status,
    ).toBe('applied')
    let view = owner.snapshot().views[0]!
    expect(view.rows.find(row => row.id === 'discovered')).toMatchObject({
      label: 'Renamed',
      selectable: true,
      protocolCapabilities: { responses: true },
      provenance: ['auto', 'manual-supplement'],
    })
    expect(view.rows.find(row => row.id === 'manual-only')).toMatchObject({
      notListed: true,
      selectable: true,
      provenance: ['manual-supplement'],
      protocolCapabilities: { responses: true },
    })

    options.fetcher.mockResolvedValueOnce(
      Response.json({ object: 'list', data: [{ id: 'discovered', object: 'model', owned_by: 'fixture' }] }),
    )
    await owner.command({ ...scope(owner), operation: 'refresh' }, () => true)
    await vi.waitFor(() => expect(options.fetcher).toHaveBeenCalledTimes(2))
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'discovered')?.protocolCapabilities).toEqual({
      responses: true,
    })

    const rejected = await owner.command({
      ...scope(owner),
      operation: 'editSupplement',
      models: [{ id: 'discovered', protocolCapabilities: {} }],
    } as never, () => true)
    expect(rejected).toMatchObject({ status: 'rejected', code: 'source-invalid' })
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'discovered')?.protocolCapabilities).toEqual({
      responses: true,
    })

    await owner.command({
      ...scope(owner),
      operation: 'editSupplement',
      models: [{ id: 'discovered', protocolCapabilities: { responses: false } }],
    }, () => true)
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'discovered')).toMatchObject({
      selectable: false,
      protocolCapabilities: { responses: false },
    })

    await owner.command({
      ...scope(owner),
      operation: 'editSupplement',
      models: [{ id: 'discovered', label: 'Label only' }],
    }, () => true)
    view = owner.snapshot().views[0]!
    expect(view.rows.find(row => row.id === 'discovered')).toMatchObject({
      label: 'Label only',
      selectable: false,
      reason: 'unconfirmed',
    })
    expect(view.rows.find(row => row.id === 'discovered')?.protocolCapabilities).toBeUndefined()

    await owner.command({
      operation: 'createConnection',
      settings: {
        ...settings,
        title: 'OpenCode Go',
        endpoint: 'https://opencode.ai/zen/go/v1',
        protocol: 'responses',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() =>
      expect(
        owner.snapshot().views.find(view => view.title === 'OpenCode Go')?.rows.some(row => row.id === 'discovered'),
      )
        .toBe(true)
    )
    const second = owner.snapshot().views.find(view => view.title === 'OpenCode Go')!
    expect(
      (await owner.command({
        operation: 'editSupplement',
        bindingRef: second.bindingRef,
        scopeRevision: second.scopeRevision,
        expectedRevision: second.revision,
        models: [{ id: 'discovered', protocolCapabilities: { responses: true } }],
      }, () => true)).status,
    ).toBe('applied')
    const firstAfter = owner.snapshot().views.find(view => view.title === 'Fixture')!
    const secondAfter = owner.snapshot().views.find(view => view.title === 'OpenCode Go')!
    expect(firstAfter.rows.find(row => row.id === 'discovered')?.protocolCapabilities).toBeUndefined()
    expect(secondAfter.rows.find(row => row.id === 'discovered')?.protocolCapabilities).toEqual({ responses: true })
  })

  it('closes promptly when credential capture ignores cancellation', async () => {
    const { owner, options } = await setup()
    await owner.close()
    const capture = vi.fn(() => new Promise<string>(() => {}))
    const active = await ManagedCatalogComposition.open({ ...options, capture })
    owners.push(active)
    const command = active.command({ operation: 'createConnection', settings }, () => true)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    await active.close()
    expect((await command).status).toBe('rejected')
    expect(active.snapshot().views).toEqual([])
  }, 2000)

  it('does not overwrite invalid state or publish a failed overlay write', async () => {
    const { owner, options } = await setup()
    await create(owner)
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', pinned: true }, () => true)
    const file = statePath(options.homeDir)
    await writeFile(file, 'invalid state', { mode: 0o600 })
    expect(
      (await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', blocked: true }, () => true))
        .status,
    ).toBe('rejected')
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'a')?.blocked).toBe(false)
    await expect(owner.close()).rejects.toThrow()
    owners.splice(owners.indexOf(owner), 1)
    await expect(ManagedCatalogComposition.open(options)).rejects.toThrow('source-invalid')
    expect(await readFile(file, 'utf8')).toBe('invalid state')
  })

  it('preserves scripts, caches, and admitted root sections during preference writes', async () => {
    const { owner, options } = await setup()
    expect(
      (await owner.command({
        operation: 'createConnection',
        settings: {
          ...settings,
          endpoint: 'https://api.deepseek.com',
          discoveryEnabled: true,
          strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60000 },
        },
      }, () => true)).status,
    ).toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows.some(row => row.id === 'discovered')).toBe(true))
    expect(
      (await owner.command({
        ...scope(owner),
        operation: 'configureScript',
        mode: 'supplement',
        config: {
          schemaVersion: 1,
          command: { kind: 'exec', executable: process.execPath, args: [] },
          cwd: options.homeDir,
        },
      }, () => true)).status,
    ).toBe('applied')
    await owner.close()
    const file = statePath(options.homeDir)
    const seeded = {
      ...JSON.parse(await readFile(file, 'utf8')),
      admittedFutureSection: { retained: ['exact'] },
    }
    expect(Object.keys(seeded.scripts)).not.toHaveLength(0)
    expect(Object.keys(seeded.caches)).not.toHaveLength(0)
    await writeFile(file, JSON.stringify(seeded), { mode: 0o600 })

    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows[0]?.id).toBe('discovered'))
    const view = reopened.snapshot().views[0]!
    const result = await reopened.command({
      ...scope(reopened),
      operation: 'setOverlay',
      modelId: view.rows[0]!.id,
      pinned: true,
    }, () => true)
    expect(result).toMatchObject({ status: 'applied' })

    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      scripts: seeded.scripts,
      caches: seeded.caches,
      admittedFutureSection: seeded.admittedFutureSection,
      modelPreferences: { schemaVersion: 3, revision: 1 },
    })
  })

  it('maps authorization revocation at owner commit to permission without publishing state', async () => {
    const { owner, options } = await setup()
    await create(owner)
    const before = owner.snapshot().views[0]!
    const durable = await readFile(statePath(options.homeDir), 'utf8')
    let checks = 0
    const result = await owner.command({
      ...scope(owner),
      operation: 'setProviderFavorite',
      favorite: true,
    }, () => ++checks < 3)

    expect(result).toEqual({ status: 'rejected', code: 'permission' })
    expect(owner.snapshot().views[0]?.providerFavorite).toBe(false)
    expect(owner.snapshot().views[0]?.revision).toBe(before.revision)
    expect(await readFile(statePath(options.homeDir), 'utf8')).toBe(durable)
  })

  it('rejects a queued preference command when its source membership changes', async () => {
    const { owner, options } = await setup()
    const script = await scriptFixture(output([{ id: 'a' }]))
    await create(owner)
    try {
      await owner.command({
        ...scope(owner),
        operation: 'configureScript',
        mode: 'replace',
        config: script.config,
      }, () => true)
      expect((await owner.command({ ...scope(owner), operation: 'runScript' }, () => true)).status).toBe('applied')
      await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows[0]?.id).toBe('a'))
      await writeFile(script.file, `setTimeout(() => ${output([{ id: 'scripted' }])}, 100)`)
      expect((await owner.command({ ...scope(owner), operation: 'runScript' }, () => true)).status).toBe('applied')
      const durable = await readFile(statePath(options.homeDir), 'utf8')
      const entered = deferred<void>()
      const release = deferred<void>()
      const mutate = owner.preferenceStore.mutate.bind(owner.preferenceStore)
      vi.spyOn(owner.preferenceStore, 'mutate').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return await mutate(...args)
      })
      const command = owner.command({
        ...scope(owner),
        operation: 'setProviderFavorite',
        favorite: true,
      }, () => true)
      try {
        await entered.promise
        await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows.some(row => row.id === 'scripted')).toBe(true))
      } finally {
        release.resolve()
      }

      await expect(command).resolves.toEqual({ status: 'conflict', code: 'conflict' })
      expect(owner.preferenceStore.snapshot().bindings).toEqual([])
      expect(await readFile(statePath(options.homeDir), 'utf8')).toBe(durable)
    } finally {
      await script.close()
    }
  })

  it('keeps supported blocked managed rows recoverable across reopen', async () => {
    const { owner, options } = await setup()
    await create(owner)
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', blocked: true }, () => true)
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'a')).toMatchObject({
      compatibility: 'supported',
      blocked: true,
      selectable: false,
    })
    await owner.close()

    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows).toHaveLength(2))
    const blocked = reopened.snapshot().views[0]!
    expect(blocked.rows.find(row => row.id === 'a')).toMatchObject({
      compatibility: 'supported',
      blocked: true,
      selectable: false,
    })
    const result = await reopened.command({
      bindingRef: blocked.bindingRef,
      scopeRevision: blocked.scopeRevision,
      expectedRevision: blocked.revision,
      operation: 'restoreBlocked',
    }, () => true)
    expect(result).toMatchObject({ status: 'applied' })
    expect(reopened.snapshot().views[0]?.rows.find(row => row.id === 'a')).toMatchObject({
      compatibility: 'supported',
      blocked: false,
      selectable: true,
    })
  })

  it('serializes native and plugin preferences through one profile store and reopens both bindings', async () => {
    const { owner, options } = await setup()
    const projection = {
      providers: [{
        providerId: 'native-fixture',
        pluginId: 'cordisx.codex-config',
        models: [{ id: 'native-model', label: 'Native model', aliases: [] }],
      }],
      providerIds: new Set(['native-fixture']),
      providerWireApis: new Map([['native-fixture', 'responses' as const]]),
      sourceAvailable: true,
      diagnostics: [],
    }
    const native = await NativeCatalogManagement.open({
      load: async () => projection,
      overlayStore: owner.preferenceStore,
    })
    const plugins = await PluginPreferenceAuthority.open({
      load: async () => [{
        pluginId: 'fixture-plugin',
        providerId: 'plugin-fixture',
        models: [{ id: 'plugin-model', label: 'Plugin model', selectable: true }],
      }],
      overlayStore: owner.preferenceStore,
    })
    try {
      const nativeView = native.snapshot().views[0]!
      expect(
        (await native.command({
          bindingRef: nativeView.bindingRef,
          scopeRevision: nativeView.scopeRevision,
          expectedRevision: nativeView.revision,
          operation: 'setOverlay',
          modelId: 'native-model',
          pinned: true,
        }, () => true)).status,
      ).toBe('applied')

      const pluginView = plugins.snapshot().views[0]!
      expect(
        (await plugins.command({
          bindingRef: pluginView.bindingRef,
          scopeRevision: pluginView.scopeRevision,
          expectedRevision: pluginView.revision,
          operation: 'setOverlay',
          modelId: 'plugin-model',
          blocked: true,
        }, () => true)).status,
      ).toBe('applied')

      const pinnedNative = native.snapshot().views[0]!
      expect(
        (await native.command({
          bindingRef: pinnedNative.bindingRef,
          scopeRevision: pinnedNative.scopeRevision,
          expectedRevision: pinnedNative.revision,
          operation: 'setOverlay',
          modelId: 'native-model',
          pinned: false,
        }, () => true)).status,
      ).toBe('applied')

      const blockedPlugin = plugins.snapshot().views[0]!
      expect(
        (await plugins.command({
          bindingRef: blockedPlugin.bindingRef,
          scopeRevision: blockedPlugin.scopeRevision,
          expectedRevision: blockedPlugin.revision,
          operation: 'restoreBlocked',
        }, () => true)).status,
      ).toBe('applied')
    } finally {
      plugins.close()
      native.close()
      await owner.close()
    }

    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.preferenceStore.snapshot().bindings.map(binding => binding.bindingRef).sort()).toEqual([
      'codex-config:native-fixture',
      'plugin:fixture-plugin:plugin-fixture',
    ].sort())
    expect(reopened.preferenceStore.read('codex-config:native-fixture', 'native-scope').entries).toEqual([])
    expect(reopened.preferenceStore.read('plugin:fixture-plugin:plugin-fixture', 'plugin-scope').entries).toEqual([])
  })

  it('imports valid legacy native preferences once without changing legacy bytes', async () => {
    const { owner, options } = await setup()
    await create(owner)
    await owner.close()
    const legacyFile = path.join(options.homeDir, 'native-catalog-management.json')
    const legacy = JSON.stringify(
      {
        schemaVersion: 2,
        revision: 7,
        bindings: [{
          bindingRef: 'codex-config:gateway',
          revision: '7',
          entries: [{ id: 'native-model', blocked: true, pinRank: 0 }],
        }],
      },
      null,
      2,
    ) + '\n'
    await writeFile(legacyFile, legacy, { mode: 0o600 })

    const reopened = await ManagedCatalogComposition.open({ ...options, legacyNativePreferenceFile: legacyFile })
    owners.push(reopened)
    expect(reopened.preferenceStore.read('codex-config:gateway', 'current').entries).toEqual([
      { id: 'native-model', blocked: true, pinRank: 0 },
    ])
    expect(reopened.preferenceStore.read('codex-config:gateway', 'current').providerFavorite).toBe(false)
    expect(await readFile(legacyFile, 'utf8')).toBe(legacy)
    expect(JSON.parse(await readFile(statePath(options.homeDir), 'utf8'))).toMatchObject({
      modelPreferences: { schemaVersion: 3, revision: 7 },
    })
  })

  it.each([
    ['malformed', '{not-json'],
    ['future', JSON.stringify({ schemaVersion: 4, revision: 9, bindings: [] })],
  ])('leaves %s legacy native preference state untouched', async (_kind, legacy) => {
    const { owner, options } = await setup()
    await create(owner)
    await owner.close()
    const legacyFile = path.join(options.homeDir, 'native-catalog-management.json')
    await writeFile(legacyFile, legacy, { mode: 0o600 })
    const before = await readFile(statePath(options.homeDir), 'utf8')

    const reopened = await ManagedCatalogComposition.open({ ...options, legacyNativePreferenceFile: legacyFile })
    owners.push(reopened)
    expect(await readFile(legacyFile, 'utf8')).toBe(legacy)
    expect(await readFile(statePath(options.homeDir), 'utf8')).toBe(before)
  })

  it('ignores and preserves legacy encrypted state while using new file-backed Providers', async () => {
    const { owner, options, keychain } = await setup()
    const view = await create(owner)
    await owner.close()
    const directory = path.join(options.homeDir, 'state/host-provider-owners')
    const legacyPath = path.join(directory, 'fixture.lock.state')
    const currentPath = path.join(directory, 'fixture.lock.state.v2.json')
    const legacy = JSON.stringify({ version: 1, iv: 'legacy-iv', tag: 'legacy-tag', body: 'legacy-body' })
    await rm(currentPath, { force: true })
    await writeFile(legacyPath, legacy, { mode: 0o600 })

    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows).toHaveLength(2))
    expect(reopened.snapshot().views[0]?.bindingRef).toBe(view.bindingRef)
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy)
    expect(keychain.calls).toBe(0)

    await reopened.command({ ...scope(reopened), operation: 'setOverlay', modelId: 'a', blocked: true }, () => true)
    await reopened.close()
    expect(JSON.parse(await readFile(currentPath, 'utf8'))).toMatchObject({ version: 1 })
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy)

    const again = await ManagedCatalogComposition.open(options)
    owners.push(again)
    expect(again.snapshot().views[0]?.rows.find(row => row.id === 'a')?.blocked).toBe(true)
  })

  it('retains durable preferences across a new endpoint scope', async () => {
    const { owner } = await setup()
    const initial = await create(owner)
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', blocked: true }, () => true)
    expect(
      (await owner.command({
        ...scope(owner),
        operation: 'updateConnection',
        settings: { ...settings, endpoint: 'https://other.invalid/v1' },
      }, () => true)).status,
    ).toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(2))
    expect(owner.snapshot().views[0]?.scopeRevision).not.toBe(initial.scopeRevision)
    expect(owner.admits(initial.providerId, 'a')).toBe(false)
  })

  it('keeps denied cached rows visible but not selectable and persists a complete empty result', async () => {
    const { owner, options } = await setup()
    await owner.command({
      operation: 'createConnection',
      settings: {
        ...settings,
        endpoint: 'https://api.deepseek.com',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'only', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(1))
    options.fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
    await owner.command({ ...scope(owner), operation: 'refresh' }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.diagnostics.code).toBe('authentication'))
    expect(owner.snapshot().views[0]?.rows).toHaveLength(1)
    expect(owner.snapshot().views[0]?.selectableCount).toBe(0)
    options.fetcher.mockResolvedValueOnce(Response.json({ object: 'list', data: [] }))
    await owner.command({ ...scope(owner), operation: 'refresh' }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.outcome).toBe('empty'))
    expect(owner.snapshot().views[0]?.preferenceCapabilities).toContain('setProviderFavorite')
    expect(
      (await owner.command({ ...scope(owner), operation: 'setProviderFavorite', favorite: true }, () => true)).status,
    )
      .toBe('applied')
    await owner.command({ ...scope(owner), operation: 'setAutoPaused', paused: true }, () => true)
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.snapshot().views[0]).toMatchObject({ outcome: 'empty', providerFavorite: true, rows: [] })
  })
})
