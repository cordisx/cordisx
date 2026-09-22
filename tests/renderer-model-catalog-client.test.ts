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
})
