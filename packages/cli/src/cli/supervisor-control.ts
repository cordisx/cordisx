import { presentation, type ShortcutPresentation } from '../shortcuts/presentation.js'
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
  readonly readPresentation?: () => Promise<ShortcutPresentation>
  readonly refreshDock?: (recordPath?: string) => Promise<boolean>
}): Promise<SupervisorControlServer> {
  await rm(input.socketPath, { force: true })
  const server = createServer({ allowHalfOpen: true }, socket => {
    let handled = false
    const timer = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => {})
    socket.on('close', () => clearTimeout(timer))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', async chunk => {
      if (handled) return
      buffer += chunk
      if (buffer.length > MAX_LINE) return socket.destroy()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      handled = true
      const line = buffer.slice(0, newline)
      buffer = ''
      try {
        const request = JSON.parse(line) as {
          readonly token?: unknown
          readonly command?: unknown
          readonly recordPath?: unknown
        }
        const fields = request.command === 'refresh-dock' ? ['token', 'command', 'recordPath'] : ['token', 'command']
        if (request.token !== input.token || Object.keys(request).some(key => !fields.includes(key))) {
          throw new Error('unauthorized control request')
        }
        if (request.command === 'read-shortcut-presentation' && input.readPresentation) {
          socket.end(JSON.stringify(presentation(await input.readPresentation())) + '\n')
        } else if (request.command === 'refresh-dock' && input.refreshDock) {
          if (request.recordPath !== undefined && typeof request.recordPath !== 'string') {
            throw new Error('Invalid Dock record')
          }
          socket.end(JSON.stringify({ ok: await input.refreshDock(request.recordPath) }) + '\n')
        } else if (request.command === 'stop') {
          socket.end('{"ok":true}\n')
          input.stop()
        } else throw new Error('unknown control request')
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

export async function requestDockRefresh(socketPath: string, token: string, recordPath?: string): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect(socketPath)
    let response = ''
    const timer = setTimeout(() => socket.destroy(), 5_000)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      response += chunk
      if (response.length > 128) socket.destroy()
    })
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(response === '{"ok":true}\n')
    })
    socket.once('connect', () => socket.end(JSON.stringify({ token, command: 'refresh-dock', recordPath }) + '\n'))
  })
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

/** Bounded response separate from the 8 KiB request budget. No token or image logging. */
export async function requestShortcutPresentation(socketPath: string, token: string): Promise<ShortcutPresentation> {
  return await new Promise(resolve => {
    const socket = connect(socketPath)
    let response = ''
    const timer = setTimeout(() => socket.destroy(), 4000)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      response += chunk
      if (Buffer.byteLength(response) > 96 * 1024) {
        response = ''
        socket.destroy()
      }
    })
    socket.once('close', () => {
      clearTimeout(timer)
      try {
        resolve(presentation(JSON.parse(response)))
      } catch {
        resolve({ status: 'unavailable' })
      }
    })
    socket.once('connect', () => socket.end(JSON.stringify({ token, command: 'read-shortcut-presentation' }) + '\n'))
  })
}
