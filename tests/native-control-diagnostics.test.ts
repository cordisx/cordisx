import { createConnection } from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { startNativeSubmissionControlServer } from '../packages/cli/src/launcher/native-submission-control-server.js'

it.each([
  [
    { id: 'PRIVATE_ID', type: 'diagnostic', event: 'model-private', input: 'PRIVATE_CONTENT' },
    'unauthenticated-diagnostic',
    'diagnostic',
  ],
  [{ id: 'PRIVATE_ID', type: 'hello', nonce: 'PRIVATE_NONCE' }, 'invalid-authentication', 'hello'],
  [{ type: 'PRIVATE_TYPE', input: 'PRIVATE_CONTENT' }, 'invalid-id', 'unknown'],
  [{ id: 'PRIVATE_ID', type: { toString: 'PRIVATE_CONTENT' } }, 'control-unavailable', 'unknown'],
])('retains only a fixed control rejection category', async (message, reason, phase) => {
  const events: DiagnosticEvent[] = []
  const server = await withDiagnostics(
    { emit: event => events.push(event) },
    () => startNativeSubmissionControlServer(),
  )
  const socket = createConnection(server.socketPath)
  socket.on('error', () => undefined)
  try {
    await once(socket, 'connect')
    const closed = once(socket, 'close')
    socket.write(`${JSON.stringify(message)}\n`)
    await closed
    expect(events).toContainEqual(expect.objectContaining({ event: 'native-control-message-rejected', reason, phase }))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  } finally {
    socket.destroy()
    await server.close()
  }
})
