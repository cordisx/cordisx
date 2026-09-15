#!/usr/bin/env node
import { spawn } from 'node:child_process'
import net from 'node:net'

const socketPath = process.env.CORDISX_NATIVE_CONTROL_SOCKET
const nonce = process.env.CORDISX_NATIVE_CONTROL_NONCE
const executable = process.env.CORDISX_NATIVE_REAL_CODEX_PATH
const marker = 'cordisx.operation_token'
// Native history and plugin catalogs can exceed the small private control-message budget.
const maxNativeLineBytes = 64 * 1024 * 1024
const maxControlLineBytes = 8 * 1024 * 1024
if (!socketPath || !nonce || !executable?.startsWith('/')) throw new Error('Native intermediary is not configured')
for (
  const key of [
    'CODEX_CLI_PATH',
    'CORDISX_NATIVE_CONTROL_SOCKET',
    'CORDISX_NATIVE_CONTROL_NONCE',
    'CORDISX_NATIVE_REAL_CODEX_PATH',
  ]
) delete process.env[key]

const child = spawn(executable, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const control = net.connect(socketPath)
const controlCalls = new Map()
const privateCalls = new Map()
const desktopCalls = new Map()
const firstTurns = new Map()
const privatePrefix = `cordisx-private-${nonce}-`
let sequence = 0
let closed = false
let inputQueue = Promise.resolve()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const validToken = value => typeof value === 'string' && /^[^\0\r\n]{16,256}$/u.test(value)
const write = (stream, value) =>
  new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('Native transport is closed'))
      return
    }
    stream.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`, error =>
      error ? reject(error) : resolve())
  })

function rejectAll(calls) {
  for (const call of calls.values()) {
    clearTimeout(call.timer)
    call.reject(new Error('Native transport closed'))
  }
  calls.clear()
}
function stop(reason = 'transport-closed') {
  if (closed) return
  closed = true
  if (typeof reason === 'string' && reason !== 'transport-closed') {
    process.stderr.write(`[cordisx] Native intermediary stopped: ${reason}\n`)
  }
  rejectAll(controlCalls)
  rejectAll(privateCalls)
  desktopCalls.clear()
  firstTurns.clear()
  control.destroy()
  process.stdin.destroy()
  child.stdin.destroy()
  if (child.exitCode === null) child.kill('SIGTERM')
}
function call(stream, calls, request, timeout = 30_000) {
  if (closed || calls.size >= 32) return Promise.reject(new Error('Native transport unavailable'))
  const id = `${privatePrefix}${++sequence}`
  return new Promise((resolve, reject) => {
    const settle = (error, value) => {
      const current = calls.get(id)
      if (!current) return
      calls.delete(id)
      clearTimeout(current.timer)
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => settle(new Error('Native transport timeout')), timeout)
    calls.set(id, { resolve, reject, timer })
    void write(stream, { ...request, id }).catch(error => settle(error))
  })
}
function controlCall(type, input = {}) {
  return call(control, controlCalls, { type, ...input })
}
function nativeCall(method, params) {
  return call(child.stdin, privateCalls, { method, params })
}
function settle(calls, message, isControl) {
  const pending = calls.get(message.id)
  if (!pending) return false
  calls.delete(message.id)
  clearTimeout(pending.timer)
  const failed = isControl ? message.ok !== true : message.error !== undefined
  failed
    ? pending.reject(new Error('Native request rejected'))
    : pending.resolve(isControl ? message.value : message.result)
  return true
}

// Only framed messages are buffered. Many small lines in one chunk do not count as one large request.
function readLines(stream, receive, maxLineBytes = maxNativeLineBytes) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > maxLineBytes) {
        stop('frame-limit-exceeded')
        return
      }
      if (line.length > 0) receive(line)
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) stop('frame-limit-exceeded')
  })
  stream.once('end', () => {
    if (buffer.trim() !== '') stop('incomplete-frame')
  })
}

let authenticate
const ready = new Promise((resolve, reject) => {
  authenticate = { resolve, reject }
})
// A rejected readiness promise must also be observed when no desktop request is queued.
void ready.catch(() => undefined)
control.once('connect', () => {
  void controlCall('hello', { nonce }).then(authenticate.resolve, error => {
    authenticate.reject(error)
    stop()
  })
})
control.on('error', () => {
  authenticate.reject(new Error('Native control unavailable'))
  stop()
})
control.on('close', stop)
child.on('error', stop)
child.stdin.on('error', stop)
process.stdout.on('error', stop)
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
  stop()
})
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

async function forward(line) {
  if (closed) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    await write(child.stdin, line)
    return
  }
  const params = object(message?.params)
  const config = object(params?.config)
  const managed = config !== undefined && Object.hasOwn(config, marker)
  if (!managed) {
    if (message?.method === 'turn/start' && firstTurns.has(params?.threadId)) {
      await write(process.stdout, {
        id: message.id,
        error: {
          code: -32000,
          message: 'Managed first turn is missing its Send association. Original request was not sent.',
        },
      })
      return
    }
    if (typeof message?.id === 'string' && message.id.startsWith(privatePrefix)) throw new Error('Reserved request id')
    await write(child.stdin, line)
    return
  }
  let admitted = false
  const token = config[marker]
  try {
    if (
      !validToken(token) || !['thread/start', 'turn/start'].includes(message.method)
      || !['string', 'number'].includes(typeof message.id) || desktopCalls.has(message.id)
    ) throw new Error('Invalid managed request')
    const dispatch = await controlCall('consume', {
      token,
      method: message.method,
      requestId: message.id,
      ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
    })
    if (
      dispatch?.kind !== 'dispatch' || typeof dispatch.model !== 'string' || typeof dispatch.providerId !== 'string'
    ) throw new Error('Managed request rejected')
    admitted = true
    const nextConfig = { ...config }
    delete nextConfig[marker]
    if (message.method === 'thread/start') {
      params.modelProvider = dispatch.providerId
      params.model = dispatch.model
      params.config = { ...nextConfig, ...dispatch.configOverrides }
    } else {
      // The private resume sets provider config. The original turn retains all user input and controls.
      params.model = dispatch.model
      if (Object.keys(nextConfig).length === 0) delete params.config
      else params.config = nextConfig
      const mode = object(params.collaborationMode)
      if (mode && object(mode.settings)) {
        params.collaborationMode = { ...mode, settings: { ...mode.settings, model: dispatch.model } }
      }
    }
    const authorized = await controlCall('authorize', { token, requestId: message.id })
    if (authorized !== true) throw new Error('Managed request authorization expired')
    desktopCalls.set(message.id, { token, method: message.method })
    if (message.method === 'turn/start') firstTurns.delete(params.threadId)
    await write(child.stdin, JSON.stringify(message))
  } catch {
    desktopCalls.delete(message?.id)
    if (admitted) {
      await controlCall('complete', { token, requestId: message?.id, succeeded: false }).catch(() => undefined)
    }
    if (message?.id !== undefined) {
      await write(process.stdout, {
        id: message.id,
        error: { code: -32000, message: 'Provider switch could not be applied. Original request was not sent.' },
      })
    }
  }
}

readLines(process.stdin, line => {
  inputQueue = inputQueue.then(async () => {
    await ready
    await forward(line)
  }).catch(stop)
})
process.stdin.once('end', () => {
  void inputQueue.finally(() => child.stdin.end())
})

readLines(child.stdout, line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    void write(process.stdout, line).catch(stop)
    return
  }
  if (settle(privateCalls, message, false)) return
  // Late private responses must never escape into the Desktop's request table.
  if (typeof message?.id === 'string' && message.id.startsWith(privatePrefix)) return
  const operation = desktopCalls.get(message?.id)
  if (!operation || message.method !== undefined) {
    void write(process.stdout, line).catch(stop)
    return
  }
  desktopCalls.delete(message.id)
  if (
    operation.method === 'thread/start' && message.error === undefined && typeof message.result?.thread?.id === 'string'
  ) {
    firstTurns.set(message.result.thread.id, operation.token)
  }
  void controlCall('complete', {
    token: operation.token,
    requestId: message.id,
    succeeded: message.error === undefined,
    ...(typeof message.result?.thread?.id === 'string' ? { threadId: message.result.thread.id } : {}),
  }).then(() => write(process.stdout, line)).catch(stop)
})

const switching = new Set()
readLines(control, line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    stop()
    return
  }
  if (settle(controlCalls, message, true)) return
  if (message.type === 'idle' && typeof message.id === 'string' && typeof message.threadId === 'string') {
    void nativeCall('thread/read', { threadId: message.threadId, includeTurns: false }).then(result => {
      const status = result?.thread?.status?.type
      return write(control, {
        id: message.id,
        ok: true,
        value: status === 'idle' || status === 'notLoaded' || status === 'systemError',
      })
    }).catch(() => write(control, { id: message.id, ok: false }).catch(stop))
    return
  }
  if (message.type !== 'switch' || typeof message.id !== 'string' || switching.has(message.threadId)) {
    if (message.type === 'switch') void write(control, { id: message.id, ok: false }).catch(stop)
    return
  }
  switching.add(message.threadId)
  void (async () => {
    try {
      await nativeCall('thread/unsubscribe', { threadId: message.threadId })
      const result = await nativeCall('thread/resume', {
        threadId: message.threadId,
        model: message.model,
        modelProvider: message.providerId,
        config: message.config,
        excludeTurns: true,
      })
      const ok = result?.thread?.id === message.threadId && result?.modelProvider === message.providerId
        && result?.model === message.model
      await write(control, { id: message.id, ok })
    } catch {
      await write(control, { id: message.id, ok: false })
    } finally {
      switching.delete(message.threadId)
    }
  })().catch(stop)
}, maxControlLineBytes)
