#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({ options: {
  port: { type: 'string' },
  'bundle-source': { type: 'string' },
  report: { type: 'string' },
} })
const port = Number(parsed.values.port)
const bundleSource = parsed.values['bundle-source']
const reportPath = parsed.values.report
if (!Number.isInteger(port) || port < 1024 || port > 65535 || bundleSource === undefined || !path.isAbsolute(bundleSource) || reportPath === undefined) {
  throw new Error('plugin bundle smoke requires --port, an absolute --bundle-source, and --report')
}

const response = await fetch(`http://127.0.0.1:${port}/json/list`)
if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
const targets = await response.json()
const target = targets.find(item => item.type === 'page' && item.url === 'app://-/index.html')
if (target?.webSocketDebuggerUrl === undefined) throw new Error('main Codex app:// target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
let nextId = 1
const pending = new Map()
const runtimeExceptions = []
socket.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.method === 'Runtime.exceptionThrown') {
    runtimeExceptions.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'unknown renderer exception')
    return
  }
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

try {
  await send('Runtime.enable')
  const evaluated = await send('Runtime.evaluate', {
    expression: `(async () => {
      const waitFor = async (read, label, timeout = 30000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const value = read()
          if (value) return value
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('timed out waiting for ' + label)
      }
      const click = element => {
        if (!(element instanceof HTMLButtonElement)) throw new Error('expected button')
        if (element.disabled) throw new Error('button is disabled: ' + (element.getAttribute('aria-label') ?? element.textContent))
        element.click()
      }
      const setValue = (element, value) => {
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
      }
      const action = (...labels) => [...document.querySelectorAll('button')].find(button => labels.includes(button.getAttribute('aria-label')))
      window.confirm = () => true

      click(await waitFor(() => document.querySelector('[data-cordisx-manager-trigger]'), 'Manager trigger'))
      click(await waitFor(() => document.querySelector('[data-tab="plugin-bundles"]'), 'plugin bundle navigation'))
      const source = await waitFor(() => document.querySelector('[data-bundle-source]'), 'bundle source field')
      setValue(source, ${JSON.stringify(bundleSource)})
      click(await waitFor(() => {
        const button = document.querySelector('[data-bundle-inspect]')
        return button instanceof HTMLButtonElement && !button.disabled ? button : null
      }, 'enabled inspect action'))
      await waitFor(() => document.querySelector('[data-bundle-install-plan="workflow-essentials"]'), 'bundle install plan')
      const permission = await waitFor(() => document.querySelector('[data-bundle-policy-id]'), 'unified permission choice')
      setValue(permission, 'allow')
      click(await waitFor(() => {
        const button = document.querySelector('[data-bundle-install]')
        return button instanceof HTMLButtonElement && !button.disabled ? button : null
      }, 'enabled install action'))
      click(await waitFor(() => document.querySelector('[data-plugin-bundle-id="workflow-essentials"]'), 'installed bundle row'))
      const detail = await waitFor(() => document.querySelector('[data-plugin-bundle-detail="workflow-essentials"]'), 'bundle detail')
      const header = detail.querySelector('.cxr-bundle-identity')
      const tablist = detail.querySelector('.cxr-tabs')
      const tabIds = [...tablist.querySelectorAll('[data-plugin-detail-tab]')].map(item => item.dataset.pluginDetailTab)
      const tabLabels = [...tablist.querySelectorAll('[data-plugin-detail-tab]')].map(item => item.textContent.trim())
      const readme = detail.querySelector('[data-bundle-readme-only="true"]')
      const headerBeforeTabs = Boolean(header.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING)
      const readmeOnly = readme.textContent.includes('This README is the only content rendered inside the README tab.')
        && !readme.textContent.includes('CordisX')
        && !readme.textContent.includes('sha256:')

      click(tablist.querySelector('[data-plugin-detail-tab="members"]'))
      const memberVisible = Boolean(await waitFor(() => document.querySelector('[data-bundle-member="bundle-smoke-member"]'), 'bundle member'))
      click(document.querySelector('[data-plugin-detail-tab="permissions"]'))
      const permissionVisible = (await waitFor(() => document.querySelector('.cxr-bundle-permission-editor'), 'bundle permission')).textContent.includes('agent.events.read')
      click(document.querySelector('[data-plugin-detail-tab="relations"]'))
      const relationVisible = (await waitFor(() => document.querySelector('[role="tabpanel"][aria-label="关联"], [role="tabpanel"][aria-label="Relations"]'), 'bundle relations')).textContent.includes('workflow-essentials')

      const update = action('Update bundle', '更新插件包')
      const disable = action('Disable bundle', '停用插件包')
      const repair = document.querySelector('[data-bundle-action="repair"]')
      const uninstall = action('Uninstall bundle', '卸载插件包')
      const actions = {
        updateEnabled: update instanceof HTMLButtonElement && !update.disabled,
        disableEnabled: disable instanceof HTMLButtonElement && !disable.disabled,
        repairPresent: repair !== null,
        uninstallEnabled: uninstall instanceof HTMLButtonElement && !uninstall.disabled,
      }
      click(disable)
      const disableOutcome = await waitFor(() => {
        const identityText = document.querySelector('.cxr-bundle-identity')?.textContent ?? ''
        const operationMessage = document.querySelector('.cxr-notice[role="status"]')?.textContent?.trim() ?? ''
        const enable = action('Enable bundle', '启用插件包')
        const currentDisable = action('Disable bundle', '停用插件包')
        const settled = enable instanceof HTMLButtonElement
          || (operationMessage !== '' && currentDisable instanceof HTMLButtonElement && !currentDisable.disabled)
        return settled ? {
          disabledProjection: identityText.includes('disabled'),
          enableActionPresent: enable instanceof HTMLButtonElement && !enable.disabled,
          operationMessage,
          identityText,
        } : null
      }, 'settled disable operation', 70000)
      click(document.querySelector('[data-plugin-detail-tab="records"]'))
      const disableRecorded = (await waitFor(() => document.querySelector('[role="tabpanel"][aria-label="记录"], [role="tabpanel"][aria-label="Records"]'), 'bundle records')).textContent.includes('disable')
      return {
        url: location.href,
        headerBeforeTabs,
        headerMetadata: ['Workflow Essentials', 'CordisX', 'plugin-bundle-smoke', '1.0.0', 'sha256:'].every(value => header.textContent.includes(value)),
        tabIds,
        tabLabels,
        readmeOnly,
        memberVisible,
        permissionVisible,
        relationVisible,
        disableRecorded,
        disableOutcome,
        actions,
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (evaluated.exceptionDetails !== undefined) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'bundle smoke evaluation failed')
  }
  const result = evaluated.result?.value
  const expectedTabs = ['readme', 'members', 'permissions', 'relations', 'records']
  const assertions = {
    appRenderer: result?.url === 'app://-/index.html',
    headerBeforeTabs: result?.headerBeforeTabs === true,
    headerMetadata: result?.headerMetadata === true,
    exactTabs: JSON.stringify(result?.tabIds) === JSON.stringify(expectedTabs),
    readmeOnly: result?.readmeOnly === true,
    memberVisible: result?.memberVisible === true,
    permissionVisible: result?.permissionVisible === true,
    relationVisible: result?.relationVisible === true,
    disableApplied: result?.disableOutcome?.disabledProjection === true
      && result?.disableOutcome?.enableActionPresent === true,
    disableRecorded: result?.disableRecorded === true,
    actions: Object.values(result?.actions ?? {}).every(Boolean),
    noRendererExceptions: runtimeExceptions.length === 0,
  }
  const report = { kind: 'plugin-bundle-production-smoke-v1', result, assertions, runtimeExceptions }
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true })
  await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`)
  if (Object.values(assertions).some(value => value !== true)) throw new Error(`plugin bundle app:// smoke failed: ${JSON.stringify(report)}`)
  console.log(`[cordisx-plugin-bundle-smoke] ${JSON.stringify(report)}`)
} finally {
  socket.close()
}
