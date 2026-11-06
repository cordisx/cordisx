import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { CdpSession, CdpTargetClosedError } from '../packages/cli/src/launcher/cdp-session.js'

async function fixtureServer(): Promise<{
  readonly server: WebSocketServer
  readonly url: string
}> {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string') throw new Error('fixture websocket did not bind a TCP port')
  return { server, url: `ws://127.0.0.1:${address.port}` }
}

describe('CdpSession transport authority', () => {
  it('keeps one monotonic request sequence and resolves out-of-order responses to their exact pending call', async () => {
    const { server, url } = await fixtureServer()
    const requests: Array<{ id: number; method: string }> = []
    server.on('connection', socket => {
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string }
        requests.push(request)
        if (requests.length !== 2) return
        socket.send(JSON.stringify({ id: requests[1]!.id, result: { owner: requests[1]!.method } }))
        socket.send(JSON.stringify({ id: requests[0]!.id, result: { owner: requests[0]!.method } }))
      })
    })
    const session = await CdpSession.connect(url)
    try {
      const first = session.send('Runtime.first')
      const second = session.send('Runtime.second')
      await expect(Promise.all([first, second])).resolves.toEqual([
        { owner: 'Runtime.first' },
        { owner: 'Runtime.second' },
      ])
      expect(requests).toMatchObject([
        { id: 1, method: 'Runtime.first' },
        { id: 2, method: 'Runtime.second' },
      ])
    } finally {
      session.close()
      server.close()
      await once(server, 'close')
    }
  })

  it('owns event listeners per method and removes the final listener without disturbing pending responses', async () => {
    const { server, url } = await fixtureServer()
    server.on('connection', socket => {
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number }
        socket.send(JSON.stringify({ method: 'Runtime.bindingCalled', params: { revision: 1 } }))
        socket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
        setTimeout(() => {
          socket.send(JSON.stringify({ method: 'Runtime.bindingCalled', params: { revision: 2 } }))
        }, 5)
      })
    })
    const session = await CdpSession.connect(url)
    const listener = vi.fn()
    const remove = session.onEvent('Runtime.bindingCalled', listener)
    try {
      await expect(session.send('Runtime.evaluate')).resolves.toEqual({ ok: true })
      remove()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ revision: 1 })
    } finally {
      session.close()
      server.close()
      await once(server, 'close')
    }
  })

  it('uses socket close as the first terminal result for every pending and future request', async () => {
    const { server, url } = await fixtureServer()
    server.on('connection', socket => {
      socket.on('message', () => socket.close())
    })
    const session = await CdpSession.connect(url)
    try {
      await expect(session.send('Runtime.neverCompletes')).rejects.toThrow('CDP connection closed')
      await expect(session.send('Runtime.afterClose')).rejects.toThrow('CDP connection is closed')
      expect(session.isClosed()).toBe(true)
      expect(session.isTargetClosed()).toBe(false)
    } finally {
      session.close()
      server.close()
      await once(server, 'close')
    }
  })

  it.each(['target_closed', 'replaced_with_devtools'])(
    'distinguishes explicit target retirement from %s detachment',
    async reason => {
      const { server, url } = await fixtureServer()
      server.on('connection', socket => {
        socket.on('message', () => {
          socket.send(JSON.stringify({ method: 'Inspector.detached', params: { reason } }))
          if (reason !== 'target_closed') socket.close()
        })
      })
      const session = await CdpSession.connect(url)
      const closed = vi.fn()
      session.onClose(closed)
      try {
        const pending = session.send('Runtime.pending')
        if (reason === 'target_closed') {
          await expect(pending).rejects.toBeInstanceOf(CdpTargetClosedError)
          await expect(session.send('Runtime.retired')).rejects.toBeInstanceOf(CdpTargetClosedError)
          expect(session.isTargetClosed()).toBe(true)
        } else {
          await expect(pending).rejects.toThrow('CDP connection closed')
          expect(session.isTargetClosed()).toBe(false)
        }
        expect(closed).toHaveBeenCalledOnce()
      } finally {
        session.close()
        server.close()
        await once(server, 'close')
      }
    },
  )
})
