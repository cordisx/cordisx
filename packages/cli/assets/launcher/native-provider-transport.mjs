import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { readNativeLines } from './native-json-lines.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const provider = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined
const key = id => JSON.stringify([typeof id, id])
const MAX_WORKERS = 128

/** Multiplex native connections after the Host has admitted the original request.
 * Credentials and endpoints remain in that request's config, never argv or disk.
 * The inert process default satisfies native provider identity checks and cannot
 * silently send a request when a per-thread override has been lost.
 */
export function createNativeProviderTransport(primary, { executable, args, env, initialize, diagnostic } = {}) {
  const stdout = new PassThrough()
  const workers = new Map()
  const owners = new Map()
  const serverRequests = new Map()
  const primaryWrite = primary.stdin.write.bind(primary.stdin)
  const observe = details => {
    try {
      diagnostic?.(details)
    } catch { /* Diagnostics never control provider transport. */ }
  }
  let initializeParams = initialize
  let disposed = false
  const emit = (message, original) => {
    if (!disposed) stdout.write((original ?? JSON.stringify(message)) + '\n')
  }
  const send = (write, message) =>
    new Promise((resolve, reject) => {
      write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve())
    })
  const receive = (connection, message, original) => {
    if (connection !== primary && connection.initializeId === message.id && message.method === undefined) {
      message.error
        ? connection.rejectReady(new Error('Native provider initialization rejected'))
        : connection.resolveReady()
      return
    }
    if (message.method === undefined) {
      const pending = connection.pending?.get(key(message.id))
      if (pending) {
        connection.pending.delete(key(message.id))
        const thread = message.result?.thread
        if (!message.error && thread?.id && ['thread/start', 'thread/resume', 'thread/fork'].includes(pending.method)) {
          owners.set(thread.id, {
            connection,
            status: thread.status,
            model: thread.model,
            providerId: message.result.modelProvider ?? thread.modelProvider,
          })
        }
        if (!message.error && pending.method === 'thread/unsubscribe') owners.delete(pending.threadId)
        if (!message.error && pending.method === 'turn/start' && message.result?.turn?.id) {
          const owner = owners.get(pending.threadId)
          if (owner?.connection === connection) owner.turn = message.result.turn
        }
      }
      if (pending?.method === 'thread/list' && Array.isArray(message.result?.data)) {
        for (const thread of message.result.data) {
          const owner = owners.get(thread.id)
          if (owner?.connection !== primary && owner?.status) {
            thread.status = owner.status
            original = undefined
          }
        }
      }
    } else if (message.id !== undefined && connection !== primary) {
      const id = `cordisx-provider-request-${randomUUID()}`
      serverRequests.set(id, { connection, id: message.id, threadId: message.params?.threadId })
      message = { ...message, id }
      original = undefined
    } else if (connection !== primary) {
      if (message.method === 'serverRequest/resolved') {
        const requestId = message.params?.requestId
        const request = [...serverRequests].find(([, entry]) =>
          entry.connection === connection && key(entry.id) === key(requestId)
        )
        if (!request) return
        serverRequests.delete(request[0])
        message = { ...message, params: { ...message.params, requestId: request[0] } }
        original = undefined
      }
      const threadId = message.params?.threadId ?? message.params?.thread?.id
      // Global account/config notifications still belong to the primary Host.
      if (typeof threadId !== 'string' && message.method !== 'serverRequest/resolved') return
      const owner = owners.get(threadId)
      if (owner?.connection === connection) {
        if (message.method === 'thread/status/changed') owner.status = message.params.status
        if (message.method === 'turn/started') owner.turn = message.params.turn
        if (message.method === 'turn/completed') delete owner.turn
        if (message.method === 'thread/closed') owners.delete(threadId)
      }
    }
    emit(message, original)
  }
  const attach = (stream, connection) => {
    readNativeLines(stream, line => {
      try {
        receive(connection, JSON.parse(line), line)
      } catch {
        if (connection === primary && !disposed) stdout.write(line + '\n')
      }
    }, reason => {
      observe({ phase: reason, childPid: connection.child?.pid })
    })
  }
  primary.pending = new Map()
  attach(primary.stdout, primary)

  const workerFor = async id => {
    let worker = workers.get(id)
    if (!worker) {
      if (workers.size >= MAX_WORKERS) throw new Error('Native provider connection limit reached')
      const insertion = args.indexOf('app-server')
      if (insertion < 0 || !initializeParams) throw new Error('Native provider launch unavailable')
      const overrides = [
        '-c',
        `model_provider=${JSON.stringify(id)}`,
        '-c',
        `model_providers={${
          JSON.stringify(id)
        }={name="CordisX provider transport",base_url="http://127.0.0.1:0/v1",wire_api="responses",requires_openai_auth=false}}`,
      ]
      const child = spawn(executable, [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      worker = {
        child,
        providerId: id,
        pending: new Map(),
        write: child.stdin.write.bind(child.stdin),
        initializeId: `cordisx-provider-initialize-${randomUUID()}`,
      }
      worker.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.rejectReady(new Error('Native provider initialization timed out'))
          child.kill('SIGTERM')
        }, 15000)
        worker.resolveReady = () => {
          clearTimeout(timer)
          resolve()
        }
        worker.rejectReady = error => {
          clearTimeout(timer)
          reject(error)
        }
      })
      workers.set(id, worker)
      attach(child.stdout, worker)
      const failed = details => {
        observe({ childPid: child.pid, provider: id, ...details })
        if (worker.closed) return
        worker.closed = true
        if (workers.get(id) === worker) workers.delete(id)
        worker.rejectReady(new Error('Native provider connection closed'))
        for (const pending of worker.pending.values()) {
          emit({
            id: pending.id,
            error: {
              code: -32000,
              message: 'Native provider connection closed. Check thread history before retrying.',
            },
          })
        }
        worker.pending.clear()
        for (const [threadId, owner] of owners) {
          if (owner.connection !== worker) continue
          if (owner.turn?.id) {
            emit({
              method: 'turn/completed',
              params: {
                threadId,
                turn: {
                  ...owner.turn,
                  status: 'failed',
                  error: { message: 'Native provider connection closed. Check thread history before retrying.' },
                },
              },
            })
          }
          emit({ method: 'thread/status/changed', params: { threadId, status: { type: 'systemError' } } })
          owners.delete(threadId)
        }
        for (const [requestId, request] of serverRequests) {
          if (request.connection !== worker) continue
          emit({ method: 'serverRequest/resolved', params: { requestId, threadId: request.threadId } })
          serverRequests.delete(requestId)
        }
      }
      const errorCode = error =>
        ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ECONNRESET'].includes(error?.code) ? error.code : 'unknown'
      child.once('error', error => failed({ phase: 'provider-spawn-failed', errorCode: errorCode(error) }))
      child.once('exit', (exitCode, signal) => failed({ phase: 'provider-exited', exitCode, signal }))
      child.stdin.on('error', error => failed({ phase: 'provider-input-error', errorCode: errorCode(error) }))
      void send(worker.write, { id: worker.initializeId, method: 'initialize', params: initializeParams })
        .catch(worker.rejectReady)
    }
    await worker.ready
    if (worker.closed || disposed) throw new Error('Native provider connection closed')
    if (!worker.initialized) {
      worker.initialized = true
      await send(worker.write, { method: 'initialized', params: {} })
    }
    return worker
  }

  const route = async (message, original) => {
    if (message.method === 'initialize') initializeParams = message.params
    if (message.method === undefined && serverRequests.has(message.id)) {
      const request = serverRequests.get(message.id)
      serverRequests.delete(message.id)
      return await send(request.connection.write, { ...message, id: request.id })
    }
    if (
      message.method === undefined && typeof message.id === 'string'
      && message.id.startsWith('cordisx-provider-request-')
    ) return
    const params = object(message.params)
    let connection = owners.get(params?.threadId)?.connection ?? primary
    if (initializeParams && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      const config = object(params?.config)
      const tables = config ? Object.keys(config).filter(name => name.startsWith('model_providers.')) : []
      const id = provider(params?.modelProvider) ?? provider(config?.model_provider)
        ?? (tables.length === 1 ? provider(tables[0].slice('model_providers.'.length)) : undefined)
      const table = id && (object(config?.[`model_providers.${id}`]) ?? object(config?.model_providers?.[id]))
      if (id && id !== 'openai' && table?.wire_api === 'responses') connection = await workerFor(id)
      else if (id === 'openai') connection = primary
    }
    if (disposed || connection.closed) throw new Error('Native provider connection closed')
    if (message.id !== undefined && message.method !== undefined) {
      connection.pending.set(key(message.id), { id: message.id, method: message.method, threadId: params?.threadId })
    }
    const write = connection === primary ? primaryWrite : connection.write
    await new Promise((resolve, reject) => write(original + '\n', error => error ? reject(error) : resolve()))
  }
  let fragments = []
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const input = chunk.toString('utf8')
      const frames = []
      let start = 0
      for (;;) {
        const boundary = input.indexOf('\n', start)
        const fragment = input.slice(start, boundary < 0 ? undefined : boundary)
        if (fragment.length > 0) fragments.push(fragment)
        if (boundary < 0) break
        const line = fragments.length === 1 ? fragments[0] : fragments.join('')
        fragments = []
        start = boundary + 1
        try {
          frames.push({ message: JSON.parse(line), original: line })
        } catch {
          primaryWrite(line + '\n')
        }
      }
      void (async () => {
        for (const { message: frame, original } of frames) {
          try {
            await route(frame, original)
          } catch {
            if (frame.id !== undefined) {
              emit({
                id: frame.id,
                error: {
                  code: -32000,
                  message: 'Native provider transport unavailable. Check thread history before retrying.',
                },
              })
            }
          }
        }
      })().then(() => callback(), callback)
    },
    final(callback) {
      primary.stdin.end(callback)
    },
  })
  const close = () => {
    if (disposed) return
    disposed = true
    for (const worker of workers.values()) {
      worker.rejectReady(new Error('Native provider transport disposed'))
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM')
    }
    workers.clear()
    owners.clear()
    serverRequests.clear()
    fragments = []
    stdin.destroy()
    stdout.end()
  }
  primary.once('exit', close)
  return {
    stdin,
    stdout,
    close,
    workers: () => [...workers.values()].map(w => ({ providerId: w.providerId, pid: w.child.pid })),
  }
}
