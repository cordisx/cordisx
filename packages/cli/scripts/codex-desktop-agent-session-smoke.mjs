#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({
  options: {
    port: { type: 'string' },
    report: { type: 'string' },
    marker: { type: 'string' },
    'session-id': { type: 'string' },
  },
})
const port = Number(parsed.values.port)
const reportPath = parsed.values.report
const marker = parsed.values.marker
const sessionId = parsed.values['session-id']
if (
  !Number.isInteger(port) || port < 1024 || port > 65535 || typeof reportPath !== 'string'
  || !path.isAbsolute(reportPath) || typeof marker !== 'string' || marker === ''
  || typeof sessionId !== 'string' || !sessionId.startsWith('cx-session.')
) {
  throw new Error('usage: --port <port> --report <absolute-json> --marker <marker> --session-id <cx-session.*>')
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
const target = targets.find(candidate => candidate.url === 'app://-/index.html')
if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error('app:// renderer target is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 0
const pending = new Map()
socket.on('message', data => {
  const message = JSON.parse(String(data))
  if (message.id === undefined) return
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP request failed'))
  else waiter.resolve(message.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text ?? 'renderer evaluation failed')
  }
  return result.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

const report = {
  schemaVersion: 1,
  kind: 'codex-desktop-agent-session-live-smoke',
  marker,
  sessionId,
  renderer: {
    url: target.url,
    ready: await evaluate(
      "document.documentElement.dataset.cordisxReady === 'true' && globalThis.__cordisxRuntime !== undefined",
    ),
    fixtureReady: await evaluate('globalThis.__cordisxDesktopAgentSessionSmoke !== undefined'),
  },
  bridge: {
    instrumentation: false,
    observationMode: 'unavailable',
    hostId: 'local',
    outboundMethods: [],
    inboundMethods: [],
    connectionEvents: [],
  },
  operations: [],
  permissionPrompts: [],
  assertions: {},
  limitations: [],
  stages: [{ stage: 'renderer-ready', elapsedMs: 0 }],
}

const installBridgeTrace = await evaluate(`(() => {
  const bridge = globalThis.electronBridge
  if (bridge === undefined || typeof bridge.sendMessageFromView !== 'function') return { installed: false, reason: 'bridge-unavailable' }
  const original = bridge.sendMessageFromView
  const trace = { outboundMethods: [], inboundMethods: [], connectionEvents: [] }
  const receive = event => {
    const value = event.data
    if (value === null || typeof value !== 'object' || value.hostId !== 'local') return
    if (value.type === 'mcp-notification' && typeof value.message?.method === 'string') trace.inboundMethods.push(value.message.method)
    if ((value.type === 'codex-app-server-connection-changed' || value.type === 'codex-app-server-initialized')) {
      const identity = {}
      for (const key of ['state', 'connectionId', 'connectionGeneration', 'generation', 'id']) {
        const candidate = value[key]
        if (typeof candidate === 'string' || typeof candidate === 'number') identity[key] = candidate
      }
      trace.connectionEvents.push({ type: value.type, keys: Object.keys(value).sort().slice(0, 16), identity })
    }
  }
  try {
    bridge.sendMessageFromView = function(value) {
      if (value !== null && typeof value === 'object' && value.type === 'mcp-request' && typeof value.request?.method === 'string') {
        trace.outboundMethods.push(value.request.method)
      }
      return original.call(this, value)
    }
  } catch (error) {
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  }
  window.addEventListener('message', receive, true)
  globalThis.__cordisxDesktopAgentSessionBridgeTrace = {
    snapshot: () => structuredClone(trace),
    cleanup: () => {
      window.removeEventListener('message', receive, true)
      bridge.sendMessageFromView = original
      delete globalThis.__cordisxDesktopAgentSessionBridgeTrace
    },
  }
  return { installed: true }
})()`)
const bridgeObserverInstalled = installBridgeTrace?.installed === true
report.bridge.observationMode = bridgeObserverInstalled ? 'method-wrapper-installed' : 'unavailable'
if (!bridgeObserverInstalled) {
  report.limitations.push(`bridge method-only trace unavailable: ${installBridgeTrace?.reason ?? 'unknown'}`)
}
report.stages.push({
  stage: bridgeObserverInstalled ? 'bridge-observer-installed' : 'bridge-unavailable',
  elapsedMs: 0,
})

let permissionPromptOrdinal = 0
const answerPermissionPrompt = async () => {
  const prompt = await evaluate(`(() => {
    const root = document.querySelector('[data-permission-prompt]')
    if (root === null) return undefined
    const button = root.querySelector('[data-permission-decision="allow-once"]')
    const capability = root.getAttribute('data-permission-prompt')
    if (!(button instanceof HTMLButtonElement)) return { capability, answered: false }
    button.click()
    return { capability, answered: true }
  })()`)
  if (prompt === undefined) return false
  permissionPromptOrdinal += 1
  report.permissionPrompts.push({ ordinal: permissionPromptOrdinal, ...prompt })
  return true
}

const controllerSnapshot = async () => await evaluate('globalThis.__cordisxDesktopAgentSessionSmoke?.snapshot()')
const invoke = async (name, input, timeoutMs = 90_000) => {
  const startedAt = Date.now()
  report.stages.push({ stage: `api:${name}:start`, elapsedMs: 0 })
  const before = await controllerSnapshot()
  const accepted = await evaluate(
    `globalThis.__cordisxDesktopAgentSessionSmoke?.invoke(${JSON.stringify(name)}, ${JSON.stringify(input)}) === true`,
  )
  if (!accepted) throw new Error(`fixture rejected operation ${name}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await answerPermissionPrompt()
    const snapshot = await controllerSnapshot()
    if (snapshot !== undefined && snapshot.busy === false && snapshot.operationOrdinal > before.operationOrdinal) {
      report.operations.push(snapshot.last)
      report.stages.push({
        stage: `api:${name}:complete`,
        elapsedMs: Date.now() - startedAt,
        ok: snapshot.last?.ok === true,
      })
      return snapshot.last
    }
    await sleep(100)
  }
  throw new Error(`operation ${name} timed out`)
}

const assertAccepted = (operation, result) => {
  if (result?.ok !== true || result.value?.status !== 'accepted') {
    throw new Error(`${operation} was not accepted: ${JSON.stringify(result)}`)
  }
}

let fatal
try {
  const created = await invoke('create', { sessionId, mutationId: `${marker}.create` })
  assertAccepted('create', created)
  await invoke('observe')
  const approval = await invoke('approval', {
    toolName: 'cordisx.smoke.local-approval',
    reason: `Local isolated approval round-trip ${marker}; no external side effect`,
  })
  if (approval?.value?.outcome !== 'allowed-once') {
    throw new Error(`manual approval did not round-trip: ${JSON.stringify(approval)}`)
  }

  const primary = await invoke('send', {
    mode: 'send',
    messageId: `${marker}.message.primary`,
    text:
      `CordisX isolated local smoke ${marker}. Use the shell tool exactly once to run printf '%s' '${marker}' without changing files or using the network, then reply with ${marker}.`,
  })
  assertAccepted('send', primary)
  const queued = await invoke('send', {
    mode: 'followup',
    messageId: `${marker}.message.queued`,
    text: `Queued smoke message ${marker}; do not execute after it is discarded.`,
  })
  assertAccepted('followup', queued)
  const discarded = await invoke('discard', { messageId: `${marker}.message.queued` })
  assertAccepted('discard', discarded)
  const steered = await invoke('send', {
    mode: 'steer',
    messageId: `${marker}.message.steer`,
    text: `Continue the same local smoke and include ${marker}.`,
  })
  assertAccepted('steer', steered)
  const injected = await invoke('send', {
    mode: 'inject',
    messageId: `${marker}.message.inject`,
    text: `Injected local-only smoke context ${marker}.`,
  })
  assertAccepted('inject', injected)
  await invoke('idle', undefined, 180_000)
  const firstRead = await invoke('read')
  if (
    firstRead?.ok !== true || firstRead.value?.snapshot?.status !== 'available'
    || firstRead.value?.page?.status !== 'available'
  ) {
    throw new Error(`Session readback unavailable: ${JSON.stringify(firstRead)}`)
  }
  await invoke('closeObservers')
  assertAccepted('disposeAgent', await invoke('disposeAgent', { mutationId: `${marker}.dispose` }))
  const sessionReadback = await invoke('sessionGet', { sessionId })
  if (sessionReadback?.value?.status !== 'found') {
    throw new Error(`Session registry lost the same-process Session: ${JSON.stringify(sessionReadback)}`)
  }
  const resumed = await invoke('resume', { sessionId, mutationId: `${marker}.resume` })
  assertAccepted('resume', resumed)
  await invoke('observe')
  assertAccepted(
    'cancel-send',
    await invoke('send', {
      mode: 'send',
      messageId: `${marker}.message.cancel`,
      text: `Begin a response for cancellation smoke ${marker}. Do not use tools.`,
    }),
  )
  const cancelled = await invoke('cancel', { mutationId: `${marker}.cancel`, keepInbox: false })
  assertAccepted('cancel', cancelled)
  await invoke('idle', undefined, 90_000)
  await invoke('read')
  await invoke('closeObservers')
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
} finally {
  const snapshot = await controllerSnapshot().catch(() => undefined)
  report.fixture = snapshot
  const trace = await evaluate('globalThis.__cordisxDesktopAgentSessionBridgeTrace?.snapshot()').catch(() => undefined)
  if (trace !== undefined) Object.assign(report.bridge, trace)
  await evaluate('globalThis.__cordisxDesktopAgentSessionBridgeTrace?.cleanup()').catch(() => undefined)
}

if (report.bridge.outboundMethods.length > 0 || report.bridge.inboundMethods.length > 0) {
  report.bridge.instrumentation = true
  report.bridge.observationMode = 'observed'
} else if (bridgeObserverInstalled) {
  report.bridge.observationMode = 'unsupported-runtime-held-reference'
  report.limitations.push('the bridge method wrapper could not observe the runtime-held connection reference')
}

const sessionEvents = report.fixture?.entries?.filter(entry => entry.kind === 'session').map(entry => entry.name) ?? []
const outboundMethods = report.bridge.outboundMethods
const requiredOutbound = [
  'thread/start',
  'turn/start',
  'turn/steer',
  'thread/inject_items',
  'thread/resume',
  'turn/interrupt',
]
report.assertions = {
  publicCreateResumeMapping: report.operations.some(item => item?.name === 'create' && item.ok)
    && report.operations.some(item => item?.name === 'resume' && item.ok),
  commandMethods: Object.fromEntries(requiredOutbound.map(method => [method, outboundMethods.includes(method)])),
  assistantObserved: sessionEvents.includes('assistant/message'),
  toolCallObserved: sessionEvents.includes('tool/call'),
  toolResultObserved: sessionEvents.includes('tool/result'),
  approvalRoundTripObserved: sessionEvents.includes('approval/asked') && sessionEvents.includes('approval/decided'),
  turnLifecycleObserved: sessionEvents.includes('turn/start') && sessionEvents.includes('turn/end'),
  sameProcessSessionReadback: report.operations.some(item =>
    item?.name === 'sessionGet' && item.value?.status === 'found'
  ),
  detailMapsSessionToNativeThread: typeof report.fixture?.detailRef === 'string'
    && report.fixture.detailRef.startsWith('codex-thread:'),
}
const core = report.assertions.publicCreateResumeMapping
  && report.assertions.approvalRoundTripObserved
  && report.assertions.turnLifecycleObserved
  && report.assertions.sameProcessSessionReadback
const complete = core
  && Object.values(report.assertions.commandMethods).every(Boolean)
  && report.assertions.assistantObserved
  && report.assertions.toolCallObserved
  && report.assertions.toolResultObserved
  && report.assertions.detailMapsSessionToNativeThread
if (!report.assertions.toolCallObserved || !report.assertions.toolResultObserved) {
  report.limitations.push('the live model did not produce the requested safe local tool call/result')
}
if (report.bridge.connectionEvents.length === 0) {
  report.limitations.push('no natural app-server connection replacement occurred during this run')
}
report.result = fatal === undefined ? complete ? 'passed' : core ? 'partial' : 'failed' : 'failed'
if (fatal !== undefined) report.error = fatal

await mkdir(path.dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
socket.close()
if (report.result === 'failed') throw new Error(fatal ?? 'Codex Desktop Agent/Session live smoke failed')
console.log(`[cordisx-desktop-agent-session-smoke] ${report.result}: ${reportPath}`)
