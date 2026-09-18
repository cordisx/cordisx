import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { reactManagerFixture } from './helpers/react-manager.js'

describe('Hidden Marketplace recovery', () => {
  it('restores discovery identity without invoking plugin lifecycle semantics', async () => {
    const fixture = reactManagerFixture()
    const { HiddenMarketplacePlugins } = await import(
      '../packages/cli/src/renderer/manager/components/HiddenMarketplacePlugins.js'
    )
    let finish!: () => void
    const unhide = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const identity = { sourceUrl: 'https://feed.example/marketplace.json', pluginId: 'demo' }
    try {
      await fixture.render(
        <HiddenMarketplacePlugins
          locale="en"
          plugins={[{ identity, name: 'Demo', description: 'Hidden from discovery.' }]}
          onUnhide={unhide}
        />,
      )
      expect(fixture.document.querySelector('[data-hidden-marketplace-count="1"]')).not.toBeNull()
      await fixture.click('[aria-label="Restore Demo"]')
      expect(unhide).toHaveBeenCalledExactlyOnceWith(identity)
      await fixture.render(
        <HiddenMarketplacePlugins
          locale="en"
          plugins={[{ identity, name: 'Demo', description: 'Hidden from discovery.' }]}
          busyIdentity={`${identity.sourceUrl}\0${identity.pluginId}`}
          onUnhide={unhide}
        />,
      )
      expect(fixture.element('[aria-label="Restore Demo"]').classList.contains('t-is-disabled')).toBe(true)
      await act(async () => finish())
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps a visible empty recovery entry', async () => {
    const fixture = reactManagerFixture()
    const { HiddenMarketplacePlugins } = await import(
      '../packages/cli/src/renderer/manager/components/HiddenMarketplacePlugins.js'
    )
    try {
      await fixture.render(<HiddenMarketplacePlugins locale="zh-CN" plugins={[]} onUnhide={vi.fn()} />)
      expect(fixture.document.body.textContent).toContain('没有已隐藏的插件')
      expect(fixture.document.querySelector('[data-hidden-marketplace-count="0"]')).not.toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
