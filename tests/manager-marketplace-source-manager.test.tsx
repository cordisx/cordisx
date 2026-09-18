import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { reactManagerFixture } from './helpers/react-manager.js'

describe('Marketplace source manager', () => {
  it('submits atomic URL edits with local name and description while preserving dialog errors', async () => {
    const fixture = reactManagerFixture()
    const shadows: ShadowRoot[] = []
    const attach = fixture.dom.window.HTMLElement.prototype.attachShadow
    const shadowSpy = vi.spyOn(fixture.dom.window.HTMLElement.prototype, 'attachShadow').mockImplementation(
      function(this: HTMLElement, options) {
        const shadow = attach.call(this, options)
        shadows.push(shadow)
        return shadow
      },
    )
    fixture.dom.window.HTMLDialogElement.prototype.showModal = function() {
      this.setAttribute('open', '')
    }
    fixture.dom.window.HTMLDialogElement.prototype.close = function() {
      this.removeAttribute('open')
    }
    const { installDialogHost } = await import('../packages/cli/src/renderer/dialogs/host.js')
    const disposeDialogs = installDialogHost(fixture.document)
    const { MarketplaceSourceManager } = await import(
      '../packages/cli/src/renderer/manager/components/MarketplaceSourceManager.js'
    )
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('Source URL already exists'))
      .mockResolvedValue(undefined)
    const source = {
      url: 'https://old.example/marketplace.json',
      enabled: true,
      name: 'Old source',
      description: 'Old description',
      official: false,
      removable: true,
      refreshing: false,
      local: { name: 'Old source', description: 'Old description' },
    }
    const confirm = async () =>
      act(async () => {
        shadows.at(-1)!.querySelector<HTMLButtonElement>('[data-action=confirm]')!.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
    try {
      await fixture.render(
        <MarketplaceSourceManager
          locale="en"
          sources={[source]}
          onSave={save}
          onSetEnabled={vi.fn()}
          onRemove={vi.fn()}
          onRefresh={vi.fn()}
        />,
      )
      await fixture.click('[aria-label="Edit source: Old source"]')
      await fixture.type('.cxr-dialog-form label:nth-child(1) input', 'https://new.example/marketplace.json')
      await fixture.type('.cxr-dialog-form label:nth-child(2) input', 'New source')
      await act(async () => {
        const textarea = fixture.element('.cxr-dialog-form textarea') as HTMLTextAreaElement
        textarea.focus()
        Object.getOwnPropertyDescriptor(fixture.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
          textarea,
          'New description',
        )
        textarea.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }))
        textarea.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }))
        textarea.dispatchEvent(new fixture.dom.window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      await confirm()
      expect(save).toHaveBeenLastCalledWith('https://old.example/marketplace.json', {
        url: 'https://new.example/marketplace.json',
        enabled: true,
        local: { name: 'New source', description: 'New description' },
      })
      expect(fixture.document.querySelector('[role="alert"]')?.textContent).toBe('Source URL already exists')
      await confirm()
      expect(save).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => disposeDialogs())
      shadowSpy.mockRestore()
      await fixture.dispose()
    }
  })

  it('exposes source actions and protects non-removable sources', async () => {
    const fixture = reactManagerFixture()
    const { MarketplaceSourceManager } = await import(
      '../packages/cli/src/renderer/manager/components/MarketplaceSourceManager.js'
    )
    const setEnabled = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(fixture.dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    try {
      await fixture.render(
        <MarketplaceSourceManager
          locale="en"
          sources={[{
            url: 'https://official.example/marketplace.json',
            enabled: true,
            name: 'Official',
            official: true,
            removable: false,
            refreshing: false,
          }]}
          onSave={vi.fn()}
          onSetEnabled={setEnabled}
          onRemove={remove}
          onRefresh={refresh}
        />,
      )
      await fixture.click('.t-switch')
      expect(setEnabled).toHaveBeenCalledWith('https://official.example/marketplace.json', false)
      await fixture.click('[aria-label="Refresh source: Official"]')
      expect(refresh).toHaveBeenCalledWith('https://official.example/marketplace.json')
      await fixture.click('[aria-label="Copy source URL: Official"]')
      expect(fixture.dom.window.navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://official.example/marketplace.json',
      )
      expect(fixture.element('[aria-label="Remove source: Official"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.click('[aria-label="Remove source: Official"]')
      expect(remove).not.toHaveBeenCalled()
    } finally {
      await fixture.dispose()
    }
  })
})
