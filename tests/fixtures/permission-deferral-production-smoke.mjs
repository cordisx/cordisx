#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    optional: { type: 'string' },
    required: { type: 'string' },
    report: { type: 'string' },
  },
})
const port = Number(values.port)
if (
  !Number.isInteger(port) || !values.optional || !path.isAbsolute(values.optional)
  || !values.required || !path.isAbsolute(values.required) || !values.report || !path.isAbsolute(values.report)
) {
  throw new Error('isolated permission smoke requires --port and absolute --optional, --required, and --report paths')
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url === 'app://-/index.html')
if (!target?.webSocketDebuggerUrl) throw new Error('isolated app renderer is unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
let nextId = 1
const pending = new Map()
const exceptions = []
socket.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params?.exceptionDetails?.text ?? 'renderer error')
  }
  if (message.id === undefined) return
  const callback = pending.get(message.id)
  if (callback === undefined) return
  pending.delete(message.id)
  if (message.error) callback.reject(new Error(message.error.message))
  else callback.resolve(message.result ?? {})
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (error) reject(error)
    })
  })
}
try {
  await send('Runtime.enable')
  const evaluated = await send('Runtime.evaluate', {
    expression: `(async () => {
      const waitFor = async (read, label) => {
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const value = read()
          if (value) return value
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('timed out waiting for ' + label)
      }
      const click = element => {
        if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) throw new Error('unavailable control')
        element.click()
      }
      const runtime = await waitFor(() => globalThis.__cordisxRuntime, 'runtime')
      click(await waitFor(() => document.querySelector('[data-cordisx-manager-trigger]'), 'Manager'))
      click(await waitFor(() => document.querySelector('[data-tab="plugins"]'), 'plugins'))
      const install = async (source, id, required) => {
        click(await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'import'))
        const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog [data-import-local-path]'), 'path')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, source)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        click(await waitFor(() => document.querySelector('[data-import-local-submit]:not(:disabled)'), 'submit'))
        if (required) {
          const dialog = await waitFor(() => document.querySelector('[data-permission-authorization]'), 'required review')
          const capabilities = [...dialog.querySelectorAll('[data-permission-capability]')]
            .map(item => item.getAttribute('data-permission-capability'))
          if (JSON.stringify(capabilities) !== JSON.stringify(['tasks.catalog.read'])) throw new Error('wrong review items: ' + JSON.stringify(capabilities))
          click(await waitFor(() => dialog.querySelector('[data-permission-decision="allow-once"]'), 'required allow once'))
          click(dialog.querySelector('[data-permission-action="confirm"]'))
        }
        await waitFor(() => runtime.snapshot().plugins.find(item => item.id === id && item.status === 'active'), 'active ' + id)
        await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'settled install')
        if (document.querySelector('[data-permission-authorization]')) throw new Error('unexpected install permission review')
      }
      await install(${JSON.stringify(values.optional)}, 'defer-smoke-optional', false)
      const before = runtime.snapshot().permissions.find(item => item.identity.id === 'defer-smoke-optional' && item.capability === 'models.read')
      if (before?.policy !== 'ask') throw new Error('optional capability did not retain ask policy')
      const call = runtime.execute('defer-smoke-optional', { id: 'probe' })
      const prompt = await waitFor(() => document.querySelector('[data-permission-authorization]'), 'runtime review')
      if (!prompt.querySelector('[data-permission-capability="models.read"]')) throw new Error('wrong runtime capability')
      click(await waitFor(() => prompt.querySelector('[data-permission-decision="deny-once"]'), 'deny once'))
      click(prompt.querySelector('[data-permission-action="confirm"]'))
      const denied = await call
      if (denied?.ok !== false || denied.error?.code !== 'permission-denied') {
        throw new Error('runtime denial did not block the capability')
      }
      const after = runtime.snapshot().permissions.find(item => item.identity.id === 'defer-smoke-optional' && item.capability === 'models.read')
      if (after?.policy !== 'ask') throw new Error('deny-once changed persistent policy')
      await install(${JSON.stringify(values.required)}, 'defer-smoke-required', true)
      return { url: location.href, optionalPolicyBefore: before.policy, optionalPolicyAfter: after.policy, requiredReviewed: true }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text)
  }
  const result = evaluated.result?.value
  if (result?.url !== 'app://-/index.html' || exceptions.length > 0) {
    throw new Error('native renderer verification failed')
  }
  await mkdir(path.dirname(values.report), { recursive: true })
  await writeFile(
    values.report,
    `${JSON.stringify({ kind: 'permission-deferral-native-smoke-v1', result, exceptions }, null, 2)}\n`,
  )
} finally {
  socket.close()
}
