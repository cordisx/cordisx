import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

it('sends no remote cancellation when a CDP observation times out and a later call succeeds', async () => {
  // Local transport only, not a Native evaluator. The peer holds the first
  // response past the Host timeout; inspect all commands for cancellation.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server address')
  const session = await CdpSession.connect(`ws://127.0.0.1:${address.port}`)
  const [peer] = await connected
  const methods: string[] = []
  peer.on('message', (data: { toString(): string }) => methods.push(JSON.parse(data.toString()).method))
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const firstMessage = once(peer, 'message')
    const first = session.send('Runtime.evaluate', { expression: 'held-first', awaitPromise: true }, 3500)
      .catch(error => error)
    const [firstData] = await firstMessage
    const firstId = JSON.parse(firstData.toString()).id
    await vi.advanceTimersByTimeAsync(3500)
    expect(await first).toMatchObject({ message: 'CDP request timed out: Runtime.evaluate' })
    expect(session.isClosed()).toBe(false)
    const secondMessage = once(peer, 'message')
    const second = session.send('Runtime.evaluate', { expression: 'second', awaitPromise: true }, 3500)
    const [secondData] = await secondMessage
    const secondId = JSON.parse(secondData.toString()).id
    peer.send(JSON.stringify({ id: secondId, result: { result: { value: 'second-ready' } } }))
    expect(await second).toEqual({ result: { value: 'second-ready' } })
    expect(methods).toEqual(['Runtime.evaluate', 'Runtime.evaluate'])
    // Consume the late response before asserting it cannot replace the second
    // observation. An event sent afterward is a transport processing barrier.
    const processed = new Promise<void>(resolve => session.onEvent('Runtime.fixtureBarrier', () => resolve()))
    peer.send(JSON.stringify({ id: firstId, result: { result: { value: 'late-first' } } }))
    peer.send(JSON.stringify({ method: 'Runtime.fixtureBarrier' }))
    await processed
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toEqual({ result: { value: 'second-ready' } })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
    session.close()
    peer.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
