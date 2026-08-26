import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  HOST_COLLECTION_STYLES,
  createHostCollection,
  type HostCollectionItem,
} from '../packages/cli/src/renderer/host-collection.js'

function icon(document: Document, value: string): () => Node {
  return () => {
    const node = document.createElement('span')
    node.dataset.icon = value
    node.textContent = value
    return node
  }
}

describe('Host collection primitive', () => {
  it('defaults to searchable adaptive cards with a stable detail body and status on the icon', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const opened = vi.fn()
    const queryChanged = vi.fn()
    const items: HostCollectionItem[] = [
      {
        id: 'alpha', title: 'Alpha 插件', description: '同步本地工作。', machineId: 'plugin.alpha',
        searchText: ['workspace sync'], icon: icon(dom.window.document, 'A'),
        status: { label: '运行中', tone: 'success' }, onOpen: opened,
      },
      {
        id: 'beta', title: 'Beta', description: 'Route catalog', machineId: 'plugin.beta',
        icon: icon(dom.window.document, 'B'), onOpen: opened,
      },
    ]
    const view = createHostCollection(dom.window.document, {
      id: 'plugins', label: '插件列表', items,
      search: { onQueryChange: queryChanged },
    })
    dom.window.document.body.append(view.element)
    try {
      const search = view.element.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')!
      expect(search).not.toBeNull()
      expect(view.element.querySelector('.cxc-list')?.getAttribute('role')).toBe('list')
      expect(view.element.querySelectorAll('[role="listitem"]')).toHaveLength(2)
      expect(view.element.querySelector('[data-collection-item="alpha"] .cxc-status')?.getAttribute('data-tone')).toBe('success')
      expect(view.element.querySelector('[data-collection-item="alpha"] .cxc-status')?.getAttribute('aria-label')).toBe('运行中')
      expect(view.element.querySelector('[data-collection-item="alpha"] .cxc-title')?.textContent).toBe('Alpha 插件')
      expect(view.element.querySelector('[data-collection-item="alpha"] .cxc-description')?.textContent).toBe('同步本地工作。')
      expect(view.element.querySelector('[data-collection-item="alpha"] .cxc-machine-id')?.textContent).toBe('plugin.alpha')
      expect(view.element.querySelector('.cxm-chevron')).toBeNull()

      view.element.querySelector<HTMLButtonElement>('[data-collection-open="alpha"]')!.click()
      expect(opened).toHaveBeenCalledTimes(1)

      search.value = '  WORKSPACE   sync '
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(view.element.querySelector<HTMLElement>('[data-collection-item="alpha"]')!.hidden).toBe(false)
      expect(view.element.querySelector<HTMLElement>('[data-collection-item="beta"]')!.hidden).toBe(true)
      expect(queryChanged).toHaveBeenLastCalledWith('  WORKSPACE   sync ')

      search.value = 'Alpha'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(view.element.querySelector('.cxc-title mark')?.textContent).toBe('Alpha')
      search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(search.value).toBe('')
      expect(view.element.querySelectorAll<HTMLElement>('[data-collection-item][hidden]')).toHaveLength(0)

      expect(HOST_COLLECTION_STYLES).toContain('repeat(auto-fit, minmax(min(100%, 220px), 1fr))')
      expect(HOST_COLLECTION_STYLES).toContain('align-content: start;')
      expect(HOST_COLLECTION_STYLES).toContain('align-items: stretch;')
      expect(HOST_COLLECTION_STYLES).toContain('.cxc-listitem { display: flex; min-width: 0; align-self: stretch; }')
      expect(HOST_COLLECTION_STYLES).toContain('display: flex;\n    container-type: inline-size;\n    min-width: 0;\n    height: 100%;\n    align-self: stretch;')
      expect(HOST_COLLECTION_STYLES).toContain('flex: 1 1 auto;\n    box-sizing: border-box;')
      expect(HOST_COLLECTION_STYLES).toContain('.cxc-copy { display: flex; min-width: 0; align-self: stretch; flex: 1 1 auto; flex-direction: column; }')
      expect(HOST_COLLECTION_STYLES).toContain('min-block-size: 2.84em;')
      expect(HOST_COLLECTION_STYLES).toContain('margin-top: auto; padding-top: var(--cxc-copy-machine-gap);')
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-grid-gap: 8px;')
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-card-padding: 12px;')
      expect(HOST_COLLECTION_STYLES).not.toContain('justify-content: start')
      expect(HOST_COLLECTION_STYLES).not.toContain('repeat(2,')
      expect(HOST_COLLECTION_STYLES).toContain('.cxc-list[data-layout="rows"] { grid-template-columns: minmax(0, 1fr); }')
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-icon-seat-size: 32px;')
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-icon-glyph-size: 16px;')
      expect(HOST_COLLECTION_STYLES).not.toContain('.cxc-list {\n    display: grid;\n    height: 100%;')
      expect(HOST_COLLECTION_STYLES).not.toContain('.cxc-primary {\n    display: flex;\n    align-items: flex-start;\n    gap: 11px;\n    width: 100%;\n    min-width: 0;\n    min-height: 82px;')
      expect(HOST_COLLECTION_STYLES).not.toContain('min-height: 82px;')
      expect(HOST_COLLECTION_STYLES).toContain('width: var(--cxc-icon-glyph-size); height: var(--cxc-icon-glyph-size);')
      expect(HOST_COLLECTION_STYLES).toContain('fill: currentColor; color: currentColor;')
      expect(HOST_COLLECTION_STYLES).toContain('font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;')
    } finally {
      view.dispose()
      dom.window.close()
    }
  })

  it('marks compact catalogs explicitly and keeps their icon seat in the shared Manager rhythm', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const view = createHostCollection(dom.window.document, {
      id: 'catalog', label: 'Catalog', density: 'compact',
      items: [{ id: 'alpha', title: 'Alpha', icon: icon(dom.window.document, 'A') }],
    })
    dom.window.document.body.append(view.element)
    try {
      expect(view.element.dataset.density).toBe('compact')
      expect(view.element.querySelector('.cxc-icon-seat')?.querySelector('button')).toBeNull()
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-icon-seat-size: var(--cx-compact-list-icon-seat, 22px);')
      expect(HOST_COLLECTION_STYLES).toContain('--cxc-icon-glyph-size: var(--cx-compact-list-icon-glyph, 16px);')
      expect(HOST_COLLECTION_STYLES).toContain('width: var(--cxc-icon-seat-size); height: var(--cxc-icon-seat-size);')
      expect(HOST_COLLECTION_STYLES).toContain('.cxc-icon-seat > :first-child > svg { display: block; width: 100% !important; height: 100% !important; fill: currentColor; color: currentColor; }')
    } finally {
      view.dispose()
      dom.window.close()
    }
  })

  it('overlays direct actions without moving card copy and keeps keyboard focus actions visible', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const opened = vi.fn()
    const disabled = vi.fn()
    const reloaded = vi.fn()
    const shared = vi.fn()
    const view = createHostCollection(dom.window.document, {
      id: 'plugins', label: '插件列表', moreIcon: icon(dom.window.document, 'more'),
      items: [{
        id: 'alpha', title: 'Alpha', description: 'A readable product introduction', machineId: 'plugin.alpha',
        icon: icon(dom.window.document, 'A'), onOpen: opened,
        actions: [
          { id: 'reload', label: '重新加载', placement: 'direct', priority: 2, icon: icon(dom.window.document, 'reload'), onInvoke: reloaded },
          { id: 'disable', label: '停用', placement: 'direct', priority: 1, icon: icon(dom.window.document, 'disable'), onInvoke: disabled },
          { id: 'share', label: '分享', placement: 'overflow', icon: icon(dom.window.document, 'share'), onInvoke: shared },
        ],
      }],
    })
    dom.window.document.body.append(view.element)
    try {
      const card = view.element.querySelector<HTMLElement>('.cxc-card')!
      const primary = card.querySelector<HTMLElement>('.cxc-primary')!
      const actions = card.querySelector<HTMLElement>('.cxc-actions')!
      expect(card.children[0]).toBe(primary)
      expect(card.children[1]).toBe(actions)
      expect([...actions.querySelectorAll<HTMLElement>('[data-collection-action]')].map(item => item.dataset.collectionAction)).toEqual(['disable', 'reload'])
      expect([...actions.querySelectorAll<HTMLButtonElement>('button')].every(button => button.tabIndex === 0)).toBe(true)
      expect(HOST_COLLECTION_STYLES).toContain('position: absolute;')
      expect(HOST_COLLECTION_STYLES).toContain('.cxc-card:focus-within .cxc-actions')
      expect(HOST_COLLECTION_STYLES).toContain('opacity: 0;')
      expect(HOST_COLLECTION_STYLES).toContain('pointer-events: none;')

      actions.querySelector<HTMLButtonElement>('[data-collection-action="disable"]')!.click()
      expect(disabled).toHaveBeenCalledTimes(1)
      expect(opened).not.toHaveBeenCalled()
      actions.querySelector<HTMLButtonElement>('[data-collection-action="reload"]')!.click()
      expect(reloaded).toHaveBeenCalledTimes(1)
      expect(opened).not.toHaveBeenCalled()

      primary.click()
      expect(opened).toHaveBeenCalledTimes(1)
    } finally {
      view.dispose()
      dom.window.close()
    }
  })

  it('owns portaled menu navigation, skips disabled items, restores focus, and cleans up', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const shared = vi.fn()
    const removed = vi.fn()
    const managerDismiss = vi.fn()
    const onManagerKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      managerDismiss()
    }
    dom.window.document.addEventListener('keydown', onManagerKeyDown)
    const view = createHostCollection(dom.window.document, {
      id: 'plugins', label: '插件列表', moreIcon: icon(dom.window.document, 'more'),
      items: [{
        id: 'alpha', title: 'Alpha', icon: icon(dom.window.document, 'A'), onOpen: vi.fn(),
        actions: [
          { id: 'share', label: '分享', placement: 'overflow', icon: icon(dom.window.document, 'share'), onInvoke: shared },
          { id: 'move-up', label: '上移', placement: 'overflow', disabled: true, unavailableReason: '已经置顶', icon: icon(dom.window.document, 'up') },
          { id: 'diagnostics', label: '诊断', placement: 'overflow', icon: icon(dom.window.document, 'info'), onInvoke: vi.fn() },
          { id: 'remove', label: '卸载', placement: 'overflow', tone: 'danger', icon: icon(dom.window.document, 'delete'), onInvoke: removed },
        ],
      }],
    })
    dom.window.document.body.append(view.element)
    try {
      const trigger = view.element.querySelector<HTMLButtonElement>('.cxc-menu-trigger')!
      trigger.style.font = '13px/1.45 ui-sans-serif'
      trigger.click()
      const popup = dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')!
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(trigger.getAttribute('aria-controls')).toBe(popup.id)
      expect(popup.getAttribute('role')).toBe('menu')
      expect(popup.style.font).toContain('13px')
      expect(popup.style.font).toContain('ui-sans-serif')
      expect([...popup.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['share分享', 'up上移', 'info诊断', 'delete卸载'])
      expect(view.element.querySelector('.cxc-card')?.getAttribute('data-action-menu-open')).toBe('true')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('share')

      const press = (key: string): void => {
        dom.window.document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
      press('ArrowDown')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('diagnostics')
      press('ArrowUp')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('share')
      press('ArrowUp')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('remove')
      press('Home')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('share')
      press('End')
      expect(dom.window.document.activeElement?.getAttribute('data-collection-action')).toBe('remove')
      const disabled = popup.querySelector<HTMLButtonElement>('[data-collection-action="move-up"]')!
      expect(disabled.disabled).toBe(true)
      expect(disabled.getAttribute('aria-disabled')).toBe('true')
      expect(disabled.getAttribute('aria-description')).toBe('已经置顶')
      expect(disabled.title).toBe('已经置顶')

      press('Escape')
      await Promise.resolve()
      expect(dom.window.document.querySelector('.cxc-menu-popup')).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(managerDismiss).not.toHaveBeenCalled()

      trigger.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-collection-action="share"]')!.click()
      await Promise.resolve()
      expect(shared).toHaveBeenCalledTimes(1)
      expect(dom.window.document.querySelector('.cxc-menu-popup')).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)

      trigger.click()
      view.dispose()
      expect(dom.window.document.querySelector('.cxc-menu-popup')).toBeNull()
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(managerDismiss).toHaveBeenCalledTimes(1)
    } finally {
      view.dispose()
      expect(dom.window.document.querySelector('.cxc-menu-popup')).toBeNull()
      dom.window.document.removeEventListener('keydown', onManagerKeyDown)
      dom.window.close()
    }
  })

  it('allows search omission only with an explicit product reason', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    expect(() => createHostCollection(dom.window.document, {
      id: 'metadata', label: '固定元数据', items: [], search: { enabled: false, reason: '' },
    })).toThrow('requires a product reason')
    const view = createHostCollection(dom.window.document, {
      id: 'metadata', label: '固定元数据', items: [], search: { enabled: false, reason: 'This is a fixed two-row metadata block.' },
    })
    try {
      expect(view.element.querySelector('[role="search"]')).toBeNull()
      expect(view.element.dataset.searchOmissionReason).toContain('fixed two-row')
      expect(view.element.querySelector('.cxc-empty')?.textContent).toBe('暂无数据')
    } finally {
      view.dispose()
      dom.window.close()
    }
  })
})
