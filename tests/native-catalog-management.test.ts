import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'
import {
  CompositeCatalogManagement,
  NativeCatalogManagement,
} from '../packages/cli/src/launcher/model-catalog/native-catalog-management.js'
import { NativeConfigCatalogDiscovery } from '../packages/cli/src/launcher/model-catalog/native-config-catalog-discovery.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-native-catalog-management-'))
  roots.push(root)
  const codexHome = path.join(root, 'codex')
  const stateFile = path.join(root, 'cordisx', 'native-catalog-management.json')
  await mkdir(codexHome, { recursive: true })
  const configFile = path.join(codexHome, 'config.toml')
  const catalogFile = path.join(codexHome, 'models.json')
  const config = '[model_providers.gateway]\nname="Gateway"\nwire_api="responses"\n'
  await writeFile(configFile, config)
  await writeFile(catalogFile, JSON.stringify({ models: [{ slug: 'b' }, { slug: 'a' }] }))
  const load = () => codexConfigModelProviders(codexHome, { gateway: 'models.json' })
  return { root, codexHome, stateFile, configFile, catalogFile, config, load }
}

describe('native catalog management', () => {
  it('projects config providers without a managed owner and persists one overlay for catalog and admission', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({ load: f.load, stateFile: f.stateFile })
    const management = new CompositeCatalogManagement(native)
    const changed = vi.fn()
    native.subscribe(changed)

    const initial = management.snapshot()
    expect(initial.canCreateConnection).toBe(false)
    expect(initial.views).toEqual([expect.objectContaining({
      providerId: 'gateway',
      sourceKind: 'native',
      capabilities: ['refresh', 'setOverlay', 'resetOrder', 'restoreBlocked'],
      rows: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
    })])
    const view = initial.views[0]!
    await expect(management.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'b',
      pinned: true,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    const pinned = management.snapshot().views[0]!
    expect(pinned.rows.map(row => row.id)).toEqual(['b', 'a'])
    await expect(management.command({
      operation: 'setOverlay',
      bindingRef: pinned.bindingRef,
      scopeRevision: pinned.scopeRevision,
      expectedRevision: pinned.revision,
      modelId: 'b',
      blocked: true,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    expect((await native.catalog())[0]?.models.map(model => model.id)).toEqual(['a'])
    await expect(native.validateSelection('gateway', 'b')).resolves.toBe(false)
    await expect(native.validateSelection('gateway', 'a')).resolves.toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(await readFile(f.configFile, 'utf8')).toBe(f.config)

    const reopened = await NativeCatalogManagement.open({ load: f.load, stateFile: f.stateFile })
    expect((await reopened.catalog())[0]?.models.map(model => model.id)).toEqual(['a'])
    reopened.close()
    management.close()
  })

  it('rereads a static catalog on refresh and emits a sanitized native view update', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({ load: f.load })
    const changed = vi.fn()
    native.subscribe(changed)
    const view = native.snapshot().views[0]!
    await writeFile(f.catalogFile, JSON.stringify({ models: [{ slug: 'c' }] }))

    await expect(native.command({
      operation: 'refresh',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    expect(native.snapshot().views[0]?.rows.map(row => row.id)).toEqual(['c'])
    expect((await native.catalog())[0]?.models.map(model => model.id)).toEqual(['c'])
    expect(changed).toHaveBeenCalledOnce()
    expect(JSON.stringify(native.snapshot())).not.toContain(f.root)
    native.close()
  })

  it('keeps native views when the optional managed authority is absent', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({ load: f.load })
    expect(new CompositeCatalogManagement(native).snapshot().views.map(view => view.providerId)).toEqual(['gateway'])
  })

  it('requires a Responses route while keeping compatible blocked rows restorable', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({ load: f.load })
    const initial = native.snapshot().views[0]!
    expect(initial.rows.find(row => row.id === 'a')).toMatchObject({ selectable: true })
    await expect(native.command({
      operation: 'setOverlay',
      bindingRef: initial.bindingRef,
      scopeRevision: initial.scopeRevision,
      expectedRevision: initial.revision,
      modelId: 'a',
      blocked: true,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    expect(native.snapshot().views[0]?.rows.find(row => row.id === 'a')).toMatchObject({
      selectable: false,
      blocked: true,
      reason: 'blocked',
    })
    const blocked = native.snapshot().views[0]!
    await expect(native.command({
      operation: 'restoreBlocked',
      bindingRef: blocked.bindingRef,
      scopeRevision: blocked.scopeRevision,
      expectedRevision: blocked.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    expect(native.snapshot().views[0]?.rows.find(row => row.id === 'a')).toMatchObject({
      selectable: true,
      blocked: false,
    })

    await writeFile(f.configFile, '[model_providers.gateway]\nname="Gateway"\nwire_api="chat-completions"\n')
    const beforeRouteChange = native.snapshot().views[0]!
    await expect(native.command({
      operation: 'refresh',
      bindingRef: beforeRouteChange.bindingRef,
      scopeRevision: beforeRouteChange.scopeRevision,
      expectedRevision: beforeRouteChange.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    const chat = native
    expect(chat.snapshot().views[0]?.rows.every(row => !row.selectable)).toBe(true)
    expect(await chat.catalog()).toEqual([expect.objectContaining({ models: [] })])

    await writeFile(f.configFile, '[model_providers.gateway]\nname="Gateway"\n')
    const unknown = await NativeCatalogManagement.open({ load: f.load })
    expect(unknown.snapshot().views[0]?.rows.every(row => !row.selectable)).toBe(true)
    unknown.close()
    native.close()
  })

  it('augments static confirmed rows with committed remote evidence and retains LKG on failure', async () => {
    const f = await fixture()
    await writeFile(
      f.catalogFile,
      JSON.stringify({
        models: [{ slug: 'b' }, { slug: 'a' }, { slug: 'deepseek-flash', display_name: 'Pinned label' }],
      }),
    )
    await writeFile(
      f.configFile,
      [
        '[model_providers.gateway]',
        'name="Gateway"',
        'base_url="https://api.deepseek.com"',
        'env_key="DEEPSEEK_KEY"',
        'wire_api="responses"',
      ].join('\n'),
    )
    let fail = false
    const fetcher = vi.fn(async () => {
      if (fail) return new Response(null, { status: 503 })
      return Response.json({
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'remote-unknown', object: 'model', owned_by: 'deepseek' },
        ],
      })
    })
    const discovery = new NativeConfigCatalogDiscovery({
      environment: () => ({ DEEPSEEK_KEY: 'host-secret' }),
      fetcher,
    })
    const load = () => discovery.load({ codexHome: f.codexHome, catalogs: { gateway: 'models.json' } })
    const native = await NativeCatalogManagement.open({ load, discovery })
    const changed = vi.fn()
    native.subscribe(changed)
    const before = native.snapshot().views[0]!

    await expect(native.command({
      operation: 'refresh',
      bindingRef: before.bindingRef,
      scopeRevision: before.scopeRevision,
      expectedRevision: before.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })

    const fresh = native.snapshot().views[0]!
    expect(fresh).toMatchObject({ mode: 'augment', freshness: 'fresh', outcome: 'ok', sourceCount: 4 })
    expect(fresh.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', label: 'a', selectable: true, provenance: ['native'] }),
      expect.objectContaining({
        id: 'deepseek-flash',
        label: 'Pinned label',
        selectable: true,
        provenance: ['auto', 'native'],
        protocolCapabilities: { responses: true },
      }),
      expect.objectContaining({ id: 'remote-unknown', selectable: false, reason: 'unconfirmed' }),
    ]))
    expect((await native.catalog())[0]?.models.map(model => model.id)).toEqual(['a', 'b', 'deepseek-flash'])
    expect(changed).toHaveBeenCalled()

    fail = true
    await expect(native.command({
      operation: 'refresh',
      bindingRef: fresh.bindingRef,
      scopeRevision: fresh.scopeRevision,
      expectedRevision: fresh.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    const stale = native.snapshot().views[0]!
    expect(stale).toMatchObject({ freshness: 'stale', outcome: 'error' })
    expect(stale.rows.find(row => row.id === 'deepseek-flash')).toMatchObject({
      label: 'Pinned label',
      selectable: true,
      protocolCapabilities: { responses: true },
    })
    expect(stale.rows.find(row => row.id === 'a')).toMatchObject({ selectable: true })
    native.close()
    discovery.dispose()
  })

  it('preserves legacy native pin and block preferences after discovery is enabled', async () => {
    const f = await fixture()
    const legacy = await NativeCatalogManagement.open({ load: f.load, stateFile: f.stateFile })
    const initial = legacy.snapshot().views[0]!
    const pinned = await legacy.command({
      operation: 'setOverlay',
      bindingRef: initial.bindingRef,
      scopeRevision: initial.scopeRevision,
      expectedRevision: initial.revision,
      modelId: 'b',
      pinned: true,
    }, () => true)
    expect(pinned.status).toBe('applied')
    const pinnedView = legacy.snapshot().views[0]!
    await expect(legacy.command({
      operation: 'setOverlay',
      bindingRef: pinnedView.bindingRef,
      scopeRevision: pinnedView.scopeRevision,
      expectedRevision: pinnedView.revision,
      modelId: 'a',
      blocked: true,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    legacy.close()

    await writeFile(
      f.configFile,
      [
        '[model_providers.gateway]',
        'name="Gateway"',
        'base_url="https://api.deepseek.com"',
        'env_key="DEEPSEEK_KEY"',
        'wire_api="responses"',
      ].join('\n'),
    )
    let fail = false
    const discovery = new NativeConfigCatalogDiscovery({
      environment: () => ({ DEEPSEEK_KEY: 'host-secret' }),
      fetcher: async () => {
        if (fail) return new Response(null, { status: 503 })
        return Response.json({
          object: 'list',
          data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }],
        })
      },
    })
    const load = () => discovery.load({ codexHome: f.codexHome, catalogs: { gateway: 'models.json' } })
    const native = await NativeCatalogManagement.open({ load, stateFile: f.stateFile, discovery })
    const reopened = native.snapshot().views[0]!
    expect(reopened.scopeRevision).toBe(initial.scopeRevision)
    expect(reopened.rows.map(row => [row.id, row.pinned, row.blocked])).toEqual([
      ['b', true, false],
      ['a', false, true],
    ])

    await expect(native.command({
      operation: 'refresh',
      bindingRef: reopened.bindingRef,
      scopeRevision: reopened.scopeRevision,
      expectedRevision: reopened.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    const fresh = native.snapshot().views[0]!
    expect(fresh.rows.slice(0, 2).map(row => [row.id, row.pinned, row.blocked])).toEqual([
      ['b', true, false],
      ['a', false, true],
    ])

    fail = true
    await expect(native.command({
      operation: 'refresh',
      bindingRef: fresh.bindingRef,
      scopeRevision: fresh.scopeRevision,
      expectedRevision: fresh.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })
    expect(native.snapshot().views[0]?.rows.slice(0, 2).map(row => [row.id, row.pinned, row.blocked])).toEqual([
      ['b', true, false],
      ['a', false, true],
    ])
    native.close()
    discovery.dispose()
  })

  it('keeps Manager refresh local-only when native discovery is disabled', async () => {
    const f = await fixture()
    await writeFile(
      f.configFile,
      [
        '[model_providers.gateway]',
        'name="Gateway"',
        'base_url="https://api.deepseek.com"',
        'env_key="DEEPSEEK_KEY"',
        'wire_api="responses"',
      ].join('\n'),
    )
    const fetcher = vi.fn(async () => Response.json({ object: 'list', data: [] }))
    const discovery = new NativeConfigCatalogDiscovery({
      environment: () => ({ DEEPSEEK_KEY: 'host-secret' }),
      fetcher,
      enabled: false,
    })
    const load = () => discovery.load({ codexHome: f.codexHome, catalogs: { gateway: 'models.json' } })
    const native = await NativeCatalogManagement.open({ load, discovery })
    const initial = native.snapshot().views[0]!
    expect(initial).toMatchObject({ sourceKind: 'native', mode: 'only', autoPaused: false })

    await writeFile(f.catalogFile, JSON.stringify({ models: [{ slug: 'local-only' }] }))
    await expect(native.command({
      operation: 'refresh',
      bindingRef: initial.bindingRef,
      scopeRevision: initial.scopeRevision,
      expectedRevision: initial.revision,
    }, () => true)).resolves.toMatchObject({ status: 'applied' })

    expect(fetcher).not.toHaveBeenCalled()
    expect(native.snapshot().views[0]).toMatchObject({
      sourceKind: 'native',
      mode: 'only',
      autoPaused: false,
      rows: [expect.objectContaining({ id: 'local-only', selectable: true })],
    })
    native.close()
    discovery.dispose()
  })
})
