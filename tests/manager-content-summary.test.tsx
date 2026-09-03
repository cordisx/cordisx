import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@oneworks/avatar-react/style.css', () => ({ default: '' }))
vi.mock('@oneworks/avatar-react', () => ({
  Avatar: ({ className }: { readonly className?: string }) => <span className={className} data-avatar-renderer="true" />,
}))

import type { ManagerModel } from '../packages/cli/src/renderer/manager.js'
import type { ManagerContentPresentation, ManagedManagerPageMount } from '../packages/cli/src/renderer/navigation.js'
import { ManagerContentPage } from '../packages/cli/src/renderer/manager/pages/ManagerContentPage.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'
import { REACT_MANAGER_STYLES } from '../packages/cli/src/renderer/manager/styles.js'

const previous = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

describe('Host Manager entity record summary', () => {
  it('renders avatar summary before tabs and keeps plugin body in the scroll panel', async () => {
    const dom = new JSDOM('<!doctype html><html data-cordisx-app-theme="dark"><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: dom.window, document: dom.window.document,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    })
    const overview = { id: 'entity-overview', params: { entityId: 'lead' } } as const
    const prompts = { id: 'entity-prompts', params: { entityId: 'lead' } } as const
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' })
    const presentation: ManagerContentPresentation = {
      title: 'Lead detail', description: 'Entity detail', parent: { id: 'team' },
      recordSummary: {
        leadingVisual: { kind: 'agent-avatar', avatar },
        title: 'Lead', description: 'Coordinates the team.',
        source: {
          leadingVisual: { kind: 'agent-avatar', avatar },
          title: { key: 'lead.title', fallback: 'Lead' },
          description: { key: 'lead.description', fallback: 'Coordinates the team.' },
        },
      },
      tabs: [
        { id: 'overview', label: 'Overview', icon: 'host:info', route: overview, active: true },
        { id: 'prompts', label: 'Prompts', icon: 'host:layers', route: prompts, active: false },
      ],
    }
    const replace = vi.fn()
    const router: ManagerRouter = {
      route: { kind: 'manager-content', id: 'chatroom:team', reference: overview },
      navigate: vi.fn(), replace, openDetail: vi.fn(), back: vi.fn(),
    }
    const model = {
      managerContentPresentation: () => presentation,
      mountManagerContent: async (_id: string, _reference: unknown, container: HTMLElement): Promise<ManagedManagerPageMount> => {
        const body = container.ownerDocument.createElement('article')
        body.dataset.entityBusinessBody = 'true'
        body.textContent = 'Plugin prompt content'
        container.append(body)
        const abort = new AbortController()
        return { owner: 'chatroom', contributionId: 'chatroom:team', routeId: 'chatroom:entity-overview', pageId: 'chatroom:entity-overview', signal: abort.signal, abort: () => abort.abort(), dispose: async () => body.remove() }
      },
      closeManagerContent: async () => {},
    } as unknown as ManagerModel
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => {
        root.render(<ManagerContentPage model={model} router={router} locale="en" />)
        await Promise.resolve()
      })
      const page = dom.window.document.querySelector<HTMLElement>('[data-manager-content-page]')!
      const summary = page.querySelector<HTMLElement>('[data-manager-content-record-summary]')!
      const tabs = page.querySelector<HTMLElement>('[data-manager-content-tabs]')!
      const panel = page.querySelector<HTMLElement>('.cxr-manager-content-panel')!
      expect([...page.children]).toEqual([summary, tabs, panel])
      expect(summary.textContent).toBe('LeadCoordinates the team.')
      expect(summary.textContent).not.toContain('lead@')
      expect(summary.querySelector('[role="status"]')).toBeNull()
      expect(summary.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Lead')
      expect(panel.querySelector('[data-entity-business-body]')?.textContent).toBe('Plugin prompt content')

      const first = tabs.querySelector<HTMLButtonElement>('[data-manager-content-tab="overview"]')!
      first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      expect(replace).toHaveBeenCalledWith({ kind: 'manager-content', id: 'chatroom:team', reference: prompts })
      expect(REACT_MANAGER_STYLES).toContain('.cxr-manager-record-summary { display: grid; min-width: 0;')
      expect(REACT_MANAGER_STYLES).toContain('background: var(--cx-hover')
      expect(REACT_MANAGER_STYLES).toContain('.cxr-manager-content-panel { min-width: 0; min-height: 0; flex: 1; overflow: auto;')
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
})
