#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({
  options: {
    port: { type: 'string' },
    screenshot: { type: 'string' },
  },
})
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: npm run smoke -- --port <port> [--screenshot <png>]')
}

const response = await fetch(`http://127.0.0.1:${port}/json/list`)
if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
const targets = await response.json()
const target = targets.find(item => item.type === 'page' && item.url === 'app://-/index.html')
if (target?.webSocketDebuggerUrl === undefined) throw new Error('main Codex page target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 1
const pending = new Map()
socket.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.id === undefined) return
  const callback = pending.get(message.id)
  if (callback === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) callback.reject(new Error(message.error.message))
  else callback.resolve(message.result ?? {})
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error == null) return
      pending.delete(id)
      reject(error)
    })
  })
}

await send('Runtime.enable')
await send('Page.enable')
const evaluated = await send('Runtime.evaluate', {
  expression: `(() => {
    const contribution = document.querySelector('[data-cordisx-contribution="hello-toolbar.panel"]')
    const panel = contribution?.querySelector('section')
    const rect = panel?.getBoundingClientRect()
    return {
      title: document.title,
      url: location.href,
      ready: document.documentElement.dataset.cordisxReady === 'true',
      pluginIds: globalThis.__cordisxRuntime?.pluginIds ?? [],
      contributions: [...document.querySelectorAll('[data-cordisx-contribution]')].map(element => element.getAttribute('data-cordisx-contribution')),
      marker: panel?.querySelector('strong')?.textContent ?? null,
      markerRect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })()`,
  returnByValue: true,
})
const report = evaluated.result?.value
if (report === undefined) throw new Error('CDP evaluation returned no report')
console.log(JSON.stringify(report, null, 2))

if (parsed.values.screenshot !== undefined) {
  const rect = report.markerRect
  if (rect === null || rect.width <= 0 || rect.height <= 0) throw new Error('CordisX marker is not visible')
  const padding = 12
  const captured = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: {
      x: Math.max(0, rect.x - padding),
      y: Math.max(0, rect.y - padding),
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
      scale: 1,
    },
  })
  if (typeof captured.data !== 'string') throw new Error('CDP screenshot returned no image')
  const screenshotPath = path.resolve(parsed.values.screenshot)
  await mkdir(path.dirname(screenshotPath), { recursive: true })
  await writeFile(screenshotPath, Buffer.from(captured.data, 'base64'))
  console.log(`screenshot=${screenshotPath}`)
}

socket.close()
