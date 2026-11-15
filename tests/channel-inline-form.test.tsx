import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { mountChannelHostForm } from '../packages/cli/src/renderer/channel-form-mount.js'
import { registerManagedConsoleSeat } from '../packages/cli/src/renderer/managed-console-seats.js'
import { ChannelPolicyWorkflow } from '../packages/cli/src/renderer/channel-policy-workflow.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { reactManagerFixture } from './helpers/react-manager.js'

function body(f: ReturnType<typeof reactManagerFixture>, owner = 'channel') {
  const page = f.document.createElement('section'), target = f.document.createElement('div')
  const pageLifetime = new AbortController()
  f.document.body.append(page)
  page.append(target)
  registerManagedConsoleSeat(page, owner, pageLifetime.signal)
  return { page, target, pageLifetime }
}

describe('Host inline Channel form seats', () => {
  it('requires actual page ownership and one empty target, then closes on abort', async () => {
    const f = reactManagerFixture(), seat = body(f), lifetime = new AbortController()
    let cleanup = 0
    const render = (signal: AbortSignal) => {
      signal.addEventListener('abort', () => {
        cleanup += 1
      }, { once: true })
      return createElement('input', { type: 'password', defaultValue: '' })
    }
    const input = {
      target: seat.target,
      owner: 'channel',
      lifetime: lifetime.signal,
      options: { signal: lifetime.signal },
      live: () => true,
      render,
    }
    try {
      const fake = f.document.createElement('div')
      fake.dataset.channelCredentialSeat = 'true'
      f.document.body.append(fake)
      expect(mountChannelHostForm({ ...input, target: fake }).status).toBe('unavailable')
      expect(mountChannelHostForm({ ...input, owner: 'foreign' }).status).toBe('unavailable')
      let result!: ReturnType<typeof mountChannelHostForm>
      await act(async () => {
        result = mountChannelHostForm(input)
      })
      expect(result.status).toBe('mounted')
      expect(mountChannelHostForm(input).status).toBe('unavailable')
      await act(async () => {
        lifetime.abort()
      })
      if (result.status !== 'mounted') throw new Error('Mount failed')
      await result.closed
      result.dispose()
      expect(cleanup).toBe(1)
      expect(seat.target.childNodes.length).toBe(0)
      expect(mountChannelHostForm({ ...input, target: f.document.createElement('div') }).status).toBe('unavailable')
    } finally {
      seat.pageLifetime.abort()
      seat.page.remove()
      await f.dispose()
    }
  })

  it('retires a form when its target is moved into another page, even for the same plugin', async () => {
    const f = reactManagerFixture(), first = body(f), second = body(f), lifetime = new AbortController()
    let result!: ReturnType<typeof mountChannelHostForm>
    try {
      await act(async () => {
        result = mountChannelHostForm({
          target: first.target,
          owner: 'channel',
          lifetime: lifetime.signal,
          options: { signal: lifetime.signal },
          live: () => true,
          render: () => createElement('span', {}, 'owned'),
        })
      })
      await act(async () => {
        second.page.append(first.target)
        await Promise.resolve()
      })
      if (result.status !== 'mounted') throw new Error('Mount failed')
      await result.closed
      expect(first.target.childNodes.length).toBe(0)
    } finally {
      first.pageLifetime.abort()
      second.pageLifetime.abort()
      first.page.remove()
      second.page.remove()
      await f.dispose()
    }
  })

  it('mounts the real policy schema and authorizes writes with the current read revision', async () => {
    const f = reactManagerFixture(), seat = body(f), lifetime = new AbortController()
    const policy = parseChannelConversationPolicy({
      enabled: false,
      replyMode: 'agent',
      replyFallbackMode: 'conversation',
    })
    const run = vi.fn(async (action: string) =>
      action === 'policy'
        ? { status: 'applied', conversationPolicy: { revision: 7, policy } }
        : { status: 'rejected', code: 'REVISION_CONFLICT' }
    )
    const authorize = vi.fn(async () => true), onResult = vi.fn()
    const workflow = new ChannelPolicyWorkflow({
      document: f.document,
      profileId: 'test',
      hostGeneration: 'one',
      signal: lifetime.signal,
      isCurrent: () => true,
      run: run as never,
    })
    let result!: Awaited<ReturnType<typeof workflow.mount>>
    try {
      await act(async () => {
        result = await workflow.mount(
          'channel',
          seat.target,
          { signal: lifetime.signal, onResult },
          () => true,
          authorize,
        )
      })
      expect(result.status).toBe('mounted')
      expect(seat.target.querySelector('[data-channel-policy-form="inline"]')).not.toBeNull()
      expect(f.document.querySelector('[role="dialog"]')).toBeNull()
      await f.click('[data-config-path="enabled"] .t-switch')
      await act(async () => {
        seat.target.querySelector('form')!.dispatchEvent(
          new f.dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(authorize).toHaveBeenCalledOnce()
      expect(run).toHaveBeenLastCalledWith(
        'policy-set',
        expect.objectContaining({ expectedRevision: 7, policy: expect.objectContaining({ enabled: true }) }),
      )
      expect(onResult).toHaveBeenLastCalledWith({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(seat.target.querySelector('[role="status"]')?.textContent).toContain('retained draft')
      expect(f.element('[data-channel-policy-form="inline"] [type="submit"]').classList.contains('t-is-disabled'))
        .toBe(true)
      await act(async () => {
        seat.pageLifetime.abort()
      })
      if (result.status === 'mounted') await result.closed
      expect(seat.target.childNodes.length).toBe(0)
    } finally {
      lifetime.abort()
      seat.pageLifetime.abort()
      seat.page.remove()
      await f.dispose()
    }
  })
})
