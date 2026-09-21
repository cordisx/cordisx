import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeExistingThreadSwitch, NativeSubmissionController } from './native-submission-controller.js'

const MAX_LINE = 256 * 1024
const TIMEOUT = 30_000
const valid = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const requestId = (value: unknown): value is string | number =>
  (typeof value === 'string' && valid(value)) || (typeof value === 'number' && Number.isSafeInteger(value))

export interface NativeSubmissionControlServer {
  readonly socketPath: string
  readonly nonce: string
  readonly existingThread: NativeExistingThreadSwitch
  isThreadIdle(threadId: string): Promise<boolean>
  bindController(controller: NativeSubmissionController): void
  close(): Promise<void>
}

/** Private launch-scoped transport. No renderer-supplied scope crosses this boundary. */
export async function startNativeSubmissionControlServer(): Promise<NativeSubmissionControlServer> {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'cx-native-'))
  const socketPath = path.join(directory, 'control.sock')
  const nonce = randomBytes(32).toString('hex')
  let peer: Socket | undefined
  let authenticated = false
  let controller: NativeSubmissionController | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  const write = (socket: Socket, value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error('Native intermediary unavailable'))
        return
      }
      socket.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
    })
  const failPending = (): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Native intermediary disconnected'))
    }
    pending.clear()
  }
  const callPeer = async (request: Record<string, unknown>): Promise<unknown> => {
    const socket = peer
    if (closed || !authenticated || socket === undefined || pending.size >= 32) {
      throw new Error('Native intermediary unavailable')
    }
    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error): void => {
        const item = pending.get(id)
        if (!item) return
        pending.delete(id)
        clearTimeout(item.timer)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('Native switch timed out')), TIMEOUT)
      pending.set(id, { resolve, reject, timer })
      void write(socket, { ...request, id }).catch(fail)
    })
  }
  const existingThread: NativeExistingThreadSwitch = {
    async switch(input) {
      await callPeer({
        type: 'switch',
        threadId: input.threadId,
        providerId: input.providerId,
        model: input.model,
        config: input.configOverrides,
      })
    },
  }
  const server = createServer(socket => {
    if (closed || peer !== undefined) {
      socket.destroy()
      return
    }
    peer = socket
    let buffer = ''
    let active = 0
    const activeIds = new Set<string>()
    const authTimer = setTimeout(() => socket.destroy(), TIMEOUT)
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(authTimer)
      if (peer === socket) {
        peer = undefined
        authenticated = false
        failPending()
      }
    })
    const handle = async (value: Record<string, unknown>): Promise<void> => {
      if (!valid(value.id, 256) || activeIds.has(value.id)) throw new Error('Invalid control id')
      if (typeof value.ok === 'boolean') {
        if (!authenticated) throw new Error('Unauthenticated response')
        const item = pending.get(value.id)
        if (!item) throw new Error('Unknown control response')
        pending.delete(value.id)
        clearTimeout(item.timer)
        value.ok ? item.resolve(value.value) : item.reject(new Error('Native switch rejected'))
        return
      }
      if (value.type === 'hello') {
        if (authenticated || value.nonce !== nonce) throw new Error('Invalid control authentication')
        authenticated = true
        clearTimeout(authTimer)
        await write(socket, { id: value.id, ok: true, value: { version: 1 } })
        return
      }
      if (value.type === 'resume' || value.type === 'resume-complete') {
        // Thread resumes carry no Send token: the intermediary reports only what the app-server persisted.
        if (!authenticated || !controller || active >= 32 || !valid(value.threadId)) {
          throw new Error('Control unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          if (value.type === 'resume-complete') {
            if (
              !valid(value.resumeToken, 256) || value.resumeToken.length < 16 || typeof value.succeeded !== 'boolean'
            ) {
              throw new Error('Invalid native thread resume completion')
            }
            const result = await controller.completeThreadResume({
              threadId: value.threadId,
              resumeToken: value.resumeToken,
              succeeded: value.succeeded,
            })
            await write(socket, { id: value.id, ok: true, value: result })
          } else if (valid(value.providerId, 128) && valid(value.model)) {
            const result = await controller.prepareThreadResume({
              threadId: value.threadId,
              providerId: value.providerId,
              model: value.model,
            })
            await write(socket, { id: value.id, ok: true, value: result })
          } else throw new Error('Invalid native thread resume')
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (!authenticated || !controller || active >= 32 || !valid(value.token, 256) || value.token.length < 16) {
        throw new Error('Control unavailable')
      }
      if (value.threadId !== undefined && !valid(value.threadId)) throw new Error('Invalid native thread')
      if (!requestId(value.requestId)) throw new Error('Invalid native request id')
      active++
      activeIds.add(value.id)
      try {
        if (value.type === 'consume') {
          if (value.method !== 'thread/start' && value.method !== 'turn/start') throw new Error('Invalid native method')
          const result = await controller.consumeMarkedRequest({
            operationToken: value.token,
            method: value.method,
            requestId: value.requestId,
            ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
          })
          await write(socket, { id: value.id, ok: true, value: result })
        } else if (value.type === 'authorize') {
          const result = await controller.authorizeMarkedRequest({
            operationToken: value.token,
            requestId: value.requestId,
          })
          await write(socket, { id: value.id, ok: true, value: result })
        } else if (value.type === 'complete' && typeof value.succeeded === 'boolean') {
          await controller.completeMarkedRequest({
            operationToken: value.token,
            requestId: value.requestId,
            succeeded: value.succeeded,
            ...(typeof value.threadId === 'string' ? { boundThreadId: value.threadId } : {}),
          })
          await write(socket, { id: value.id, ok: true })
        } else throw new Error('Unknown control command')
      } catch {
        await write(socket, { id: value.id, ok: false })
      } finally {
        active--
        activeIds.delete(value.id)
      }
    }
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > MAX_LINE) {
          socket.destroy()
          return
        }
        try {
          const value = record(JSON.parse(line))
          if (!value) throw new Error('Invalid control envelope')
          void handle(value).catch(() => socket.destroy())
        } catch {
          socket.destroy()
          return
        }
      }
      if (Buffer.byteLength(buffer) > MAX_LINE) socket.destroy()
    })
  })
  try {
    await chmod(directory, 0o700)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return Object.freeze({
    socketPath,
    nonce,
    existingThread,
    async isThreadIdle(threadId: string) {
      return await callPeer({ type: 'idle', threadId }) === true
    },
    bindController(value: NativeSubmissionController) {
      if (controller) throw new Error('Native controller already bound')
      controller = value
    },
    async close() {
      closePromise ??= (async () => {
        closed = true
        failPending()
        peer?.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      })()
      await closePromise
    },
  })
}
