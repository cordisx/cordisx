import { describe, expect, it, vi } from 'vitest'
import {
  ManagementOverlayStore,
  parseManagementOverlayData,
  projectManagementOverlay,
  serializeManagementOverlayData,
} from '../packages/cli/src/model-catalog/management-overlay.js'

const scope = { bindingRef: 'binding', scopeRevision: 'account-endpoint-v1', expectedRevision: '0' }
const source = [
  { id: 'z', label: 'First', selectable: true },
  { id: 'A', label: 'Last', selectable: true },
  { id: 'a', label: 'A', selectable: false },
  { id: 'unknown', label: 'Unknown' },
]

describe('Host catalog preferences', () => {
  it('keeps exact ID/scope isolation, source immutability and admission ceiling', async () => {
    const store = new ManagementOverlayStore(async () => {})
    const before = structuredClone(source)
    const overlay = await store.mutate(
      { ...scope, operation: 'setOverlay', modelId: 'A', blocked: true, pinned: true },
      source.map(m => m.id),
    )
    const projected = projectManagementOverlay(source, overlay)
    expect(source).toEqual(before)
    expect(projected.active.map(m => [m.id, m.blocked, m.selectable])).toEqual([
      ['A', true, false],
      ['a', false, false],
      ['unknown', false, false],
      ['z', false, true],
    ])
    expect(store.read('binding', 'new-account').entries).toEqual([])
    expect(store.read('other-binding', scope.scopeRevision).entries).toEqual([])
    expect(store.read('binding', scope.scopeRevision).entries).toEqual([{ id: 'A', blocked: true, pinRank: 0 }])
  })

  it('retains dormant blocks and pins on complete-empty and exact reappearance', async () => {
    const store = new ManagementOverlayStore(async () => {})
    const overlay = await store.mutate(
      { ...scope, operation: 'setOverlay', modelId: 'z', blocked: true, pinned: true },
      ['z'],
    )
    expect(projectManagementOverlay([], overlay)).toEqual({
      active: [],
      dormant: [
        { id: 'z', label: 'z', present: false, selectable: false, blocked: true, pinned: true },
      ],
    })
    expect(projectManagementOverlay(source, overlay).active[0]).toMatchObject({
      id: 'z',
      blocked: true,
      pinned: true,
      selectable: false,
    })
    const restored = await store.mutate(
      { ...scope, expectedRevision: overlay.revision, operation: 'restoreBlocked' },
      [],
    )
    expect(projectManagementOverlay([], restored).dormant[0]).toMatchObject({
      id: 'z',
      pinned: true,
      blocked: false,
      selectable: false,
    })
    await expect(
      store.mutate({
        ...scope,
        expectedRevision: restored.revision,
        operation: 'setOverlay',
        modelId: 'missing',
        blocked: false,
      }, []),
    )
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('sorts pinned first independent of labels/source order, and resets only pins', async () => {
    const store = new ManagementOverlayStore(async () => {})
    const pinned = await store.mutate(
      { ...scope, operation: 'setOverlay', modelId: 'z', pinned: true },
      source.map(m => m.id),
    )
    const blocked = await store.mutate({
      ...scope,
      expectedRevision: pinned.revision,
      operation: 'setOverlay',
      modelId: 'a',
      blocked: true,
    }, ['a'])
    expect(projectManagementOverlay([...source].reverse(), blocked).active.map(m => m.id)).toEqual([
      'z',
      'A',
      'a',
      'unknown',
    ])
    const reset = await store.mutate({ ...scope, expectedRevision: blocked.revision, operation: 'resetOrder' }, [])
    expect(projectManagementOverlay(source, reset).active.map(m => m.id)).toEqual(['A', 'a', 'unknown', 'z'])
    expect(reset.entries).toEqual([{ id: 'a', blocked: true }])
  })

  it('commits after atomic persistence, serializes concurrent CAS and keeps last durable state on error', async () => {
    let release!: () => void
    const persist = vi.fn(() =>
      new Promise<void>(resolve => {
        release = resolve
      })
    )
    const store = new ManagementOverlayStore(persist)
    const first = store.mutate({ ...scope, operation: 'setOverlay', modelId: 'A', blocked: true }, ['A'])
    const second = store.mutate({ ...scope, operation: 'setOverlay', modelId: 'z', pinned: true }, ['z'])
    const rejected = expect(second).rejects.toMatchObject({ code: 'conflict' })
    await Promise.resolve()
    expect(store.snapshot().overlays).toEqual([])
    release()
    const overlay = await first
    await rejected
    expect(persist).toHaveBeenCalledTimes(1)
    const durable = serializeManagementOverlayData(store.snapshot())
    const failing = new ManagementOverlayStore(async () => {
      throw new Error('private-path')
    }, JSON.parse(durable))
    await expect(failing.mutate({ ...scope, expectedRevision: overlay.revision, operation: 'restoreBlocked' }, ['A']))
      .rejects.toMatchObject({ message: 'persist-failed' })
    expect(serializeManagementOverlayData(failing.snapshot())).toBe(durable)
  })

  it('validates bounded versioned data and rejects hidden executable or authority fields', () => {
    const empty = { schemaVersion: 1, revision: 0, overlays: [] }
    expect(parseManagementOverlayData(empty)).toEqual(empty)
    for (
      const data of [
        { ...empty, schemaVersion: 2 },
        { ...empty, secret: 'not-allowed' },
        { ...empty, overlays: [{ ...scope, entries: [] }] },
        {
          ...empty,
          overlays: [{ bindingRef: 'b', scopeRevision: 's', revision: '1', entries: [{ id: 'a\n', blocked: true }] }],
        },
        {
          ...empty,
          overlays: [{
            bindingRef: 'b',
            scopeRevision: 's',
            revision: '1',
            entries: [{ id: 'a', blocked: true, capability: 'allow' }],
          }],
        },
      ]
    ) expect(() => parseManagementOverlayData(data)).toThrow('source-invalid')
  })
})
