import type {
  ManagerCollectionQueryV1,
  ManagerCollectionSnapshotV1,
} from '@cordisx/protocol/manager-collection/v1'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { HostManagerCollectionPageRegistry } from '../packages/cli/src/renderer/manager-collection.js'
import { mountManagerCollectionHost } from '../packages/cli/src/renderer/manager/components/ManagerCollection.js'
import {
  MANAGER_COLLECTION_UNICODE_VERSION,
  normalizeManagerCollectionSearch,
} from '../packages/cli/src/renderer/manager-collection-normalization.js'

const text = (key: string, fallback: string) => ({ key, fallback } as const)

describe('Host Manager collection', () => {
  it('uses the frozen Unicode 17 NFKC casefold and whitespace transform', () => {
    expect(MANAGER_COLLECTION_UNICODE_VERSION).toBe('17.0.0')
    expect(normalizeManagerCollectionSearch('  Ａ\u00a0Straße\u3000K  ')).toBe('a strasse k')
    expect(() => normalizeManagerCollectionSearch('x'.repeat(257), { maximumInputCodePoints: 256 })).toThrow(/code-point bound/)
  })

  it('owns page-scoped search, text input action forwarding, revision fencing, and cleanup', async () => {
    const dom = new JSDOM('<body></body>', { url: 'https://example.test/' })
    const queries: ManagerCollectionQueryV1[] = []
    const commands: unknown[] = []
    let revision = 1
    let disposed = 0
    let unsubscribed = 0
    const snapshot = (query: ManagerCollectionQueryV1): ManagerCollectionSnapshotV1 => ({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json',
      contract: 'cordisx.manager-collection-snapshot/v1', schemaVersion: 1,
      collectionId: 'rooms', queryRevision: query.queryRevision, view: query.view,
      normalizedSearch: query.search.normalized, revision,
      items: [{
        id: 'room-1', title: text('room.title', 'Straße planning'), summary: text('room.summary', 'Public summary'),
        leadingVisual: { kind: 'semantic-icon', icon: 'host:chat' }, route: { id: 'room-detail', params: { roomId: 'room-1' } },
        order: 0, disabled: { value: false }, actions: [{
          kind: 'text-input-command', id: 'rename', label: text('rename', 'Rename'), icon: 'host:settings',
          placement: 'direct', tone: 'neutral', pressed: false, disabled: { value: false },
          command: { id: 'room.rename', arguments: { roomId: 'room-1' } },
          input: { argument: 'title', title: text('rename.title', 'Rename Room'), label: text('rename.label', 'Title'), submitLabel: text('rename.submit', 'Rename'), minLength: 1, maxLength: 80, trim: 'both' },
          feedback: { success: text('rename.success', 'Renamed'), failure: text('rename.failure', 'Rename failed') },
        }],
      }],
    })
    const registry = new HostManagerCollectionPageRegistry({
      document: dom.window.document, owner: 'chatroom', routeId: 'chatroom:rooms', pageId: 'chatroom:rooms',
      resolveText: value => value.fallback ?? value.key, clearTextSite() {},
      navigate: async () => {}, deepLink: () => 'https://example.test/manager/extensions/chatroom/rooms/room-1',
      executeCommand: async (_actionId, reference) => {
        commands.push(reference)
        revision = 2
        return {
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-action-result.v1.schema.json',
          contract: 'cordisx.manager-collection-action-result/v1', schemaVersion: 1,
          collectionId: 'rooms', itemId: 'room-1', actionId: 'rename', code: 'renamed', status: 'applied', revision,
        }
      },
      writeClipboard: async () => {}, hostCopy: key => key,
    })
    const handle = registry.register({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json',
      contract: 'cordisx.manager-collection-registration/v1', schemaVersion: 1, id: 'rooms',
      label: text('rooms', 'Rooms'), description: text('rooms.description', 'Manage Rooms'),
      views: [{ id: 'active', label: text('active', 'Active'), emptyTitle: text('empty', 'No Rooms'), emptyDescription: text('empty.description', 'Create a Room') }],
      defaultView: 'active',
      search: { fields: ['title', 'summary'], normalization: 'nfkc-casefold', label: text('search', 'Search'), placeholder: text('search.placeholder', 'Search Rooms'), noMatchTitle: text('search.empty', 'No matches'), noMatchDescription: text('search.empty.description', 'Try another query') },
    }, {
      async snapshot(query) { queries.push(query); return snapshot(query) },
      subscribe() { return () => { unsubscribed += 1 } },
      dispose() { disposed += 1 },
    })
    await vi.waitFor(() => expect(registry.snapshot()).toMatchObject({ state: 'ready', source: { revision: 1 } }))
    registry.setSearch('STRASSE')
    await vi.waitFor(() => expect(registry.snapshot()).toMatchObject({ state: 'ready', search: 'STRASSE', source: { items: [{ id: 'room-1' }] } }))
    expect(queries.at(-1)?.search.normalized).toBe('strasse')
    registry.requestAction('room-1', 'rename')
    expect(registry.snapshot().dialog).toMatchObject({ kind: 'text-input', actionId: 'rename' })
    registry.submitDialog('  New title  ')
    await vi.waitFor(() => expect(registry.snapshot()).toMatchObject({ state: 'ready', source: { revision: 2 }, feedback: { tone: 'success' } }))
    expect(commands).toEqual([{ id: 'room.rename', arguments: { roomId: 'room-1', title: 'New title' } }])
    expect(() => registry.register({} as never, {} as never)).toThrow(/already has an active registration/)
    handle.dispose()
    expect(registry.snapshot().state).toBe('unregistered')
    expect({ unsubscribed, disposed }).toEqual({ unsubscribed: 1, disposed: 1 })
    registry.dispose()
    dom.window.close()
  })

  it('focuses and dismisses the Host dialog, then removes the collection on unload', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://example.test/' })
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: false,
    })
    let disposed = 0
    let unsubscribed = 0
    const container = dom.window.document.getElementById('root')!
    const mounted = mountManagerCollectionHost(container, {
      document: dom.window.document, owner: 'chatroom', routeId: 'chatroom:rooms', pageId: 'chatroom:rooms',
      resolveText: value => value.fallback ?? value.key, clearTextSite() {},
      navigate: async () => {}, deepLink: () => 'https://example.test/rooms/room-1',
      executeCommand: async () => { throw new Error('dialog was not confirmed') },
      writeClipboard: async () => {}, hostCopy: key => key,
    })
    try {
      mounted.registry.register({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json',
        contract: 'cordisx.manager-collection-registration/v1', schemaVersion: 1, id: 'rooms',
        label: text('rooms', 'Rooms'), description: text('rooms.description', 'Manage Rooms'),
        views: [{ id: 'active', label: text('active', 'Active'), emptyTitle: text('empty', 'No Rooms'), emptyDescription: text('empty.description', 'Create a Room') }],
        defaultView: 'active',
        search: { fields: ['title', 'summary'], normalization: 'nfkc-casefold', label: text('search', 'Search'), placeholder: text('search.placeholder', 'Search Rooms'), noMatchTitle: text('search.empty', 'No matches'), noMatchDescription: text('search.empty.description', 'Try another query') },
      }, {
        snapshot: query => ({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json',
          contract: 'cordisx.manager-collection-snapshot/v1', schemaVersion: 1,
          collectionId: 'rooms', queryRevision: query.queryRevision, view: query.view,
          normalizedSearch: query.search.normalized, revision: 1,
          items: [{
            id: 'room-1', title: text('room.title', 'Room'), summary: text('room.summary', 'Public summary'),
            leadingVisual: { kind: 'semantic-icon', icon: 'host:chat' }, route: { id: 'room-detail' },
            order: 0, disabled: { value: false }, actions: [{
              kind: 'command', id: 'delete', label: text('delete', 'Delete'),
              placement: 'direct', tone: 'danger', pressed: false, disabled: { value: false },
              command: { id: 'room.delete' },
              confirmation: {
                title: text('delete.title', 'Delete Room'),
                description: text('delete.description', 'This cannot be undone.'),
                confirmLabel: text('delete.confirm', 'Delete'),
              },
              feedback: { success: text('delete.success', 'Deleted'), failure: text('delete.failure', 'Delete failed') },
            }],
          }],
        }),
        subscribe: () => () => { unsubscribed += 1 },
        dispose: () => { disposed += 1 },
      })

      await vi.waitFor(() => expect(container.querySelector('[data-manager-collection-item="room-1"]')).not.toBeNull())
      const trigger = container.querySelector<HTMLButtonElement>('.cxr-manager-collection-action')!
      trigger.focus()
      trigger.click()
      await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull())
      expect(dom.window.document.activeElement?.tagName).toBe('BUTTON')
      container.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }))
      await vi.waitFor(() => {
        expect(container.querySelector('[role="dialog"]')).toBeNull()
        expect(dom.window.document.activeElement).toBe(trigger)
      })

      trigger.click()
      await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull())
      mounted.dispose()
      expect(container.hasAttribute('data-manager-collection-host')).toBe(false)
      expect(container.childElementCount).toBe(0)
      expect({ unsubscribed, disposed }).toEqual({ unsubscribed: 1, disposed: 1 })
    } finally {
      mounted.dispose()
      await new Promise(resolve => setImmediate(resolve))
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
