import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { MarketplaceTrustBadges } from '../packages/cli/src/renderer/manager/components/MarketplaceTrustBadges.js'
import type { MarketplaceCertificationRecord, MarketplaceOfficialRecord } from '../packages/cli/src/renderer/marketplace-trust.js'

describe('React Marketplace trust badges', () => {
  it('renders all four independent states with stacked Host icons, tooltips, and accessible names', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><body><div id="root"></div></body></html>')
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      MutationObserver: globalThis.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
    const root = createRoot(dom.window.document.getElementById('root')!)
    const official = {} as MarketplaceOfficialRecord
    const certification = {} as MarketplaceCertificationRecord
    try {
      await act(async () => root.render(<MarketplaceTrustBadges plugin={{}} locale="zh-CN" />))
      expect(dom.window.document.querySelectorAll('[data-trust-dimension]')).toHaveLength(0)

      await act(async () => root.render(<MarketplaceTrustBadges plugin={{ certification }} locale="zh-CN" />))
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-trust-dimension]')].map(item => item.dataset.trustDimension)).toEqual(['certified'])

      await act(async () => root.render(<MarketplaceTrustBadges plugin={{ official }} locale="en" />))
      expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-trust-dimension]')].map(item => item.dataset.trustDimension)).toEqual(['official'])

      await act(async () => root.render(<MarketplaceTrustBadges plugin={{ official, certification }} locale="en" />))
      const badges = [...dom.window.document.querySelectorAll<HTMLElement>('[data-trust-dimension]')]
      expect(badges.map(item => item.dataset.trustDimension)).toEqual(['official', 'certified'])
      expect(badges[0]?.getAttribute('aria-label')).toContain('never permissions')
      expect(badges[1]?.getAttribute('aria-label')).toContain('does not affect Marketplace ordering')
      expect(badges.every(item => item.getAttribute('role') === 'img' && item.title.length > 0)).toBe(true)
      expect(badges.map(item => item.querySelector('svg')?.dataset.hostIconKey)).toEqual(['trust.official', 'trust.certified'])
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
