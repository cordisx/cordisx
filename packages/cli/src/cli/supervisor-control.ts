import { chmod, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'

const MAX_LINE = 8 * 1024

export interface SupervisorControlServer {
  close(): Promise<void>
}

/** A mode-0600 Unix-domain control seat; every request carries the instance token. */
export async function startSupervisorControlServer(input: {
  readonly socketPath: string
  readonly token: string
  readonly stop: () => void
}): Promise<SupervisorControlServer> {
  await rm(input.socketPath, { force: true })
  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > MAX_LINE) return socket.destroy()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = ''
      try {
        const request = JSON.parse(line) as { readonly token?: unknown; readonly command?: unknown }
        if (request.token !== input.token || request.command !== 'stop') throw new Error('unauthorized control request')
        socket.end('{"ok":true}\n')
        input.stop()
      } catch {
        socket.end('{"ok":false}\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(input.socketPath, () => resolve())
  })
  await chmod(input.socketPath, 0o600)
  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close(error => error === undefined ? resolve() : reject(error))
      )
      await rm(input.socketPath, { force: true })
    },
  }
}

export async function requestSupervisorStop(socketPath: string, token: string): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket: Socket = connect(socketPath)
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3_000, () => socket.destroy())
    socket.once('error', () => resolve(false))
    socket.on('data', chunk => {
      response += chunk
    })
    socket.once('close', () => resolve(response === '{"ok":true}\n'))
    socket.once('connect', () => socket.end(`${JSON.stringify({ token, command: 'stop' })}\n`))
  })
}
