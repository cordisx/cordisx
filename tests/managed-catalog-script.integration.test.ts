import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import { output, scriptFixture } from './script-source-helpers.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'

it('persists write-only script config, runs explicitly, publishes exact results, and restarts without execution', async () => {
  const fixture = await scriptFixture(output([{ id: 'scripted' }]))
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'managed-script-'))
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
  const values = new Map<string, string>()
  const options = {
    homeDir,
    profileId: 'fixture',
    responsesAvailable: true,
    capture: async () => 'fixture-key',
    keychain: {
      async read(service: string, account: string) {
        const value = values.get(`${service}/${account}`)
        if (!value) throw Error()
        return value
      },
      async status(service: string, account: string): Promise<'set' | 'unset'> {
        return values.has(`${service}/${account}`) ? 'set' : 'unset'
      },
      async upsert(service: string, account: string, value: string) {
        values.set(`${service}/${account}`, value)
      },
      async remove(service: string, account: string) {
        values.delete(`${service}/${account}`)
      },
    },
  }
  let owner = await ManagedCatalogComposition.open(options)
  const scope = () => {
    const view = owner.snapshot().views[0]!
    return { bindingRef: view.bindingRef, scopeRevision: view.scopeRevision, expectedRevision: view.revision }
  }
  try {
    await owner.command({
      operation: 'createConnection',
      settings: {
        title: 'Script fixture',
        endpoint: 'https://fixture.invalid',
        protocol: 'responses',
        discoveryEnabled: false,
        strategy: { kind: 'manual', ids: ['manual'] },
      },
    }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows).toHaveLength(1))
    expect(
      (await owner.command(
        { ...scope(), operation: 'configureScript', mode: 'replace', config: fixture.config },
        () => true,
      )).status,
    ).toBe('applied')
    expect(owner.snapshot().views[0]?.rows).toEqual([])
    expect(JSON.stringify(owner.snapshot())).not.toMatch(/fixture\.cjs|environment|executable|fixture-key/)
    expect((await owner.command({ ...scope(), operation: 'runScript' }, () => true)).status).toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows[0]?.id).toBe('scripted'))
    expect(owner.catalog()[0]?.models[0]?.provenance).toEqual(['script'])
    await writeFile(fixture.file, output([]))
    await owner.command({ ...scope(), operation: 'runScript' }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.outcome).toBe('empty'))
    await owner.close()
    const raw = await readFile(path.join(homeDir, 'state/host-provider-owners/fixture.lock.state.v2.json'), 'utf8')
    expect(raw).toContain(fixture.file)
    expect(raw).not.toContain('fixture-key')
    owner = await ManagedCatalogComposition.open(options)
    expect(owner.snapshot().views[0]).toMatchObject({ sourceKind: 'script', outcome: 'none', rows: [] })
    await owner.command({ ...scope(), operation: 'refresh' }, () => true)
    expect(owner.snapshot().views[0]?.outcome).toBe('none')
    expect(
      (await owner.command({ ...scope(), operation: 'editManual', models: [{ id: 'manual' }] }, () => true)).status,
    )
      .toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.sourceKind).toBe('manual'))
    expect(owner.snapshot().views[0]?.capabilities).not.toContain('runScript')
    await owner.close()
    owner = await ManagedCatalogComposition.open(options)
    expect(owner.snapshot().views[0]?.sourceKind).toBe('manual')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.freshness).toBe('fresh'))
    await owner.command(
      { ...scope(), operation: 'configureScript', mode: 'replace', config: fixture.config },
      () => true,
    )
    expect(owner.snapshot().views[0]?.sourceKind).toBe('script')
    expect(
      (await owner.command({
        ...scope(),
        operation: 'editManual',
        models: [{ id: 'manual', label: 'Named manual model' }],
      }, () => true)).status,
    ).toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.sourceKind).toBe('manual'))
    expect(owner.snapshot().views[0]?.connection?.models).toEqual([{ id: 'manual', label: 'Named manual model' }])
    expect(owner.snapshot().views[0]?.capabilities).not.toContain('runScript')
    await owner.close()
    owner = await ManagedCatalogComposition.open(options)
    expect(owner.snapshot().views[0]?.sourceKind).toBe('manual')
    expect(owner.snapshot().views[0]?.connection?.models).toEqual([{ id: 'manual', label: 'Named manual model' }])
    await owner.command(
      { ...scope(), operation: 'configureScript', mode: 'replace', config: fixture.config },
      () => true,
    )
    await owner.close()
    owner = await ManagedCatalogComposition.open(options)
    expect(owner.snapshot().views[0]?.sourceKind).toBe('script')
    await writeFile(fixture.file, output([{ id: 'converted', label: 'Converted model' }]))
    await owner.command({ ...scope(), operation: 'runScript' }, () => true)
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.rows[0]?.id).toBe('converted'))
    expect((await owner.command({ ...scope(), operation: 'convertToManual' }, () => true)).status).toBe('applied')
    await vi.waitFor(() => expect(owner.snapshot().views[0]?.sourceKind).toBe('manual'))
    expect(owner.snapshot().views[0]?.connection?.models).toEqual([{ id: 'converted', label: 'Converted model' }])
    await owner.close()
    owner = await ManagedCatalogComposition.open(options)
    expect(owner.snapshot().views[0]?.sourceKind).toBe('manual')
    expect(owner.snapshot().views[0]?.connection?.models).toEqual([{ id: 'converted', label: 'Converted model' }])
    await owner.command({
      ...scope(),
      operation: 'updateConnection',
      settings: {
        title: 'Paused supplement fixture',
        endpoint: 'https://api.deepseek.com',
        protocol: 'responses',
        discoveryEnabled: false,
        strategy: { kind: 'auto', adapter: 'detect', mode: 'augment', ttlMs: 60000 },
      },
    }, () => true)
    expect(
      (await owner.command(
        { ...scope(), operation: 'configureScript', mode: 'supplement', config: fixture.config },
        () => true,
      )).status,
    )
      .toBe('applied')
    const scriptState = owner.snapshot().views[0]?.scriptState
    for (const mode of ['only', 'augment'] as const) {
      expect((await owner.command({ ...scope(), operation: 'setMode', mode }, () => true)).status).toBe('applied')
      expect(owner.snapshot().views[0]?.scriptState).toEqual(scriptState)
      expect(owner.snapshot().views[0]?.capabilities).toContain('runScript')
    }
  } finally {
    await owner.close()
    await fixture.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})
