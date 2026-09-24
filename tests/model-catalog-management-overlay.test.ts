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
    expect(store.read('binding', 'new-account').entries).toEqual([{ id: 'A', blocked: true, pinRank: 0 }])
    expect(store.read('binding', 'new-account').scopeRevision).toBe('new-account')
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
    const persist = vi.fn((_data, _expectedRevision) =>
      new Promise<void>(resolve => {
        release = resolve
      })
    )
    const store = new ManagementOverlayStore(persist)
    const first = store.mutate({ ...scope, operation: 'setOverlay', modelId: 'A', blocked: true }, ['A'])
    const second = store.mutate({ ...scope, operation: 'setOverlay', modelId: 'z', pinned: true }, ['z'])
    const rejected = expect(second).rejects.toMatchObject({ code: 'conflict' })
    await Promise.resolve()
    expect(store.snapshot().bindings).toEqual([])
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

  it('persists provider favorite independently of model preferences and accepts empty providers', async () => {
    const store = new ManagementOverlayStore(async () => {})
    const favorite = await store.mutate({ ...scope, operation: 'setProviderFavorite', favorite: true }, [])
    expect(favorite).toMatchObject({ providerFavorite: true, entries: [] })
    const pinned = await store.mutate({
      ...scope,
      expectedRevision: favorite.revision,
      operation: 'setOverlay',
      modelId: 'A',
      pinned: true,
    }, ['A'])
    expect(pinned).toMatchObject({ providerFavorite: true, entries: [{ id: 'A', blocked: false, pinRank: 0 }] })
    const reset = await store.mutate({
      ...scope,
      expectedRevision: pinned.revision,
      operation: 'resetOrder',
    }, [])
    expect(reset).toMatchObject({ providerFavorite: true, entries: [] })
    const unfavorite = await store.mutate({
      ...scope,
      expectedRevision: reset.revision,
      operation: 'setProviderFavorite',
      favorite: false,
    }, [])
    expect(unfavorite).toMatchObject({ providerFavorite: false, entries: [] })
  })

  it('serializes concurrent favorite and model writes through the existing section CAS', async () => {
    let release!: () => void
    const persist = vi.fn(() => new Promise<void>(resolve => release = resolve))
    const store = new ManagementOverlayStore(persist)
    const favorite = store.mutate({ ...scope, operation: 'setProviderFavorite', favorite: true }, [])
    const model = store.mutate({ ...scope, operation: 'setOverlay', modelId: 'A', blocked: true }, ['A'])
    const rejected = expect(model).rejects.toMatchObject({ code: 'conflict' })
    await Promise.resolve()
    release()
    await expect(favorite).resolves.toMatchObject({ providerFavorite: true })
    await rejected
    expect(store.snapshot().bindings).toEqual([
      { bindingRef: 'binding', revision: '1', providerFavorite: true, entries: [] },
    ])
  })

  it('validates bounded versioned data and rejects hidden executable or authority fields', () => {
    const empty = { schemaVersion: 3, revision: 0, bindings: [] }
    expect(parseManagementOverlayData(empty)).toEqual(empty)
    for (
      const data of [
        { ...empty, schemaVersion: 4 },
        { ...empty, secret: 'not-allowed' },
        { ...empty, bindings: [{ ...scope, entries: [] }] },
        {
          ...empty,
          bindings: [{ bindingRef: 'b', revision: '1', entries: [{ id: 'a\n', blocked: true }] }],
        },
        {
          ...empty,
          bindings: [{
            bindingRef: 'b',
            revision: '1',
            entries: [{ id: 'a', blocked: true, capability: 'allow' }],
          }],
        },
      ]
    ) expect(() => parseManagementOverlayData(data)).toThrow('source-invalid')
  })

  it('migrates legacy scope-keyed entries to the latest stable binding preference', () => {
    expect(parseManagementOverlayData({
      schemaVersion: 1,
      revision: 9,
      overlays: [
        { bindingRef: 'plugin:aiden:main', scopeRevision: 'generation-1', revision: '3', entries: [] },
        {
          bindingRef: 'plugin:aiden:main',
          scopeRevision: 'generation-2',
          revision: '8',
          entries: [{ id: 'same-name', blocked: true }],
        },
      ],
    })).toEqual({
      schemaVersion: 3,
      revision: 9,
      bindings: [{
        bindingRef: 'plugin:aiden:main',
        revision: '8',
        providerFavorite: false,
        entries: [{ id: 'same-name', blocked: true }],
      }],
    })
  })

  it('migrates v2 bindings without losing model preferences or revisions', () => {
    expect(parseManagementOverlayData({
      schemaVersion: 2,
      revision: 7,
      bindings: [{
        bindingRef: 'plugin:aiden:main',
        revision: '5',
        entries: [{ id: 'same-name', blocked: true, pinRank: 0 }],
      }],
    })).toEqual({
      schemaVersion: 3,
      revision: 7,
      bindings: [{
        bindingRef: 'plugin:aiden:main',
        revision: '5',
        providerFavorite: false,
        entries: [{ id: 'same-name', blocked: true, pinRank: 0 }],
      }],
    })
  })

  it('rejects ambiguous opaque legacy duplicates instead of guessing which is newer', () => {
    expect(() =>
      parseManagementOverlayData({
        schemaVersion: 1,
        revision: 2,
        overlays: [
          { bindingRef: 'plugin:aiden:main', scopeRevision: 'one', revision: 'opaque-a', entries: [] },
          { bindingRef: 'plugin:aiden:main', scopeRevision: 'two', revision: 'opaque-b', entries: [] },
        ],
      })
    ).toThrow('source-invalid')
  })

  it('passes the exact prior section revision to the persistence CAS', async () => {
    const persist = vi.fn(async () => {})
    const store = new ManagementOverlayStore(persist)
    const first = await store.mutate({ ...scope, operation: 'setOverlay', modelId: 'A', blocked: true }, ['A'])
    await store.mutate(
      { ...scope, expectedRevision: first.revision, operation: 'setOverlay', modelId: 'A', pinned: true },
      ['A'],
    )
    expect(persist.mock.calls.map(call => call[1])).toEqual([0, 1])
  })
})
