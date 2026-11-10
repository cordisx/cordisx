import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { CdpSession, CdpTargetClosedError, removeCdpFutureScript } from '../packages/cli/src/launcher/cdp-session.js'

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
  it.each(['owned-target', 'other-target'])('opens cleanup only for the original target (%s)', async targetId => {
    const { server, url } = await fixtureServer()
    const requests: string[] = []
    let connections = 0
    server.on('connection', socket => {
      const first = ++connections === 1
      socket.on('message', data => {
        const request = JSON.parse(String(data)) as { id: number; method: string }
        requests.push(request.method)
        if (first) socket.close()
        else {socket.send(JSON.stringify({
            id: request.id,
            result: request.method === 'Target.getTargetInfo' ? { targetInfo: { targetId } } : { cleaned: true },
          }))}
      })
    })
    const session = await CdpSession.connect(url)
    let cleanup: CdpSession | undefined
    try {
      await expect(session.send('Runtime.interrupted')).rejects.toThrow('CDP connection closed')
      if (targetId === 'owned-target') {
        cleanup = await session.reconnectForCleanup('owned-target')
        await expect(cleanup.send('Runtime.cleanup')).resolves.toEqual({ cleaned: true })
        await expect(session.send('Runtime.oldChannel')).rejects.toThrow('CDP connection is closed')
        expect(requests).toEqual(['Runtime.interrupted', 'Target.getTargetInfo', 'Runtime.cleanup'])
      } else {
        await expect(session.reconnectForCleanup('owned-target')).rejects.toThrow('target identity changed')
        expect(requests).toEqual(['Runtime.interrupted', 'Target.getTargetInfo'])
      }
    } finally {
      cleanup?.close()
      session.close()
      server.close()
      await once(server, 'close')
    }
  })

  it('accepts only already-removed scripts from a disconnected original session', async () => {
    const original = { isClosed: () => true } as CdpSession
    const send = vi.fn().mockRejectedValue(new Error('CDP -32000: Script not found'))
    const replacement = { send, isClosed: () => false } as unknown as CdpSession
    await expect(removeCdpFutureScript(replacement, 'old-script', original)).resolves.toBeUndefined()
    await expect(removeCdpFutureScript(replacement, 'old-script')).rejects.toThrow('Script not found')
    send.mockRejectedValue(new Error('CDP connection is closed'))
    await expect(removeCdpFutureScript(replacement, 'old-script', original)).rejects.toThrow('connection is closed')
  })

  it.each(['result', 'protocol-error'])(
    'keeps a slow operation on its connection when a probe gets a %s',
    async reply => {
      const { server, url } = await fixtureServer()
      const methods: string[] = []
      server.on('connection', socket =>
        socket.on('message', data => {
          const request = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
          methods.push(request.method)
          if (request.params.expression !== 'true') return
          socket.send(JSON.stringify(
            reply === 'result'
              ? { id: request.id, result: { result: { value: true } } }
              : { id: request.id, error: { code: -32000, message: 'Execution context changed' } },
          ))
        }))
      const session = await CdpSession.connect(url)
      const closed = vi.fn()
      session.onClose(closed)
      try {
        expect(await session.isResponsive()).toBe(true)
        expect(methods).toEqual([])
        await expect(session.send('Runtime.evaluate', { expression: 'slow' }, 25)).rejects.toThrow('timed out')
        expect(await session.isResponsive()).toBe(true)
        expect(session.isClosed()).toBe(false)
        expect(closed).not.toHaveBeenCalled()
        expect(methods).toEqual(['Runtime.evaluate', 'Runtime.evaluate'])
      } finally {
        session.close()
        server.close()
        await once(server, 'close')
      }
    },
  )
})
