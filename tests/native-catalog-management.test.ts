import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'
import {
  CompositeCatalogManagement,
  NativeCatalogManagement,
} from '../packages/cli/src/launcher/model-catalog/native-catalog-management.js'

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
  const config = '[model_providers.gateway]\nname="Gateway"\n'
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
})
