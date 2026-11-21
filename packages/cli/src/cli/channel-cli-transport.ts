import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'

interface Binding {
  readonly contract: 'cordisx.channel-cli-binding/v1'
  readonly socket: string
  readonly token: string
  readonly expiresAt: number
}

export interface ChannelCliRequest {
  readonly token?: unknown
  readonly action?: unknown
  readonly operationId?: unknown
  readonly text?: unknown
  readonly media?: unknown
}

export interface ChannelCliTransport {
  readonly server: Server
  readonly bindingPath: string
  close(): Promise<void>
}

/** The socket and descriptor are scoped to a private directory and a short lifetime. */
export async function openChannelCliTransport(
  directory: string,
  expiresAt: number,
  receive: (request: ChannelCliRequest, socket: Socket) => void,
): Promise<ChannelCliTransport> {
  const socketPath = path.join(directory, 'rpc.sock')
  const bindingPath = path.join(directory, 'binding.json')
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5_000, () => socket.destroy())
    socket.on('error', () => undefined)
    socket.on('data', chunk => {
      input += chunk
      if (Buffer.byteLength(input) > 65_536) return socket.destroy()
      const end = input.indexOf('\n')
      if (end < 0) return
      socket.removeAllListeners('data')
      socket.setTimeout(0)
      try {
        const request = JSON.parse(input.slice(0, end)) as ChannelCliRequest
        const presented = typeof request.token === 'string' ? Buffer.from(request.token) : Buffer.alloc(0)
        const expected = Buffer.from(token)
        if (Date.now() >= expiresAt || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          throw new Error('binding unavailable')
        }
        receive(request, socket)
      } catch {
        socket.end('{"event":"error","code":"request-rejected"}\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const binding: Binding = { contract: 'cordisx.channel-cli-binding/v1', socket: socketPath, token, expiresAt }
  try {
    await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    server.close()
    throw error
  }
  return {
    server,
    bindingPath,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export async function callChannelCli(
  bindingPath: string,
  request: Omit<ChannelCliRequest, 'token'>,
  onLine: (line: string) => void,
  timeoutMs: number,
): Promise<void> {
  if (!path.isAbsolute(bindingPath)) throw new Error('binding path must be absolute')
  const [directory, metadata] = await Promise.all([lstat(path.dirname(bindingPath)), lstat(bindingPath)])
  if (
    !directory.isDirectory() || (directory.mode & 0o077) !== 0 || !metadata.isFile()
    || (metadata.mode & 0o077) !== 0 || metadata.size > 4096
    || (process.getuid !== undefined && (directory.uid !== process.getuid() || metadata.uid !== process.getuid()))
  ) {
    throw new Error('binding permissions invalid')
  }
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Binding
  if (
    binding.contract !== 'cordisx.channel-cli-binding/v1'
    || binding.socket !== path.join(path.dirname(bindingPath), 'rpc.sock')
    || !/^[a-f0-9]{64}$/u.test(binding.token) || !Number.isFinite(binding.expiresAt) || binding.expiresAt <= Date.now()
  ) {
    throw new Error('binding unavailable')
  }
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(binding.socket)
    let source = ''
    let terminal = false
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('channel request timed out; outcome may be unknown')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, token: binding.token })}\n`))
    socket.on('data', chunk => {
      source += chunk
      if (source.length > 1_048_576) return socket.destroy(new Error('channel response too large'))
      for (;;) {
        const end = source.indexOf('\n')
        if (end < 0) break
        const line = source.slice(0, end)
        source = source.slice(end + 1)
        try {
          const value = JSON.parse(line) as { event?: string }
          onLine(line)
          if (value.event === 'error') {
            terminal = true
            socket.destroy(new Error('channel request rejected'))
          } else if (value.event !== 'listening') terminal = true
        } catch {
          socket.destroy(new Error('invalid channel response'))
        }
      }
    })
    socket.on(
      'end',
      () => terminal ? resolve() : reject(new Error('channel connection closed; outcome may be unknown')),
    )
    socket.on('error', reject)
  })
}
