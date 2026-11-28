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

  it('drains existing snapshots before replacing the view and blocks new reads during handoff', async () => {
    const f = fixture()
    let finish!: () => void
    const waiting = new Promise<void>(resolve => {
      finish = resolve
    })
    f.snapshot.mockImplementation(async () => {
      await waiting
      return { status: 'unavailable' }
    })
    f.bridge.bind(f.one, f.view)
    const pending = f.bridge.channel.prepare(f.request('in-flight'), f.one).dispatch()
    const prepared = f.bridge.channel.prepare(f.request('before-pause'), f.one)
    let suspended = false
    const handoff = f.bridge.suspend('one').then(result => {
      suspended = true
      return result
    })
    expect(() => f.bridge.channel.prepare(f.request('during-pause'), f.one)).toThrow()
    await expect(prepared.dispatch()).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
    await Promise.resolve()
    expect(suspended).toBe(false)
    finish()
    await expect(pending).resolves.toMatchObject({ ok: true })
    const reservation = await handoff
    const nextSnapshot = vi.fn(async () => ({ status: 'applied' as const, projection: {} }))
    const nextClose = vi.fn()
    expect(reservation.replace({ snapshot: nextSnapshot, close: nextClose } as unknown as View)).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
    expect(reservation.release()).toBe(true)
    await expect(f.bridge.channel.prepare(f.request('after-pause'), f.one).dispatch()).resolves.toMatchObject({
      ok: true,
      value: { status: 'applied' },
    })
    await expect(f.bridge.channel.prepare(f.request('in-flight'), f.one).dispatch()).rejects.toThrow()
    f.bridge.close()
    expect(nextClose).toHaveBeenCalledOnce()
  })

  it('refuses an unaccounted peer and discards a replacement after session loss', async () => {
    const f = fixture()
    f.bridge.bind(f.one, f.view)
    const otherClose = vi.fn()
    f.bridge.bind(f.two, { ...f.view, close: otherClose })
    await expect(f.bridge.suspend('one')).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
    f.bridge.unbind(f.two)
    const reservation = await f.bridge.suspend('one')
    f.first.abort()
    const nextClose = vi.fn()
    expect(reservation.replace({ ...f.view, close: nextClose })).toBe(false)
    expect(nextClose).toHaveBeenCalledOnce()
    expect(reservation.release()).toBe(false)
    expect(f.close).toHaveBeenCalledOnce()
    f.bridge.close()
    expect(otherClose).toHaveBeenCalledOnce()
  })

  it('retires the view when a pending read cannot be drained', async () => {
    const f = fixture()
    let finish!: () => void
    const waiting = new Promise<void>(resolve => {
      finish = resolve
    })
    f.snapshot.mockImplementation(async () => {
      await waiting
      return { status: 'unavailable' }
    })
    f.bridge.bind(f.one, f.view)
    const pending = f.bridge.channel.prepare(f.request('slow'), f.one).dispatch()
    const rejected = expect(pending).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
    await expect(f.bridge.suspend('one', 100)).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
    expect(f.close).toHaveBeenCalledOnce()
    finish()
    await rejected
    f.bridge.close()
  })

  it('drains every accounted renderer before replacing their views', async () => {
    const f = fixture()
    let finish!: () => void
    const waiting = new Promise<void>(resolve => {
      finish = resolve
    })
    const otherClose = vi.fn()
    f.bridge.bind(f.one, f.view)
    f.bridge.bind(f.two, {
      ...f.view,
      close: otherClose,
      snapshot: async () => {
        await waiting
        return { status: 'unavailable' as const }
      },
    })
    const pending = f.bridge.channel.prepare(f.request('pending'), f.two).dispatch()
    let ready = false
    const handoff = f.bridge.suspendAll(['one', 'two']).then(value => {
      ready = true
      return value
    })
    expect(() => f.bridge.channel.prepare(f.request('blocked-one'), f.one)).toThrow()
    expect(() => f.bridge.channel.prepare(f.request('blocked-two'), f.two)).toThrow()
    await Promise.resolve()
    expect(ready).toBe(false)
    finish()
    await pending
    const reservation = await handoff
    const firstNext = { ...f.view, close: vi.fn() }
    const secondNext = { ...f.view, close: vi.fn() }
    expect(reservation.forRenderer('one').replace(firstNext)).toBe(true)
    expect(reservation.forRenderer('two').replace(secondNext)).toBe(true)
    expect(reservation.release()).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
    expect(otherClose).toHaveBeenCalledOnce()
    await expect(f.bridge.channel.prepare(f.request('new-one'), f.one).dispatch()).resolves.toMatchObject({ ok: true })
    await expect(f.bridge.channel.prepare(f.request('new-two'), f.two).dispatch()).resolves.toMatchObject({ ok: true })
    f.bridge.close()
  })

  it('fences the entire handoff when an accounted renderer disconnects', async () => {
    const f = fixture()
    const otherClose = vi.fn()
    f.bridge.bind(f.one, f.view)
    f.bridge.bind(f.two, { ...f.view, close: otherClose })
    await expect(f.bridge.suspendAll(['one'])).rejects.toThrow('CHANNEL_RENDERER_UNAVAILABLE')
    const reservation = await f.bridge.suspendAll(['one', 'two'])
    f.second.abort()
    expect(reservation.isCurrent()).toBe(false)
    expect(reservation.release()).toBe(false)
    expect(f.close).toHaveBeenCalledOnce()
    expect(otherClose).toHaveBeenCalledOnce()
    expect(() => f.bridge.channel.prepare(f.request('closed'), f.one)).toThrow()
    f.bridge.close()
  })
})
