import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelCatalogClient } from '../packages/cli/src/renderer/model-catalog-client.js'
import { parseManagementSnapshot } from '../packages/cli/src/renderer/model-catalog-projection.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
import type {
  CatalogManagementCursor,
  CatalogManagementSnapshot,
} from '../packages/cli/src/model-catalog-management.js'

const clients: ModelCatalogClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

describe('catalog management Host consumer', () => {
  it('accepts an exact maximum-length ID used as its fallback label', () => {
    const id = 'm'.repeat(512)
    const row = { ...catalogView().rows[0]!, id, label: id }
    const parsed = parseManagementSnapshot({ epoch: 'a', sequence: 0, views: [catalogView({ rows: [row] })] })
    expect(parsed.views[0]?.rows[0]?.id).toBe(id)
    expect(() =>
      parseManagementSnapshot({
        epoch: 'a',
        sequence: 0,
        views: [catalogView({ rows: [{ ...row, label: 'l'.repeat(257) }] })],
      })
    ).toThrow()
  })

  it('projects missing compatibility as unknown and recomputes supported counts', () => {
    const legacy = catalogView({
      sourceCount: 3,
      selectableCount: 3,
      rows: [
        { ...catalogView().rows[0]!, compatibility: undefined },
        { ...catalogView().rows[1]!, compatibility: 'unsupported' },
        { ...catalogView().rows[0]!, id: 'supported', label: 'Supported', compatibility: 'supported' },
      ],
    })
    const parsed = parseManagementSnapshot({ epoch: 'a', sequence: 0, views: [legacy] }).views[0]!
    expect(parsed.rows.map(row => row.compatibility)).toEqual(['unknown', 'unsupported', 'supported'])
    expect(parsed.sourceCount).toBe(1)
    expect(parsed.selectableCount).toBe(1)
  })

  it('projects only valid bounded reasoning metadata', () => {
    const source = catalogView({
      rows: [{
        ...catalogView().rows[0]!,
        reasoningCapabilities: { efforts: ['high', 'low'], defaultEffort: 'low' },
      }],
      supplement: [{ id: 'manual', reasoningCapabilities: { efforts: ['low'], defaultEffort: 'low' } }],
    })
    const parsed = parseManagementSnapshot({ epoch: 'a', sequence: 0, views: [source] }).views[0]!
    expect(parsed.rows[0]?.reasoningCapabilities).toEqual({ efforts: ['low', 'high'], defaultEffort: 'low' })
    expect(parsed.supplement[0]?.reasoningCapabilities).toEqual({ efforts: ['low'], defaultEffort: 'low' })
    expect(() =>
      parseManagementSnapshot({
        epoch: 'a',
        sequence: 0,
        views: [catalogView({
          rows: [{
            ...catalogView().rows[0]!,
            reasoningCapabilities: { efforts: ['low'], defaultEffort: 'high' },
          }],
        })],
      })
    ).toThrow()
  })

  it('projects only bounded safe fields and never carries raw diagnostics or credentials', () => {
    const source = {
      epoch: 'a',
      sequence: 1,
      secret: 'top',
      views: [{
        ...catalogView(),
        credentialRef: 'ref',
        secret: 'key',
        scriptState: {
          authorityRevision: 'authority',
          runGeneration: 1,
          persistence: 'session-only',
          evidence: 'script-declared',
          command: 'private-command',
          args: ['private-argument'],
          cwd: '/private-path',
          environment: { key: 'private-key' },
        },
        protocolCapabilities: { responses: true, secret: 'private-key' },
        diagnostics: {
          scopeConfirmed: true,
          targetState: 'applied',
          code: 'https://secret.example',
          stderr: 'private',
        },
      }],
    }
    const result = parseManagementSnapshot(source)
    expect(JSON.stringify(result)).not.toMatch(/secret|credentialRef|stderr|private|https:\/\/secret/)
    expect(result.views[0]?.diagnostics.code).toBeUndefined()
    expect(result.views[0]?.scriptState).toEqual({
      authorityRevision: 'authority',
      runGeneration: 1,
      persistence: 'session-only',
      evidence: 'script-declared',
    })
    expect(result.views[0]?.protocolCapabilities).toEqual({ responses: true })
    expect(() =>
      parseManagementSnapshot({
        ...source,
        views: [catalogView({ rows: [catalogView().rows[0]!, catalogView().rows[0]!] })],
      })
    ).toThrow()
  })

  it('subscribes before read, coalesces changes during reads and fences stale snapshots', async () => {
    let notify!: (cursor: CatalogManagementCursor) => void
    const pending: ((snapshot: CatalogManagementSnapshot) => void)[] = []
    const read = vi.fn(() => new Promise<CatalogManagementSnapshot>(resolve => pending.push(resolve)))
    const client = new ModelCatalogClient({
      catalogManagementRead: read,
      catalogManagementSubscribe: listener => {
        notify = listener
        return () => {}
      },
      catalogManagementCommand: async () => ({ status: 'unavailable' }),
    })
    clients.push(client)
    notify({ epoch: 'a', sequence: 3 })
    notify({ epoch: 'a', sequence: 4 })
    pending.shift()!({ epoch: 'a', sequence: 2, views: [catalogView()] })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(client.snapshot().connected).toBe(false)
    pending.shift()!({ epoch: 'a', sequence: 4, views: [catalogView({ revision: '4' })] })
    await vi.waitFor(() => expect(client.snapshot().sequence).toBe(4))
    const promise = client.refresh()
    pending.shift()!({ epoch: 'a', sequence: 3, views: [] })
    await promise
    expect(client.snapshot().views).toHaveLength(1)
  })

  it('retains diagnostic-only rows on transport error, blocks writes, and recovers on Host resync', async () => {
    const fixture = catalogFixture()
    clients.push(fixture.client)
    await fixture.client.refresh()
    const read = vi.spyOn(fixture.channel, 'catalogManagementRead').mockRejectedValueOnce(
      new Error('private auth path'),
    )
    await fixture.client.refresh()
    expect(fixture.client.snapshot()).toMatchObject({
      connected: false,
      views: [expect.objectContaining({ bindingRef: 'binding-a' })],
    })
    expect(
      await fixture.client.command({
        operation: 'refresh',
        bindingRef: 'binding-a',
        scopeRevision: 'scope-1',
        expectedRevision: '1',
      }),
    )
      .toMatchObject({ status: 'unavailable' })
    expect(fixture.commands).toEqual([])
    read.mockRestore()
    await fixture.client.refresh()
    expect(fixture.client.snapshot().connected).toBe(true)
    fixture.client.dispose()
    expect(fixture.listeners.size).toBe(0)
  })

  it('accepts replacement epochs on reconciliation without accepting a stale read during replacement', async () => {
    const fixture = catalogFixture()
    clients.push(fixture.client)
    await fixture.client.refresh()
    const replacement = { ...fixture.snapshot(), epoch: 'replacement', sequence: 0, views: [] }
    const read = vi.spyOn(fixture.channel, 'catalogManagementRead').mockResolvedValueOnce(replacement)
    await fixture.client.refresh()
    expect(fixture.client.snapshot()).toMatchObject({ epoch: 'replacement', sequence: 0, connected: true, views: [] })
    read.mockRestore()
    fixture.publish({ ...replacement, sequence: 1, views: [catalogView()] })
    await fixture.client.refresh()
    expect(fixture.client.snapshot().views).toHaveLength(1)
  })

  it.each([{ views: [] }, { views: [catalogView()] }])(
    'preserves a successful snapshot through slow polling/manual reads, invalidates replacement epochs',
    async ({ views }) => {
      vi.useFakeTimers()
      let notify!: (cursor: CatalogManagementCursor) => void
      const initial: CatalogManagementSnapshot = { epoch: 'old', sequence: 1, views, canCreateConnection: true }
      const read = vi.fn(async () => initial)
      const client = new ModelCatalogClient({
        catalogManagementRead: read,
        catalogManagementSubscribe: listener => {
          notify = listener
          return () => {}
        },
        catalogManagementCommand: async () => ({ status: 'applied' }),
      })
      try {
        await client.refresh()
        let resolve!: (snapshot: CatalogManagementSnapshot) => void
        read.mockImplementation(() =>
          new Promise(done => {
            resolve = done
          })
        )
        await vi.advanceTimersByTimeAsync(30_000)
        expect(client.snapshot()).toMatchObject({ loading: false, refreshing: true, connected: true, views })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(client.snapshot()).toMatchObject({ loading: false, refreshing: true, connected: true })
        resolve(initial)
        await Promise.resolve()
        await Promise.resolve()
        const manual = client.refresh()
        expect(client.snapshot()).toMatchObject({ loading: false, refreshing: true, views })
        resolve(initial)
        await manual
        notify({ epoch: 'new', sequence: 0 })
        expect(client.snapshot()).toMatchObject({ connected: false, loading: true, refreshing: true })
        expect(
          await client.command(
            { operation: 'createConnection', scopeRevision: 'x', expectedRevision: 'x', connection: {} } as never,
          ),
        ).toMatchObject({ status: 'unavailable' })
        resolve(initial)
        await Promise.resolve()
        await Promise.resolve()
        expect(client.snapshot().connected).toBe(false)
        const recovery = client.refresh()
        resolve({ ...initial, epoch: 'new', sequence: 0, views: [] })
        await recovery
        expect(client.snapshot()).toMatchObject({
          connected: true,
          loading: false,
          refreshing: false,
          epoch: 'new',
          views: [],
        })
        read.mockRejectedValueOnce(new Error('transport'))
        await client.refresh()
        expect(client.snapshot()).toMatchObject({ connected: false, loading: false, refreshing: false })
      } finally {
        client.dispose()
        vi.useRealTimers()
      }
    },
  )

  it('uses exact model IDs and CAS, updates only after Host readback and never changes selection', async () => {
    const fixture = catalogFixture()
    clients.push(fixture.client)
    await fixture.client.refresh()
    const command = {
      operation: 'setOverlay' as const,
      bindingRef: 'binding-a',
      scopeRevision: 'scope-1',
      expectedRevision: '1',
      modelId: 'Model-A',
      blocked: true,
    }
    expect(await fixture.client.command(command)).toMatchObject({ status: 'applied' })
    expect(fixture.commands).toEqual([command])
    expect(fixture.client.snapshot().views[0]?.rows.map(row => row.blocked)).toEqual([true, false])
    expect(await fixture.client.command(command)).toMatchObject({ status: 'conflict' })
    expect(await fixture.client.command({ ...command, scopeRevision: 'wrong' })).toMatchObject({
      code: 'scope-changed',
    })
    expect(fixture.commands).toHaveLength(1)
  })

  it('forwards environment and prepared transfer requests and refreshes after writes', async () => {
    const fixture = catalogFixture()
    clients.push(fixture.client)
    await fixture.client.refresh()
    const refresh = vi.spyOn(fixture.client, 'refresh')
    const environmentRead = vi.fn(async () => ({
      status: 'ok' as const,
      entries: [{ name: 'MODEL_KEY', value: 'fixture-value', enabled: true }],
      applies: 'app-restart' as const,
    }))
    const environmentSave = vi.fn(async () => ({ status: 'applied' as const, applies: 'app-restart' as const }))
    const environmentGenerate = vi.fn(async ({ runId }: { readonly runId: string; readonly script: string }) => ({
      status: 'ok' as const,
      runId,
      value: 'generated-value',
    }))
    const environmentGenerateCancel = vi.fn(async (runId: string) => ({ status: 'cancelled' as const, runId }))
    const prepareExport = vi.fn(async () => ({ status: 'ok' as const, variables: [] }))
    const exportModels = vi.fn(async () => ({ status: 'ok' as const, text: 'fixture-payload' }))
    const prepareImport = vi.fn(async () => ({ status: 'ok' as const, variables: [], connections: [] }))
    const importModels = vi.fn(async () => ({
      status: 'applied' as const,
      imported: 1,
      skipped: 0,
      bindingRefs: ['local-ref'],
    }))
    fixture.channel.catalogEnvironmentRead = environmentRead
    fixture.channel.catalogEnvironmentSave = environmentSave
    fixture.channel.catalogEnvironmentGenerate = environmentGenerate
    fixture.channel.catalogEnvironmentGenerateCancel = environmentGenerateCancel
    fixture.channel.catalogManagementPrepareExport = prepareExport
    fixture.channel.catalogManagementExport = exportModels
    fixture.channel.catalogManagementPrepareImport = prepareImport
    fixture.channel.catalogManagementImport = importModels

    const selection = { selections: [{ bindingRef: 'binding-a', modelIds: ['Model-A'] }] }
    const exportRequest = { ...selection, includeValues: false, variables: [] }
    const importRequest = { text: 'fixture-payload', variables: [] }
    await expect(fixture.client.environmentRead()).resolves.toMatchObject({ status: 'ok' })
    await expect(fixture.client.environmentSave([
      { name: 'MODEL_KEY', value: 'updated-value', enabled: true },
    ])).resolves.toMatchObject({ status: 'applied' })
    await expect(fixture.client.environmentGenerate({ runId: 'run-1', script: 'printf value' })).resolves.toEqual({
      status: 'ok',
      runId: 'run-1',
      value: 'generated-value',
    })
    await expect(fixture.client.environmentGenerateCancel('run-1')).resolves.toEqual({
      status: 'cancelled',
      runId: 'run-1',
    })
    await expect(fixture.client.prepareExport(selection)).resolves.toEqual({ status: 'ok', variables: [] })
    await expect(fixture.client.export(exportRequest)).resolves.toEqual({ status: 'ok', text: 'fixture-payload' })
    await expect(fixture.client.prepareImport('fixture-payload')).resolves.toEqual({
      status: 'ok',
      variables: [],
      connections: [],
    })
    await expect(fixture.client.import(importRequest)).resolves.toMatchObject({ status: 'applied', imported: 1 })
    expect(environmentRead).toHaveBeenCalledOnce()
    expect(environmentSave).toHaveBeenCalledWith([
      { name: 'MODEL_KEY', value: 'updated-value', enabled: true },
    ])
    expect(environmentGenerate).toHaveBeenCalledWith({ runId: 'run-1', script: 'printf value' })
    expect(environmentGenerateCancel).toHaveBeenCalledWith('run-1')
    expect(prepareExport).toHaveBeenCalledWith(selection)
    expect(exportModels).toHaveBeenCalledWith(exportRequest)
    expect(prepareImport).toHaveBeenCalledWith('fixture-payload')
    expect(importModels).toHaveBeenCalledWith(importRequest)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
