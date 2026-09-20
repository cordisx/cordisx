import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { reactManagerFixture } from './helpers/react-manager.js'

async function selectMenuItem(fixture: ReturnType<typeof reactManagerFixture>, label: string) {
  await fixture.click('[aria-haspopup="menu"]')
  const item = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
    .find(candidate => candidate.textContent?.includes(label))
  expect(item, label).toBeDefined()
  await act(async () => {
    item!.click()
    await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
  })
  return item!
}

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
      trusted: true,
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
      await selectMenuItem(fixture, 'Edit source')
      expect(shadows.at(-1)!.querySelector('.source')).toBeNull()
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
        trusted: true,
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

  it('searches projected source copy and keeps infrequent actions in the standard menu', async () => {
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
    const { dialogCenterForDocument, installDialogHost } = await import(
      '../packages/cli/src/renderer/dialogs/host.js'
    )
    const disposeDialogs = installDialogHost(fixture.document)
    const { MarketplaceSourceManager } = await import(
      '../packages/cli/src/renderer/manager/components/MarketplaceSourceManager.js'
    )
    const setEnabled = vi.fn().mockResolvedValue(undefined)
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
            description: 'Managed catalog',
            official: true,
            removable: false,
            refreshing: false,
          }, {
            url: 'https://community.example/feed.json',
            enabled: true,
            name: 'Community',
            description: 'Third-party plugins',
            official: false,
            removable: true,
            refreshing: false,
          }]}
          onSave={vi.fn()}
          onSetEnabled={setEnabled}
          onRemove={remove}
          onRefresh={vi.fn()}
        />,
      )
      expect(fixture.document.querySelectorAll('.cxr-source-actions > .cxm-manager-icon-action')).toHaveLength(0)
      await fixture.click('.t-switch')
      expect(setEnabled).toHaveBeenCalledWith('https://official.example/marketplace.json', false)
      await selectMenuItem(fixture, 'Copy source URL')
      expect(fixture.dom.window.navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://official.example/marketplace.json',
      )
      const removeOfficial = await selectMenuItem(fixture, 'Remove source')
      expect(removeOfficial.classList.contains('t-dropdown__item--disabled')).toBe(true)
      expect(remove).not.toHaveBeenCalled()

      await fixture.type('.cxr-marketplace-search input', 'third-PARTY')
      expect(fixture.document.querySelector('[data-marketplace-source="https://official.example/marketplace.json"]'))
        .toBeNull()
      expect(fixture.document.querySelector('[data-marketplace-source="https://community.example/feed.json"]'))
        .not.toBeNull()
      await fixture.type('.cxr-marketplace-search input', 'missing')
      expect(fixture.document.body.textContent).toContain('No Marketplace sources match your search')
      await fixture.type('.cxr-marketplace-search input', '')
      expect(fixture.document.querySelectorAll('[data-marketplace-source]')).toHaveLength(2)

      const menus = fixture.document.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]')
      await act(async () => {
        menus[1]!.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      const removeCommunity = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Remove source'))!
      expect(removeCommunity.classList.contains('t-dropdown__item--theme-error')).toBe(true)
      await act(async () => {
        removeCommunity.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      const center = dialogCenterForDocument(fixture.document)!
      const confirmation = center.visible()[0]!
      expect(confirmation.chrome.title).toBe('Remove source')
      expect(shadows.at(-1)!.querySelector('.source')).toBeNull()
      await act(async () => center.run(confirmation, confirmation.chrome.footer!.primaryAction!))
      expect(remove).toHaveBeenCalledExactlyOnceWith('https://community.example/feed.json')
    } finally {
      await act(async () => disposeDialogs())
      shadowSpy.mockRestore()
      await fixture.dispose()
    }
  })

  it('shows real source errors and keeps the last error through revalidation until a successful snapshot', async () => {
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
    const { dialogCenterForDocument, installDialogHost } = await import(
      '../packages/cli/src/renderer/dialogs/host.js'
    )
    const disposeDialogs = installDialogHost(fixture.document)
    const { MarketplaceSourceManager } = await import(
      '../packages/cli/src/renderer/manager/components/MarketplaceSourceManager.js'
    )
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = {
      url: 'https://broken.example/marketplace.json',
      enabled: true,
      name: 'Broken source',
      description: 'Unavailable catalog',
      error: 'TLS handshake failed',
      official: false,
      removable: true,
      refreshing: false,
    }
    try {
      await fixture.render(
        <MarketplaceSourceManager
          locale="en"
          sources={[source]}
          onSave={vi.fn()}
          onSetEnabled={vi.fn()}
          onRemove={vi.fn()}
          onRefresh={refresh}
        />,
      )
      await fixture.click('[aria-label^="View source error"]')
      const center = dialogCenterForDocument(fixture.document)!
      const errorDialog = center.visible()[0]!
      expect(errorDialog.chrome.title).toBe('Source error')
      expect(shadows.at(-1)!.querySelector('.source')).toBeNull()
      expect(fixture.document.querySelector('[data-cordisx-dialog]')?.textContent).toContain('TLS handshake failed')
      await act(async () => center.run(errorDialog, errorDialog.chrome.footer!.primaryAction!))
      expect(refresh).toHaveBeenCalledExactlyOnceWith(source.url)

      await fixture.render(
        <MarketplaceSourceManager
          locale="en"
          sources={[{ ...source, error: undefined, refreshing: true }]}
          onSave={vi.fn()}
          onSetEnabled={vi.fn()}
          onRemove={vi.fn()}
          onRefresh={refresh}
        />,
      )
      expect(center.visible()).toHaveLength(1)
      expect(fixture.document.querySelector('[data-cordisx-dialog]')?.textContent).toContain('TLS handshake failed')
      await fixture.render(
        <MarketplaceSourceManager
          locale="en"
          sources={[{ ...source, error: undefined, refreshing: false }]}
          onSave={vi.fn()}
          onSetEnabled={vi.fn()}
          onRemove={vi.fn()}
          onRefresh={refresh}
        />,
      )
      expect(center.visible()).toHaveLength(0)
    } finally {
      await act(async () => disposeDialogs())
      shadowSpy.mockRestore()
      await fixture.dispose()
    }
  })
})
