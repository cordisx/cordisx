import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountManagerCollectionHost } from '../packages/cli/src/renderer/manager/components/ManagerCollection.js'
import { REACT_MANAGER_STYLES } from '../packages/cli/src/renderer/manager/styles.js'

const text = (key: string, fallback: string) => ({ key, fallback } as const)

const globals = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, globals))

function mountCollection() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://example.test/',
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: false,
  })
  const container = dom.window.document.getElementById('root')!
  const mounted = mountManagerCollectionHost(container, {
    document: dom.window.document,
    owner: 'chatroom',
    routeId: 'chatroom:rooms',
    pageId: 'chatroom:rooms',
    resolveText: value => value.fallback ?? value.key,
    clearTextSite() {},
    navigate: async () => {},
    deepLink: () => 'https://example.test/rooms/room-1',
    executeCommand: async () => {
      throw new Error('actions are not submitted by this visual test')
    },
    writeClipboard: async () => {},
    hostCopy: key => key,
  })
  mounted.registry.register({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json',
    contract: 'cordisx.manager-collection-registration/v1',
    schemaVersion: 1,
    id: 'rooms',
    label: text('rooms', 'Rooms'),
    description: text('rooms.description', 'Manage Rooms'),
    views: [{
      id: 'active',
      label: text('active', 'Active'),
      emptyTitle: text('empty', 'No Rooms'),
      emptyDescription: text('empty.description', 'Create a Room'),
    }],
    defaultView: 'active',
    search: {
      fields: ['title', 'summary'],
      normalization: 'nfkc-casefold',
      label: text('search', 'Search'),
      placeholder: text('search.placeholder', 'Search Rooms'),
      noMatchTitle: text('search.empty', 'No matches'),
      noMatchDescription: text('search.empty.description', 'Try another query'),
    },
  }, {
    snapshot: query => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json',
      contract: 'cordisx.manager-collection-snapshot/v1',
      schemaVersion: 1,
      collectionId: 'rooms',
      queryRevision: query.queryRevision,
      view: query.view,
      normalizedSearch: query.search.normalized,
      revision: 1,
      items: [{
        id: 'room-1',
        title: text('room.title', 'Planning'),
        summary: text('room.summary', 'Public summary'),
        leadingVisual: { kind: 'semantic-icon', icon: 'host:chat' },
        route: { id: 'room-detail' },
        order: 0,
        disabled: { value: false },
        actions: [{
          kind: 'command',
          id: 'pin',
          label: text('pin', 'Pin'),
          placement: 'direct',
          tone: 'neutral',
          pressed: false,
          disabled: { value: false },
          command: { id: 'room.pin' },
          feedback: { success: text('pin.success', 'Pinned'), failure: text('pin.failure', 'Pin failed') },
        }, {
          kind: 'command',
          id: 'archive',
          label: text('archive', 'Archive'),
          placement: 'overflow',
          tone: 'neutral',
          pressed: false,
          disabled: { value: false },
          command: { id: 'room.archive' },
          feedback: {
            success: text('archive.success', 'Archived'),
            failure: text('archive.failure', 'Archive failed'),
          },
        }],
      }],
    }),
    subscribe: () => () => {},
    dispose: () => {},
  })
  return { container, dom, mounted }
}

describe('Host Manager collection visual accessibility', () => {
  it('keeps row actions keyboard reachable and projects the overflow-open state', async () => {
    const { container, dom, mounted } = mountCollection()
    try {
      await vi.waitFor(() => expect(container.querySelector('[data-manager-collection-item="room-1"]')).not.toBeNull())
      const row = container.querySelector<HTMLElement>('[data-manager-collection-item="room-1"]')!
      const actions = row.querySelector<HTMLElement>('.cxr-manager-collection-actions')!
      const direct = actions.querySelector<HTMLButtonElement>('[aria-label="Pin"]')!
      const overflow = actions.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!

      expect(row.dataset.actionsOpen).toBeUndefined()
      expect(direct.tabIndex).toBe(0)
      direct.focus()
      expect(dom.window.document.activeElement).toBe(direct)
      expect(row.contains(dom.window.document.activeElement)).toBe(true)

      overflow.click()
      await vi.waitFor(() => {
        expect(row.dataset.actionsOpen).toBe('true')
        expect(overflow.getAttribute('aria-expanded')).toBe('true')
        expect(row.querySelector('[role="menu"]')).not.toBeNull()
      })
      expect(dom.window.document.activeElement?.getAttribute('role')).toBe('menuitem')

      row.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      await vi.waitFor(() => {
        expect(row.dataset.actionsOpen).toBeUndefined()
        expect(overflow.getAttribute('aria-expanded')).toBe('false')
        expect(dom.window.document.activeElement).toBe(overflow)
      })
    } finally {
      mounted.dispose()
      await new Promise(resolve => setImmediate(resolve))
      dom.window.close()
    }
  })

  it('uses overlay actions, no-hover fallback, compact dividers, and aligned content edges', () => {
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-collection-actions { position: absolute; top: 50%; right: 8px;',
    )
    expect(REACT_MANAGER_STYLES).toContain('opacity: 0; pointer-events: none;')
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-collection-row:hover .cxr-manager-collection-actions, .cxr-manager-collection-row:focus-within .cxr-manager-collection-actions, .cxr-manager-collection-row[data-actions-open="true"] .cxr-manager-collection-actions { opacity: 1; pointer-events: auto;',
    )
    expect(REACT_MANAGER_STYLES).toContain(
      '@media (hover: none), (pointer: coarse) { .cxr-manager-collection-actions { opacity: 1; pointer-events: auto;',
    )
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-collection-list { display: grid; width: 100%; min-width: 0; gap: 0; margin: 0; border: 1px solid',
    )
    expect(REACT_MANAGER_STYLES).toContain('border: 0; border-bottom: 1px solid')
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-collection-search { display: grid; width: 100%; min-width: 0;',
    )
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-collection-panel { width: 100%; min-width: 0; margin: 0; }',
    )
  })
})
