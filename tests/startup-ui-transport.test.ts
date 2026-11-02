import type {
  StartupCursorV1,
  StartupEventV1,
  StartupObserverV1,
  StartupSnapshotV1,
} from '@cordisx/protocol/startup/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import { createBrowserStartupObserver } from '../packages/cli/src/renderer/startup-ui-observer.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'

const owner = { pluginId: 'demo', pluginGeneration: 'plugin-1' }
const options = { token: 'token', profileId: 'profile', generation: 'host-1', services: [] }
const cursor: StartupCursorV1 = { scopeId: 'owner-scope', hostGeneration: 'host-1', epoch: 'epoch-1', sequence: 0 }
function fixture() {
  let current: StartupSnapshotV1 = { contract: 'cordisx.startup-snapshot/v1', cursor, entries: [], pages: [] }
  const listeners = new Set<(event: StartupEventV1) => void>()
  const closes = vi.fn()
  const afters: (StartupCursorV1 | undefined)[] = []
  const observer: StartupObserverV1 = {
    contract: 'cordisx.startup-observer/v1',
    async read() {
      return current
    },
    async subscribe(listener, options) {
      const after = options?.after
      afters.push(after)
      if (after && (after.scopeId !== cursor.scopeId || after.hostGeneration !== cursor.hostGeneration)) {
        throw new Error('cross-scope cursor')
      }
      const reason = !after
        ? 'initial'
        : after.epoch !== current.cursor.epoch
        ? 'epoch-changed'
        : after.sequence !== current.cursor.sequence
        ? 'gap'
        : 'update'
      listeners.add(listener)
      listener({ kind: 'snapshot', reason, snapshot: current })
      const close = () => {
        if (!listeners.delete(listener)) return
        closes()
        listener({ kind: 'closed', reason: 'unsubscribed', cursor: current.cursor })
      }
      options?.signal?.addEventListener('abort', close, { once: true })
      return { close }
    },
  }
  return {
    observer,
    closes,
    afters,
    listeners,
    update(sequence: number, epoch = 'epoch-1') {
      current = { ...current, cursor: { ...cursor, sequence, epoch } }
      for (const listener of [...listeners]) {
        listener({
          kind: 'snapshot',
          reason: epoch === 'epoch-1' ? 'update' : 'epoch-changed',
          snapshot: current,
        })
      }
    },
  }
}
function setup(startup = true) {
  const source = fixture()
  const handler = createManagedServiceUIBridgeHandler({
    ...options,
    startupObservers: [{ ...owner, observer: source.observer }],
  })
  let disconnect = false
  let failedReconnects = 0
  globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
    const value = JSON.parse(payload)
    const fail = (disconnect && value.operation === 'startupNext')
      || (failedReconnects > 0 && value.operation === 'startupSubscribe')
    if (fail && value.operation === 'startupSubscribe') failedReconnects--
    if (fail) disconnect = false
    const response = fail
      ? Promise.reject(new Error('disconnected'))
      : handler.handle(owner, parseManagedServiceUIBindingRequest(value, handler, owner))
    void response.then(
      result =>
        globalThis.__cordisxManagedServiceUIReceiveV1?.(
          JSON.stringify({ requestId: value.requestId, ok: true, value: result }),
        ),
      error =>
        globalThis.__cordisxManagedServiceUIReceiveV1?.(
          JSON.stringify({ requestId: value.requestId, ok: false, code: error.message }),
        ),
    )
  }
  const bridge = BrowserManagedServiceUIBridge.connect(
    [{ ...owner, token: options.token, startup }],
    options.profileId,
    options.generation,
  )
  return {
    source,
    handler,
    bridge,
    observer: bridge.bindStartup(owner)!,
    disconnect: (reconnectFailures = 0) => {
      disconnect = true
      failedReconnects = reconnectFailures
    },
  }
}
afterEach(() => {
  delete globalThis.__cordisxManagedServiceUIRequestV1
  delete globalThis.__cordisxManagedServiceUIReceiveV1
  vi.useRealTimers()
})

describe('startup observation transport', () => {
  it('observes before any execution service exists and keeps legacy get honestly unavailable', async () => {
    const { observer, bridge, handler } = setup()
    expect((await observer.read()).cursor).toEqual(cursor)
    const events: StartupEventV1[] = []
    const sub = await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    })
    expect(events[0]).toMatchObject({ kind: 'snapshot', reason: 'initial' })
    expect((await bridge.bind(owner)!.get({ serviceId: 'gateway' })).status).toBe('unavailable')
    sub.close()
    sub.close()
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(1)
    bridge.dispose()
    await handler.dispose()
  })
  it('does not expose startup to a legacy capability', async () => {
    const { bridge, handler } = setup(false)
    expect(bridge.bindStartup(owner)).toBeUndefined()
    bridge.dispose()
    await handler.dispose()
  })
  it('rejects scope spoofing and forwards authority replay/gap/epoch decisions', async () => {
    const { observer, source, bridge, handler } = setup()
    await expect(observer.subscribe(() => {}, { after: { ...cursor, scopeId: 'other' } })).rejects.toThrow(
      'cross-scope',
    )
    const events: StartupEventV1[] = []
    const gap = await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    }, { after: { ...cursor, sequence: 99 } })
    expect(events[0]).toMatchObject({ kind: 'snapshot', reason: 'gap' })
    source.update(0, 'replacement')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toMatchObject({
      kind: 'snapshot',
      reason: 'epoch-changed',
      snapshot: { cursor: { sequence: 0 } },
    })
    gap.close()
    bridge.dispose()
    await handler.dispose()
  })
  it('reconnects using the last cursor and excludes duplicate or late callbacks after close', async () => {
    const { observer, source, bridge, handler, disconnect } = setup()
    disconnect()
    const events: StartupEventV1[] = []
    const sub = await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    })
    await vi.waitFor(() => expect(source.afters).toHaveLength(2))
    expect(source.afters[1]).toEqual(cursor)
    expect(events).toHaveLength(1)
    source.update(1)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    sub.close()
    source.update(2)
    await Promise.resolve()
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ kind: 'closed', reason: 'unsubscribed' })
    bridge.dispose()
    await handler.dispose()
  })
  it('fences owner replacement, closes exactly once and keeps new generation sequence independent', async () => {
    const { observer, source, bridge, handler } = setup()
    const events: StartupEventV1[] = []
    await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    })
    bridge.disposeStartupOwner(owner)
    source.update(10)
    await Promise.resolve()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: 'closed', reason: 'scope-revoked' })
    await expect(observer.read()).rejects.toThrow('unavailable')
    bridge.dispose()
    await handler.dispose()
  })
  it('rejects private fields from an authority projection', async () => {
    const { observer, source, bridge, handler } = setup()
    source.observer.read = async () =>
      ({
        contract: 'cordisx.startup-snapshot/v1',
        cursor,
        entries: [],
        pages: [],
        originUrl: 'http://secret',
      }) as StartupSnapshotV1
    await expect(observer.read()).rejects.toThrow('private or unsupported')
    bridge.dispose()
    await handler.dispose()
  })
  it('survives a temporary reconnect failure and only terminates on actual revocation', async () => {
    const { observer, source, bridge, handler, disconnect } = setup()
    const events: StartupEventV1[] = []
    const sub = await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    })
    disconnect(1)
    source.update(1)
    await vi.waitFor(() => expect(source.afters.length).toBe(2), { timeout: 2500 })
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(0)
    source.update(2)
    await vi.waitFor(() => expect(events).toHaveLength(3))
    await handler.disposeOwner(owner)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'closed', reason: 'scope-revoked' }))
    source.update(2)
    sub.close()
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(1)
    bridge.dispose()
    await handler.dispose()
  })
  it('rejects a read that resolves after local dispose even when the transport ignores abort', async () => {
    let resolve!: (value: unknown) => void
    const facade = createBrowserStartupObserver(async () =>
      await new Promise(done => {
        resolve = done
      })
    )
    const pending = facade.observer.read()
    facade.dispose()
    resolve({ contract: 'cordisx.startup-snapshot/v1', cursor, entries: [], pages: [] })
    await expect(pending).rejects.toThrow('unavailable')
  })
  it('aborts observation once and frees remote watches without stopping its producer', async () => {
    const { observer, source, bridge, handler } = setup()
    const controller = new AbortController()
    const events: StartupEventV1[] = []
    await observer.subscribe(event => {
      if (event.kind !== 'connection') events.push(event)
    }, { signal: controller.signal })
    controller.abort()
    await vi.waitFor(() => expect(source.listeners.size).toBe(0))
    source.update(2)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ kind: 'closed', reason: 'unsubscribed' })
    expect(bridge.bindStartup(owner)).toBe(observer)
    bridge.dispose()
    await handler.dispose()
  })
  it('resets slow subscribers with a full gap snapshot and fences subscription ids by owner', async () => {
    const source = fixture()
    const other = { pluginId: 'other', pluginGeneration: 'other-1' }
    const handler = createManagedServiceUIBridgeHandler({
      ...options,
      startupObservers: [{ ...owner, observer: source.observer }, { ...other, observer: fixture().observer }],
    })
    const opened = await handler.handle(owner, {
      requestId: 'open',
      operation: 'startupSubscribe',
      subscriptionId: 'slow',
    }) as { subscriptionId: string }
    for (let sequence = 1; sequence <= 40; sequence++) source.update(sequence)
    const next = await handler.handle(owner, {
      requestId: 'next',
      operation: 'startupNext',
      ...opened,
    }) as StartupEventV1
    expect(next).toMatchObject({ kind: 'snapshot', reason: 'gap', snapshot: { cursor: { sequence: 33 } } })
    await expect(handler.handle(other, { requestId: 'steal', operation: 'startupNext', ...opened })).rejects.toThrow(
      'owner scope',
    )
    await handler.dispose()
  })

  it('reports connection loss and recovery separately without changing the authority cursor', async () => {
    const { observer, source, bridge, handler, disconnect } = setup()
    const events: StartupEventV1[] = []
    const sub = await observer.subscribe(event => events.push(event))
    disconnect(1)
    source.update(1)
    await vi.waitFor(() => expect(source.afters.length).toBe(2), { timeout: 2500 })
    const connection = events.filter(event => event.kind === 'connection').map(event => event.connection.state)
    expect(connection).toEqual(['connected', 'disconnected', 'reconnecting', 'reconnecting', 'connected'])
    const snapshots = events.filter(event => event.kind === 'snapshot')
    expect(snapshots.map(event => event.snapshot.cursor.sequence)).toEqual([0, 1])
    sub.close()
    bridge.dispose()
    await handler.dispose()
  })

  it('keeps an idle long read healthy beyond eight seconds and releases it on abort or real disconnect', async () => {
    vi.useFakeTimers()
    const { observer, source, bridge, handler } = setup()
    const events: StartupEventV1[] = []
    const controller = new AbortController()
    await observer.subscribe(event => events.push(event), { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(9000)
    expect(events.filter(event => event.kind === 'connection').map(event => event.connection.state)).toEqual([
      'connected',
    ])
    bridge.transportDisconnected()
    await vi.advanceTimersByTimeAsync(300)
    expect(events.filter(event => event.kind === 'connection').map(event => event.connection.state)).toContain(
      'disconnected',
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.listeners.size).toBe(0)
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(1)
    bridge.dispose()
    await handler.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps generic owner-unavailable recoverable rather than asserting scope revocation', async () => {
    const { observer, source, bridge, handler } = setup()
    const deliver = globalThis.__cordisxManagedServiceUIRequestV1!
    let rejectNext = true
    globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
      const request = JSON.parse(payload)
      if (rejectNext && request.operation === 'startupNext') {
        rejectNext = false
        globalThis.__cordisxManagedServiceUIReceiveV1?.(
          JSON.stringify({ requestId: request.requestId, ok: false, code: 'owner-unavailable' }),
        )
      } else deliver(payload)
    }
    const events: StartupEventV1[] = []
    const sub = await observer.subscribe(event => events.push(event))
    await vi.waitFor(() => expect(source.afters).toHaveLength(2))
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(0)
    source.update(1)
    await vi.waitFor(() => expect(events.filter(event => event.kind === 'snapshot')).toHaveLength(2))
    sub.close()
    bridge.dispose()
    await handler.dispose()
  })
})
