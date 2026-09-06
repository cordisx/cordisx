import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { ManagerSettingsNavigationProjectionV2 } from '@cordisx/protocol/manager-settings-navigation/v2'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'

const pointId = 'manager.settings.navigation-items'
const surfaceSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v9.schema.json' as const

const navigationProjection = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-projection.v2.schema.json',
  contract: 'cordisx.manager-settings-navigation-projection/v2',
  schemaVersion: 2,
  catalog: {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-groups.v1.schema.json',
    contract: 'cordisx.manager-settings-navigation-groups/v1',
    schemaVersion: 1,
    fallbackGroup: 'other',
    groups: [
      { id: 'resources', label: { namespace: 'host', key: 'resources', fallback: 'Raw resources' }, order: 100 },
      {
        id: 'development',
        label: { namespace: 'host', key: 'development', fallback: 'Raw development' },
        order: 200,
      },
      {
        id: 'collaboration',
        label: { namespace: 'host', key: 'collaboration', fallback: 'Raw collaboration' },
        order: 300,
      },
      { id: 'other', label: { namespace: 'host', key: 'other', fallback: 'Raw other' }, order: 1000 },
    ],
  },
  contributions: [{
    owner: 'chatroom',
    id: 'team-architecture',
    surfaceProvenance: { kind: 'versioned', $schema: surfaceSchema, schemaVersion: 9 },
    insertionGroup: 'after-settings',
    declaredGroup: 'collaboration',
    effectiveGroup: 'collaboration',
    assignment: 'declared',
    order: 20,
  }, {
    owner: 'legacy',
    id: 'tool',
    surfaceProvenance: { kind: 'legacy-unversioned' },
    insertionGroup: 'before-settings',
    effectiveGroup: 'other',
    assignment: 'legacy-fallback',
    order: 10,
  }, {
    owner: 'modern',
    id: 'ungrouped',
    surfaceProvenance: { kind: 'versioned', $schema: surfaceSchema, schemaVersion: 9 },
    insertionGroup: 'after-settings',
    effectiveGroup: 'other',
    assignment: 'unassigned-fallback',
    order: 30,
  }],
} satisfies ManagerSettingsNavigationProjectionV2

function snapshot(locale = 'zh-CN'): ManagerSnapshot {
  return {
    localization: { locale },
    extensionPoints: {
      points: [{
        id: pointId,
        plugins: [],
        available: true,
        availability: 'available',
        availabilityDetail: 'Host-rendered navigation is available.',
        descriptionProjection: { text: 'Adds a Host-rendered Manager destination.' },
      }],
      managerSettingsNavigation: navigationProjection,
    },
  } as unknown as ManagerSnapshot
}

describe('Manager navigation extension point diagnostics', () => {
  it('shows exact provenance, qualified identity, localized groups, order, and fallback reasons', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://host.invalid/',
    })
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver,
      getComputedStyle: globalThis.getComputedStyle,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })

    const { ExtensionPointDetailPage } = await import(
      '../packages/cli/src/renderer/manager/pages/ExtensionPointDetailPage.js'
    )
    const router: ManagerRouter = {
      route: { kind: 'extension-point', pointId },
      navigate() {},
      back() {},
    }
    const root = createRoot(dom.window.document.getElementById('root')!)
    const clickTab = async (label: string) => {
      const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find(item => item.textContent?.includes(label))
      expect(button).toBeDefined()
      await act(async () => button!.click())
    }

    try {
      await act(async () =>
        root.render(
          <ExtensionPointDetailPage model={{} as ManagerModel} snapshot={snapshot()} router={router} />,
        )
      )
      await clickTab('信息')
      const contract = dom.window.document.querySelector('[data-manager-navigation-contract]')
      expect(contract?.textContent).toContain('Surface contribution v9')
      expect(contract?.textContent).toContain('两者互不替代')
      expect(dom.window.document.querySelectorAll('[data-manager-navigation-group]')).toHaveLength(4)
      expect(contract?.textContent).toContain('资源resources · 顺序 100')
      expect(contract?.textContent).not.toContain('Raw resources')

      await clickTab('诊断')
      const declared = dom.window.document.querySelector(
        '[data-manager-navigation-contribution="chatroom:team-architecture"]',
      )
      expect(declared?.textContent).toContain('所有者chatroom')
      expect(declared?.textContent).toContain('本地 contribution IDteam-architecture')
      expect(declared?.textContent).toContain('versioned（精确 v9） · schemaVersion 9')
      expect(declared?.textContent).toContain('surface-contribution.v9.schema.json')
      expect(declared?.textContent).toContain('插入位置after-settings')
      expect(declared?.textContent).toContain('声明的视觉分组collaboration')
      expect(declared?.textContent).toContain('生效的视觉分组collaboration')
      expect(declared?.textContent).toContain('declared · 使用声明的视觉分组')
      expect(declared?.textContent).toContain('顺序20')

      const legacy = dom.window.document.querySelector('[data-manager-navigation-contribution="legacy:tool"]')
      expect(legacy?.textContent).toContain('legacy-unversioned（运行时未声明 schema 版本）')
      expect(legacy?.textContent).not.toContain('v5-v8')
      expect(legacy?.textContent).toContain('legacy-fallback · legacy-unversioned 注册未声明视觉分组，归入兜底分组')
      const unassigned = dom.window.document.querySelector('[data-manager-navigation-contribution="modern:ungrouped"]')
      expect(unassigned?.textContent).toContain('unassigned-fallback · v9 注册未声明视觉分组，归入兜底分组')

      await act(async () =>
        root.render(
          <ExtensionPointDetailPage model={{} as ManagerModel} snapshot={snapshot('en-US')} router={router} />,
        )
      )
      await clickTab('信息')
      expect(dom.window.document.querySelector('[data-manager-navigation-contract]')?.textContent).toContain(
        'Resourcesresources · Order 100',
      )
      expect(dom.window.document.body.textContent).toContain('They are independent fields.')
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
