import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'

const pointId = 'manager.settings.navigation-items'

function snapshot(): ManagerSnapshot {
  return {
    extensionPoints: {
      points: [{
        id: pointId,
        plugins: [],
        available: true,
        availability: 'available',
        availabilityDetail: 'Host-rendered navigation is available.',
        descriptionProjection: { text: 'Adds a Host-rendered Manager destination.' },
      }],
      managerSettingsNavigation: {
        contract: 'cordisx.manager-settings-navigation-projection/v2',
        schemaVersion: 2,
        catalog: {
          contract: 'cordisx.manager-settings-navigation-groups/v1',
          schemaVersion: 1,
          fallbackGroup: 'other',
          groups: [
            { id: 'resources', label: { fallback: 'Resources' }, order: 100 },
            { id: 'development', label: { fallback: 'Development' }, order: 200 },
            { id: 'collaboration', label: { fallback: 'Collaboration' }, order: 300 },
            { id: 'other', label: { fallback: 'Other' }, order: 1000 },
          ],
        },
        contributions: [{
          owner: 'chatroom',
          id: 'chatroom:team-architecture',
          surfaceProvenance: {
            kind: 'versioned',
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v9.schema.json',
            schemaVersion: 9,
          },
          insertionGroup: 'after-settings',
          declaredGroup: 'collaboration',
          effectiveGroup: 'collaboration',
          assignment: 'declared',
        }, {
          owner: 'legacy',
          id: 'legacy:tool',
          surfaceProvenance: { kind: 'legacy-unversioned' },
          insertionGroup: 'before-settings',
          effectiveGroup: 'other',
          assignment: 'legacy-fallback',
        }, {
          owner: 'modern',
          id: 'modern:ungrouped',
          surfaceProvenance: {
            kind: 'versioned',
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v9.schema.json',
            schemaVersion: 9,
          },
          insertionGroup: 'after-settings',
          effectiveGroup: 'other',
          assignment: 'unassigned-fallback',
        }],
      },
    },
  } as unknown as ManagerSnapshot
}

describe('Manager navigation extension point diagnostics', () => {
  it('distinguishes insertion order from visual groups and explains every assignment', async () => {
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
      expect(contract?.textContent).toContain('other')

      await clickTab('诊断')
      const declared = dom.window.document.querySelector(
        '[data-manager-navigation-contribution="chatroom:team-architecture"]',
      )
      expect(declared?.textContent).toContain('Surface schema version9')
      expect(declared?.textContent).toContain('Insertion groupafter-settings')
      expect(declared?.textContent).toContain('Declared visual groupcollaboration')
      expect(declared?.textContent).toContain('Effective visual groupcollaboration')
      expect(declared?.textContent).toContain('declared · 使用声明的视觉分组')

      const legacy = dom.window.document.querySelector('[data-manager-navigation-contribution="legacy:tool"]')
      expect(legacy?.textContent).toContain('未声明（legacy v5-v8）')
      expect(legacy?.textContent).toContain('legacy-fallback · 旧版注册未声明视觉分组，归入兜底分组')

      const unassigned = dom.window.document.querySelector('[data-manager-navigation-contribution="modern:ungrouped"]')
      expect(unassigned?.textContent).toContain('unassigned-fallback · v9 注册未声明视觉分组，归入兜底分组')
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
