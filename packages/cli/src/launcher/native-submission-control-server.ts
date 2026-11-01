import { bindDiagnostic, diagnosticError } from '../diagnostics/context.js'
import { projectDiagnostic } from '../diagnostics/journal.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NativeExistingThreadSwitch, NativeSubmissionController } from './native-submission-controller.js'
import { NativeAgentModelSelectionRejected } from './native-agent-models.js'
import type { NativeAgentTaskRouting } from './native-agent-task-routing.js'

// Requests stay small; authenticated native responses may contain history.
const MAX_LINE = 256 * 1024
// Match the intermediary native-history envelope; command budgets stay small.
const MAX_RESPONSE_LINE = 64 * 1024 * 1024
const TIMEOUT = 30_000
const valid = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const requestId = (value: unknown): value is string | number =>
  (typeof value === 'string' && valid(value)) || (typeof value === 'number' && Number.isSafeInteger(value))
const processId = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
function rejectionReason(error: unknown): string {
  const reasons: Readonly<Record<string, string>> = {
    'Invalid control id': 'invalid-id',
    'Unauthenticated response': 'unauthenticated-response',
    'Unknown control response': 'unknown-response',
    'Unauthenticated diagnostic': 'unauthenticated-diagnostic',
    'Invalid control authentication': 'invalid-authentication',
    'Control unavailable': 'control-unavailable',
    'Invalid native thread': 'invalid-thread',
    'Invalid native request id': 'invalid-request-id',
  }
  return error instanceof Error ? reasons[error.message] ?? 'protocol-validation' : 'protocol-validation'
}

export type NativeBridgeMethod =
  | 'thread/list'
  | 'thread/read'
  | 'thread/start'
  | 'thread/resume'
  | 'thread/name/set'
  | 'turn/start'
  | 'turn/interrupt'

export interface NativeSubmissionControlServer {
  readonly socketPath: string
  readonly nonce: string
  readonly existingThread: NativeExistingThreadSwitch
  switchAgentThread(
    input: Readonly<{
      threadId: string
      providerId: string
      model: string
      configOverrides: Readonly<Record<string, unknown>>
    }>,
  ): Promise<void>
  isThreadIdle(threadId: string): Promise<boolean>
  /** One allowlisted method on the desktop's own app-server; see `native-app-server-protocol.mjs`. */
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
  bindConfiguredProvider(prepare: (providerId?: string) => Promise<Readonly<Record<string, unknown>>>): void
  bindController(controller: NativeSubmissionController): void
  bindTaskRouting(routing: NativeAgentTaskRouting): void
  invokeTask(
    input: { callId: string; sourceThreadId: string; sourceTurnId: string; arguments: Record<string, unknown> },
  ): Promise<unknown>
  close(): Promise<void>
}

/** Private launch-scoped transport. No renderer-supplied scope crosses this boundary. */
export async function startNativeSubmissionControlServer(
  options: { readonly requestTimeoutMs?: number } = {},
): Promise<NativeSubmissionControlServer> {
  const diagnostic = bindDiagnostic()
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'cx-native-'))
  const socketPath = path.join(directory, 'control.sock')
  const nonce = randomBytes(32).toString('hex')
  let peer: Socket | undefined
  let authenticated = false
  let prepareConfigured: ((providerId?: string) => Promise<Readonly<Record<string, unknown>>>) | undefined
  let controller: NativeSubmissionController | undefined
  let taskRouting: NativeAgentTaskRouting | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  // Retire only timed-out IDs; a late response cannot resolve a new request.
  const expiredIds = new Set<string>()
  const rememberExpired = (id: string): void => {
    expiredIds.add(id)
    if (expiredIds.size > 128) expiredIds.delete(expiredIds.values().next().value!)
  }
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
      const timer = setTimeout(() => {
        rememberExpired(id)
        fail(new Error('Native switch timed out'))
      }, options.requestTimeoutMs ?? TIMEOUT)
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
    const peerRef = randomUUID()
    if (closed || peer !== undefined) {
      diagnostic({
        event: 'native-control-peer-rejected',
        requestRef: peerRef,
        reason: closed ? 'disposed' : 'peer-already-connected',
      })
      socket.destroy()
      return
    }
    peer = socket
    diagnostic({ event: 'native-control-peer-connected', requestRef: peerRef })
    let fragments: string[] = []
    let fragmentBytes = 0
    let active = 0
    const activeIds = new Set<string>()
    const authTimer = setTimeout(() => socket.destroy(), TIMEOUT)
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      diagnostic({ event: 'native-control-peer-closed', requestRef: peerRef, verified: authenticated, aborted: closed })
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
        if (!item) {
          if (expiredIds.has(value.id)) return
          throw new Error('Unknown control response')
        }
        pending.delete(value.id)
        clearTimeout(item.timer)
        value.ok ? item.resolve(value.value) : item.reject(new Error('Native switch rejected'))
        return
      }
      if (value.type === 'diagnostic') {
        if (!authenticated) throw new Error('Unauthenticated diagnostic')
        if (typeof value.event === 'string' && /^model-[a-z-]{1,40}$/u.test(value.event)) {
          diagnostic({ ...projectDiagnostic(value as { event: string }), event: value.event, serviceRef: peerRef })
        }
        return
      }
      if (value.type === 'configured-provider') {
        if (!authenticated || active >= 32 || (value.providerId !== undefined && !valid(value.providerId, 128))) {
          throw new Error('Configured provider unavailable')
        }
        active++
        activeIds.add(value.id)
        try {
          const overrides =
            await prepareConfigured?.(typeof value.providerId === 'string' ? value.providerId : undefined) ?? {}
          await write(socket, { id: value.id, ok: true, value: overrides })
        } catch {
          await write(socket, { id: value.id, ok: false })
        } finally {
          active--
          activeIds.delete(value.id)
        }
        return
      }
      if (value.type === 'hello') {
        if (authenticated || value.nonce !== nonce) throw new Error('Invalid control authentication')
        authenticated = true
        diagnostic({
          event: 'native-control-peer-authenticated',
          requestRef: peerRef,
          sourcePid: processId(value.sourcePid),
          parentPid: processId(value.parentPid),
          method: value.method === 'app-server-stdio' ? value.method : 'unknown',
        })
        clearTimeout(authTimer)
        await write(socket, { id: value.id, ok: true, value: { version: 1 } })
        return
      }
      if (value.type === 'resume' || value.type === 'managed-resume' || value.type === 'resume-complete') {
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
              ...(value.type === 'managed-resume' ? { managedOnly: true } : {}),
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
          const request = {
            operationToken: value.token,
            method: value.method as 'thread/start' | 'turn/start',
            requestId: value.requestId,
            ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
          }
          const result = await taskRouting?.consume(request) ?? await controller.consumeMarkedRequest(request)
          await write(socket, { id: value.id, ok: true, value: result })
        } else if (value.type === 'authorize') {
          const result = await taskRouting?.authorize(value.token, value.requestId)
            ?? await controller.authorizeMarkedRequest({
              operationToken: value.token,
              requestId: value.requestId,
            })
          await write(socket, { id: value.id, ok: true, value: result })
        } else if (value.type === 'complete' && typeof value.succeeded === 'boolean') {
          const completion = {
            operationToken: value.token,
            requestId: value.requestId,
            succeeded: value.succeeded,
            ...(typeof value.threadId === 'string' ? { boundThreadId: value.threadId } : {}),
            ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
            ...(typeof value.model === 'string' ? { model: value.model } : {}),
          }
          if (!await taskRouting?.complete(completion)) await controller.completeMarkedRequest(completion)
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
      let start = 0
      for (;;) {
        const newline = chunk.indexOf('\n', start)
        const fragment = chunk.slice(start, newline < 0 ? undefined : newline)
        fragmentBytes += Buffer.byteLength(fragment)
        const frameLimit = authenticated ? MAX_RESPONSE_LINE : MAX_LINE
        if (fragmentBytes > frameLimit) {
          diagnostic({
            event: 'native-control-frame-rejected',
            phase: authenticated ? 'response-frame-limit' : 'request-frame-limit',
            frameBytes: fragmentBytes,
            frameLimitBytes: frameLimit,
            verified: authenticated,
          })
          socket.destroy()
          return
        }
        if (fragment.length > 0) fragments.push(fragment)
        if (newline < 0) return
        const line = fragments.join('')
        const lineBytes = fragmentBytes
        fragments = []
        fragmentBytes = 0
        start = newline + 1
        try {
          const value = record(JSON.parse(line))
          if (!value) throw new Error('Invalid control envelope')
          // The larger frame budget is only for an authenticated response to
          // an outstanding request. Commands and diagnostics retain 256 KiB.
          if (
            lineBytes > MAX_LINE
            && (!authenticated || typeof value.ok !== 'boolean' || !valid(value.id, 256)
              || (!pending.has(value.id) && !expiredIds.has(value.id)))
          ) {
            throw new Error('Invalid oversized control envelope')
          }
          void handle(value).catch(error => {
            diagnostic({
              event: 'native-control-message-rejected',
              requestRef: peerRef,
              reason: rejectionReason(error),
              phase: typeof value.type === 'string'
                  && ['hello', 'diagnostic', 'resume', 'resume-complete', 'consume', 'authorize', 'complete'].includes(
                    value.type,
                  )
                ? value.type
                : 'unknown',
              verified: authenticated,
              ready: controller !== undefined,
              ...diagnosticError(error),
            })
            socket.destroy()
          })
        } catch {
          socket.destroy()
          return
        }
      }
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
    bindTaskRouting(value: NativeAgentTaskRouting) {
      if (taskRouting) throw new Error('Native task routing already bound')
      taskRouting = value
    },
    async invokeTask(
      input: { callId: string; sourceThreadId: string; sourceTurnId: string; arguments: Record<string, unknown> },
    ) {
      return await callPeer({ type: 'task-create', ...input })
    },
    async switchAgentThread(
      input: Readonly<{
        threadId: string
        providerId: string
        model: string
        configOverrides: Readonly<Record<string, unknown>>
      }>,
    ) {
      const result = await callPeer({
        type: 'switch',
        requireIdle: true,
        threadId: input.threadId,
        providerId: input.providerId,
        model: input.model,
        config: input.configOverrides,
      })
      if (record(result)?.status === 'rejected') {
        throw new NativeAgentModelSelectionRejected('The target thread is not idle')
      }
    },
    async isThreadIdle(threadId: string) {
      return await callPeer({ type: 'idle', threadId }) === true
    },
    async nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) {
      return await callPeer({ type: 'native-request', method, params })
    },
    bindConfiguredProvider(value: (providerId?: string) => Promise<Readonly<Record<string, unknown>>>) {
      if (prepareConfigured) throw new Error('Configured provider already bound')
      prepareConfigured = value
    },
    bindController(value: NativeSubmissionController) {
      if (controller) throw new Error('Native controller already bound')
      controller = value
    },
    async close() {
      closePromise ??= (async () => {
        closed = true
        failPending()
        expiredIds.clear()
        peer?.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      })()
      await closePromise
    },
  })
}
