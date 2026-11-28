import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConnectionForm } from '../packages/cli/src/renderer/channel-connection-form.js'
import { reactManagerFixture } from './helpers/react-manager.js'

describe('unified Host Channel connection form', () => {
  it('locks an uncertain save until the user reopens and checks the saved configuration', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    const snapshot = {
      displayName: 'Original',
      selectors: ['direct'],
      revision: 2,
      serviceRevision: 7,
      writable: true,
      credentialWritable: true,
    }
    const onResult = vi.fn()
    const apply = vi.fn(async () => {
      throw new Error('INDEPENDENT_HOST_RESULT_UNKNOWN')
    })
    try {
      await f.render(createElement(ChannelConnectionForm, {
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' },
        initial: snapshot,
        credentialsAvailable: true,
        locale: 'en',
        signal: lifetime.signal,
        subscribe: () => () => {},
        read: async () => snapshot,
        apply,
        resolveTenant: vi.fn(),
        onResult,
      }))
      await f.type('#channel-connection-displayName input', 'Edited')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(f.document.body.textContent).toContain('The save result is unknown')
      expect(f.element('[type="submit"]').hasAttribute('disabled')).toBe(true)
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).toHaveBeenCalledOnce()
      expect(onResult).not.toHaveBeenCalled()
    } finally {
      lifetime.abort()
      await f.dispose()
    }
  })
  it('shows pending identity, allows retry and accepts a manual key without asking for the secret again', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    const snapshot = {
      displayName: 'Pending',
      selectors: ['direct'],
      revision: 2,
      serviceRevision: 7,
      writable: true,
      credentialWritable: false,
    }
    const retry = vi.fn(async () => ({ status: 'rejected' as const, code: 'TENANT_DISCOVERY_PERMISSION_DENIED' }))
    const apply = vi.fn()
      .mockResolvedValueOnce({ status: 'rejected', code: 'TENANT_MISMATCH' })
      .mockResolvedValueOnce({ status: 'applied', code: 'APPLIED' })
    try {
      await f.render(createElement(ChannelConnectionForm, {
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: '' },
        initial: snapshot,
        credentialsAvailable: true,
        locale: 'en',
        signal: lifetime.signal,
        subscribe: () => () => {},
        read: async () => snapshot,
        apply,
        resolveTenant: retry,
        onResult: vi.fn(),
      }))
      expect(f.document.body.textContent).toContain('Tenant identification is pending')
      expect(f.document.querySelector('a')?.href).toContain('/app/cli_fixture/auth?')
      expect(f.document.querySelector('#channel-credential-secret')).toBeNull()
      await f.type('#channel-credential-tenantId input', 'tenant-wrong')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(f.document.querySelector('#channel-credential-tenantId-error')?.textContent).toContain('does not match')
      await f.type('#channel-credential-tenantId input', 'tenant-real')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-real', secret: '' }), snapshot)
      const retryButton = [...f.document.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Retry automatic')
      )!
      await act(async () => {
        retryButton.click()
      })
      expect(retry).toHaveBeenCalledWith('', snapshot)
      expect(f.document.body.textContent).toContain('tenant:tenant:readonly')
    } finally {
      lifetime.abort()
      await f.dispose()
    }
  })
  it('keeps a malformed pending tenant on the field without dispatching a write', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    const snapshot = {
      displayName: 'Pending',
      selectors: ['direct'],
      revision: 2,
      serviceRevision: 7,
      writable: true,
      credentialWritable: false,
    }
    const apply = vi.fn(async () => ({ status: 'applied' as const, code: 'APPLIED' }))
    try {
      await f.render(createElement(ChannelConnectionForm, {
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: '' },
        initial: snapshot,
        credentialsAvailable: true,
        locale: 'en',
        signal: lifetime.signal,
        subscribe: () => () => {},
        read: async () => snapshot,
        apply,
        resolveTenant: vi.fn(),
        onResult: vi.fn(),
      }))
      for (const value of ['x'.repeat(513), '   ']) {
        await f.type('#channel-credential-tenantId input', value)
        await act(async () => {
          f.document.querySelector('form')!.dispatchEvent(
            new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
          )
        })
        expect(apply).not.toHaveBeenCalled()
        expect(f.document.querySelector('#channel-credential-tenantId-error')?.textContent).toContain('check')
      }
      await f.type('#channel-credential-tenantId input', 'fixture-tenant')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).toHaveBeenCalledOnce()
      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'fixture-tenant' }), snapshot)
    } finally {
      lifetime.abort()
      await f.dispose()
    }
  })
  it('saves settings without a new key and resets every editable field with one footer', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    const snapshot = {
      displayName: 'Original',
      selectors: ['direct', 'group'],
      revision: 2,
      serviceRevision: 7,
      writable: true,
      credentialWritable: true,
    }
    const apply = vi.fn(async () => ({ status: 'applied' as const, code: 'APPLIED' })), onResult = vi.fn()
    const props = {
      account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' },
      initial: snapshot,
      credentialsAvailable: true,
      locale: 'en',
      signal: lifetime.signal,
      subscribe: () => () => {},
      read: async () => ({ ...snapshot, displayName: 'Updated' }),
      apply,
      resolveTenant: vi.fn(),
      onResult,
    }
    try {
      await f.render(createElement(ChannelConnectionForm, props))
      expect(f.document.querySelectorAll('form')).toHaveLength(1)
      expect(f.document.querySelectorAll('.cxf-form-grid')).toHaveLength(1)
      expect(f.document.querySelectorAll('[type="submit"]')).toHaveLength(1)
      expect((f.element('#channel-credential-appId input') as HTMLInputElement).disabled).toBe(true)
      expect((f.element('#channel-credential-secret input') as HTMLInputElement).value).toBe('')
      await f.type('#channel-connection-displayName input', 'Updated')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Updated', secret: '', groupMode: 'all' }),
        snapshot,
      )
      expect(onResult).toHaveBeenLastCalledWith({ status: 'applied', code: 'APPLIED' })
      await f.type('#channel-connection-displayName input', 'Draft')
      await f.type('#channel-credential-secret input', 'test-secret')
      const undo = [...f.document.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Undo changes')
      )!
      await act(async () => {
        undo.click()
      })
      expect((f.element('#channel-connection-displayName input') as HTMLInputElement).value).toBe('Updated')
      expect((f.element('#channel-credential-secret input') as HTMLInputElement).value).toBe('')
      expect(apply).toHaveBeenCalledOnce()
    } finally {
      lifetime.abort()
      await f.dispose()
    }
  })

  it('retains edits and a new secret through refresh/conflict, then clears only on abort or reset', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    let snapshot = {
        displayName: 'Original',
        selectors: ['direct'],
        revision: 2,
        serviceRevision: 7,
        writable: true,
        credentialWritable: true,
      },
      refresh: (() => void) | undefined
    const apply = vi.fn(async () => ({ status: 'conflict' as const, code: 'REVISION_CONFLICT' }))
    const props = {
      account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' },
      initial: snapshot,
      credentialsAvailable: true,
      locale: 'en',
      signal: lifetime.signal,
      subscribe: (listener: () => void) => {
        refresh = listener
        return () => {
          refresh = undefined
        }
      },
      read: async () => snapshot,
      apply,
      resolveTenant: vi.fn(),
      onResult: vi.fn(),
    }
    try {
      await f.render(createElement(ChannelConnectionForm, props))
      await f.type('#channel-connection-displayName input', 'My edit')
      await f.type('#channel-credential-secret input', 'test-secret')
      snapshot = { ...snapshot, displayName: 'Other window', revision: 3, serviceRevision: 8 }
      await act(async () => {
        refresh!()
        await Promise.resolve()
      })
      expect((f.element('#channel-connection-displayName input') as HTMLInputElement).value).toBe('My edit')
      expect((f.element('#channel-credential-secret input') as HTMLInputElement).value).toBe('test-secret')
      expect(f.document.querySelector('.cxf-form-action-buttons')?.textContent).toContain('Use latest version')
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).not.toHaveBeenCalled()
      const review = [...f.document.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Use latest version')
      )!
      await act(async () => {
        review.click()
      })
      await act(async () => {
        f.document.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(apply).toHaveBeenLastCalledWith(
        expect.objectContaining({ secret: 'test-secret', displayName: 'My edit' }),
        snapshot,
      )
      expect((f.element('#channel-credential-secret input') as HTMLInputElement).value).toBe('test-secret')
      const undo = [...f.document.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Undo changes')
      )!
      await act(async () => {
        undo.click()
      })
      expect((f.element('#channel-connection-displayName input') as HTMLInputElement).value).toBe('Other window')
      expect((f.element('#channel-credential-secret input') as HTMLInputElement).value).toBe('')
      await act(async () => {
        lifetime.abort()
      })
    } finally {
      lifetime.abort()
      await f.dispose()
      expect(refresh).toBeUndefined()
    }
  })

  it('warns before refreshing a standalone page with an unsaved connection draft', async () => {
    const f = reactManagerFixture(), lifetime = new AbortController()
    f.document.getElementById('root')!.setAttribute('data-manager-surface', 'standalone')
    const snapshot = {
      displayName: 'Original',
      selectors: ['direct'],
      revision: 1,
      serviceRevision: 1,
      writable: true,
      credentialWritable: false,
    }
    try {
      await f.render(createElement(ChannelConnectionForm, {
        account: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
        initial: snapshot,
        credentialsAvailable: false,
        externalStyles: true,
        locale: 'en',
        signal: lifetime.signal,
        subscribe: () => () => {},
        read: async () => snapshot,
        apply: vi.fn(),
        resolveTenant: vi.fn(),
        onResult: vi.fn(),
      }))
      expect(f.document.querySelector('[data-channel-connection-form] style')).toBeNull()
      const clean = new f.dom.window.Event('beforeunload', { cancelable: true })
      f.dom.window.dispatchEvent(clean)
      expect(clean.defaultPrevented).toBe(false)
      await f.type('#channel-connection-displayName input', 'Unsaved')
      const warning = new f.dom.window.Event('beforeunload', { cancelable: true })
      f.dom.window.dispatchEvent(warning)
      expect(warning.defaultPrevented).toBe(true)
      await f.click('.cxf-form-action-buttons button[type="button"]')
      const reset = new f.dom.window.Event('beforeunload', { cancelable: true })
      f.dom.window.dispatchEvent(reset)
      expect(reset.defaultPrevented).toBe(false)
    } finally {
      lifetime.abort()
      await f.dispose()
    }
  })
})
