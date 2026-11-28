import { presentation, type ShortcutPresentation } from '../shortcuts/presentation.js'
import { chmod, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { isManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'

const MAX_LINE = 8 * 1024
// A refresh may run five bounded native helper calls (15 s each), followed by
// the 3 s Dock-agent request. Presentation stays off the startup readiness path.
const DOCK_REFRESH_TIMEOUT_MS = 90_000

export interface SupervisorControlServer {
  close(options?: { readonly preserveSocket?: boolean }): Promise<void>
}

/** A mode-0600 Unix-domain control seat; every request carries the instance token. */
export async function startSupervisorControlServer(input: {
  readonly socketPath: string
  readonly token: string
  readonly stop: () => void
  readonly canStop?: () => boolean
  readonly readPresentation?: () => Promise<ShortcutPresentation>
  readonly refreshDock?: (recordPath?: string, signal?: AbortSignal) => Promise<boolean>
  readonly issueManagerLink?: () => Promise<string>
  readonly issueManagerEntry?: () => Promise<string>
}): Promise<SupervisorControlServer> {
  await rm(input.socketPath, { force: true })
  const connections = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket)
    const controller = new AbortController()
    let handled = false
    let timer = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      controller.abort()
      connections.delete(socket)
    })
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
        if (request.command === 'ping') {
          socket.end('{"ok":true}\n')
        } else if (request.command === 'issue-manager-entry' && input.issueManagerEntry) {
          socket.end(JSON.stringify({ entry: await input.issueManagerEntry() }) + '\n')
        } else if (request.command === 'issue-manager-link' && input.issueManagerLink) {
          socket.end(JSON.stringify({ url: await input.issueManagerLink() }) + '\n')
        } else if (request.command === 'read-shortcut-presentation' && input.readPresentation) {
          socket.end(JSON.stringify(presentation(await input.readPresentation())) + '\n')
        } else if (request.command === 'refresh-dock' && input.refreshDock) {
          if (request.recordPath !== undefined && typeof request.recordPath !== 'string') {
            throw new Error('Invalid Dock record')
          }
          clearTimeout(timer)
          timer = setTimeout(() => socket.destroy(), DOCK_REFRESH_TIMEOUT_MS)
          socket.end(JSON.stringify({ ok: await input.refreshDock(request.recordPath, controller.signal) }) + '\n')
        } else if (request.command === 'stop') {
          if (input.canStop?.() === false) socket.end('{"ok":false}\n')
          else socket.end('{"ok":true}\n', input.stop)
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
  try {
    await chmod(input.socketPath, 0o600)
  } catch (error) {
    // A failed publication must not leave the listener keeping its owner alive.
    for (const socket of connections) socket.destroy()
    try {
      await new Promise<void>((resolve, reject) => server.close(failure => failure ? reject(failure) : resolve()))
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Supervisor control publication and cleanup failed')
    }
    throw error
  }
  return {
    async close(options): Promise<void> {
      // Presentation must never hold supervisor shutdown behind its deadline.
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => error === undefined ? resolve() : reject(error))
      )
      if (!options?.preserveSocket) await rm(input.socketPath, { force: true })
    },
  }
}

export async function requestManagerEntry(socketPath: string, token: string): Promise<string | undefined> {
  return await new Promise(resolve => {
    const socket = connect(socketPath)
    let response = ''
    socket.setTimeout(4_000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      response += chunk
      if (response.length > MAX_LINE) socket.destroy()
    })
    socket.once('close', () => {
      try {
        const value = JSON.parse(response) as { entry?: unknown }
        resolve(typeof value.entry === 'string' ? value.entry : undefined)
      } catch {
        resolve(undefined)
      }
    })
    socket.once('connect', () => socket.end(JSON.stringify({ token, command: 'issue-manager-entry' }) + '\n'))
  })
}

/** Only the profile-scoped private control socket may mint an ephemeral browser link. */
export async function requestManagerLink(
  socketPath: string,
  token: string,
  expectedOrigin?: string,
): Promise<string | undefined> {
  return await new Promise(resolve => {
    const socket = connect(socketPath)
    let response = ''
    socket.setTimeout(4_000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', chunk => {
      response += chunk
      if (response.length > MAX_LINE) socket.destroy()
    })
    socket.once('close', () => {
      try {
        const value = JSON.parse(response) as { url?: unknown }
        if (typeof value.url !== 'string') return resolve(undefined)
        const url = new URL(value.url)
        const expected = expectedOrigin === undefined
          ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
          : isManagerBrowserOrigin(expectedOrigin) && url.origin === expectedOrigin
        resolve(
          expected && url.href === value.url && url.pathname === '/' && url.search === ''
            && !url.username && !url.password && /^#[a-f0-9]{64}$/u.test(url.hash)
            ? value.url
            : undefined,
        )
      } catch {
        resolve(undefined)
      }
    })
    socket.once('connect', () => socket.end(JSON.stringify({ token, command: 'issue-manager-link' }) + '\n'))
  })
}

export async function requestDockRefresh(socketPath: string, token: string, recordPath?: string): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect(socketPath)
    let response = ''
    const timer = setTimeout(() => socket.destroy(), DOCK_REFRESH_TIMEOUT_MS)
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
  return await requestSupervisorBoolean(socketPath, token, 'stop')
}

export async function requestSupervisorPing(socketPath: string, token: string): Promise<boolean> {
  return await requestSupervisorBoolean(socketPath, token, 'ping')
}

async function requestSupervisorBoolean(socketPath: string, token: string, command: 'stop' | 'ping'): Promise<boolean> {
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
    socket.once('connect', () => socket.end(`${JSON.stringify({ token, command })}\n`))
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
