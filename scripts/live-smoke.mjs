#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({
  options: {
    port: { type: 'string' },
    screenshot: { type: 'string' },
    'manager-screenshot': { type: 'string' },
    'manager-tab': { type: 'string' },
    'manager-plugin': { type: 'string' },
    'manager-detail-tab': { type: 'string' },
    'manager-settings-tab': { type: 'string' },
    'trigger-screenshot': { type: 'string' },
    'fetch-url': { type: 'string' },
  },
})
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: npm run smoke -- --port <port> [--screenshot <png>] [--manager-screenshot <png> --manager-tab <tab> --manager-plugin <id> --manager-detail-tab <tab> --manager-settings-tab <tab>] [--trigger-screenshot <png>]')
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
    const runtime = globalThis.__cordisxRuntime
    const snapshot = runtime?.snapshot?.()
    const panel = document.querySelector('[data-cordisx-demo-marker]')
      ?? document.querySelector('[data-cordisx-contribution="hello-toolbar.panel"] section')
    const rect = panel?.getBoundingClientRect()
    return {
      title: document.title,
      url: location.href,
      ready: document.documentElement.dataset.cordisxReady === 'true',
      version: runtime?.version ?? null,
      pluginIds: runtime?.pluginIds ?? [],
      pluginStates: snapshot?.plugins?.map(plugin => ({ id: plugin.id, status: plugin.status })) ?? [],
      contributions: [...document.querySelectorAll('[data-cordisx-contribution]')].map(element => element.getAttribute('data-cordisx-contribution')),
      managerTrigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
      marker: panel?.getAttribute('data-cordisx-demo-marker')
        ?? panel?.querySelector('strong')?.textContent
        ?? null,
      markerRect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })()`,
  returnByValue: true,
})
const report = evaluated.result?.value
if (report === undefined) throw new Error('CDP evaluation returned no report')
console.log(JSON.stringify(report, null, 2))

if (parsed.values['fetch-url'] !== undefined) {
  const fetched = await send('Runtime.evaluate', {
    expression: `(async () => {
      const result = {}
      try {
        const response = await fetch(${JSON.stringify(parsed.values['fetch-url'])})
        result.fetch = { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 120) }
      } catch (error) {
        result.fetch = { ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }
      }
      result.xhr = await new Promise(resolve => {
        const request = new XMLHttpRequest()
        request.open('GET', ${JSON.stringify(parsed.values['fetch-url'])})
        request.onload = () => resolve({ ok: request.status >= 200 && request.status < 300, status: request.status, text: request.responseText.slice(0, 120) })
        request.onerror = () => resolve({ ok: false, error: 'XMLHttpRequest error' })
        request.send()
      })
      return result
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(`fetch=${JSON.stringify(fetched.result?.value)}`)
}

async function capture(rect, outputPath, label) {
  if (rect === null || rect.width <= 0 || rect.height <= 0) throw new Error(`${label} is not visible`)
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
  const screenshotPath = path.resolve(outputPath)
  await mkdir(path.dirname(screenshotPath), { recursive: true })
  await writeFile(screenshotPath, Buffer.from(captured.data, 'base64'))
  console.log(`screenshot=${screenshotPath}`)
}

if (parsed.values.screenshot !== undefined) {
  await capture(report.markerRect, parsed.values.screenshot, 'CordisX marker')
}

if (parsed.values['manager-screenshot'] !== undefined) {
  const managerTab = parsed.values['manager-tab'] ?? 'plugins'
  if (!['about', 'slots', 'plugins', 'marketplace', 'settings'].includes(managerTab)) throw new Error(`unknown manager tab: ${managerTab}`)
  const managerPlugin = parsed.values['manager-plugin']
  const managerDetailTab = parsed.values['manager-detail-tab']
  if (managerDetailTab !== undefined && !['readme', 'config', 'runtime', 'slots'].includes(managerDetailTab)) throw new Error(`unknown manager detail tab: ${managerDetailTab}`)
  const managerSettingsTab = parsed.values['manager-settings-tab']
  if (managerSettingsTab !== undefined && !['marketplace', 'runtime', 'launcher'].includes(managerSettingsTab)) throw new Error(`unknown manager settings tab: ${managerSettingsTab}`)
  const evaluatedManager = await send('Runtime.evaluate', {
    expression: `(() => {
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      trigger?.click()
      document.querySelector('[data-tab=${JSON.stringify(managerTab)}]')?.click()
      const pluginId = ${JSON.stringify(managerPlugin)}
      if (pluginId !== undefined) {
        const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
          .find(element => element.getAttribute('data-plugin-id') === pluginId || element.getAttribute('data-marketplace-plugin') === pluginId)
        row?.click()
      }
      const detailTab = ${JSON.stringify(managerDetailTab)}
      if (detailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
      const settingsTab = ${JSON.stringify(managerSettingsTab)}
      if (settingsTab !== undefined) document.querySelector('[data-settings-tab="' + settingsTab + '"]')?.click()
      const dialog = document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')
      const rect = dialog?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`,
    returnByValue: true,
  })
  await capture(evaluatedManager.result?.value ?? null, parsed.values['manager-screenshot'], 'CordisX manager')
}

if (parsed.values['trigger-screenshot'] !== undefined) {
  const evaluatedTrigger = await send('Runtime.evaluate', {
    expression: `(() => {
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      if (modal !== null && !modal.hidden) document.querySelector('.cxm-close')?.click()
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const switcher = trigger?.previousElementSibling
      const left = switcher?.getBoundingClientRect()
      const right = trigger?.getBoundingClientRect()
      if (left === undefined || right === undefined) return null
      const x = Math.min(left.x, right.x)
      const y = Math.min(left.y, right.y)
      const edge = Math.max(left.right, right.right)
      const bottom = Math.max(left.bottom, right.bottom)
      return { x, y, width: edge - x, height: bottom - y }
    })()`,
    returnByValue: true,
  })
  await capture(evaluatedTrigger.result?.value ?? null, parsed.values['trigger-screenshot'], 'CordisX manager trigger')
}

socket.close()
