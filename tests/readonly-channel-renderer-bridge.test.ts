import { describe, expect, it, vi } from 'vitest'
import { ReadonlyChannelRendererBridge } from '../packages/cli/src/cli/readonly-channel-renderer-bridge.js'
import type { openReadonlyHeadlessChannel } from '../packages/cli/src/cli/readonly-headless-channel.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'

type View = NonNullable<Awaited<ReturnType<typeof openReadonlyHeadlessChannel>>>

function fixture() {
  const first = new AbortController()
  const second = new AbortController()
  let live = true
  const bridge = new ReadonlyChannelRendererBridge({
    profileId: 'test',
    generation: 'owner-1',
    isCurrent: () => live,
  })
  const context = (rendererId: string, signal: AbortSignal): ManagerRendererChannelContext => ({
    rendererId,
    signal,
    profileId: 'test',
    ownerGeneration: 'owner-1',
    admitted: true,
  })
  const one = context('one', first.signal)
  const two = context('two', second.signal)
  const snapshot = vi.fn(async () => ({ status: 'unavailable' as const }))
  const close = vi.fn()
  const view = { snapshot, close } as unknown as View
  const request = (id: string, extras: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      token: 'renderer-binding-placeholder',
      requestId: id,
      action: 'snapshot',
      ...extras,
    })
  return {
    bridge,
    first,
    second,
    one,
    two,
    snapshot,
    close,
    view,
    request,
    stopOwner: () => {
      live = false
    },
  }
}

describe('readonly Channel renderer bridge', () => {
  it('binds only the owner-selected renderer and rejects unadmitted, cross-session and write requests', async () => {
    const f = fixture()
    f.bridge.bind(f.one, f.view)
    const prepare = f.bridge.channel.prepare
    expect(() => prepare(f.request('x'), { ...f.one, admitted: false })).toThrow()
    expect(() => prepare(f.request('x'), f.two)).toThrow()
    expect(() => prepare(f.request('x'), { ...f.one, signal: f.second.signal })).toThrow()
    expect(() => prepare(f.request('x'), { ...f.one, ownerGeneration: 'other' })).toThrow()
    expect(() => prepare(f.request('x', { action: 'enable' }), f.one)).toThrow()
    expect(() => prepare(f.request('x', { privateField: 'anything' }), f.one)).toThrow()
    expect(() => prepare(f.request('x', { token: 'other' }), f.one)).toThrow()
    const result = prepare(f.request('one'), f.one)
    expect(result.mode).toBe('read')
    await expect(result.dispatch()).resolves.toEqual({
      requestId: 'one',
      ok: true,
      value: { status: 'unavailable' },
    })
    await expect(prepare(f.request('one'), f.one).dispatch()).rejects.toThrow()
    expect(f.snapshot).toHaveBeenCalledTimes(1)
    f.first.abort()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(() => prepare(f.request('two'), f.one)).toThrow()
    f.bridge.close()
  })

  it('discards an in-flight read after owner loss or session revocation', async () => {
    for (const cause of ['owner', 'session'] as const) {
      const f = fixture()
      let release!: () => void
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      f.snapshot.mockImplementation(async () => {
        await waiting
        return { status: 'unavailable' }
      })
      f.bridge.bind(f.one, f.view)
      const pending = f.bridge.channel.prepare(f.request(cause), f.one).dispatch()
      if (cause === 'owner') f.stopOwner()
      else f.first.abort()
      release()
      await expect(pending).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
      f.bridge.close()
      expect(f.close).toHaveBeenCalledTimes(1)
    }
  })

  it('removes only the owner-selected session when bootstrap cleanup unbinds a view', async () => {
    const f = fixture()
    const otherClose = vi.fn()
    f.bridge.bind(f.one, f.view)
    f.bridge.bind(f.two, { ...f.view, close: otherClose })
    f.bridge.unbind({ ...f.one, signal: f.second.signal })
    expect(f.close).not.toHaveBeenCalled()
    f.bridge.unbind(f.one)
    expect(f.close).toHaveBeenCalledOnce()
    expect(() => f.bridge.channel.prepare(f.request('closed'), f.one)).toThrow()
    await expect(f.bridge.channel.prepare(f.request('live'), f.two).dispatch()).resolves.toMatchObject({ ok: true })
    expect(otherClose).not.toHaveBeenCalled()
    f.bridge.close()
    expect(otherClose).toHaveBeenCalledOnce()
  })
})
