import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({
  options: {
    port: { type: 'string' },
    report: { type: 'string' },
    screenshot: { type: 'string' },
    'connector-harness-policy': { type: 'string' },
    'connector-harness-scenario': { type: 'string' },
  },
})
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || parsed.values.report === undefined) {
  throw new Error('connector production smoke requires --port and --report')
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.url === 'app://-/index.html')
if (target?.webSocketDebuggerUrl === undefined) throw new Error('main app:// target is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
let nextId = 1
const pending = new Map()
const runtimeExceptions = []
socket.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.method === 'Runtime.exceptionThrown') {
    runtimeExceptions.push(message.params?.exceptionDetails?.text ?? 'renderer exception')
  }
  if (message.id === undefined) return
  const item = pending.get(message.id)
  if (item === undefined) return
  pending.delete(message.id)
  message.error === undefined ? item.resolve(message.result) : item.reject(new Error(message.error.message))
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error === undefined || error === null) return
      pending.delete(id)
      reject(error)
    })
  })
}
let assertion
for (let attempt = 0; attempt < 300; attempt += 1) {
  const evaluated = await send('Runtime.evaluate', {
    expression: 'document.documentElement.dataset.connectorHarnessReport ?? null',
    returnByValue: true,
  })
  const text = evaluated.result?.value
  if (typeof text === 'string') {
    assertion = JSON.parse(text)
    break
  }
  await new Promise(resolve => setTimeout(resolve, 50))
}
if (assertion === undefined) throw new Error('Host-private connector fixture did not publish a redacted assertion')
const policy = parsed.values['connector-harness-policy'] ?? 'allow'
const scenario = parsed.values['connector-harness-scenario'] ?? 'flow'
const expected = assertion.status === 'passed'
  && assertion.rawBridgeExposed === false
  && assertion.secondConnectionCreated === false
  && (policy === 'allow'
    ? scenario === 'flow'
      ? assertion.listenerBeforeWatermark === true && assertion.replayToLive === true
        && assertion.replacementTerminal === true
      : assertion.cancellation === true
    : assertion.policy === 'fail-closed')
if (!expected) throw new Error(`connector production assertions failed: ${JSON.stringify(assertion)}`)
let screenshot
if (parsed.values.screenshot !== undefined) {
  const captured = await send('Page.captureScreenshot', { format: 'png' })
  if (typeof captured.data !== 'string') throw new Error('app screenshot capture failed')
  screenshot = path.resolve(parsed.values.screenshot)
  await mkdir(path.dirname(screenshot), { recursive: true })
  await writeFile(screenshot, Buffer.from(captured.data, 'base64'))
}
if (runtimeExceptions.length !== 0) throw new Error(`renderer exceptions: ${runtimeExceptions.join('; ')}`)
const report = {
  appUrl: target.url,
  assertions: assertion,
  runtimeExceptions,
  ...(screenshot === undefined ? {} : { screenshot }),
}
await mkdir(path.dirname(path.resolve(parsed.values.report)), { recursive: true })
await writeFile(path.resolve(parsed.values.report), `${JSON.stringify(report, null, 2)}\n`)
socket.close()
