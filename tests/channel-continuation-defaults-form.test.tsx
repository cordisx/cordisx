import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dom } from './helpers/host-react-form.js'
import { registerManagedConsoleSeat } from '../packages/cli/src/renderer/managed-console-seats.js'
let ChannelContinuationDefaultsWorkflow:
  typeof import('../packages/cli/src/renderer/channel-continuation-defaults-workflow.js').ChannelContinuationDefaultsWorkflow
beforeEach(async () => {
  ;({ ChannelContinuationDefaultsWorkflow } = await import(
    '../packages/cli/src/renderer/channel-continuation-defaults-workflow.js'
  ))
})

describe('Host continuation defaults form', () => {
  it('does not write on mount, writes with CAS, and retains a conflicting draft', async () => {
    const target = dom.window.document.createElement('div'), lifetime = new AbortController()
    dom.window.document.body.append(target)
    registerManagedConsoleSeat(target, 'channel', lifetime.signal)
    let revision = 1, policy = { enabled: false, thresholdRatio: .9 }
    const run = vi.fn(async (action: string, input: any) => {
      if (action === 'continuation-defaults-set') {
        if (input.expectedRevision !== revision) return { status: 'unavailable', code: 'REVISION_CONFLICT' }
        policy = input.policy
        revision++
      }
      return { status: 'applied', continuationDefaults: { revision, policy } }
    })
    const workflow = new ChannelContinuationDefaultsWorkflow({
      document: dom.window.document,
      lifetime: lifetime.signal,
      live: () => true,
      run: run as never,
    })
    const onResult = vi.fn()
    let mounted: Awaited<ReturnType<typeof workflow.mount>> | undefined
    await act(async () => {
      mounted = await workflow.mount({
        target,
        owner: 'channel',
        options: { signal: lifetime.signal, onResult },
        live: () => true,
        authorize: async () => true,
      })
    })
    expect(run).toHaveBeenCalledExactlyOnceWith('continuation-defaults', {})
    const group = target.querySelector('[data-config-path="enabled"] .t-radio-group')!
    expect(group.className).toContain('filled')
    const on = [...group.querySelectorAll<HTMLElement>('.t-radio-button')].find(item =>
      item.textContent?.trim() === 'On'
    )!
    await act(async () => on.click())
    revision++
    await act(async () =>
      target.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(run).toHaveBeenCalledWith('continuation-defaults-set', {
      expectedRevision: 1,
      policy: { enabled: true, thresholdRatio: .9 },
    })
    expect(onResult).toHaveBeenCalledWith({ status: 'conflict', code: 'REVISION_CONFLICT' })
    expect(target.textContent).toContain('Settings changed')
    if (mounted?.status === 'mounted') {
      await act(async () => {
        mounted!.dispose()
        await mounted!.closed
      })
    }
    lifetime.abort()
    target.remove()
  })
})
