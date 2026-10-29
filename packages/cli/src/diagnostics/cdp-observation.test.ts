import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { CdpSession } from '../launcher/cdp-session.js'
import { diagnosticError, type DiagnosticEvent, withDiagnostics } from './context.js'

it('records HTTP rejection of the existing CDP handshake without collecting headers or response text', async () => {
  const events: DiagnosticEvent[] = []
  const server = createServer((_request, response) =>
    response.writeHead(500, { 'set-cookie': 'PRIVATE_COOKIE' }).end('PRIVATE_RESPONSE')
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    await expect(
      withDiagnostics(
        { emit: event => events.push(event) },
        () => CdpSession.connect(`ws://127.0.0.1:${address.port}/`),
      ),
    ).rejects.toThrow('Unexpected server response: 500')
    expect(events).toContainEqual({ event: 'cdp-handshake-failed', phase: 'connect', statusCode: 500 })
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
it('retains the launch sink when a CDP session closes with an in-flight request', async () => {
  const events: DiagnosticEvent[] = []
  const server = createServer(), sockets = new WebSocketServer({ server })
  sockets.on('connection', socket => socket.once('message', () => socket.close()))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    const session = await withDiagnostics(
      { emit: event => events.push(event) },
      () => CdpSession.connect(`ws://127.0.0.1:${address.port}/`),
    )
    await expect(session.send('Runtime.evaluate', { expression: 'PRIVATE_EXPRESSION' })).rejects.toThrow(
      'CDP connection closed',
    )
    expect(events).toContainEqual(expect.objectContaining({ event: 'cdp-connection-closed', count: 1 }))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
    session.close()
  } finally {
    await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())))
  }
})
it('classifies bounded nested protocol failures without persisting arbitrary error text or throwing from a diagnostic', () => {
  expect(diagnosticError(new AggregateError([new Error('CDP connection closed')], 'PRIVATE_CONTEXT'))).toEqual({
    errorCode: 'CDP_CLOSED',
    errorClass: 'local-cdp',
  })
  expect(diagnosticError(new Error('Unexpected server response: 500'))).toEqual({
    errorCode: 'HTTP_RESPONSE',
    errorClass: 'http-response',
    statusCode: 500,
  })
  const hostile = new Error('PRIVATE_ERROR')
  Object.defineProperty(hostile, 'cause', {
    get() {
      throw new Error('PRIVATE_GETTER')
    },
  })
  expect(diagnosticError(hostile)).toEqual({ errorCode: 'unknown', errorClass: 'unknown' })
})
