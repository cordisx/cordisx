import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { Navigation } from '../packages/cli/src/renderer/manager/components/Navigation.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-test-brand-mark aria-hidden="true" />,
}))

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

function keydown(dom: JSDOM, target: HTMLElement, key: string): void {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

async function mountNavigation(locale = 'zh-CN', includeContributions = true) {
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
  const navigate = vi.fn()
  const router: ManagerRouter = {
    route: { kind: 'primary', page: 'plugins' },
    navigate,
    replace: vi.fn(),
    openDetail: vi.fn(),
    back: vi.fn(),
  }
  const snapshot = {
    localization: { locale },
    settingsNavigationItems: includeContributions
      ? [{
        id: 'chatroom:talent',
        owner: 'chatroom',
        group: 'after-settings',
        navigationGroup: 'resources',
        order: 10,
        disabled: false,
        title: '人才市场',
        description: '',
        pageTitle: '人才市场',
        pageDescription: '',
        icon: 'host:people',
        route: { id: 'talent' },
      }, {
        id: 'chatroom:team',
        owner: 'chatroom',
        group: 'after-settings',
        navigationGroup: 'collaboration',
        order: 20,
        disabled: false,
        title: '团队架构',
        description: '',
        pageTitle: '团队架构',
        pageDescription: '',
        icon: 'host:hierarchy',
        route: { id: 'team' },
      }, {
        id: 'legacy:page',
        owner: 'legacy',
        group: 'before-settings',
        order: 5,
        disabled: false,
        title: '旧入口',
        description: '',
        pageTitle: '旧入口',
        pageDescription: '',
        icon: 'host:settings',
        route: { id: 'legacy' },
      }]
      : [],
  } as unknown as ManagerSnapshot
  const root: Root = createRoot(dom.window.document.getElementById('root')!)
  root.render(<Navigation snapshot={snapshot} router={router} />)
  await vi.waitFor(() => expect(dom.window.document.querySelector('.cxr-nav')).not.toBeNull())
  return { dom, root, navigate }
}

describe('Manager grouped navigation', () => {
  it('renders only non-empty groups in catalog order and keeps About outside the groups', async () => {
    const { dom, root } = await mountNavigation()
    try {
      const groups = [...dom.window.document.querySelectorAll<HTMLElement>('[data-navigation-group]')]
      expect(groups.map(group => group.dataset.navigationGroup)).toEqual([
        'resources',
        'development',
        'collaboration',
        'other',
      ])
      expect(groups.map(group => group.querySelector('[role="heading"]')?.textContent)).toEqual([
        '资源',
        '开发',
        '协作',
        '其他',
      ])
      expect(groups.at(0)?.querySelector('[data-tab="plugins"]')).not.toBeNull()
      expect(groups.at(0)?.querySelector('[data-settings-navigation-item="chatroom:talent"]')).not.toBeNull()
      expect(groups.at(2)?.querySelector('[data-settings-navigation-item="chatroom:team"]')).not.toBeNull()
      expect(groups.at(3)?.querySelector('[data-settings-navigation-item="legacy:page"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-tab="plugin-bundles"]')).toBeNull()
      expect(dom.window.document.querySelector('[data-tab="marketplace"]')).toBeNull()
      const about = dom.window.document.querySelector('[data-tab="about"]')
      expect(about?.parentElement?.classList.contains('cxr-nav')).toBe(true)
      expect(about?.closest('[data-navigation-group]')).toBeNull()
      expect(dom.window.document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current')).toBe('page')
    } finally {
      root.unmount()
      await new Promise(resolve => setImmediate(resolve))
      dom.window.close()
    }
  })

  it('moves focus across group boundaries while preserving ordinary Tab stops and activation', async () => {
    const { dom, root, navigate } = await mountNavigation('en')
    try {
      const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.cxr-nav button:not(:disabled)')]
      expect(buttons.every(button => button.tabIndex === 0)).toBe(true)
      buttons[0]!.focus()
      keydown(dom, buttons[0]!, 'ArrowDown')
      expect(dom.window.document.activeElement).toBe(buttons[1])
      keydown(dom, buttons[1]!, 'End')
      expect(dom.window.document.activeElement).toBe(buttons.at(-1))
      keydown(dom, buttons.at(-1)!, 'ArrowDown')
      expect(dom.window.document.activeElement).toBe(buttons[0])
      keydown(dom, buttons[0]!, 'ArrowUp')
      expect(dom.window.document.activeElement).toBe(buttons.at(-1))
      keydown(dom, buttons.at(-1)!, 'Home')
      expect(dom.window.document.activeElement).toBe(buttons[0])
      buttons.find(button => button.dataset.settingsNavigationItem === 'chatroom:team')?.click()
      expect(navigate).toHaveBeenCalledWith({ kind: 'manager-content', id: 'chatroom:team', reference: { id: 'team' } })
    } finally {
      root.unmount()
      await new Promise(resolve => setImmediate(resolve))
      dom.window.close()
    }
  })

  it('does not render empty collaboration or fallback groups', async () => {
    const { dom, root } = await mountNavigation('en', false)
    try {
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-navigation-group]')]
        .map(group => group.dataset.navigationGroup)).toEqual(['resources', 'development'])
      expect(dom.window.document.querySelector('[data-navigation-group="collaboration"]')).toBeNull()
      expect(dom.window.document.querySelector('[data-navigation-group="other"]')).toBeNull()
    } finally {
      root.unmount()
      await new Promise(resolve => setImmediate(resolve))
      dom.window.close()
    }
  })
})
