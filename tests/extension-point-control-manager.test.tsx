import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'

const identity = { source: 'https://plugins.example/theme', pluginId: 'theme', pointId: 'composer.reasoning-intensity' }
const selectedClaim = { principalHandle: 'principal:theme', identity, claimId: 'overlay', mode: 'overlay' as const }

function snapshot(policyRevision: number, outcome: 'native' | 'selected'): ManagerSnapshot {
  const decision = outcome === 'selected'
    ? { groupId: 'renderer', outcome, selectedClaim, authority: 'user' as const, hostGeneration: 'host', reason: 'user.selected' }
    : { groupId: 'renderer', outcome, authority: 'user' as const, hostGeneration: 'host', reason: 'user.native' }
  return {
    extensionPoints: { points: [{
      id: identity.pointId, plugins: [], available: true, availability: 'available', availabilityDetail: '',
      descriptionProjection: { text: 'Reasoning intensity' },
    }] },
    extensionPointControls: {
      revision: policyRevision + 10, policyRevision, hostGeneration: 'host', diagnostics: [],
      points: [{
        id: identity.pointId, state: 'active', reason: 'point.mounted', selected: outcome === 'selected' ? [selectedClaim] : [],
        eligibleCandidates: [], deniedCandidates: [], groupDecisions: [decision],
        groups: [{ id: 'renderer', selection: 'user', nativeFallback: true, modes: ['overlay'], decision }],
        candidates: [{
          ...selectedClaim, contributionId: 'overlay', exclusiveGroup: 'renderer', priority: 0,
          authorization: 'allowed', policy: 'allow', state: outcome === 'selected' ? 'selected' : 'eligible',
          reason: outcome === 'selected' ? 'user.selected' : 'policy.eligible',
        }],
      }],
    },
  } as unknown as ManagerSnapshot
}

describe('React Manager controlled group select', () => {
  it('refreshes selected label across policy CAS and remount, then dispatches native fallback', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://host.invalid/' })
    const previous = {
      document: globalThis.document, window: globalThis.window,
      HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle,
      requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document, window: dom.window,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      attachEvent: { configurable: true, value() {} },
      detachEvent: { configurable: true, value() {} },
    })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    const { ExtensionPointDetailPage } = await import('../packages/cli/src/renderer/manager/pages/ExtensionPointDetailPage.js')
    const setChoice = vi.fn(async () => undefined)
    const model = { setExtensionPointControlGroupChoice: setChoice } as unknown as ManagerModel
    const router: ManagerRouter = { route: { kind: 'extension-point', pointId: identity.pointId }, navigate() {}, back() {} }
    let root = createRoot(dom.window.document.getElementById('root')!)
    const input = () => dom.window.document.querySelector<HTMLInputElement>('[data-cordisx-control-group-select] input')
    try {
      await act(async () => root.render(<ExtensionPointDetailPage model={model} snapshot={snapshot(0, 'native')} router={router} />))
      expect(input()?.value).toBe('原生渲染')
      await act(async () => root.render(<ExtensionPointDetailPage model={model} snapshot={snapshot(1, 'selected')} router={router} />))
      expect(input()?.value).toBe('theme · overlay')

      await act(async () => root.unmount())
      dom.window.document.body.innerHTML = '<div id="root"></div>'
      root = createRoot(dom.window.document.getElementById('root')!)
      await act(async () => root.render(<ExtensionPointDetailPage model={model} snapshot={snapshot(1, 'selected')} router={router} />))
      expect(input()?.value).toBe('theme · overlay')

      const selectInput = input()!
      await act(async () => {
        selectInput.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        selectInput.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      })
      const native = [...dom.window.document.querySelectorAll<HTMLElement>('.t-select-option')].find(option => option.textContent?.includes('原生渲染'))
      expect(native).toBeDefined()
      await act(async () => native!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      expect(setChoice).toHaveBeenCalledWith(1, { pointId: identity.pointId, groupId: 'renderer', outcome: 'native' })
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
