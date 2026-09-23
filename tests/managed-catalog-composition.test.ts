import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import type { LauncherKeychainBackend } from '../packages/cli/src/launcher/secret-store.js'
import type { CatalogConnectionSettings } from '../packages/cli/src/model-catalog-management.js'
import { createNativeProviderCredentialBroker } from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

class Keychain implements LauncherKeychainBackend {
  values = new Map<string, string>()
  async read(service: string, account: string) {
    const value = this.values.get(`${service}/${account}`)
    if (!value) throw Error()
    return value
  }
  async status(service: string, account: string): Promise<'set' | 'unset'> {
    return this.values.has(`${service}/${account}`) ? 'set' : 'unset'
  }
  async upsert(service: string, account: string, value: string) {
    this.values.set(`${service}/${account}`, value)
  }
  async remove(service: string, account: string) {
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

describe('managed catalog production owner', () => {
  const owners: ManagedCatalogComposition[] = [], homes: string[] = []
  afterEach(async () => {
    for (const owner of owners) await owner.close()
    for (const home of homes) await rm(home, { recursive: true, force: true })
  })
  async function setup() {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'managed-catalog-'))
    homes.push(homeDir)
    const options = {
      homeDir,
      profileId: 'fixture',
      keychain: new Keychain(),
      responsesAvailable: true,
      capture: async () => 'fixture-provider-secret',
      fetcher: vi.fn(async () =>
        Response.json({ object: 'list', data: [{ object: 'model', id: 'discovered', owned_by: 'fixture' }] })
      ),
    }
    const owner = await ManagedCatalogComposition.open(options)
    owners.push(owner)
    return { owner, options }
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

  it('routes only Responses, keeps credentials private, and applies block/pin without membership elevation', async () => {
    const { owner, options } = await setup()
    const view = await create(owner)
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
    expect(owner.admits(view.providerId, 'a')).toBe(false)
    expect(options.fetcher).not.toHaveBeenCalled()
    const raw = await readFile(path.join(options.homeDir, 'state/host-provider-owners/fixture.lock.state'), 'utf8')
    expect(raw).not.toContain('bindingRef')
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    await vi.waitFor(() => expect(reopened.snapshot().views[0]?.rows).toHaveLength(2))
    expect(reopened.admits(view.providerId, 'a')).toBe(false)
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
        protocol: 'chat-completions',
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
        protocol: 'chat-completions',
        discoveryEnabled: true,
        strategy: { kind: 'auto', mode: 'only', adapter: 'detect', ttlMs: 60000 },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(4))
    expect(owner.catalog()[0]?.models.map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    const session = await owner.nativeConnection(owner.snapshot().views[0]!.providerId)
    expect(session.value.endpoint).toMatchObject({ origin: 'https://api.deepseek.com', apiPath: '/' })
    await owner.command({ ...scope(owner), operation: 'setAutoPaused', paused: true }, () => true)
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.catalog()[0]?.models.map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
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

  it('does not overwrite invalid ciphertext or publish a failed overlay write', async () => {
    const { owner, options } = await setup()
    await create(owner)
    await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', pinned: true }, () => true)
    const file = path.join(options.homeDir, 'state/host-provider-owners/fixture.lock.state')
    await writeFile(file, 'invalid ciphertext', { mode: 0o600 })
    expect(
      (await owner.command({ ...scope(owner), operation: 'setOverlay', modelId: 'a', blocked: true }, () => true))
        .status,
    ).toBe('rejected')
    expect(owner.snapshot().views[0]?.rows.find(row => row.id === 'a')?.blocked).toBe(false)
    await expect(owner.close()).rejects.toThrow()
    owners.splice(owners.indexOf(owner), 1)
    await expect(ManagedCatalogComposition.open(options)).rejects.toThrow('source-invalid')
    expect(await readFile(file, 'utf8')).toBe('invalid ciphertext')
  })

  it('does not carry overlay preferences into a new endpoint scope', async () => {
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
    expect(owner.admits(initial.providerId, 'a')).toBe(true)
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
    await owner.command({ ...scope(owner), operation: 'setAutoPaused', paused: true }, () => true)
    await owner.close()
    const reopened = await ManagedCatalogComposition.open(options)
    owners.push(reopened)
    expect(reopened.snapshot().views[0]).toMatchObject({ outcome: 'empty', rows: [] })
  })
})
