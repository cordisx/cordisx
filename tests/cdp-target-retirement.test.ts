import { afterEach, expect, it, vi } from 'vitest'
import { CdpSession, type CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'
import { observeCdpTargetRetirement } from '../packages/cli/src/launcher/cdp-target-retirement.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture(options: { closed?: boolean; browserClosed?: boolean; targetInfos?: unknown } = {}) {
  const target: CdpTarget = { id: 'owned', title: 'Codex', type: 'page', url: 'app://-/index.html' }
  let retired = false
  let crashed = false
  const listeners = new Map<string, (params: Record<string, unknown>) => void>()
  const send = vi.fn(async (method: string) =>
    method === 'Target.getTargets'
      ? { targetInfos: options.targetInfos ?? [{ targetId: 'owned' }] }
      : {}
  )
  const close = vi.fn()
  const browser = {
    send,
    close,
    isClosed: () => options.browserClosed === true,
    onEvent: (method: string, listener: (params: Record<string, unknown>) => void) => {
      listeners.set(method, listener)
      return () => listeners.delete(method)
    },
  } as unknown as CdpSession
  const confirmTargetRetirement = vi.fn(() => retired = true)
  const renderer = {
    isClosed: () => options.closed !== false,
    isTargetClosed: () => retired,
    isTargetCrashed: () => crashed,
    confirmTargetRetirement,
    confirmTargetCrash: () => crashed = true,
  } as unknown as CdpSession
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/owned-browser',
      }))
    ),
  )
  vi.spyOn(CdpSession, 'connect').mockResolvedValue(browser)
  const observer = await observeCdpTargetRetirement(1234, target, renderer)
  return { observer, confirmTargetRetirement, send, close, listeners, renderer }
}

it('confirms an exact destroyed closed target and removes its own observer', async () => {
  const app = await fixture()
  app.listeners.get('Target.targetDestroyed')!({ targetId: 'owned' })
  await app.observer.confirm()
  expect(app.confirmTargetRetirement).toHaveBeenCalledWith('owned')
  expect(app.send.mock.calls.map(([method]) => method)).toEqual(['Target.setDiscoverTargets'])
  app.observer.close()
  expect(app.close).toHaveBeenCalledOnce()
  expect(app.listeners.size).toBe(0)
})

it('uses a complete independent browser target table when destruction was unannounced', async () => {
  const app = await fixture({ targetInfos: [{ targetId: 'replacement' }] })
  await app.observer.confirm()
  expect(app.confirmTargetRetirement).toHaveBeenCalledOnce()
  expect(app.send.mock.calls.map(([method]) => method)).toEqual(['Target.setDiscoverTargets', 'Target.getTargets'])
  app.observer.close()
})

it.each([
  { label: 'still-live original target' },
  { label: 'malformed browser target table', targetInfos: [{}] },
  { label: 'open original renderer', closed: false, targetInfos: [] },
  { label: 'closed browser observer', browserClosed: true, targetInfos: [] },
])('does not infer retirement from $label', async options => {
  const app = await fixture(options)
  app.listeners.get('Target.targetDestroyed')!({ targetId: 'unrelated' })
  await app.observer.confirm()
  expect(app.confirmTargetRetirement).not.toHaveBeenCalled()
  app.observer.close()
})

it('keeps crash proof terminal even when the browser later destroys that target', async () => {
  const app = await fixture({ targetInfos: [] })
  app.listeners.get('Target.targetCrashed')!({ targetId: 'owned' })
  app.listeners.get('Target.targetDestroyed')!({ targetId: 'owned' })
  await app.observer.confirm()
  expect(app.renderer.isTargetCrashed()).toBe(true)
  expect(app.confirmTargetRetirement).not.toHaveBeenCalled()
  app.observer.close()
})

it('retains failure when the independent target table cannot be read', async () => {
  const app = await fixture()
  app.send.mockRejectedValueOnce(new Error('browser transport unavailable'))
  await app.observer.confirm()
  expect(app.confirmTargetRetirement).not.toHaveBeenCalled()
  app.observer.close()
})

it('does not promote target absence when a crash races with its response', async () => {
  const app = await fixture()
  app.send.mockImplementationOnce(async () => {
    app.listeners.get('Target.targetCrashed')!({ targetId: 'owned' })
    return { targetInfos: [] }
  })
  await app.observer.confirm()
  expect(app.confirmTargetRetirement).not.toHaveBeenCalled()
  app.observer.close()
})
