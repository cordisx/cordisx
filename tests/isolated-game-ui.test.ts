import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedGameUiService } from '../packages/cli/src/renderer/isolated-game-ui/service.js'

const content = '<!doctype html><main></main>'
const bundle = {
  format: 'html-v1' as const,
  entry: 'index.html',
  bridgeVersion: 1 as const,
  assets: {
    'index.html': {
      mediaType: 'text/html' as const,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  },
}
const snapshot = {
  matchId: 'match-one',
  sequence: 1,
  observation: { turn: 0 },
  status: 'playing',
  canAct: true,
  readOnly: false,
  theme: 'dark' as const,
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function fixture() {
  const dom = new JSDOM('<main></main>')
  const sent: unknown[] = []
  const port = {
    onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>),
    start() {},
    close: vi.fn(),
    postMessage: (data: unknown) => sent.push(data),
  }
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = port
      port2 = {}
    },
  )
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
  const handler = vi.fn(async () => ({ status: 'accepted' as const }))
  const unavailable = vi.fn()
  let active = true
  const service = createIsolatedGameUiService(() => active)
  cleanups.push(() => {
    service.dispose()
    dom.window.close()
  })
  const mounted = await service.mount({
    element: dom.window.document.querySelector('main') as unknown as HTMLElement,
    bundle,
    title: 'Game',
    onRequest: handler,
    onUnavailable: unavailable,
  })
  expect(mounted.status).toBe('accepted')
  if (mounted.status !== 'accepted') throw Error('mount failed')
  const frame = dom.window.document.querySelector('iframe')!
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'null',
      data: { type: 'game-ui-hello', token: '00000000-0000-4000-8000-000000000001', versions: [1] },
    }),
  )
  mounted.value.publish(snapshot)
  await port.onmessage!({ data: { version: 1, type: 'ready' } })
  const request = (id: string, extra = {}) =>
    port.onmessage!({
      data: {
        version: 1,
        type: 'request',
        requestId: id,
        matchId: snapshot.matchId,
        sequence: 1,
        kind: 'action',
        payload: { x: 1 },
        ...extra,
      },
    })
  return {
    service,
    seat: mounted.value,
    frame,
    handler,
    unavailable,
    sent,
    request,
    port,
    retire: () => {
      active = false
    },
  }
}

describe('isolated game UI lifecycle and authority', () => {
  it('passes public participant metadata through cloned snapshots and sequences owner transfers', async () => {
    const f = await fixture()
    expect(f.sent).toContainEqual({ version: 1, type: 'snapshot', snapshot })
    const participants = [
      { seatIndex: 0, name: 'Player', kind: 'human' as const, isOwner: true, avatar: 'data:image/png;base64,AA==' },
      { seatIndex: 1, name: 'Bot', kind: 'bot' as const, isOwner: false },
    ]
    const projected = { ...snapshot, sequence: 2, participants }
    f.seat.publish(projected)
    expect(f.sent).toContainEqual({ version: 1, type: 'snapshot', snapshot: projected })
    participants[0].name = 'Caller mutation'
    await f.port.onmessage!({ data: { version: 1, type: 'snapshot-request' } })
    expect(f.sent.at(-1)).toMatchObject({ snapshot: { participants: [{ name: 'Player' }, { name: 'Bot' }] } })
    const transferred = participants.map(p => ({ ...p, isOwner: p.seatIndex === 1 }))
    expect(() => f.seat.publish({ ...snapshot, sequence: 2, participants: transferred })).toThrow('stale-state')
    f.seat.publish({ ...snapshot, sequence: 3, participants: transferred })
    expect(f.sent.at(-1)).toMatchObject({ snapshot: { sequence: 3, participants: transferred } })
    f.seat.publish({ ...snapshot, sequence: 4, participants: [] })
    expect(f.sent.at(-1)).toMatchObject({ snapshot: { participants: [] } })
    f.seat.publish({ ...snapshot, sequence: 5 })
    expect(f.sent.at(-1)).toEqual({ version: 1, type: 'snapshot', snapshot: { ...snapshot, sequence: 5 } })
  })

  it('rejects private fields and invalid participants before sending any snapshot', async () => {
    const f = await fixture()
    const participant = { seatIndex: 0, name: 'Player', kind: 'human', isOwner: true }
    for (
      const invalid of [
        null,
        [],
        { ...participant, seat: 0 },
        { ...participant, accountId: 'private' },
        { ...participant, token: 'private' },
        { ...participant, seatIndex: -1 },
        { ...participant, seatIndex: 32 },
        { ...participant, seatIndex: 0.5 },
        { ...participant, name: '' },
        { ...participant, name: '😀'.repeat(129) },
        { ...participant, kind: 'owner' },
        { ...participant, isOwner: 'true' },
        { seatIndex: 0, name: 'Player', kind: 'human' },
        { ...participant, avatar: 'https://example.com/avatar.png' },
        { ...participant, avatar: '/native/avatar.png' },
        { ...participant, avatar: 'data:image/svg+xml;base64,AA==' },
        { ...participant, avatar: 'data:image/png;base64,' },
        { ...participant, avatar: 'data:image/png;base64,invalid' },
        { ...participant, avatar: 'data:image/png;base64,AA==\n' },
        { ...participant, avatar: `data:image/png;base64,${'A'.repeat(65536)}` },
      ]
    ) {
      expect(() => f.seat.publish({ ...snapshot, sequence: 2, participants: [invalid] } as never))
        .toThrow('invalid-snapshot')
    }
    for (
      const participants of [null, {}, Array(33).fill(participant), [participant, { ...participant, name: 'Other' }]]
    ) {
      expect(() => f.seat.publish({ ...snapshot, sequence: 2, participants } as never)).toThrow('invalid-snapshot')
    }
    expect(() => f.seat.publish({ ...snapshot, sequence: 2, accountId: 'private' } as never)).toThrow(
      'invalid-snapshot',
    )
    expect(f.sent).toHaveLength(1)
    let sequence = 2
    for (const kind of ['human', 'agent', 'bot']) {
      for (const mediaType of ['png', 'jpeg', 'webp']) {
        f.seat.publish({
          ...snapshot,
          sequence: sequence++,
          participants: [{
            ...participant,
            kind,
            name: '😀'.repeat(128),
            avatar: `data:image/${mediaType};base64,AA==`,
          }],
        } as never)
      }
    }
    const seats = Array.from({ length: 32 }, (_, seatIndex) => ({ ...participant, seatIndex, isOwner: false }))
    f.seat.publish({ ...snapshot, sequence: sequence++, participants: seats } as never)
    expect(f.sent.at(-1)).toMatchObject({ snapshot: { participants: seats } })
    expect(() =>
      f.seat.publish({
        ...snapshot,
        sequence,
        participants: seats.map(p => ({
          ...p,
          avatar: `data:image/png;base64,${'A'.repeat(60000)}`,
        })),
      } as never)
    ).toThrow()
  })

  it('retains the action fence for same-sequence participant changes and owner display flags', async () => {
    const f = await fixture()
    const participants = [{ seatIndex: 0, name: 'Player', kind: 'human' as const, isOwner: true }]
    f.seat.publish({ ...snapshot, sequence: 2, participants })
    await f.request('one', { sequence: 2 })
    expect(() => f.seat.publish({ ...snapshot, sequence: 2, participants: [{ ...participants[0], isOwner: false }] }))
      .toThrow('stale-state')
    f.seat.publish({ ...snapshot, sequence: 2, participants, theme: 'light' })
    await f.request('locked', { sequence: 2 })
    expect(f.handler).toHaveBeenCalledTimes(1)
    f.seat.publish({ ...snapshot, sequence: 3, canAct: false, participants })
    await f.request('owner-cannot-act', { sequence: 3 })
    expect(f.handler).toHaveBeenCalledTimes(1)
  })

  it('reserves the element while resource verification is pending', async () => {
    const dom = new JSDOM('<main></main>')
    const service = createIsolatedGameUiService(() => true)
    cleanups.push(() => {
      service.dispose()
      dom.window.close()
    })
    const input = {
      element: dom.window.document.querySelector('main') as unknown as HTMLElement,
      bundle,
      title: 'Game',
      onRequest: async () => ({ status: 'accepted' as const }),
    }
    const results = await Promise.all([service.mount(input), service.mount(input)])
    expect(results.map(result => result.status)).toEqual(['accepted', 'unavailable'])
    expect(dom.window.document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('deduplicates requests and locks accepted actions until a newer projection', async () => {
    const f = await fixture()
    await f.request('one')
    await f.request('one')
    await f.request('two')
    expect(f.handler).toHaveBeenCalledTimes(1)
    expect(f.sent).toContainEqual({
      version: 1,
      type: 'reply',
      requestId: 'two',
      reply: { status: 'rejected', code: 'not-actionable' },
    })
    f.seat.publish({ ...snapshot, sequence: 2 })
    await f.request('three', { sequence: 2 })
    expect(f.handler).toHaveBeenCalledTimes(2)
  })

  it('routes only declared writable room actions without using gameplay canAct', async () => {
    const f = await fixture()
    f.seat.publish({ ...snapshot, sequence: 2, canAct: false, roomActions: ['ready', 'funding'] })
    await f.request('ready', { sequence: 2, kind: 'room-action', payload: { operation: 'ready' } })
    expect(f.handler).toHaveBeenCalledWith({
      requestId: 'ready',
      matchId: snapshot.matchId,
      sequence: 2,
      kind: 'room-action',
      payload: { operation: 'ready' },
    })
    await f.request('locked', { sequence: 2, kind: 'room-action', payload: { operation: 'funding' } })
    expect(f.handler).toHaveBeenCalledTimes(1)

    f.seat.publish({ ...snapshot, sequence: 3, canAct: false, roomActions: ['funding'] })
    await f.request('malformed', { sequence: 3, kind: 'room-action', payload: { operation: 'play' } })
    await f.request('undeclared', { sequence: 3, kind: 'room-action', payload: { operation: 'ready' } })
    expect(f.handler).toHaveBeenCalledTimes(1)
    await f.request('funding', { sequence: 3, kind: 'room-action', payload: { operation: 'funding' } })
    expect(f.handler).toHaveBeenCalledTimes(2)

    f.seat.publish({ ...snapshot, sequence: 4, readOnly: true, roomActions: ['funding'] })
    await f.request('readonly-room', { sequence: 4, kind: 'room-action', payload: { operation: 'funding' } })
    expect(f.handler).toHaveBeenCalledTimes(2)
  })

  it('rejects stale and read-only actions, conflicting request ids and altered same-sequence state', async () => {
    const f = await fixture()
    await f.request('stale', { matchId: 'old-match' })
    expect(f.handler).not.toHaveBeenCalled()
    await f.request('one')
    await f.request('one', { payload: { x: 2 } })
    expect(f.sent).toContainEqual({
      version: 1,
      type: 'reply',
      requestId: 'one',
      reply: { status: 'rejected', code: 'request-id-conflict' },
    })
    expect(() => f.seat.publish({ ...snapshot, observation: { turn: 1 } })).toThrow('stale-state')
    f.seat.publish({ ...snapshot, sequence: 2, readOnly: true })
    await f.request('readonly', { sequence: 2 })
    expect(f.handler).toHaveBeenCalledTimes(1)
  })

  it('retires the iframe and message port when its owning generation expires', async () => {
    const f = await fixture()
    f.retire()
    await f.request('retired')
    expect(f.handler).not.toHaveBeenCalled()
    expect(f.frame.isConnected).toBe(false)
    expect(f.port.close).toHaveBeenCalledOnce()
    f.seat.dispose()
    expect(f.port.close).toHaveBeenCalledOnce()
  })

  it('rejects tampered resources before creating a frame', async () => {
    const f = await fixture()
    f.seat.dispose()
    const result = await f.service.mount({
      element: f.frame.ownerDocument.querySelector('main') as unknown as HTMLElement,
      bundle: { ...bundle, assets: { 'index.html': { ...bundle.assets['index.html'], content: 'tampered' } } },
      title: 'Invalid',
      onRequest: f.handler,
    })
    expect(result).toEqual({ status: 'unavailable', code: 'invalid-bundle' })
    expect(f.frame.ownerDocument.querySelector('iframe')).toBeNull()
  })
})
