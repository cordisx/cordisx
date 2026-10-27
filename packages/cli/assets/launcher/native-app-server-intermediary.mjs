#!/bin/sh
':' // ; exec "${CORDISX_NATIVE_NODE_PATH:-${CORDISX_NATIVE_REAL_CODEX_PATH%%/Contents/Resources/*}/Contents/Resources/cua_node/bin/node}" "$0" "$@"
import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { NativeRequestTracker } from './native-request-tracker.mjs'

const socketPath = process.env.CORDISX_NATIVE_CONTROL_SOCKET
const nonce = process.env.CORDISX_NATIVE_CONTROL_NONCE
const executable = process.env.CORDISX_NATIVE_REAL_CODEX_PATH
const agentModelsBinding = process.env.CORDISX_NATIVE_AGENT_MODELS_BINDING
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
    'CORDISX_NATIVE_NODE_PATH',
    'CORDISX_NATIVE_AGENT_MODELS_BINDING',
  ]
) delete process.env[key]

const nativeArgs = process.argv.slice(2)
if (agentModelsBinding && nativeArgs.includes('app-server')) {
  nativeArgs.unshift(
    '-c',
    `mcp_servers.cordisx_models.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.cordisx_models.args=${
      JSON.stringify([
        fileURLToPath(new URL('./native-agent-models-mcp.mjs', import.meta.url)),
        agentModelsBinding,
      ])
    }`,
  )
}
const child = spawn(executable, nativeArgs, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const control = net.connect(socketPath)
const controlCalls = new Map()
const privateCalls = new Map()
const desktopCalls = new Map()
const resumeCalls = new NativeRequestTracker()
const unmarkedTurns = new NativeRequestTracker()
// An unacknowledged lifecycle mutation stays uncertain; retain its fence, not its payload.
const lifecycleCalls = new Map()
// If the bounded map loses a mutation, its safety fence lasts until this process restarts.
// Ordinary native requests still pass through; only automatic recovery/Host switching stops.
let lifecycleUncertain = false
const recoveringTurns = new Set()
const cancelledRecovery = new Set()
const firstTurns = new Map()
const privatePrefix = `cordisx-private-${nonce}-`
let sequence = 0
let closed = false
let inputQueue = Promise.resolve()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const validToken = value => typeof value === 'string' && /^[^\0\r\n]{16,256}$/u.test(value)
const lifecyclePending = threadId => lifecycleUncertain || [...lifecycleCalls.values()].includes(threadId)
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
  resumeCalls.clear()
  unmarkedTurns.clear()
  recoveringTurns.clear()
  cancelledRecovery.clear()
  lifecycleCalls.clear()
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
    ? pending.reject(
      Object.assign(new Error('Native request rejected'), isControl ? {} : { nativeError: message.error }),
    )
    : pending.resolve(isControl ? message.value : message.result)
  return true
}

function missingManagedProvider(message) {
  if (message?.error?.code !== -32600 || typeof message.error.message !== 'string') return undefined
  const match = /^failed to load configuration: Model provider `([^`\0\r\n]{1,128})` not found$/u.exec(
    message.error.message,
  )
  return match?.[1]
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
  if (message?.method === 'turn/interrupt' && typeof params?.threadId === 'string') {
    unmarkedTurns.retireThread(params.threadId)
    if (recoveringTurns.has(params.threadId)) cancelledRecovery.add(params.threadId)
  }
  const mutatesThread = ['turn/start', 'turn/addUserMessage', 'turn/steer', 'thread/resume', 'thread/unsubscribe']
    .includes(message?.method)
  if (
    mutatesThread && (recoveringTurns.has(params?.threadId) || switching.has(params?.threadId))
  ) {
    await write(process.stdout, {
      id: message.id,
      error: { code: -32000, message: 'Thread recovery is in progress. Wait before sending another message.' },
    })
    return
  }
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
    if (
      message?.method === 'thread/resume' && typeof params?.threadId === 'string'
      && ['string', 'number'].includes(typeof message.id)
    ) resumeCalls.track(message.id, params)
    if (
      message?.method === 'turn/start' && typeof params?.threadId === 'string'
      && ['string', 'number'].includes(typeof message.id)
    ) unmarkedTurns.track(message.id, params)
    if (
      ['thread/resume', 'thread/unsubscribe'].includes(message?.method)
      && typeof params?.threadId === 'string' && ['string', 'number'].includes(typeof message.id)
    ) {
      if (lifecycleCalls.size >= 64 || lifecycleCalls.has(message.id)) {
        // Continue the native request; uncertain correlation disables only automatic recovery/switching.
        lifecycleUncertain = true
      } else lifecycleCalls.set(message.id, params.threadId)
      if (message.method === 'thread/unsubscribe') unmarkedTurns.retireThread(params.threadId)
    }
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
      if (typeof dispatch.reasoningEffort === 'string') {
        params.config.model_reasoning_effort = dispatch.reasoningEffort
      }
    } else {
      // The private resume sets provider config. The original turn retains all user input and controls.
      params.model = dispatch.model
      if (typeof dispatch.reasoningEffort === 'string') params.effort = dispatch.reasoningEffort
      if (Object.keys(nextConfig).length === 0) delete params.config
      else params.config = nextConfig
      const mode = object(params.collaborationMode)
      if (mode && object(mode.settings)) {
        params.collaborationMode = {
          ...mode,
          settings: {
            ...mode.settings,
            model: dispatch.model,
            ...(typeof dispatch.reasoningEffort === 'string'
              ? { reasoning_effort: dispatch.reasoningEffort }
              : {}),
          },
        }
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

// A restarted app-server no longer knows a launch-scoped managed provider that a persisted thread still names.
async function recoverResume(id, params, providerId, failureLine) {
  if (
    recoveringTurns.has(params.threadId) || switching.has(params.threadId)
    || lifecyclePending(params.threadId)
  ) {
    await write(process.stdout, failureLine)
    return
  }
  recoveringTurns.add(params.threadId)
  try {
    const read = await nativeCall('thread/read', { threadId: params.threadId, includeTurns: false })
    const persistedProviderId = read?.thread?.modelProvider
    const model = read?.thread?.model
    if (
      persistedProviderId !== providerId || providerId === 'openai'
      || typeof model !== 'string' || model === ''
    ) throw new Error('Native thread is not managed')
    const prepared = await controlCall('resume', { threadId: params.threadId, providerId, model })
    const overrides = object(prepared?.configOverrides)
    if (prepared?.kind !== 'resume' || !validToken(prepared.resumeToken) || overrides === undefined) {
      throw new Error('Managed resume rejected')
    }
    let result
    try {
      result = await nativeCall('thread/resume', { ...params, config: { ...object(params.config), ...overrides } })
      if (result?.thread?.id !== params.threadId) throw new Error('Managed resume returned another thread')
    } catch (error) {
      await controlCall('resume-complete', {
        threadId: params.threadId,
        resumeToken: prepared.resumeToken,
        succeeded: false,
      }).catch(() => undefined)
      throw error
    }
    const completed = await controlCall('resume-complete', {
      threadId: params.threadId,
      resumeToken: prepared.resumeToken,
      succeeded: true,
    })
    if (completed !== true) throw new Error('Managed resume completion rejected')
    // Recovery restores the persisted provider; it does not prepare a Send or
    // provider change. Unchanged-provider sends/retries have no operation token.
    // Only thread/start creates a first-turn association fence; retain any
    // existing fence rather than introducing one for a historical thread.
    await write(process.stdout, { id, result })
  } catch {
    // The original native failure stays authoritative whenever the Host cannot vouch for the provider.
    await write(process.stdout, failureLine)
  } finally {
    recoveringTurns.delete(params.threadId)
    cancelledRecovery.delete(params.threadId)
  }
}

// A persisted history can exist after its executable session has been unloaded.
// Replay only the exact missing-thread rejection, never a timeout or failed turn.
async function recoverUnloadedTurn(id, params, failureLine) {
  const threadId = params.threadId
  if (recoveringTurns.has(threadId) || switching.has(threadId) || lifecyclePending(threadId)) {
    await write(process.stdout, failureLine)
    return
  }
  recoveringTurns.add(threadId)
  let resumeToken
  let committed = false
  let replayAttempted = false
  try {
    const read = await nativeCall('thread/read', { threadId, includeTurns: false })
    const thread = object(read?.thread)
    if (
      thread?.id !== threadId || thread.status?.type !== 'notLoaded'
      || typeof thread.modelProvider !== 'string' || thread.modelProvider === 'openai'
      || typeof thread.model !== 'string' || thread.model === ''
    ) throw new Error('Missing thread is not an unloaded managed session')
    const prepared = await controlCall('resume', {
      threadId,
      providerId: thread.modelProvider,
      model: thread.model,
    })
    if (prepared?.kind !== 'resume' || !validToken(prepared.resumeToken) || !object(prepared.configOverrides)) {
      throw new Error('Managed recovery rejected')
    }
    resumeToken = prepared.resumeToken
    const resumed = await nativeCall('thread/resume', {
      threadId,
      modelProvider: thread.modelProvider,
      model: thread.model,
      config: prepared.configOverrides,
      excludeTurns: true,
    })
    if (
      resumed?.thread?.id !== threadId || resumed.modelProvider !== thread.modelProvider
      || resumed.model !== thread.model || resumed.thread.status?.type !== 'idle'
    ) throw new Error('Recovery did not acknowledge the same idle thread and provider')
    committed = await controlCall('resume-complete', { threadId, resumeToken, succeeded: true }) === true
    if (!committed) throw new Error('Managed recovery completion rejected')
    const current = await nativeCall('thread/read', { threadId, includeTurns: false })
    if (
      cancelledRecovery.has(threadId) || current?.thread?.id !== threadId
      || current.thread.status?.type !== 'idle' || current.thread.modelProvider !== thread.modelProvider
      || current.thread.model !== thread.model
    ) {
      throw new Error('Recovered thread changed before replay')
    }
    // The replay uses a private id but preserves all original parameters and
    // native permission checks. Its result is delivered once under the original id.
    replayAttempted = true
    const result = await nativeCall('turn/start', params)
    await write(process.stdout, { id, result })
  } catch (error) {
    if (resumeToken !== undefined && !committed) {
      await controlCall('resume-complete', { threadId, resumeToken, succeeded: false }).catch(() => undefined)
    }
    // Once replay was attempted, the original missing-thread failure is no
    // longer authoritative. Preserve a native rejection or report uncertainty
    // rather than falsely telling Desktop that the message was never sent.
    await write(
      process.stdout,
      replayAttempted
        ? {
          id,
          error: error.nativeError ?? {
            code: -32000,
            message: 'Recovered turn result is unknown. Check thread history before retrying.',
          },
        }
        : failureLine,
    )
  } finally {
    recoveringTurns.delete(threadId)
    cancelledRecovery.delete(threadId)
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
  if (message.method === undefined) lifecycleCalls.delete(message.id)
  const turnParams = message.method === undefined ? unmarkedTurns.take(message.id) : undefined
  if (turnParams !== undefined) {
    if (message.error?.code === -32600 && message.error.message === `thread not found: ${turnParams.threadId}`) {
      void recoverUnloadedTurn(message.id, turnParams, line).catch(stop)
      return
    }
  }
  const resumeParams = message.method === undefined ? resumeCalls.take(message?.id) : undefined
  if (resumeParams !== undefined) {
    const providerId = missingManagedProvider(message)
    if (providerId !== undefined) {
      void recoverResume(message.id, resumeParams, providerId, line).catch(stop)
      return
    }
  }
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
  if (
    message.type !== 'switch' || typeof message.id !== 'string'
    || switching.has(message.threadId) || recoveringTurns.has(message.threadId)
    || lifecyclePending(message.threadId)
  ) {
    if (message.type === 'switch') void write(control, { id: message.id, ok: false }).catch(stop)
    return
  }
  switching.add(message.threadId)
  void (async () => {
    try {
      if (message.requireIdle === true) {
        const before = await nativeCall('thread/read', { threadId: message.threadId, includeTurns: false })
        if (before?.thread?.id !== message.threadId || before?.thread?.status?.type !== 'idle') {
          await write(control, { id: message.id, ok: true, value: { status: 'rejected', reason: 'thread-not-idle' } })
          return
        }
      }
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
