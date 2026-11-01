import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startNativeSubmissionControlServer } from '../packages/cli/src/launcher/native-submission-control-server.js'

/** An authenticated intermediary stand-in; no native App or process is launched. */
async function peer() {
  const server = await startNativeSubmissionControlServer()
  const socket = createConnection(server.socketPath)
  socket.on('error', () => undefined)
  let buffer = ''
  const messages: Array<Record<string, unknown>> = []
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      messages.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  await once(socket, 'connect')
  socket.write(JSON.stringify({ id: 'hello', type: 'hello', nonce: server.nonce }) + '\n')
  while (!messages.find(value => value.id === 'hello')) await new Promise(resolve => setTimeout(resolve, 1))
  const next = async () => {
    for (;;) {
      const index = messages.findIndex(value => value.type === 'native-request')
      if (index >= 0) return messages.splice(index, 1)[0]!
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }
  return { server, socket, next }
}

async function fragments(socket: Socket, frame: string) {
  // Small chunks exercise linear fragment accumulation instead of repeated whole-buffer copies.
  for (let offset = 0; offset < frame.length; offset += 8192) {
    if (!socket.write(frame.slice(offset, offset + 8192))) await once(socket, 'drain')
  }
}

describe('native control response budgets', () => {
  it('accepts multi-megabyte history and remains usable for subsequent requests', async () => {
    const f = await peer()
    try {
      const waiting = f.server.nativeRequest('thread/read', { threadId: 'history', includeTurns: true })
      const request = await f.next()
      const history = 'x'.repeat(2 * 1024 * 1024)
      await fragments(
        f.socket,
        JSON.stringify({ id: request.id, ok: true, value: { thread: { turns: [{ items: [{ text: history }] }] } } })
          + '\n',
      )
      const result = await waiting as { thread: { turns: Array<{ items: Array<{ text: string }> }> } }
      expect(result.thread.turns[0]?.items[0]?.text.length).toBe(history.length)
      const second = f.server.nativeRequest('thread/list', { limit: 1 })
      const request2 = await f.next()
      f.socket.write(JSON.stringify({ id: request2.id, ok: true, value: { data: [] } }) + '\n')
      expect(await second).toEqual({ data: [] })
    } finally {
      f.socket.destroy()
      await f.server.close()
    }
  })

  it('retains the small limit for commands even after authentication', async () => {
    const f = await peer()
    try {
      const closed = once(f.socket, 'close')
      f.socket.write(
        JSON.stringify({ id: 'command', type: 'diagnostic', event: 'model-test', content: 'x'.repeat(300 * 1024) })
          + '\n',
      )
      await closed
      expect(f.socket.destroyed).toBe(true)
    } finally {
      f.socket.destroy()
      await f.server.close()
    }
  })

  it('rejects a response above 8 MiB and settles the outstanding request', async () => {
    const f = await peer()
    try {
      const waiting = f.server.nativeRequest('thread/read', { threadId: 'huge', includeTurns: true })
      const rejected = expect(waiting).rejects.toThrow('disconnected')
      const request = await f.next()
      f.socket.write(JSON.stringify({ id: request.id, ok: true, value: 'x'.repeat(8 * 1024 * 1024) }) + '\n')
      await rejected
    } finally {
      f.socket.destroy()
      await f.server.close()
    }
  })
})
