#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const parsed = parseArgs({
  options: {
    port: { type: 'string' },
    screenshot: { type: 'string' },
    'app-screenshot': { type: 'string' },
    'manager-screenshot': { type: 'string' },
    'manager-tab': { type: 'string' },
    'manager-plugin': { type: 'string' },
    'manager-detail-tab': { type: 'string' },
    'manager-permission-capability': { type: 'string' },
    'manager-settings-tab': { type: 'string' },
    'manager-settings-exercise': { type: 'boolean', default: false },
    'config-exercise': { type: 'boolean', default: false },
    'manager-lifecycle-source': { type: 'string' },
    'manager-extension-point': { type: 'string' },
    'manager-extension-point-tab': { type: 'string' },
    'manager-route': { type: 'string' },
    'manager-marketplace-tab': { type: 'string' },
    'manager-marketplace-source': { type: 'string' },
    'manager-click-external': { type: 'boolean', default: false },
    'manager-viewport-width': { type: 'string' },
    'manager-breadcrumb-width': { type: 'string' },
    'trigger-screenshot': { type: 'string' },
    'color-scheme': { type: 'string' },
    locale: { type: 'string' },
    'fetch-url': { type: 'string' },
    report: { type: 'string' },
    'select-thread': { type: 'string' },
    'plugin-owner': { type: 'string' },
    'open-route': { type: 'string' },
    'click-surface': { type: 'string' },
    'click-label': { type: 'string' },
    'session-id': { type: 'string' },
    'permission-capability': { type: 'string', multiple: true },
    'permission-policy': { type: 'string' },
    'authorization-plugin': { type: 'string' },
    'authorization-decision': { type: 'string' },
    'authorization-decline-optional': { type: 'boolean', default: false },
    'authorization-screenshot': { type: 'string' },
    'demo-kind': { type: 'string', multiple: true },
    'clear-demo': { type: 'boolean', default: false },
    'plugin-lifecycle': { type: 'boolean', default: false },
    'plugin-console-exercise': { type: 'boolean', default: false },
    'generation-transaction-exercise': { type: 'boolean', default: false },
    'adapter-commit': { type: 'string' },
    'protocol-commit': { type: 'string' },
    'host-version': { type: 'string' },
    'host-build': { type: 'string' },
    exercise: { type: 'boolean', default: false },
    generation: { type: 'boolean', default: false },
    'ui-catalog': { type: 'boolean', default: false },
  },
})
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: npm run smoke -- --port <port> [--color-scheme light|dark] [--locale en|zh-CN] [--screenshot <png>] [--app-screenshot <png>] [--plugin-owner <id> --open-route <id> | --click-surface <id> --click-label <aria-label>] [--permission-capability <name> --permission-policy allow|ask|deny] [--manager-screenshot <png> --manager-tab <tab> --manager-plugin <id> --manager-detail-tab <tab> --manager-permission-capability <name> --manager-settings-tab <tab> --manager-extension-point <id> --manager-extension-point-tab <tab> --manager-route <qualified-id> --manager-marketplace-tab <tab> --manager-marketplace-source <https-url> --manager-click-external --manager-viewport-width <pixels> --manager-breadcrumb-width <pixels>] [--manager-lifecycle-source <absolute-directory> --report <json>] [--trigger-screenshot <png>]')
}
if (parsed.values['ui-catalog'] && parsed.values.report === undefined) {
  throw new Error('--ui-catalog requires --report so screenshots and machine-readable assertions share one artifact directory')
}
if (parsed.values['plugin-console-exercise'] && parsed.values.report === undefined) {
  throw new Error('--plugin-console-exercise requires --report')
}
if (parsed.values['generation-transaction-exercise'] && parsed.values['manager-lifecycle-source'] === undefined) {
  throw new Error('--generation-transaction-exercise requires --manager-lifecycle-source')
}
if (parsed.values['open-route'] !== undefined && parsed.values['click-surface'] !== undefined) {
  throw new Error('--open-route and --click-surface are mutually exclusive')
}
if ((parsed.values['permission-capability'] === undefined) !== (parsed.values['permission-policy'] === undefined)) {
  throw new Error('--permission-capability and --permission-policy must be provided together')
}
if (parsed.values['authorization-plugin'] === undefined && (
  parsed.values['authorization-decision'] !== undefined
  || parsed.values['authorization-decline-optional']
  || parsed.values['authorization-screenshot'] !== undefined
)) throw new Error('authorization smoke options require --authorization-plugin')
if (parsed.values['manager-lifecycle-source'] !== undefined) {
  if (parsed.values.report === undefined) throw new Error('--manager-lifecycle-source requires --report')
  if (!path.isAbsolute(parsed.values['manager-lifecycle-source'])) {
    throw new Error('--manager-lifecycle-source must be an absolute local package directory')
  }
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

async function pointerClick(rect) {
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
}

async function pressKey(key, code, keyCode) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    ...(key.length === 1 ? { text: key } : {}),
  })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
}

await send('Runtime.enable')
await send('Page.enable')
const locale = parsed.values.locale
if (locale !== undefined) {
  if (!['en', 'zh-CN'].includes(locale)) throw new Error(`unknown smoke locale: ${locale}`)
  await send('Runtime.evaluate', {
    expression: `document.documentElement.lang = ${JSON.stringify(locale)}`,
    returnByValue: true,
  })
  await new Promise(resolve => setTimeout(resolve, 120))
}
const colorScheme = parsed.values['color-scheme']
if (colorScheme !== undefined) {
  if (!['light', 'dark'].includes(colorScheme)) throw new Error(`unknown color scheme: ${colorScheme}`)
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: colorScheme }],
  })
  await send('Runtime.evaluate', {
    expression: `(() => {
      globalThis.__cordisxRestoreSmokeTheme?.()
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const switcher = trigger?.previousElementSibling
      const host = trigger?.parentElement
      if (!(trigger instanceof HTMLElement) || !(switcher instanceof HTMLElement) || !(host instanceof HTMLElement)) return false
      const records = [host, switcher, trigger].map(element => ({ element, style: element.getAttribute('style') }))
      const themeRecords = [document.documentElement, document.body]
        .filter(element => element instanceof HTMLElement)
        .map(element => ({ element, value: element.getAttribute('data-theme') }))
      globalThis.__cordisxRestoreSmokeTheme = () => {
        for (const record of records) {
          if (record.style === null) record.element.removeAttribute('style')
          else record.element.setAttribute('style', record.style)
        }
        for (const record of themeRecords) {
          if (record.value === null) record.element.removeAttribute('data-theme')
          else record.element.setAttribute('data-theme', record.value)
        }
        delete globalThis.__cordisxRestoreSmokeTheme
      }
      const dark = ${JSON.stringify(colorScheme)} === 'dark'
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(colorScheme)})
      host.style.setProperty('background-color', dark ? '#1a1c1f' : '#ffffff', 'important')
      host.style.setProperty('color', dark ? '#f7f8f8' : '#1a1c1f', 'important')
      switcher.style.setProperty('color', 'inherit', 'important')
      trigger.style.setProperty('color', 'inherit', 'important')
      return true
    })()`,
    returnByValue: true,
  })
  await new Promise(resolve => setTimeout(resolve, 80))
}
if (parsed.values['select-thread'] !== undefined) {
  const target = await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelector('.cxm-close')?.click()
      const id = ${JSON.stringify(parsed.values['select-thread'])}
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === id)
      const rect = row?.getBoundingClientRect()
      return rect === undefined ? null : { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`,
    returnByValue: true,
  })
  const value = target.result?.value
  if (value === null || value === undefined) throw new Error(`thread row not found: ${parsed.values['select-thread']}`)
  await pointerClick(value)
  await new Promise(resolve => setTimeout(resolve, 1800))
  const selected = await send('Runtime.evaluate', {
    expression: `(() => ({ clicked: true, id: ${JSON.stringify(parsed.values['select-thread'])},
      selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null }))()`,
    returnByValue: true,
  })
  console.log(`thread=${JSON.stringify(selected.result?.value)}`)
}
if (parsed.values['permission-capability'] !== undefined) {
  const policy = parsed.values['permission-policy']
  if (!['allow', 'ask', 'deny'].includes(policy)) throw new Error(`unknown permission policy: ${policy}`)
  const permission = await send('Runtime.evaluate', {
    expression: `(async () => {
      const owner = ${JSON.stringify(parsed.values['plugin-owner'] ?? 'slot-showcase')}
      const capabilities = ${JSON.stringify(parsed.values['permission-capability'])}
      const policy = ${JSON.stringify(policy)}
      for (const capability of capabilities) {
        await globalThis.__cordisxRuntime?.setPermissionPolicy?.(owner, capability, policy)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
      return globalThis.__cordisxRuntime?.snapshot?.().permissions?.filter(item => item.identity.id === owner && capabilities.includes(item.capability)) ?? []
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(`permission=${JSON.stringify(permission.result?.value)}`)
}
if (parsed.values['click-surface'] !== undefined) {
  const target = await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelector('.cxm-close')?.click()
      for (const page of document.querySelectorAll('[data-cordisx-page]')) page.querySelector('button[aria-label="Close"]')?.click()
      const surface = ${JSON.stringify(parsed.values['click-surface'])}
      const label = ${JSON.stringify(parsed.values['click-label'])}
      const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(surface) + '"]')
      const buttons = [...(root?.querySelectorAll('button') ?? [])]
      const button = label === undefined ? buttons[0] : buttons.find(item => item.getAttribute('aria-label') === label)
      const rect = button?.getBoundingClientRect()
      return rect === undefined ? null : {
        surface, label: button?.getAttribute('aria-label') ?? null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })()`,
    returnByValue: true,
  })
  const value = target.result?.value
  if (value?.rect === undefined) throw new Error(`surface pointer target not found: ${parsed.values['click-surface']}`)
  await pointerClick(value.rect)
  await new Promise(resolve => setTimeout(resolve, 300))
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const page = document.querySelector('[data-cordisx-page]')
      const outlet = page?.closest('[data-cordisx-page-outlet]')
      return {
        target: ${JSON.stringify(value)},
        page: page?.getAttribute('data-cordisx-page') ?? null,
        outlet: outlet?.getAttribute('data-cordisx-page-outlet') ?? null,
        error: document.querySelector('[data-cordisx-surface-host=${JSON.stringify(parsed.values['click-surface'])}] button')?.dataset.error ?? null,
      }
    })()`,
    returnByValue: true,
  })
  console.log(`surface-click=${JSON.stringify(clicked.result?.value)}`)
  await send('Runtime.evaluate', {
    expression: `globalThis.__cordisxSmokeSurfaceClick = ${JSON.stringify(clicked.result?.value)}`,
  })
}
let demoReport
if (parsed.values['demo-kind'] !== undefined) {
  const allowed = new Set(['followup', 'steer', 'inject', 'pre-step', 'system-prompt-section', 'system-prompt-context'])
  for (const kind of parsed.values['demo-kind']) {
    if (!allowed.has(kind)) throw new Error(`unknown Agent Trace demo kind: ${kind}`)
  }
  const platformMode = await evaluateByValue(`globalThis.__cordisxRuntime?.snapshot?.().platform?.mode ?? null`)
  if (platformMode !== 'unavailable') {
    throw new Error(`refusing Agent Trace smoke writes while adapter mode is ${String(platformMode)}; use an unavailable isolated renderer`)
  }
  const before = await evaluateByValue(`(() => ({
    page: document.querySelector('[data-agent-trace-showcase="true"]') !== null,
    rows: document.querySelectorAll('[data-agent-trace-showcase="true"] .cxt-row').length,
  }))()`)
  if (!before.page) throw new Error('Agent Trace page must be mounted before --demo-kind')
  const invocations = []
  for (const kind of parsed.values['demo-kind']) {
    const target = await evaluateByValue(`(() => {
      const button = document.querySelector('[data-agent-trace-showcase="true"] [data-demo-kind=${JSON.stringify(kind)}]')
      const rect = button?.getBoundingClientRect()
      return rect === undefined ? null : { disabled: button.disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    })()`)
    if (target === null || target.disabled) throw new Error(`Agent Trace demo is unavailable: ${kind}`)
    await pointerClick(target.rect)
    invocations.push({ kind, rect: target.rect })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  let cleared = false
  if (parsed.values['clear-demo']) {
    const target = await evaluateByValue(`(() => {
      const button = document.querySelector('[data-agent-trace-showcase="true"] .cxt-clear')
      const rect = button?.getBoundingClientRect()
      return rect === undefined ? null : { disabled: button.disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    })()`)
    if (target === null || target.disabled) throw new Error('Agent Trace clear control is unavailable')
    await pointerClick(target.rect)
    cleared = true
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  const after = await evaluateByValue(`(() => {
    const page = document.querySelector('[data-agent-trace-showcase="true"]')
    return {
      badge: page?.querySelector('.cxt-badge')?.textContent ?? null,
      integrity: page?.querySelector('.cxt-integrity')?.textContent ?? null,
      rows: [...(page?.querySelectorAll('.cxt-row') ?? [])].map(row => ({
        id: row.getAttribute('data-event-id'), text: row.textContent?.trim() ?? '',
      })),
    }
  })()`)
  demoReport = { platformMode, before, invocations, cleared, after }
  console.log(`agent-trace-demo=${JSON.stringify(demoReport)}`)
}
let pluginLifecycleReport
if (parsed.values['plugin-lifecycle']) {
  const owner = parsed.values['plugin-owner']
  const surface = parsed.values['click-surface']
  const label = parsed.values['click-label']
  if (owner === undefined || surface === undefined) {
    throw new Error('--plugin-lifecycle requires --plugin-owner and --click-surface')
  }
  const beforeClose = await evaluateByValue(`(() => {
    const page = document.querySelector('[data-cordisx-page]')
    const pageClose = page?.querySelector('button[aria-label="Close"]')
    const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')
    const surfaceButtons = [...(root?.querySelectorAll('button') ?? [])]
    const surfaceToggle = ${JSON.stringify(label)} === undefined
      ? surfaceButtons.find(item => item.getAttribute('aria-pressed') === 'true')
      : surfaceButtons.find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)} && item.getAttribute('aria-pressed') === 'true')
    const button = pageClose ?? surfaceToggle
    const rect = button?.getBoundingClientRect()
    return {
      page: page?.getAttribute('data-cordisx-page') ?? null,
      control: pageClose === button ? 'page-close' : surfaceToggle === button ? 'surface-toggle' : null,
      rect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })()`)
  if (beforeClose.rect === null) throw new Error('mounted page close path not found for --plugin-lifecycle')
  await pointerClick(beforeClose.rect)
  await new Promise(resolve => setTimeout(resolve, 160))
  const afterClose = await evaluateByValue(`(() => ({
    page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
    mounted: globalThis.__cordisxRuntime?.snapshot?.().navigation?.outlets
      ?.find(item => item.id === 'session.content')?.mounted ?? null,
    pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')?.querySelectorAll('button') ?? [])]
      .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${JSON.stringify(label)})?.getAttribute('aria-pressed') ?? null,
  }))()`)
  const reopenTarget = await evaluateByValue(`(() => {
    const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')
    const buttons = [...(root?.querySelectorAll('button') ?? [])]
    const button = ${JSON.stringify(label)} === undefined
      ? buttons[0]
      : buttons.find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)})
    globalThis.__cordisxAgentTraceStaleEntry = button
    const rect = button?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  if (reopenTarget === null) throw new Error('surface entry not found after page close')
  await pointerClick(reopenTarget)
  await new Promise(resolve => setTimeout(resolve, 200))
  const reopened = await evaluateByValue(`(() => ({
    page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
    pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')?.querySelectorAll('button') ?? [])]
      .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${JSON.stringify(label)})?.getAttribute('aria-pressed') ?? null,
  }))()`)
  const blocked = await evaluateByValue(`(async () => {
    await globalThis.__cordisxRuntime.setPluginBlocked(${JSON.stringify(owner)}, true)
    await new Promise(resolve => setTimeout(resolve, 120))
    const snapshot = globalThis.__cordisxRuntime.snapshot()
    return {
      status: snapshot.plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
      surfaceEntries: document.querySelectorAll('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"] button').length,
      pages: snapshot.navigation.pages.filter(page => page.qualifiedId.startsWith(${JSON.stringify(`${owner}:`)})).length,
      commands: snapshot.commands.filter(command => command.qualifiedId.startsWith(${JSON.stringify(`${owner}:`)})).length,
      routes: snapshot.navigation.routes.filter(route => route.qualifiedId.startsWith(${JSON.stringify(`${owner}:`)})).length,
    }
  })()`, true)
  const staleInvocation = await evaluateByValue(`(async () => {
    globalThis.__cordisxAgentTraceStaleEntry?.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    return {
      page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
      status: globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
    }
  })()`, true)
  const restored = await evaluateByValue(`(async () => {
    await globalThis.__cordisxRuntime.setPluginBlocked(${JSON.stringify(owner)}, false)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')
      const buttons = [...(root?.querySelectorAll('button') ?? [])]
      const button = ${JSON.stringify(label)} === undefined
        ? buttons[0]
        : buttons.find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (button !== undefined) {
        const rect = button.getBoundingClientRect()
        return {
          status: globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
          freshEntry: button !== globalThis.__cordisxAgentTraceStaleEntry,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return null
  })()`, true)
  if (restored?.rect === undefined) throw new Error('plugin did not restore its surface entry')
  await pointerClick(restored.rect)
  await new Promise(resolve => setTimeout(resolve, 200))
  const afterRestoreClick = await evaluateByValue(`(() => ({
    page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
    outlet: document.querySelector('[data-cordisx-page]')?.closest('[data-cordisx-page-outlet]')?.getAttribute('data-cordisx-page-outlet') ?? null,
    pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${JSON.stringify(surface)}) + '"]')?.querySelectorAll('button') ?? [])]
      .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${JSON.stringify(label)})?.getAttribute('aria-pressed') ?? null,
  }))()`)
  pluginLifecycleReport = { beforeClose, afterClose, reopened, blocked, staleInvocation, restored, afterRestoreClick }
  console.log(`plugin-lifecycle=${JSON.stringify(pluginLifecycleReport)}`)
}
if (parsed.values['open-route'] !== undefined) {
  const opened = await send('Runtime.evaluate', {
    expression: `(async () => {
      document.querySelector('.cxm-close')?.click()
      for (const page of document.querySelectorAll('[data-cordisx-page]')) {
        page.querySelector('button[aria-label="Close"]')?.click()
      }
      await new Promise(resolve => setTimeout(resolve, 80))
      const route = ${JSON.stringify(parsed.values['open-route'])}
      const sessionId = ${JSON.stringify(parsed.values['session-id'])}
      const owner = ${JSON.stringify(parsed.values['plugin-owner'] ?? 'slot-showcase')}
      await globalThis.__cordisxRuntime?.navigate?.(owner, {
        id: route,
        ...(sessionId === undefined ? {} : { params: { sessionId } }),
      })
      await new Promise(resolve => setTimeout(resolve, 180))
      const page = document.querySelector('[data-cordisx-page]')
      const outlet = page?.closest('[data-cordisx-page-outlet]')
      const pageRect = page?.getBoundingClientRect()
      const outletRect = outlet?.getBoundingClientRect()
      const anchor = outlet?.parentElement
      const anchorRect = anchor?.getBoundingClientRect()
      return {
        owner,
        route,
        page: page?.getAttribute('data-cordisx-page') ?? null,
        pageRect: pageRect === undefined ? null : { x: pageRect.x, y: pageRect.y, width: pageRect.width, height: pageRect.height },
        outlet: outlet?.getAttribute('data-cordisx-page-outlet') ?? null,
        outletStyle: outlet?.getAttribute('style') ?? null,
        outletRect: outletRect === undefined ? null : { x: outletRect.x, y: outletRect.y, width: outletRect.width, height: outletRect.height },
        anchorStyle: anchor === null ? null : getComputedStyle(anchor).cssText,
        anchorPosition: anchor === null ? null : getComputedStyle(anchor).position,
        anchorRect: anchorRect === undefined ? null : { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height },
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(`route=${JSON.stringify(opened.result?.value)}`)
}
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
      platform: snapshot?.platform ?? null,
      permissions: snapshot?.permissions?.map(permission => ({
        pluginId: permission.identity.id,
        capability: permission.capability,
        required: permission.required,
        policy: permission.policy,
        reasonText: permission.reasonText,
        scope: permission.scope,
        lastRequested: permission.lastRequested ?? null,
        denialCount: permission.denialCount,
        availability: permission.availability,
      })) ?? [],
      capabilityProviders: snapshot?.capabilityProviders ?? [],
      surfaceClick: globalThis.__cordisxSmokeSurfaceClick ?? null,
      localization: snapshot?.localization ?? null,
      contributions: snapshot?.registrations?.map(item => ({
        owner: item.owner, surface: item.surface, id: item.id, valid: item.valid,
        visible: item.visible, rendered: item.rendered, pending: item.pending,
        error: item.error ?? null,
      })) ?? [],
      commands: snapshot?.commands?.map(command => ({ id: command.qualifiedId, running: command.running, error: command.error ?? null })) ?? [],
      routes: snapshot?.navigation?.routes?.map(route => ({ id: route.qualifiedId, valid: route.valid, error: route.error ?? null })) ?? [],
      pages: snapshot?.navigation?.pages?.map(page => page.qualifiedId) ?? [],
      outlets: snapshot?.navigation?.outlets?.map(outlet => ({
        id: outlet.id, available: outlet.available, contextKey: outlet.contextKey ?? null,
        placement: outlet.placement, mounted: outlet.mounted, activeRoute: outlet.activeRoute ?? null,
        error: outlet.error ?? null,
      })) ?? [],
      native: {
        mainAnchors: document.querySelectorAll('[data-app-shell-main-content-layout="thread-edge-scroll"]').length,
        sessionAnchors: document.querySelectorAll('[data-codex-thread-reference-drop-target]').length,
        selectedThread: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
        threadRows: document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,
        rightPanels: document.querySelectorAll('[data-pip-home-surface="thread-summary-panel"]').length,
        bottomPanels: document.querySelectorAll('[data-panel-location="bottom"], [data-bottom-panel]').length,
        responseMarkers: [...document.querySelectorAll('[data-response-annotation-conversation]')].map(element => ({
          sessionId: element.getAttribute('data-response-annotation-conversation'),
          visible: element.getClientRects().length > 0,
          ancestors: [...function * () { for (let current = element.parentElement, depth = 0; current !== null && depth < 20; current = current.parentElement, depth += 1) yield current }()]
            .map(current => ({ tag: current.tagName.toLowerCase(), data: Object.fromEntries([...current.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) })),
        })),
        composerMarkers: [...document.querySelectorAll('[data-above-composer-conversation-id]')].map(element => ({
          sessionId: element.getAttribute('data-above-composer-conversation-id'),
          visible: element.getClientRects().length > 0,
          ancestors: [...function * () { for (let current = element.parentElement, depth = 0; current !== null && depth < 20; current = current.parentElement, depth += 1) yield current }()]
            .map(current => ({ tag: current.tagName.toLowerCase(), data: Object.fromEntries([...current.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) })),
        })),
        sessionAnchorProbe: (() => {
          const selectedRaw = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
          const sessionId = selectedRaw?.startsWith('local:') ? selectedRaw.slice('local:'.length) : null
          const rect = (element) => {
            const value = element.getBoundingClientRect()
            return { x: value.x, y: value.y, width: value.width, height: value.height }
          }
          const data = (element) => Object.fromEntries([...element.attributes]
            .filter(attribute => attribute.name.startsWith('data-') && !attribute.name.startsWith('data-cordisx-'))
            .map(attribute => [attribute.name, attribute.value]))
          const response = sessionId === null ? [] : [...document.querySelectorAll('[data-response-annotation-conversation]')]
            .filter(element => element.getAttribute('data-response-annotation-conversation') === sessionId)
          const composer = sessionId === null ? [] : [...document.querySelectorAll('[data-above-composer-conversation-id]')]
            .filter(element => element.getAttribute('data-above-composer-conversation-id') === sessionId)
          const semantic = [...document.querySelectorAll('[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]')]
            .map((element, index) => {
              const responseMatches = sessionId === null ? 0 : [...element.querySelectorAll('[data-response-annotation-conversation]')]
                .filter(marker => marker.getAttribute('data-response-annotation-conversation') === sessionId).length
              const composerMatches = sessionId === null ? 0 : [...element.querySelectorAll('[data-above-composer-conversation-id]')]
                .filter(marker => marker.getAttribute('data-above-composer-conversation-id') === sessionId).length
              const value = element.getBoundingClientRect()
              return {
                index, data: data(element), rect: rect(element), visible: element.getClientRects().length > 0 && value.width > 0 && value.height > 0,
                responseMatches, composerMatches, joined: responseMatches === 1 && composerMatches === 1,
              }
            })
          let commonAncestor = null
          if (response.length === 1 && composer.length === 1) {
            const composerAncestors = new Set(function * () { for (let current = composer[0]; current !== null; current = current.parentElement) yield current }())
            const candidate = [...function * () { for (let current = response[0]; current !== null; current = current.parentElement) yield current }()]
              .find(element => composerAncestors.has(element))
            if (candidate !== undefined) commonAncestor = {
              tag: candidate.tagName.toLowerCase(), data: data(candidate), rect: rect(candidate),
              semantic: candidate.matches('[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]'),
            }
          }
          return {
            selectedRaw: selectedRaw ?? null, sessionId, responseMatches: response.length, composerMatches: composer.length,
            legacyCandidates: document.querySelectorAll('[data-codex-thread-reference-drop-target]').length,
            semanticCandidates: semantic, commonAncestor,
          }
        })(),
        sessionCandidates: [...document.querySelectorAll('[data-codex-thread-reference-drop-target]')].map((element, index) => {
          const rect = element.getBoundingClientRect()
          return {
            index, connected: element.isConnected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: getComputedStyle(element).display,
            visibility: getComputedStyle(element).visibility,
            responseSession: element.querySelector('[data-response-annotation-conversation]')?.getAttribute('data-response-annotation-conversation') ?? null,
            composerSession: element.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null,
          }
        }),
      },
      controls: [...document.querySelectorAll('button')].map(button => ({
        label: button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '',
        pressed: button.getAttribute('aria-pressed'),
        expanded: button.getAttribute('aria-expanded'),
      })).filter(item => item.label !== '').slice(0, 120),
      separators: [...document.querySelectorAll('[role="separator"]')].map(separator => {
        const rect = separator.getBoundingClientRect()
        return { orientation: separator.getAttribute('aria-orientation'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }),
      threadCandidates: [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].filter(element => element.getClientRects().length > 0).slice(0, 8).map(element => ({
        id: element.getAttribute('data-app-action-sidebar-thread-id'),
        text: element.textContent?.trim().slice(0, 120) ?? '',
        selected: element.getAttribute('data-app-action-sidebar-thread-selected'),
      })),
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

async function evaluateByValue(expression, awaitPromise = false) {
  const value = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (value.exceptionDetails !== undefined) throw new Error(value.exceptionDetails.text ?? 'CDP evaluation failed')
  return value.result?.value
}

let exerciseReport
let settingsTabsReport
let configExerciseReport
if (parsed.values['manager-settings-exercise']) {
  const owner = parsed.values['plugin-owner'] ?? 'settings-tab-demo'
  const qualifiedTabId = `${owner}:settings`
  const initial = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    trigger?.click()
    document.querySelector('[data-tab="settings"]')?.click()
    await wait(120)
    const main = document.querySelector('[data-app-shell-main-content-layout]')
    const selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')
    globalThis.__cordisxSettingsSmokeNative = { main, selected }
    const snapshot = runtime.snapshot()
    const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
    const panel = document.querySelector('[data-settings-root] [role="tabpanel"]')
    return {
      url: location.href,
      tabs: [...document.querySelectorAll('[data-settings-tab]')].map(element => ({
        id: element.getAttribute('data-settings-tab'),
        owner: element.getAttribute('data-settings-owner'),
        title: element.textContent?.trim() ?? '',
        role: element.getAttribute('role'),
        selected: element.getAttribute('aria-selected'),
        tabIndex: element.tabIndex,
        icon: element.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null,
      })),
      projection: snapshot.settingsTabs,
      structuredHeader: tab !== null
        && tab.querySelector('.cxm-tab-content') !== null
        && tab.querySelector('[data-host-icon]') !== null
        && tab.querySelector('section, style') === null,
      panel: panel === null ? null : {
        role: panel.getAttribute('role'),
        labelledBy: panel.getAttribute('aria-labelledby'),
        controls: tab?.getAttribute('aria-controls') ?? null,
      },
      points: ['manager.settings.tabs', 'manager.settings.content'].map(id => {
        const point = snapshot.extensionPoints.points.find(item => item.id === id)
        return point === undefined ? null : {
          id, available: point.available, usingPluginCount: point.usingPluginCount,
          activePluginCount: point.activePluginCount,
        }
      }),
      native: {
        mainPresent: main !== null,
        mainConnected: main?.isConnected ?? false,
        selectedId: selected?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
        selectedConnected: selected?.isConnected ?? false,
      },
    }
  })()`, true)

  const tabRect = async () => await evaluateByValue(`(() => {
    const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
    const rect = tab?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  const firstRect = await tabRect()
  if (firstRect === null) throw new Error(`manager settings demo tab not found: ${qualifiedTabId}`)
  await pointerClick(firstRect)
  await new Promise(resolve => setTimeout(resolve, 250))
  const mounted = await evaluateByValue(`(() => {
    const runtime = globalThis.__cordisxRuntime
    const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
    const panel = document.querySelector('[data-settings-root] [role="tabpanel"]')
    const page = panel?.querySelector('[data-cordisx-settings-page="${qualifiedTabId}"]')
    return {
      activeTab: tab?.getAttribute('aria-selected') === 'true' ? ${JSON.stringify(qualifiedTabId)} : null,
      focusedTab: document.activeElement?.getAttribute('data-settings-tab') ?? null,
      contentMounted: page?.querySelector('[data-settings-demo-content="mounted"]') !== null,
      bodyOnly: page !== null && page.querySelector('[data-cordisx-page-chrome]') === null,
      controlledBody: page?.parentElement?.hasAttribute('data-settings-panel-body') ?? false,
      panelLabel: panel?.getAttribute('aria-labelledby') ?? null,
      outlet: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.settings.content'),
      url: location.href,
    }
  })()`)

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await new Promise(resolve => setTimeout(resolve, 220))
  const keyboard = await evaluateByValue(`(() => ({
    selected: document.querySelector('[data-settings-tab][aria-selected="true"]')?.getAttribute('data-settings-tab') ?? null,
    focused: document.activeElement?.getAttribute('data-settings-tab') ?? null,
    pluginContentPresent: document.querySelector('[data-settings-demo-content]') !== null,
  }))()`)

  const mountAgain = async () => {
    const rect = await tabRect()
    if (rect === null) throw new Error(`manager settings demo tab did not restore: ${qualifiedTabId}`)
    await pointerClick(rect)
    await new Promise(resolve => setTimeout(resolve, 220))
  }
  await mountAgain()
  const source = await evaluateByValue(`globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.source ?? null`)
  if (source === null) throw new Error(`manager settings demo plugin source not found: ${owner}`)

  const denyPoint = async (pointId) => await evaluateByValue(`(async () => {
    const runtime = globalThis.__cordisxRuntime
    await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, ${JSON.stringify(pointId)}, 'deny')
    await new Promise(resolve => setTimeout(resolve, 220))
    return {
      tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
      contentPresent: document.querySelector('[data-settings-demo-content]') !== null,
      fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
      outletMounted: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.settings.content')?.mounted ?? null,
    }
  })()`, true)
  const restorePoint = async (pointId) => await evaluateByValue(`(async () => {
    const runtime = globalThis.__cordisxRuntime
    await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, ${JSON.stringify(pointId)}, 'inherit')
    await new Promise(resolve => setTimeout(resolve, 220))
    return {
      tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
      fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
    }
  })()`, true)

  const surfaceDenied = await denyPoint('manager.settings.tabs')
  const surfaceRestored = await restorePoint('manager.settings.tabs')
  await mountAgain()
  const outletDenied = await denyPoint('manager.settings.content')
  const outletRestored = await restorePoint('manager.settings.content')
  await mountAgain()

  const blocked = await evaluateByValue(`(async () => {
    const runtime = globalThis.__cordisxRuntime
    await runtime.setPluginBlocked(${JSON.stringify(owner)}, true)
    await new Promise(resolve => setTimeout(resolve, 220))
    return {
      status: runtime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
      tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
      contentPresent: document.querySelector('[data-settings-demo-content]') !== null,
      fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
    }
  })()`, true)
  const restored = await evaluateByValue(`(async () => {
    const runtime = globalThis.__cordisxRuntime
    await runtime.setPluginBlocked(${JSON.stringify(owner)}, false)
    await new Promise(resolve => setTimeout(resolve, 260))
    return {
      status: runtime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
      tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
      fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
    }
  })()`, true)

  const locale = await evaluateByValue(`(async () => {
    const original = document.documentElement.lang
    const projectedLocale = original.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
    document.documentElement.lang = projectedLocale
    await new Promise(resolve => setTimeout(resolve, 260))
    const projected = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')?.textContent?.trim() ?? null
    const runtimeTitle = globalThis.__cordisxRuntime.snapshot().settingsTabs.find(item => item.id === ${JSON.stringify(qualifiedTabId)})?.title ?? null
    document.documentElement.lang = original
    await new Promise(resolve => setTimeout(resolve, 260))
    return {
      original, projectedLocale, projected, runtimeTitle,
      expectedProjected: projectedLocale.toLowerCase().startsWith('zh') ? '演示插件' : 'Demo plugin',
      expectedRestored: original.toLowerCase().startsWith('zh') ? '演示插件' : 'Demo plugin',
      restored: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')?.textContent?.trim() ?? null,
    }
  })()`, true)
  await mountAgain()

  const final = await evaluateByValue(`(() => {
    const refs = globalThis.__cordisxSettingsSmokeNative
    const snapshot = globalThis.__cordisxRuntime.snapshot()
    const accesses = snapshot.extensionPoints.accessDiagnostics
      .filter(item => item.request.identity.pluginId === ${JSON.stringify(owner)}
        && ['manager.settings.tabs', 'manager.settings.content'].includes(item.request.identity.pointId))
    return {
      url: location.href,
      contentMounted: document.querySelector('[data-settings-demo-content="mounted"]') !== null,
      native: {
        sameMain: refs?.main === document.querySelector('[data-app-shell-main-content-layout]'),
        mainConnected: refs?.main?.isConnected ?? false,
        sameSelected: refs?.selected === document.querySelector('[data-app-action-sidebar-thread-selected="true"]'),
        selectedConnected: refs?.selected?.isConnected ?? false,
        selectedStable: refs?.selected == null
          ? document.querySelector('[data-app-action-sidebar-thread-selected="true"]') === null
          : refs.selected === document.querySelector('[data-app-action-sidebar-thread-selected="true"]') && refs.selected.isConnected,
      },
      access: {
        operations: [...new Set(accesses.map(item => item.request.operation))],
        generations: [...new Set(accesses.map(item => item.request.generation))],
        allAttributed: accesses.length >= 3 && accesses.every(item => item.request.identity.source === ${JSON.stringify(source)}),
      },
    }
  })()`)
  settingsTabsReport = {
    owner, qualifiedTabId, initial, mounted, keyboard,
    policy: { surfaceDenied, surfaceRestored, outletDenied, outletRestored },
    lifecycle: { blocked, restored }, locale, final,
    passed: initial.url === 'app://-/index.html'
      && initial.structuredHeader === true
      && initial.tabs.map(item => item.id).join(',') === ['host:marketplace', qualifiedTabId, 'host:runtime', 'host:launcher'].join(',')
      && mounted.contentMounted === true && mounted.bodyOnly === true && mounted.controlledBody === true
      && mounted.url === initial.url && keyboard.selected === 'host:runtime' && keyboard.focused === 'host:runtime'
      && surfaceDenied.tabPresent === false && surfaceDenied.contentPresent === false && surfaceDenied.fallbackSelected === true
      && outletDenied.tabPresent === false && outletDenied.contentPresent === false && outletDenied.fallbackSelected === true
      && surfaceRestored.tabPresent === true && surfaceRestored.fallbackSelected === true
      && outletRestored.tabPresent === true && outletRestored.fallbackSelected === true
      && blocked.status === 'blocked' && blocked.tabPresent === false && blocked.contentPresent === false && blocked.fallbackSelected === true
      && restored.status === 'active' && restored.tabPresent === true && restored.fallbackSelected === true
      && locale.projected === locale.expectedProjected && locale.runtimeTitle === locale.expectedProjected
      && locale.restored === locale.expectedRestored
      && final.url === initial.url && final.contentMounted === true
      && final.native.sameMain === true && final.native.mainConnected === true
      && final.native.selectedStable === true
      && final.access.operations.includes('surface.route.navigate')
      && final.access.operations.includes('outlet.route.navigate')
      && final.access.operations.includes('outlet.page.mount')
      && final.access.allAttributed === true,
  }
  console.log(`manager-settings=${JSON.stringify(settingsTabsReport, null, 2)}`)
}

if (parsed.values['config-exercise']) {
  configExerciseReport = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const value = predicate()
        if (value) return value
        await wait(50)
      }
      throw new Error('timed out waiting for ' + label)
    }
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    const openPluginConfig = async owner => {
      document.querySelector('[data-cordisx-manager-trigger]')?.click()
      document.querySelector('[data-tab="plugins"]')?.click()
      await waitFor(() => document.querySelector('[data-plugin-id="' + owner + '"]'), owner + ' manager row')
      document.querySelector('[data-plugin-id="' + owner + '"]')?.click()
      await waitFor(() => document.querySelector('[data-plugin-detail-tab="config"]'), owner + ' detail tabs')
      document.querySelector('[data-plugin-detail-tab="config"]')?.click()
      return waitFor(() => document.querySelector('[data-plugin-config-form="' + owner + '"]'), owner + ' config form')
    }
    const edit = async (owner, path, value, selector) => {
      const before = runtime.snapshot().plugins.find(plugin => plugin.id === owner)
      const form = await openPluginConfig(owner)
      const field = form.querySelector('[data-config-path="' + path + '"]')
      const control = await waitFor(() => field?.querySelector(selector), owner + ' ' + path + ' control')
      const label = field?.querySelector('label')
      const labelOwnsControl = label?.htmlFor !== '' && label?.htmlFor === control.id
      const panelText = form.closest('[role="tabpanel"]')?.textContent ?? ''
      const productSurface = {
        label: label?.textContent ?? null,
        rawPathVisible: field?.querySelector('.cxm-config-path') !== null,
        summaryGridVisible: form.closest('[role="tabpanel"]')?.querySelector('.cxm-detail-grid') !== null,
        internalMetadataVisible: ['Schemastery', 'Revision', '实时发布（不重载）'].some(value => panelText.includes(value)),
      }
      control.value = String(value)
      control.dispatchEvent(new Event('input', { bubbles: true }))
      form.requestSubmit()
      const after = await waitFor(() => {
        const plugin = runtime.snapshot().plugins.find(item => item.id === owner)
        return plugin?.configuration.revision === (before?.configuration.revision ?? -1) + 1 ? plugin : undefined
      }, owner + ' revision commit')
      return {
        beforeRevision: before?.configuration.revision ?? null,
        afterRevision: after.configuration.revision,
        applies: after.configuration.applies,
        labelOwnsControl,
        controlType: control.type,
        panelRole: form.closest('[role="tabpanel"]')?.getAttribute('role') ?? null,
        productSurface,
      }
    }
    const liveState = globalThis.__cordisxConfigFixture
    const restartState = globalThis.__cordisxRestartConfigFixture
    if (liveState === undefined || restartState === undefined) throw new Error('config smoke fixture state is unavailable')
    const before = {
      liveApply: liveState.liveApply,
      liveDispose: liveState.liveDispose,
      restartApply: [...restartState.restartApply],
      restartDispose: restartState.restartDispose,
    }
    const live = await edit('live-config', 'timeout', 47, 'input[type="range"]')
    document.querySelector('.cxm-back')?.click()
    const restart = await edit('restart-config', 'label', 'smoke-restart', 'input[type="text"]')
    const after = {
      liveApply: liveState.liveApply,
      liveDispose: liveState.liveDispose,
      liveValues: [...liveState.liveValues],
      restartApply: [...restartState.restartApply],
      restartDispose: restartState.restartDispose,
    }
    const assertions = {
      appRenderer: location.href === 'app://-/index.html',
      structuredForms: live.panelRole === 'tabpanel' && restart.panelRole === 'tabpanel',
      accessibleLabels: live.labelOwnsControl && restart.labelOwnsControl,
      productTaskSurface: !live.productSurface.rawPathVisible && !restart.productSurface.rawPathVisible
        && !live.productSurface.summaryGridVisible && !restart.productSurface.summaryGridVisible
        && !live.productSurface.internalMetadataVisible && !restart.productSurface.internalMetadataVisible,
      customRenderer: live.controlType === 'range',
      liveWithoutReload: after.liveApply === before.liveApply && after.liveDispose === before.liveDispose
        && after.liveValues.at(-1) === 47,
      owningRestartOnly: after.restartApply.length === before.restartApply.length + 1
        && after.restartApply.at(-1) === 'smoke-restart' && after.restartDispose === before.restartDispose + 1
        && after.liveApply === before.liveApply,
      revisionsCommitted: live.afterRevision === live.beforeRevision + 1
        && restart.afterRevision === restart.beforeRevision + 1,
    }
    return {
      result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
      url: location.href,
      live,
      restart,
      before,
      after,
      assertions,
    }
  })()`, true)
  console.log(`configExercise=${JSON.stringify(configExerciseReport, null, 2)}`)
}

if (parsed.values.exercise) {
  await evaluateByValue(`(() => {
    document.querySelector('.cxm-close')?.click()
    for (const page of document.querySelectorAll('[data-cordisx-page]')) {
      page.querySelector('button[aria-label="Close"]')?.click()
    }
  })()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  const separatorBefore = await evaluateByValue(`(() => {
    const separator = [...document.querySelectorAll('[role="separator"]')]
      .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-orientation') === 'vertical')
      .sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0]
    const rect = separator?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  let drag = { attempted: false }
  if (separatorBefore !== null && separatorBefore !== undefined) {
    const startX = separatorBefore.x + separatorBefore.width / 2
    const startY = Math.max(80, separatorBefore.y + Math.min(separatorBefore.height / 2, 300))
    const endX = startX + 36
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: startY, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: startY, button: 'left', buttons: 0, clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, 350))
    const separatorAfter = await evaluateByValue(`(() => {
      const separator = [...document.querySelectorAll('[role="separator"]')]
        .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-orientation') === 'vertical')
        .sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0]
      const rect = separator?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    drag = { attempted: true, before: separatorBefore, after: separatorAfter, deltaX: separatorAfter === null ? null : separatorAfter.x - separatorBefore.x }
    if (separatorAfter !== null) {
      const restoreX = separatorAfter.x + separatorAfter.width / 2
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: restoreX, y: startY })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: restoreX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY, button: 'left', buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX, y: startY, button: 'left', buttons: 0, clickCount: 1 })
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  exerciseReport = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    document.querySelector('.cxm-close')?.click()
    for (const page of document.querySelectorAll('[data-cordisx-page]')) {
      page.querySelector('button[aria-label="Close"]')?.click()
    }
    await wait(100)
    const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    const button = label => [...document.querySelectorAll('button')]
      .filter(visible)
      .filter(element => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim()) === label)
      .at(-1)
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    const selectedRaw = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
    const sessionId = selectedRaw?.startsWith('local:') ? selectedRaw.slice('local:'.length) : undefined
    if (sessionId === undefined) throw new Error('exercise requires a selected local native session')
    const nativeRootFor = id => {
      const candidates = [...document.querySelectorAll([
        '[data-codex-thread-reference-drop-target]',
        '[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]',
      ].join(','))]
        .filter(visible)
        .filter(element => [...element.querySelectorAll('[data-response-annotation-conversation]')]
          .some(child => child.getAttribute('data-response-annotation-conversation') === id)
          && [...element.querySelectorAll('[data-above-composer-conversation-id]')]
            .some(child => child.getAttribute('data-above-composer-conversation-id') === id))
      return candidates.length === 1 ? candidates[0] : undefined
    }
    const nativeRoot = nativeRootFor(sessionId)
    if (nativeRoot === undefined) throw new Error('native session content root not found')
    const nativeParent = nativeRoot.parentElement
    const initialMain = document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]')
    const initialNative = {
      rootConnected: nativeRoot.isConnected,
      parentConnected: nativeParent?.isConnected ?? false,
      display: getComputedStyle(nativeRoot).display,
      visibility: getComputedStyle(nativeRoot).visibility,
      mainRect: rect(initialMain),
      sessionRect: rect(nativeRoot),
      childCount: nativeRoot.childElementCount,
    }
    let nativeMutationCount = 0
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement
        if (target?.closest?.('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]')) continue
        const changed = [...record.addedNodes, ...record.removedNodes]
        const onlyCordisX = changed.length > 0 && changed.every(node => node.nodeType === Node.ELEMENT_NODE
          && node.matches?.('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]'))
        if (!onlyCordisX) nativeMutationCount += 1
      }
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })

    const hideSidebar = button('隐藏边栏')
    const sidebarBefore = rect(document.querySelector('[role="separator"][aria-orientation="vertical"]'))
    hideSidebar?.click()
    await wait(500)
    const collapsed = button('显示边栏') !== undefined
    const collapsedMain = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
    button('显示边栏')?.click()
    await wait(500)
    const expanded = button('隐藏边栏') !== undefined
    const sidebarAfter = rect(document.querySelector('[role="separator"][aria-orientation="vertical"]'))

    const panelResult = {}
    for (const [key, label] of [['bottom', '切换底部面板显示'], ['right', '显示/隐藏侧边面板']]) {
      const control = button(label)
      const before = control?.getAttribute('aria-pressed') ?? null
      const mainBefore = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
      control?.click()
      await wait(500)
      const afterControl = button(label)
      const after = afterControl?.getAttribute('aria-pressed') ?? null
      const mainAfter = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
      panelResult[key] = { found: control !== undefined, before, after, mainBefore, mainAfter }
      if (control !== undefined && before !== after) {
        afterControl?.click()
        await wait(350)
      }
    }

    await runtime.navigate('slot-showcase', { id: 'main.analytics' })
    await wait(120)
    const mainPage = document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')
    const back = mainPage?.querySelector('button[aria-label="Back"]')
    const backEnabled = back !== null && back?.disabled === false
    back?.click()
    await wait(120)
    const mainAfterBack = runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')
    mainPage?.querySelector('button[aria-label="Close"]')?.click()
    await wait(120)
    const mainAfterClose = runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')

    await runtime.navigate('slot-showcase', { id: 'app.overview' })
    await wait(120)
    const appPage = document.querySelector('[data-cordisx-page="slot-showcase:app.overview"]')
    const originalLang = document.documentElement.lang
    const originalText = appPage?.textContent ?? ''
    const projectedLang = originalLang.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
    document.documentElement.lang = projectedLang
    await wait(180)
    const projectedText = appPage?.textContent ?? ''
    document.documentElement.lang = originalLang
    await wait(180)
    const restoredText = appPage?.textContent ?? ''
    appPage?.querySelector('button[aria-label="Close"]')?.click()
    await wait(120)

    await runtime.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId } })
    await wait(200)
    const sessionPage = document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]')
    const nativeDuringPage = {
      sameRoot: nativeRootFor(sessionId) === nativeRoot,
      sameParent: nativeRoot.parentElement === nativeParent,
      connected: nativeRoot.isConnected,
      display: getComputedStyle(nativeRoot).display,
      visibility: getComputedStyle(nativeRoot).visibility,
      pageRect: rect(sessionPage),
      active: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
    }

    const alternate = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
      .filter(visible)
      .find(element => element.getAttribute('data-app-action-sidebar-thread-id') !== selectedRaw)
    const alternateId = alternate?.getAttribute('data-app-action-sidebar-thread-id') ?? null
    alternate?.click()
    await wait(1800)
    const switched = {
      selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
      oldNativeRootConnected: nativeRoot.isConnected,
      outlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
      pagePresent: document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]') !== null,
    }
    const originalRow = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
      .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === selectedRaw)
    originalRow?.click()
    await wait(1800)
    const returned = {
      selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
      outlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
      autoRestoredPage: document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]') !== null,
    }

    await runtime.setPluginBlocked('slot-showcase', true)
    await wait(120)
    const blocked = {
      plugin: runtime.snapshot().plugins.find(plugin => plugin.id === 'slot-showcase')?.status,
      commands: runtime.snapshot().commands.length,
      registrationsRendered: runtime.snapshot().registrations.filter(item => item.rendered).length,
      pages: document.querySelectorAll('[data-cordisx-page]').length,
    }
    await runtime.setPluginBlocked('slot-showcase', false)
    await wait(180)
    const restored = {
      plugin: runtime.snapshot().plugins.find(plugin => plugin.id === 'slot-showcase')?.status,
      commands: runtime.snapshot().commands.length,
      registrationsRendered: runtime.snapshot().registrations.filter(item => item.rendered).length,
    }
    let finalNavigate = 'started'
    void runtime.navigate('slot-showcase', { id: 'main.analytics' }).then(
      () => { finalNavigate = 'settled' },
      error => { finalNavigate = 'rejected:' + String(error) },
    )
    await wait(180)
    observer.disconnect()
    return {
      sessionId,
      alternateId,
      initialNative,
      sidebar: { before: sidebarBefore, collapsed, collapsedMain, expanded, after: sidebarAfter },
      panels: panelResult,
      history: { backEnabled, afterBack: mainAfterBack, afterClose: mainAfterClose },
      localization: {
        originalLang, projectedLang,
        changed: originalText !== projectedText,
        restored: originalText === restoredText,
        originalSample: originalText.slice(0, 160),
        projectedSample: projectedText.slice(0, 160),
      },
      nativeDuringPage,
      sessionSwitch: { switched, returned },
      nativeMutationCount,
      blocked,
      restored,
      finalNavigate,
      browserHistoryUnchanged: location.href === 'app://-/index.html',
      finalOutlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main'),
    }
  })()`, true)
  exerciseReport.drag = drag
  console.log(`exercise=${JSON.stringify(exerciseReport, null, 2)}`)
}

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
  const clip = {
    x: Math.max(0, rect.x - padding),
    y: Math.max(0, rect.y - padding),
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
    scale: 1,
  }
  const captured = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip,
  })
  if (typeof captured.data !== 'string') throw new Error('CDP screenshot returned no image')
  const screenshotPath = path.resolve(outputPath)
  await mkdir(path.dirname(screenshotPath), { recursive: true })
  await writeFile(screenshotPath, Buffer.from(captured.data, 'base64'))
  console.log(`screenshot=${screenshotPath}`)
  return { path: screenshotPath, clip }
}

let managerLifecycleReport
let generationTransactionReport
if (parsed.values['manager-lifecycle-source'] !== undefined) {
  const sourceDirectory = parsed.values['manager-lifecycle-source']
  const reportPath = path.resolve(parsed.values.report)
  const extension = path.extname(reportPath)
  const stem = path.basename(reportPath, extension)
  const artifact = suffix => path.join(path.dirname(reportPath), `${stem}.${suffix}.png`)
  const installed = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const value = predicate()
        if (value) return value
        await wait(50)
      }
      throw new Error('timed out waiting for ' + label)
    }
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height,
        right: value.right, bottom: value.bottom }
    }
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    document.querySelector('[data-permission-authorization] [data-authorization-decision="cancel"]')?.click()
    document.querySelector('.cxm-lifecycle-overlay .cxm-lifecycle-actions button')?.click()
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    if (modal?.hidden !== false) {
      if (trigger !== null && modal?.hidden !== false) trigger.click()
      else if (modal instanceof HTMLElement) modal.hidden = false
    }
    document.querySelector('[data-tab="plugins"]')?.click()
    const install = await waitFor(() => document.querySelector('[data-install-local-plugin]:not(:disabled)'), 'local install action')
    install.click()
    const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog input[aria-label="本地插件包绝对路径"]'), 'local package input')
    input.value = ${JSON.stringify(sourceDirectory)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.cxm-lifecycle-dialog .cxm-lifecycle-actions button:last-child')?.click()
    const authorization = await waitFor(() => document.querySelector('[data-permission-authorization="lifecycle-smoke"]'), 'install authorization')
    const authorizationState = {
      title: authorization.querySelector('h2')?.textContent ?? null,
      optional: authorization.querySelector('[data-authorization-choice="models.read"]')?.disabled === false,
      primaryFocused: document.activeElement === authorization.querySelector('[data-authorization-decision="allow"]'),
    }
    authorization.querySelector('[data-authorization-decision="allow"]')?.click()
    await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'installed plugin row')
    const plugin = await waitFor(() => runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke' && item.status === 'active'), 'active installed plugin')
    await wait(150)
    const currentRow = await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'current installed plugin row')
    return {
      appRenderer: location.href === 'app://-/index.html',
      authorization: authorizationState,
      revision: runtime.snapshot().pluginLifecycle?.revision ?? null,
      plugin: { id: plugin.id, status: plugin.status, source: plugin.source, package: plugin.package },
      localSourceProjected: JSON.stringify(runtime.snapshot()).includes(${JSON.stringify(sourceDirectory)}),
      primaryRect: rect(currentRow.querySelector('[data-plugin-primary="lifecycle-smoke"]')),
      managerRect: rect(document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')),
    }
  })()`, true)
  if (installed.primaryRect === null || installed.primaryRect.width <= 0 || installed.primaryRect.height <= 0
    || installed.managerRect === null) throw new Error('installed lifecycle fixture is not visible')
  const screenshots = {
    installed: await capture(installed.managerRect, artifact('lifecycle-installed'), 'installed lifecycle plugin'),
  }

  if (parsed.values['generation-transaction-exercise']) {
    generationTransactionReport = await evaluateByValue(`(async () => {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      const targetId = 'lifecycle-smoke'
      const snapshot = runtime.snapshot()
      const target = snapshot.plugins.find(plugin => plugin.id === targetId)
      if (target?.package === undefined) throw new Error('lifecycle smoke activation package is unavailable')
      const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
      let previous
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const activation = runtime.activePluginGeneration()
        if (activation.recordKind === 'active' && activation.transactionId === undefined
          && activation.plugins.some(plugin => plugin.id === targetId)) {
          previous = activation
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (previous === undefined) throw new Error('installed activation did not reach committed last-good state')
      const transactionId = 'live-generation-' + Date.now()
      const transactionEpoch = transactionId + ':host'
      const candidateGeneration = target.package.moduleGeneration + ':candidate'
      const candidateDigest = 'sha256:' + 'e'.repeat(64)
      const candidate = {
        ...previous, recordKind: 'candidate', transactionId, revision: previous.revision + 1,
        lastGoodRevision: previous.revision,
        plugins: previous.plugins.map(plugin => plugin.id === targetId
          ? { ...plugin, digest: candidateDigest, moduleGeneration: candidateGeneration }
          : plugin),
      }
      const packageManifest = {
        $schema: schema + 'plugin-package.v1.schema.json', schemaVersion: 1, id: targetId,
        version: target.package.version, entry: './module.js', compatibility: { runtimeAbi: 1, protocol: 1 },
        dependencies: candidate.plugins.find(plugin => plugin.id === targetId).dependencies,
        runtimeManifest: {
          $schema: schema + 'plugin-manifest.v1.schema.json', schemaVersion: 1, id: targetId,
          name: 'Lifecycle Smoke Candidate', capabilities: [],
        },
      }
      const candidateModuleFactory = console => ({
        name: 'Lifecycle Smoke Candidate', inject: ['commands', 'pages', 'routes', 'slots'],
        apply(ctx) {
          globalThis.__cordisxGenerationLiveSmoke = { candidateReady: true, selfCommand: false }
          console.log('generation-candidate-ready', { transactionId })
          const label = { key: 'lifecycle-smoke-candidate', fallback: 'Lifecycle smoke candidate' }
          ctx.commands.register({ id: 'invoke', title: label }, () => {
            globalThis.__cordisxGenerationLiveSmoke.selfCommand = true
          })
          ctx.pages.register({ id: 'overview', title: label, icon: 'host:refresh', chrome: 'body-only' }, () => () => undefined)
          ctx.routes.register({ id: 'overview', path: '/lifecycle-smoke', outlet: 'main', page: 'overview' })
          ctx.slots.register({ name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95 }, {
            label, icon: 'host:refresh', route: { id: 'overview' },
          })
          void ctx.commands.execute({ id: 'invoke' })
          ctx.effect(() => () => { globalThis.__cordisxGenerationLiveSmoke.candidateDisposed = true }, 'generation live smoke cleanup')
        },
      })
      const nativeNode = document.querySelector('main') ?? document.body
      const nativeUrl = location.href
      // Snapshot localization diagnostics are derived lazily. Reach the
      // Host-private microtask fixed point before the transaction baseline so
      // a completed live projection cannot be misattributed to candidate stage.
      runtime.snapshot()
      await runtime.settleRegistryProjection()
      const liveBefore = runtime.snapshot()
      await runtime.settleRegistryProjection()
      let notifications = 0
      const unsubscribe = runtime.subscribe(() => { notifications += 1 })
      const consoleBefore = runtime.pluginConsole(targetId)
      const traceStart = runtime.generationNotificationTrace().length
      const readiness = await runtime.stagePluginMutation({
        transactionId, transactionEpoch, operation: 'update', previous, candidate, targetId,
        affectedPluginIds: [targetId],
        package: { manifest: packageManifest, digest: candidateDigest, identitySource: 'file:///cordisx-live-smoke/candidate/module.js' },
      }, undefined, candidateModuleFactory)
      await new Promise(resolve => setTimeout(resolve, 20))
      const staged = runtime.snapshot()
      const consoleStaged = runtime.pluginConsole(targetId)
      const stageNotifications = notifications
      const publication = await runtime.publishPluginMutation(transactionId)
      await new Promise(resolve => setTimeout(resolve, 20))
      const published = runtime.snapshot()
      const consolePublished = runtime.pluginConsole(targetId)
      const publishNotifications = notifications
      const cleanup = await runtime.completePluginMutation(transactionId)
      const cleanupNotifications = notifications
      const rollback = await runtime.rollbackPluginMutation(transactionId)
      await new Promise(resolve => setTimeout(resolve, 20))
      const restored = runtime.snapshot()
      const consoleRestored = runtime.pluginConsole(targetId)
      unsubscribe()
      const marker = entry => JSON.stringify(entry).includes('generation-candidate-ready')
      const oldGeneration = target.package.moduleGeneration
      return {
        transactionId, transactionEpoch, readiness, publication, cleanup, rollback,
        visibility: {
          stageSnapshotUnchanged: JSON.stringify(staged) === JSON.stringify(liveBefore),
          stageNotifications,
          stageConsoleHidden: !consoleStaged.entries.some(marker),
          publishedGeneration: published.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration ?? null,
          publishedConsoleVisible: consolePublished.entries.some(marker),
          restoredGeneration: restored.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration ?? null,
          restoredConsoleHidden: !consoleRestored.entries.some(marker),
          oldConsolePreserved: consoleBefore.entries.every(entry => consoleRestored.entries.some(item => item.entryId === entry.entryId)),
          notifications, publishNotifications, cleanupNotifications,
          notificationTrace: runtime.generationNotificationTrace().slice(traceStart),
        },
        readinessView: { ...globalThis.__cordisxGenerationLiveSmoke },
        continuity: {
          appRenderer: location.href === 'app://-/index.html' && location.href === nativeUrl,
          nativeNodeIdentity: (document.querySelector('main') ?? document.body) === nativeNode,
          runtimeIdentity: globalThis.__cordisxRuntime === runtime,
        },
        passed: JSON.stringify(staged) === JSON.stringify(liveBefore)
          && stageNotifications === 0 && !consoleStaged.entries.some(marker)
          && published.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration === candidateGeneration
          && consolePublished.entries.some(marker)
          && restored.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration === oldGeneration
          && !consoleRestored.entries.some(marker)
          && notifications === 2
          && cleanup.disposedAfter.plugins.some(plugin => plugin.id === targetId && plugin.moduleGeneration === oldGeneration)
          && rollback.disposedAfter.plugins.some(plugin => plugin.id === targetId && plugin.moduleGeneration === candidateGeneration)
          && globalThis.__cordisxGenerationLiveSmoke.selfCommand === true
          && globalThis.__cordisxGenerationLiveSmoke.candidateDisposed === true
          && location.href === 'app://-/index.html' && (document.querySelector('main') ?? document.body) === nativeNode
          && globalThis.__cordisxRuntime === runtime,
      }
    })()`, true)
    console.log(`generation-transaction=${JSON.stringify(generationTransactionReport, null, 2)}`)
    if (generationTransactionReport.passed !== true) throw new Error('generation transaction smoke assertions failed')
  }

  // The direct generation transaction intentionally exercises the renderer
  // authority without mutating the durable package journal. End that scenario
  // here; run the full Manager lifecycle as a separate fresh-profile smoke so
  // its next Host transaction cannot inherit a renderer-only registry epoch.
  if (!parsed.values['generation-transaction-exercise']) {
  await pointerClick(installed.primaryRect)
  await new Promise(resolve => setTimeout(resolve, 180))
  const pointerNavigation = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const detail = document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null
    document.querySelector('.cxm-back')?.click()
    for (let attempt = 0; attempt < 80 && document.querySelector('[data-plugin-primary="lifecycle-smoke"]') === null; attempt += 1) await wait(25)
    return { detail, restored: document.querySelector('[data-plugin-primary="lifecycle-smoke"]') !== null }
  })()`, true)

  const focusPrimary = async () => await evaluateByValue(`(() => {
    const primary = document.querySelector('[data-plugin-primary="lifecycle-smoke"]')
    primary?.focus()
    return document.activeElement === primary
  })()`)
  const keyboardNavigation = {}
  keyboardNavigation.enterFocused = await focusPrimary()
  await pressKey('Enter', 'Enter', 13)
  await new Promise(resolve => setTimeout(resolve, 120))
  keyboardNavigation.enterDetail = await evaluateByValue(`document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null`)
  await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 120))
  keyboardNavigation.spaceFocused = await focusPrimary()
  await pressKey(' ', 'Space', 32)
  await new Promise(resolve => setTimeout(resolve, 120))
  keyboardNavigation.spaceDetail = await evaluateByValue(`document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null`)
  await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 120))

  const exercised = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const value = predicate()
        if (value) return value
        await wait(50)
      }
      throw new Error('timed out waiting for ' + label)
    }
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height,
        right: value.right, bottom: value.bottom }
    }
    const runtime = globalThis.__cordisxRuntime
    const counters = globalThis.__cordisxLifecycleSmoke
    if (runtime === undefined || counters === undefined) throw new Error('lifecycle fixture runtime state is unavailable')
    const initial = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }
    document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="reload"]')?.click()
    await waitFor(() => counters.apply === initial.apply + 1 && counters.dispose === initial.dispose + 1, 'owning plugin reload')
    const afterReload = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

    document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="disable"]')?.click()
    const disableDialog = await waitFor(() => document.querySelector('.cxm-lifecycle-overlay'), 'disable impact confirmation')
    const disableImpact = disableDialog.querySelector('.cxm-lifecycle-impact')?.textContent ?? ''
    disableDialog.querySelector('.cxm-lifecycle-actions button:last-child')?.click()
    await waitFor(() => runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'configured-disabled', 'disabled plugin')
    await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="enable"]:not(:disabled)'), 'disabled plugin actions')
    const afterDisable = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

    document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="enable"]')?.click()
    let enableAuthorization
    for (let attempt = 0; attempt < 120; attempt += 1) {
      enableAuthorization = document.querySelector('[data-permission-authorization="lifecycle-smoke"]') ?? undefined
      if (enableAuthorization !== undefined
        || runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active') break
      await wait(50)
    }
    enableAuthorization?.querySelector('[data-authorization-decision="allow-once"]')?.click()
    await waitFor(() => runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active', 'enabled plugin')
    await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="reload"]:not(:disabled)'), 'enabled plugin actions')
    const afterEnable = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

    const menuTrigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger')
    menuTrigger?.click()
    let popup = await waitFor(() => document.querySelector('body > .cxm-plugin-menu-popup'), 'plugin action menu')
    popup.querySelector('[data-plugin-menu-action="favorite"]')?.click()
    await waitFor(() => document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger'), 'favorite rerender')
    const routeAfterFavorite = document.querySelector('[data-manager-page-route="primary:plugins"]') !== null
    const replacementTrigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger')
    const favoriteFocusRestored = document.activeElement === replacementTrigger
    replacementTrigger?.click()
    popup = await waitFor(() => document.querySelector('body > .cxm-plugin-menu-popup'), 'reopened plugin action menu')
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const modalWasHidden = modal?.hidden === true
    if (modal instanceof HTMLElement) modal.hidden = false
    const managerRect = rect(modal?.querySelector('[role="dialog"]'))
    const popupRect = rect(popup)
    const menu = {
      portaled: popup.parentElement === document.body,
      actions: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
        action: item.getAttribute('data-plugin-menu-action'), disabled: item.disabled,
      })),
      bounded: popupRect !== null && popupRect.x >= 0 && popupRect.y >= 0
        && popupRect.right <= innerWidth && popupRect.bottom <= innerHeight,
      firstItemFocused: popup.contains(document.activeElement),
      shareText: popup.querySelector('[data-plugin-menu-action="share"]')?.textContent?.trim() ?? null,
      icons: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
        action: item.getAttribute('data-plugin-menu-action'),
        icon: item.querySelector('[data-material-icon]')?.getAttribute('data-material-icon') ?? null,
      })),
      triggerRect: rect(replacementTrigger),
    }
    return {
      initial, afterReload, disableImpact, afterDisable, afterEnable,
      enableAuthorization: enableAuthorization === undefined ? 'persisted-policy' : 'allow-once',
      routeAfterFavorite, favoriteFocusRestored, favoriteStored: localStorage.getItem('cordisx.manager.favoritePlugins.v1:smoke'),
      menu, menuRect: managerRect, modalWasHidden,
    }
  })()`, true)
  if (exercised.menuRect === null) throw new Error('lifecycle action menu is not visible')
  screenshots.menu = await capture(exercised.menuRect, artifact('lifecycle-menu'), 'lifecycle action menu')

  if (exercised.menu.triggerRect === null) throw new Error('lifecycle action menu trigger is not visible')
  // Close/reopen with a trusted pointer, then validate keyboard, external-dismiss,
  // diagnostic execution, and block/restore cleanup against the real renderer.
  await pointerClick(exercised.menu.triggerRect)
  const menuToggle = await evaluateByValue(`(() => ({
    closed: document.querySelector('body > .cxm-plugin-menu-popup') === null,
    triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger') ?? false,
  }))()`)
  await pointerClick(exercised.menu.triggerRect)
  await pressKey('ArrowDown', 'ArrowDown', 40)
  await pressKey('End', 'End', 35)
  const menuKeyboard = await evaluateByValue(`(() => {
    const popup = document.querySelector('body > .cxm-plugin-menu-popup')
    return {
      open: popup !== null,
      focusedMenuItem: popup?.contains(document.activeElement) ?? false,
      activeAction: document.activeElement?.getAttribute?.('data-plugin-menu-action') ?? null,
    }
  })()`)
  await pressKey('Escape', 'Escape', 27)
  const menuEscape = await evaluateByValue(`(() => ({
    closed: document.querySelector('body > .cxm-plugin-menu-popup') === null,
    triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger') ?? false,
  }))()`)

  await pointerClick(exercised.menu.triggerRect)
  const diagnosticTarget = await evaluateByValue(`(() => {
    const button = document.querySelector('body > .cxm-plugin-menu-popup [data-plugin-menu-action="diagnostics"]')
    const rect = button?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  if (diagnosticTarget === null || diagnosticTarget.width <= 0 || diagnosticTarget.height <= 0) {
    throw new Error('diagnostic menu action is not visible')
  }
  await pointerClick(diagnosticTarget)
  const diagnosticExecution = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('[data-manager-page-route="plugin:lifecycle-smoke:runtime"]') !== null) break
      await wait(25)
    }
    return {
      runtimeRoute: document.querySelector('[data-manager-page-route="plugin:lifecycle-smoke:runtime"]') !== null,
      popupClosed: document.querySelector('body > .cxm-plugin-menu-popup') === null,
    }
  })()`, true)
  await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 120))

  const outsideTarget = await evaluateByValue(`(() => {
    const trigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger')
    const rect = trigger?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  if (outsideTarget === null) throw new Error('lifecycle action menu trigger disappeared')
  await pointerClick(outsideTarget)
  const outsideDismissTarget = await evaluateByValue(`(() => {
    const target = document.querySelector('.cxm-heading')
    const rect = target?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  if (outsideDismissTarget === null || outsideDismissTarget.width <= 0 || outsideDismissTarget.height <= 0) {
    throw new Error('manager outside-dismiss target is not visible')
  }
  await pointerClick(outsideDismissTarget)
  const outsideDismiss = await evaluateByValue(`document.querySelector('body > .cxm-plugin-menu-popup') === null`)

  await pointerClick(outsideTarget)
  const blockRestore = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    await runtime.setPluginBlocked('lifecycle-smoke', true)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('body > .cxm-plugin-menu-popup') === null) break
      await wait(25)
    }
    const closedOnBlock = document.querySelector('body > .cxm-plugin-menu-popup') === null
    await runtime.setPluginBlocked('lifecycle-smoke', false)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active') break
      await wait(25)
    }
    return {
      closedOnBlock,
      restored: runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active',
      counters: { ...globalThis.__cordisxLifecycleSmoke },
    }
  })()`, true)

  const uninstallPlan = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    let popup = document.querySelector('body > .cxm-plugin-menu-popup')
    if (popup === null) {
      document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxm-plugin-menu-trigger')?.click()
      for (let attempt = 0; attempt < 80 && popup === null; attempt += 1) {
        popup = document.querySelector('body > .cxm-plugin-menu-popup')
        if (popup === null) await wait(25)
      }
    }
    const uninstall = popup?.querySelector('[data-plugin-menu-action="uninstall"]')
    if (!(uninstall instanceof HTMLButtonElement) || uninstall.disabled) throw new Error('uninstall menu action is unavailable')
    uninstall.click()
    let dialog
    for (let attempt = 0; attempt < 120 && dialog === undefined; attempt += 1) {
      dialog = document.querySelector('.cxm-lifecycle-overlay') ?? undefined
      if (dialog === undefined) await wait(50)
    }
    const value = dialog?.getBoundingClientRect()
    return value === undefined ? null : {
      text: dialog.textContent?.trim() ?? '',
      rect: { x: value.x, y: value.y, width: value.width, height: value.height },
    }
  })()`, true)
  if (uninstallPlan?.rect === undefined) throw new Error('uninstall confirmation did not open')
  screenshots.uninstall = await capture(uninstallPlan.rect, artifact('lifecycle-uninstall'), 'lifecycle uninstall confirmation')

  const removed = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    const counters = globalThis.__cordisxLifecycleSmoke
    const beforeRevision = runtime.snapshot().pluginLifecycle?.revision ?? null
    const expectedDispose = counters.dispose + 1
    document.querySelector('.cxm-lifecycle-overlay .cxm-lifecycle-actions button:last-child')?.click()
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (!runtime.snapshot().plugins.some(item => item.id === 'lifecycle-smoke') && counters.dispose >= expectedDispose) break
      await wait(50)
    }
    const snapshot = runtime.snapshot()
    return {
      beforeRevision,
      afterRevision: snapshot.pluginLifecycle?.revision ?? null,
      removed: !snapshot.plugins.some(item => item.id === 'lifecycle-smoke'),
      registrationsRemoved: !snapshot.registrations.some(item => item.owner === 'lifecycle-smoke'),
      routesRemoved: !snapshot.navigation.routes.some(item => item.owner === 'lifecycle-smoke'),
      pagesRemoved: !snapshot.navigation.pages.some(item => item.owner === 'lifecycle-smoke'),
      counters: { ...counters },
      appRenderer: location.href === 'app://-/index.html',
    }
  })()`, true)

  const assertions = {
    appRenderer: installed.appRenderer && removed.appRenderer,
    authorization: installed.authorization.title === '安装授权' && installed.authorization.optional
      && installed.authorization.primaryFocused,
    installedWithoutLocalPath: installed.plugin.status === 'active' && installed.localSourceProjected === false
      && installed.plugin.package?.canonicalSource === 'https://github.com/cordisx/cordisx/tree/main/examples/plugins/lifecycle-smoke',
    pointerNavigation: pointerNavigation.detail && pointerNavigation.restored,
    keyboardNavigation: Object.values(keyboardNavigation).every(Boolean),
    owningReloadOnly: exercised.afterReload.apply === exercised.initial.apply + 1
      && exercised.afterReload.dispose === exercised.initial.dispose + 1
      && exercised.afterReload.revision === exercised.initial.revision,
    disableEnable: exercised.disableImpact.includes('lifecycle-smoke')
      && exercised.afterDisable.dispose === exercised.afterReload.dispose + 1
      && exercised.afterEnable.apply === exercised.afterReload.apply + 1,
    profileFavorite: exercised.routeAfterFavorite && exercised.favoriteFocusRestored
      && JSON.parse(exercised.favoriteStored ?? '[]').includes('lifecycle-smoke'),
    menu: exercised.menu.portaled && exercised.menu.bounded && exercised.menu.firstItemFocused
      && exercised.menu.actions.some(item => item.action === 'share' && item.disabled === false)
      && exercised.menu.actions.some(item => item.action === 'uninstall' && item.disabled === false)
      && exercised.menu.icons.some(item => item.action === 'share' && item.icon === 'share-plugin')
      && exercised.menu.icons.some(item => item.action === 'source' && item.icon === 'authors-source')
      && exercised.menu.icons.some(item => item.action === 'diagnostics' && item.icon === 'diagnostics'),
    menuInteraction: menuToggle.closed && menuToggle.triggerFocused
      && menuKeyboard.open && menuKeyboard.focusedMenuItem && menuKeyboard.activeAction !== null
      && menuEscape.closed && menuEscape.triggerFocused
      && diagnosticExecution.runtimeRoute && diagnosticExecution.popupClosed
      && outsideDismiss && blockRestore.closedOnBlock && blockRestore.restored,
    uninstallImpact: uninstallPlan.text.includes('lifecycle-smoke') && uninstallPlan.text.includes('确认卸载'),
    uninstallCleanup: removed.removed && removed.registrationsRemoved && removed.routesRemoved && removed.pagesRemoved
      && removed.counters.dispose === blockRestore.counters.dispose + 1,
  }
  managerLifecycleReport = {
    result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
    installed, pointerNavigation, keyboardNavigation, exercised,
    menuInteraction: { menuToggle, menuKeyboard, menuEscape, diagnosticExecution, outsideDismiss, blockRestore },
    uninstallPlan: { text: uninstallPlan.text }, removed,
    screenshots, assertions,
  }
  console.log(`manager-lifecycle=${JSON.stringify(managerLifecycleReport, null, 2)}`)
  }
}

let uiCatalogReport
if (parsed.values['ui-catalog']) {
  uiCatalogReport = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return true
        await wait(50)
      }
      return false
    }
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) return { result: 'fail', error: 'CordisX runtime is unavailable', assertions: [] }
    document.querySelector('.cxm-close')?.click()
    for (const page of document.querySelectorAll('[data-cordisx-page]')) page.querySelector('button[aria-label="Close"]')?.click()
    await wait(120)
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }
    }
    const visible = element => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false
      const value = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return value.width > 0 && value.height > 0 && value.right > 0 && value.bottom > 0
        && value.left < innerWidth && value.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const selectorFor = key => '[data-cordisx-surface-host="' + key + '"]'
    const pointConfig = [{
      id: 'session.header.actions', key: 'session.header.actions', contributionId: 'slot-showcase:trace',
    }, {
      id: 'composer.toolbar.items', key: 'composer.submit.before', contributionId: 'slot-showcase:submit-before',
    }]
    const rootFor = config => document.querySelector(selectorFor(config.key))
    const contributionFor = config => rootFor(config)?.querySelector('[data-cordisx-contribution-id="' + CSS.escape(config.contributionId) + '"]') ?? null
    await waitFor(() => pointConfig.every(config => visible(rootFor(config))), 'initial extension seats')
    const nativeFor = root => {
      const anchor = root?.nextSibling
      if (!(anchor instanceof HTMLElement)) return { anchor: null, control: null }
      return { anchor, control: anchor.matches('button') ? anchor : anchor.querySelector('button') }
    }
    const initial = new Map(pointConfig.map(config => {
      const root = rootFor(config)
      const native = nativeFor(root)
      return [config.id, { root, nativeAnchor: native.anchor, nativeControl: native.control, nativeParent: native.anchor?.parentElement ?? null }]
    }))
    const mutation = { cordisxChildChanges: 0, unexpectedChildChanges: 0, nativeAttributeChanges: 0 }
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') mutation.nativeAttributeChanges += 1
        else {
          const changed = [...record.addedNodes, ...record.removedNodes]
          if (changed.every(node => node instanceof HTMLElement && node.matches('[data-cordisx-surface-host]'))) mutation.cordisxChildChanges += 1
          else mutation.unexpectedChildChanges += 1
        }
      }
    })
    for (const value of initial.values()) {
      if (value.nativeParent !== null) observer.observe(value.nativeParent, { childList: true })
      if (value.nativeControl !== null) observer.observe(value.nativeControl, { attributes: true, attributeFilter: ['style', 'hidden', 'aria-hidden'] })
    }
    const plugin = runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')
    const policyTransitions = []
    if (plugin !== undefined && typeof runtime.setExtensionPointPolicy === 'function') {
      for (const config of pointConfig) {
        const before = initial.get(config.id)
        const original = runtime.snapshot().extensionPoints.policies.find(item => item.identity.source === plugin.source
          && item.identity.pluginId === 'slot-showcase' && item.identity.pointId === config.id)?.policy ?? 'inherit'
        try {
          await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, 'deny')
          const hidden = await waitFor(() => contributionFor(config) === null
            && runtime.snapshot().registrations.find(item => item.owner === 'slot-showcase' && item.surface === config.id)?.authorized === false, config.id + ' deny')
          const nativeWhileDenied = before?.nativeControl?.isConnected === true
            && before.nativeAnchor?.parentElement === before.nativeParent && visible(before.nativeControl)
          await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, 'allow')
          const restored = await waitFor(() => visible(contributionFor(config)), config.id + ' allow')
          const after = rootFor(config)
          policyTransitions.push({ id: config.id, original, hidden, restored, sameSeat: after === before?.root,
            nativeWhileDenied, sameNative: nativeFor(after).control === before?.nativeControl,
            sameNativeParent: before?.nativeAnchor?.parentElement === before?.nativeParent })
        } finally {
          await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, original)
          if (original !== 'deny') await waitFor(() => visible(contributionFor(config)), config.id + ' policy restore')
        }
      }
    }
    let pluginBlock = null
    if (typeof runtime.setPluginBlocked === 'function') {
      await runtime.setPluginBlocked('slot-showcase', true)
      const blocked = await waitFor(() => pointConfig.every(config => contributionFor(config) === null)
        && runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')?.status === 'blocked', 'plugin block')
      const nativeWhileBlocked = pointConfig.every(config => {
        const before = initial.get(config.id)
        return before?.nativeControl?.isConnected === true && before.nativeAnchor?.parentElement === before.nativeParent
          && visible(before.nativeControl)
      })
      await runtime.setPluginBlocked('slot-showcase', false)
      const restored = await waitFor(() => pointConfig.every(config => visible(contributionFor(config)))
        && runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')?.status === 'active', 'plugin restore')
      const sameNative = pointConfig.every(config => nativeFor(rootFor(config)).control === initial.get(config.id)?.nativeControl)
      pluginBlock = { blocked, nativeWhileBlocked, restored, sameNative }
    }
    observer.disconnect()
    const snapshot = runtime.snapshot()
    const points = pointConfig.map(config => {
      const root = rootFor(config)
      const native = nativeFor(root)
      const rootRect = rect(root)
      const nativeRect = rect(native.control)
      const parentRect = rect(root?.parentElement)
      const style = root === null ? null : getComputedStyle(root)
      const action = contributionFor(config) ?? root?.querySelector('button') ?? null
      const actionStyle = action === null ? null : getComputedStyle(action)
      const point = snapshot.extensionPoints.points.find(item => item.id === config.id)
      const registration = snapshot.registrations.find(item => item.owner === 'slot-showcase' && item.surface === config.id)
      const insideViewport = rootRect !== null && rootRect.x >= 0 && rootRect.y >= 0 && rootRect.right <= innerWidth && rootRect.bottom <= innerHeight
      const nonOverlapping = rootRect !== null && nativeRect !== null && rootRect.right <= nativeRect.x + 0.5
      return {
        id: config.id, key: config.key, contributionId: config.contributionId,
        availability: point === undefined ? null : { stability: point.stability, availability: point.availability, available: point.available,
          code: point.availabilityCode ?? null, detail: point.availabilityDetail ?? null, anchors: point.anchors ?? [] },
        registration: registration === undefined ? null : { valid: registration.valid, authorized: registration.authorized,
          visible: registration.visible, rendered: registration.rendered, pending: registration.pending, error: registration.error ?? null },
        candidateCount: document.querySelectorAll(selectorFor(config.key)).length,
        relationship: { sameParent: root?.parentElement === native.anchor?.parentElement, beforeNative: root?.nextSibling === native.anchor,
          nativeConnected: native.control?.isConnected ?? false, nativeParentConnected: native.anchor?.parentElement?.isConnected ?? false },
        geometry: { root: rootRect, native: nativeRect, parent: parentRect, nonOverlapping },
        computed: { display: style?.display ?? null, position: style?.position ?? null, transform: style?.transform ?? null,
          appRegion: style?.getPropertyValue('-webkit-app-region') ?? null, actionAppRegion: actionStyle?.getPropertyValue('-webkit-app-region') ?? null },
        a11y: { actionLabel: action?.getAttribute('aria-label') ?? null, tooltipText: action?.dataset.cordisxTooltip ?? null,
          noDragData: root?.dataset.cordisxNoDrag ?? null },
        viewport: { width: innerWidth, height: innerHeight, inside: insideViewport },
        captureRect: rootRect === null || nativeRect === null ? null : {
          x: Math.min(rootRect.x, nativeRect.x), y: Math.min(rootRect.y, nativeRect.y),
          width: Math.max(rootRect.right, nativeRect.right) - Math.min(rootRect.x, nativeRect.x),
          height: Math.max(rootRect.bottom, nativeRect.bottom) - Math.min(rootRect.y, nativeRect.y),
        },
      }
    })
    const iconControls = [...document.querySelectorAll('[data-cordisx-surface-host] .cordisx-native-icon-action')]
      .filter(visible)
      .map(action => {
        const root = action.closest('[data-cordisx-surface-host]')
        const wrapper = action.querySelector('.cordisx-host-icon')
        const glyph = wrapper?.querySelector('svg') ?? null
        const actionRect = rect(action)
        const wrapperRect = rect(wrapper)
        const glyphRect = rect(glyph)
        const actionStyle = getComputedStyle(action)
        const reduced = action.classList.contains('cordisx-icon-only-control')
        const compact = action.classList.contains('cordisx-shortcut-action')
        const expectedGlyphSize = reduced ? (compact ? 12 : 16) : null
        const centered = wrapperRect !== null && glyphRect !== null
          && Math.abs((wrapperRect.x + wrapperRect.width / 2) - (glyphRect.x + glyphRect.width / 2)) <= 0.5
          && Math.abs((wrapperRect.y + wrapperRect.height / 2) - (glyphRect.y + glyphRect.height / 2)) <= 0.5
        return {
          surface: root?.dataset.cordisxSurfaceHost ?? null,
          label: action.getAttribute('aria-label'),
          reduced,
          compact,
          expectedGlyphSize,
          token: actionStyle.getPropertyValue('--cordisx-icon-only-glyph-size').trim(),
          geometry: { action: actionRect, wrapper: wrapperRect, glyph: glyphRect, centered },
        }
      })
    const managerTrigger = document.querySelector('[data-cordisx-manager-trigger]')
    const managerMark = managerTrigger?.querySelector('[data-cordisx-brand-mark]') ?? null
    const managerActionRect = rect(managerTrigger)
    const managerGlyphRect = rect(managerMark)
    const managerBrand = {
      reduced: managerTrigger?.classList.contains('cordisx-icon-only-control') ?? false,
      geometry: { action: managerActionRect, glyph: managerGlyphRect,
        centered: managerActionRect !== null && managerGlyphRect !== null
          && Math.abs((managerActionRect.x + managerActionRect.width / 2) - (managerGlyphRect.x + managerGlyphRect.width / 2)) <= 0.5
          && Math.abs((managerActionRect.y + managerActionRect.height / 2) - (managerGlyphRect.y + managerGlyphRect.height / 2)) <= 0.5 },
    }
    const assertions = []
    const assert = (id, pass, actual, expected) => assertions.push({ id, pass: Boolean(pass), actual, expected })
    for (const point of points) {
      assert(point.id + '.unique-seat', point.candidateCount === 1, point.candidateCount, 1)
      assert(point.id + '.rendered', point.registration?.rendered === true, point.registration, 'rendered=true')
      assert(point.id + '.sibling-before-native', point.relationship.sameParent && point.relationship.beforeNative, point.relationship, 'same parent and immediate preceding sibling')
      assert(point.id + '.normal-flow', point.computed.position === 'static' && point.computed.transform === 'none', point.computed, 'position=static, transform=none')
      assert(point.id + '.native-continuity', point.relationship.nativeConnected && point.relationship.nativeParentConnected, point.relationship, 'native node and parent connected')
      assert(point.id + '.non-overlap', point.geometry.nonOverlapping, point.geometry, 'CordisX root ends before native control')
      assert(point.id + '.no-drag', point.a11y.noDragData === 'true' && point.computed.appRegion === 'no-drag'
        && point.computed.actionAppRegion === 'no-drag', { a11y: point.a11y, computed: point.computed }, 'root/action no-drag')
      assert(point.id + '.viewport', point.viewport.inside, point.viewport, 'inside viewport')
    }
    for (const transition of policyTransitions) {
      assert(transition.id + '.policy-hide-restore', transition.hidden && transition.restored && transition.nativeWhileDenied
        && transition.sameNative && transition.sameNativeParent, transition, 'hide/restore without changing native control')
    }
    assert('native.no-unexpected-child-mutations', mutation.unexpectedChildChanges === 0, mutation, 'only CordisX seat child changes')
    assert('native.no-attribute-mutations', mutation.nativeAttributeChanges === 0, mutation, 'no native style/hidden/aria-hidden mutations')
    assert('plugin.block-restore', pluginBlock?.blocked === true && pluginBlock.nativeWhileBlocked === true
      && pluginBlock.restored === true && pluginBlock.sameNative === true, pluginBlock, 'plugin block/restore without changing native controls')
    for (const control of iconControls.filter(item => item.reduced)) {
      const expectedToken = control.expectedGlyphSize + 'px'
      assert('icon.' + control.surface + '.' + control.label + '.glyph-size', control.token === expectedToken
        && control.geometry.glyph?.width === control.expectedGlyphSize && control.geometry.glyph?.height === control.expectedGlyphSize,
      control, 'host token and rendered glyph are exactly ' + expectedToken)
      assert('icon.' + control.surface + '.' + control.label + '.hit-area', (control.geometry.action?.width ?? 0) >= 24
        && (control.geometry.action?.height ?? 0) >= 24, control.geometry.action, 'button hit area remains at least 24x24')
      assert('icon.' + control.surface + '.' + control.label + '.centered', control.geometry.centered,
        control.geometry, 'glyph is horizontally and vertically centered in its unchanged wrapper')
    }
    const composerControl = iconControls.find(item => item.surface === 'composer.submit.before')
    assert('composer.toolbar.items.appearance-preserved', composerControl?.reduced === false && composerControl?.token === ''
      && composerControl.geometry.glyph?.width === 16 && composerControl.geometry.glyph?.height === 16,
    composerControl, 'composer keeps its existing 16px glyph and does not opt into the shell reduction')
    assert('manager.brand-trigger.size-preserved', managerBrand.reduced === false && managerBrand.geometry.action?.width === 32
      && managerBrand.geometry.action?.height === 32 && managerBrand.geometry.glyph?.width === 20 && managerBrand.geometry.glyph?.height === 20
      && managerBrand.geometry.centered,
    managerBrand, 'brand trigger remains a 20px mark in its 32px button')
    const titlebar = [...document.querySelectorAll('header[data-app-shell-application-menu-bar]')].find(visible)
    const titlebarRect = rect(titlebar)
    const safeLeft = titlebarRect === null ? null : Math.max(12, Math.ceil(Math.min(...[...titlebar.querySelectorAll('button')]
      .filter(visible).map(button => button.getBoundingClientRect().x).filter(x => x >= titlebarRect.x + 64 && x < titlebarRect.x + 180), titlebarRect.x + 88) - titlebarRect.x))
    const sessionPoint = points.find(point => point.id === 'session.header.actions')
    assert('session.header.actions.safe-inset', safeLeft !== null && sessionPoint?.geometry.root?.x >= safeLeft,
      { safeLeft, rootX: sessionPoint?.geometry.root?.x ?? null }, 'root starts after titlebar safe inset')
    return { result: assertions.every(item => item.pass) ? 'pass' : 'fail', sessionId: snapshot.extensionPoints === undefined ? null
      : document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/, '') ?? null,
      points, iconControls, managerBrand, policyTransitions, pluginBlock, nativeMutation: mutation, safeInsets: { titlebar: titlebarRect, safeLeft }, assertions }
  })()`, true)

  const reportPath = path.resolve(parsed.values.report)
  const extension = path.extname(reportPath)
  const stem = path.basename(reportPath, extension)
  const artifact = suffix => path.join(path.dirname(reportPath), `${stem}.${suffix}.png`)
  const screenshots = {}
  for (const [id, suffix] of [['session.header.actions', 'session-header-actions'], ['composer.toolbar.items', 'composer-submit-before']]) {
    const point = uiCatalogReport.points?.find(item => item.id === id)
    if (point?.captureRect !== null && point?.captureRect !== undefined) screenshots[id] = await capture(point.captureRect, artifact(suffix), id)
  }
  const tooltipEvidence = async (id, key, suffix) => {
    const activations = []
    let evidence = { pass: false, error: 'tooltip unavailable' }
    for (let attempt = 1; attempt <= 3 && !evidence.pass; attempt += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 100, pointerType: 'mouse' })
      await new Promise(resolve => setTimeout(resolve, 80))
      const trigger = await evaluateByValue(`(() => {
        const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
        const rect = button?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      if (trigger === null) return { pass: false, error: 'trigger unavailable', activations }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2, pointerType: 'mouse' })
      const activation = await evaluateByValue(`(() => {
        const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
        if (!(button instanceof HTMLElement)) return { focused: false, pointerDispatched: false, connected: false }
        button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
        button.focus()
        return { focused: document.activeElement === button, pointerDispatched: true, connected: button.isConnected }
      })()`)
      activations.push({ attempt, ...activation })
      await new Promise(resolve => setTimeout(resolve, 900))
      evidence = await evaluateByValue(`(() => {
        const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
        const tooltip = document.querySelector('.cordisx-host-tooltip')
        if (button === null || tooltip === null) return { pass: false, error: 'tooltip unavailable' }
        const trigger = button.getBoundingClientRect()
        const tip = tooltip.getBoundingClientRect()
        const rect = { x: Math.min(trigger.x, tip.x), y: Math.min(trigger.y, tip.y),
          width: Math.max(trigger.right, tip.right) - Math.min(trigger.x, tip.x),
          height: Math.max(trigger.bottom, tip.bottom) - Math.min(trigger.y, tip.y) }
        const role = tooltip.getAttribute('role') ?? tooltip.role ?? null
        return { pass: role === 'tooltip' && button.getAttribute('aria-describedby') === tooltip.id && tip.x >= 0 && tip.y >= 0
          && tip.right <= innerWidth && tip.bottom <= innerHeight, text: tooltip.textContent, side: tooltip.dataset.side,
          role, describedBy: button.getAttribute('aria-describedby'), tooltipId: tooltip.id, rect }
      })()`)
    }
    evidence.activations = activations
    if (evidence.rect !== undefined) evidence.screenshot = await capture(evidence.rect, artifact(suffix), `${id} tooltip`)
    await evaluateByValue(`document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')?.blur()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 100, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 80))
    evidence.dismissed = await evaluateByValue(`document.querySelector('.cordisx-host-tooltip') === null`)
    evidence.pass &&= evidence.dismissed
    return evidence
  }
  const tooltips = {
    'session.header.actions': await tooltipEvidence('session.header.actions', 'session.header.actions', 'session-header-actions-tooltip'),
    'composer.toolbar.items': await tooltipEvidence('composer.toolbar.items', 'composer.submit.before', 'composer-submit-before-tooltip'),
  }
  for (const [id, evidence] of Object.entries(tooltips)) {
    uiCatalogReport.assertions.push({ id: `${id}.tooltip`, pass: evidence.pass, actual: evidence, expected: 'described, in viewport, dismissed' })
  }

  const toolbarSnapshot = () => evaluateByValue(`(() => {
    const rect = element => {
      const value = element?.getBoundingClientRect()
      return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }
    }
    const row = element => {
      if (!(element instanceof HTMLButtonElement)) return null
      const geometry = rect(element)
      const style = getComputedStyle(element)
      const hit = geometry === null ? null : document.elementFromPoint(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2)
      return {
        owner: element.dataset.cordisxOwner ?? null,
        surface: element.dataset.cordisxSurface ?? null,
        contributionId: element.dataset.cordisxContributionId ?? null,
        label: element.getAttribute('aria-label'),
        pressed: element.getAttribute('aria-pressed'),
        routeState: element.dataset.cordisxRouteState ?? null,
        state: element.getAttribute('data-state'),
        disabled: element.disabled,
        focused: document.activeElement === element,
        className: element.className,
        background: style.backgroundColor,
        color: style.color,
        outline: style.outline,
        geometry,
        hit: hit === null ? null : {
          tag: hit.tagName,
          label: hit.getAttribute?.('aria-label') ?? null,
          contributionId: hit.closest?.('[data-cordisx-contribution-id]')?.dataset.cordisxContributionId ?? null,
        },
      }
    }
    const sessionRoot = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
    const nativeAnchor = sessionRoot?.nextElementSibling ?? null
    const nativeSummary = nativeAnchor?.matches('button') ? nativeAnchor : nativeAnchor?.querySelector('button') ?? null
    const sessionActions = [...(sessionRoot?.querySelectorAll(':scope > button') ?? [])].map(row).filter(Boolean)
    const sessionRootRect = rect(sessionRoot)
    const nativeSummaryRow = row(nativeSummary)
    const actionGaps = sessionActions.slice(1).map((item, index) => item.geometry.x - sessionActions[index].geometry.right)
    const nativeGap = sessionRootRect === null || nativeSummaryRow?.geometry === null ? null : nativeSummaryRow.geometry.x - sessionRootRect.right

    const beforeRoot = document.querySelector('[data-cordisx-surface-host="toolbar.before"]')
    const afterRoot = document.querySelector('[data-cordisx-surface-host="toolbar.after"]')
    const workspaceAnchor = beforeRoot?.nextElementSibling ?? null
    const workspaceNative = workspaceAnchor?.matches('button') ? workspaceAnchor : workspaceAnchor?.querySelector('button') ?? null
    const beforeRect = rect(beforeRoot)
    const afterRect = rect(afterRoot)
    const workspaceNativeRect = rect(workspaceNative)
    const slot = beforeRoot?.closest('[data-test-id="header-shell-slot"]') ?? null
    const alignmentGroup = beforeRoot?.parentElement ?? null
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      selectedThread: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
      agentTracePresented: document.querySelector('[data-agent-trace-showcase="true"]') !== null,
      session: {
        root: sessionRoot === null ? null : { className: sessionRoot.className, geometry: sessionRootRect,
          gap: getComputedStyle(sessionRoot).gap, marginInlineEnd: getComputedStyle(sessionRoot).marginInlineEnd,
          background: getComputedStyle(sessionRoot).backgroundColor },
        actions: sessionActions,
        native: nativeSummaryRow,
        actionGaps,
        nativeGap,
        relationship: { sameParent: sessionRoot?.parentElement === nativeAnchor?.parentElement, immediateBefore: sessionRoot?.nextElementSibling === nativeAnchor },
      },
      workspace: {
        before: { root: beforeRect, action: row(beforeRoot?.querySelector(':scope > button') ?? null) },
        native: row(workspaceNative),
        after: { root: afterRect, action: row(afterRoot?.querySelector(':scope > button') ?? null) },
        compactGaps: {
          beforeToNative: beforeRect === null || workspaceNativeRect === null ? null : workspaceNativeRect.x - beforeRect.right,
          nativeToAfter: workspaceNativeRect === null || afterRect === null ? null : afterRect.x - workspaceNativeRect.right,
        },
        outerGapFromSummary: nativeSummaryRow?.geometry === null || beforeRect === null ? null : beforeRect.x - nativeSummaryRow.geometry.right,
        slot: slot === null ? null : { className: slot.className, inlineWidth: slot.style.width, computedWidth: getComputedStyle(slot).width, geometry: rect(slot) },
        alignmentGroup: alignmentGroup === null ? null : { className: alignmentGroup.className, hasMsAuto: alignmentGroup.classList.contains('ms-auto'), geometry: rect(alignmentGroup) },
      },
    }
  })()`)

  const annotateToolbar = async (label, suffix) => {
    const clip = await evaluateByValue(`(() => {
      document.querySelector('[data-cordisx-toolbar-smoke-annotation]')?.remove()
      const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
      const nativeAnchor = root?.nextElementSibling
      const native = nativeAnchor?.matches('button') ? nativeAnchor : nativeAnchor?.querySelector('button')
      const buttons = [...(root?.querySelectorAll(':scope > button') ?? []), native].filter(Boolean)
      if (root === null || !(native instanceof HTMLElement) || buttons.length < 2) return null
      const rootRect = root.getBoundingClientRect()
      const nativeRect = native.getBoundingClientRect()
      const layer = document.createElement('div')
      layer.dataset.cordisxToolbarSmokeAnnotation = 'true'
      Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none', font: '600 10px/1.2 ui-monospace, monospace', color: '#d51f3f' })
      const add = (text, left, top, width = null) => {
        const item = document.createElement('span')
        item.textContent = text
        Object.assign(item.style, { position: 'fixed', left: left + 'px', top: top + 'px', padding: '2px 3px', borderRadius: '3px', background: 'rgba(255,255,255,.94)', boxShadow: '0 0 0 1px rgba(213,31,63,.35)' })
        if (width !== null) item.style.width = width + 'px'
        layer.append(item)
      }
      const all = buttons.map(button => ({ button, rect: button.getBoundingClientRect() }))
      for (let index = 1; index < all.length; index += 1) {
        const left = all[index - 1].rect.right
        const right = all[index].rect.x
        const line = document.createElement('i')
        Object.assign(line.style, { position: 'fixed', left: left + 'px', top: '39px', width: Math.max(1, right - left) + 'px', height: '2px', background: '#d51f3f' })
        layer.append(line)
        add(Math.round((right - left) * 100) / 100 + 'px', left - 7, 43)
      }
      add(${JSON.stringify(label)}, rootRect.x, 64)
      document.body.append(layer)
      return { x: Math.max(0, rootRect.x - 18), y: 0, width: nativeRect.right - rootRect.x + 36, height: 84 }
    })()`)
    if (clip === null) return null
    const evidence = await capture(clip, artifact(suffix), label)
    await evaluateByValue(`document.querySelector('[data-cordisx-toolbar-smoke-annotation]')?.remove()`)
    return evidence
  }

  let inactive = await toolbarSnapshot()
  const initialNativePressed = inactive.session.native?.pressed
  if (initialNativePressed === 'true') {
    await pointerClick(inactive.session.native.geometry)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 160))
  inactive = await toolbarSnapshot()
  screenshots['toolbar.inactive'] = await annotateToolbar('inactive · independent gaps', 'toolbar-inactive-annotated')

  const originalThread = inactive.selectedThread
  const threadTarget = await evaluateByValue(`(() => {
    const selected = ${JSON.stringify(inactive.selectedThread)}
    const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
      .find(element => element.getClientRects().length > 0 && element.getAttribute('data-app-action-sidebar-thread-id') !== selected)
    const rect = row?.getBoundingClientRect()
    return rect === undefined ? null : { id: row.getAttribute('data-app-action-sidebar-thread-id'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  let threadSwitch = { attempted: false }
  if (threadTarget !== null && originalThread !== null) {
    await evaluateByValue(`(() => {
      globalThis.__cordisxToolbarSmokeIdentity = {
        root: document.querySelector('[data-cordisx-surface-host="session.header.actions"]'),
        native: (() => { const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]'); const anchor = root?.nextElementSibling; return anchor?.matches('button') ? anchor : anchor?.querySelector('button') ?? null })(),
      }
      return true
    })()`)
    await pointerClick(threadTarget)
    await new Promise(resolve => setTimeout(resolve, 1800))
    const originalTarget = await evaluateByValue(`(() => {
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${JSON.stringify(originalThread)})
      const rect = row?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    if (originalTarget !== null) {
      await pointerClick(originalTarget)
      await new Promise(resolve => setTimeout(resolve, 1800))
    }
    threadSwitch = await evaluateByValue(`(() => {
      const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
      const anchor = root?.nextElementSibling
      const native = anchor?.matches('button') ? anchor : anchor?.querySelector('button') ?? null
      return { attempted: true, alternate: ${JSON.stringify(threadTarget.id)}, restored: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') === ${JSON.stringify(originalThread)},
        rootConnected: root?.isConnected ?? false, immediateBefore: root?.nextElementSibling === anchor,
        rootIdentityPreserved: root === globalThis.__cordisxToolbarSmokeIdentity?.root,
        nativeIdentityPreserved: native === globalThis.__cordisxToolbarSmokeIdentity?.native }
    })()`)
  }

  inactive = await toolbarSnapshot()
  await pointerClick(inactive.session.native.geometry)
  await new Promise(resolve => setTimeout(resolve, 500))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
  await new Promise(resolve => setTimeout(resolve, 160))
  const nativeActive = await toolbarSnapshot()
  screenshots['toolbar.native-active'] = await annotateToolbar('native pressed · CordisX idle', 'toolbar-native-active-annotated')

  if (nativeActive.session.native?.geometry !== null && nativeActive.session.native?.geometry !== undefined) {
    const target = nativeActive.session.native.geometry
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x + target.width / 2, y: target.y + target.height / 2, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 160))
  }
  const nativeActiveHovered = await toolbarSnapshot()

  const hoverTarget = nativeActive.session.actions[0]?.geometry
  if (hoverTarget !== null && hoverTarget !== undefined) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTarget.x + hoverTarget.width / 2, y: hoverTarget.y + hoverTarget.height / 2, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 160))
  }
  const hovered = await toolbarSnapshot()
  screenshots['toolbar.hover'] = await annotateToolbar('hover first · sibling idle', 'toolbar-hover-annotated')

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
  await evaluateByValue(`document.querySelector('[data-cordisx-surface-host="session.header.actions"] > button:nth-of-type(2)')?.focus()`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const focused = await toolbarSnapshot()
  screenshots['toolbar.focus'] = await annotateToolbar('focus second · state isolated', 'toolbar-focus-annotated')

  await evaluateByValue(`document.activeElement?.blur?.()`)
  const beforeRoute = await toolbarSnapshot()
  if (beforeRoute.session.native?.pressed === 'true') {
    await pointerClick(beforeRoute.session.native.geometry)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const routeTargetState = await toolbarSnapshot()
  const routeTarget = routeTargetState.session.actions.find(item => item.routeState !== null)?.geometry ?? null
  if (routeTarget !== null) {
    await pointerClick(routeTarget)
    await new Promise(resolve => setTimeout(resolve, 500))
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 160))
  }
  const routeActive = await toolbarSnapshot()
  screenshots['toolbar.route-active'] = await annotateToolbar('single CordisX route pressed', 'toolbar-route-active-annotated')

  const activeRouteTarget = routeActive.session.actions.find(item => item.pressed === 'true')?.geometry ?? null
  if (activeRouteTarget !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: activeRouteTarget.x + activeRouteTarget.width / 2, y: activeRouteTarget.y + activeRouteTarget.height / 2, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 160))
  }
  const routeHovered = await toolbarSnapshot()
  screenshots['toolbar.route-active-hover'] = await annotateToolbar('route pressed + hover · siblings idle', 'toolbar-route-active-hover-annotated')

  let routeSessionSwitch = { attempted: false }
  if (threadTarget !== null && originalThread !== null) {
    const alternateTarget = await evaluateByValue(`(() => {
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${JSON.stringify(threadTarget.id)})
      const rect = row?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    if (alternateTarget !== null) {
      await pointerClick(alternateTarget)
      await new Promise(resolve => setTimeout(resolve, 1800))
      const alternate = await toolbarSnapshot()
      const originalTarget = await evaluateByValue(`(() => {
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${JSON.stringify(originalThread)})
        const rect = row?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      if (originalTarget !== null) {
        await pointerClick(originalTarget)
        await new Promise(resolve => setTimeout(resolve, 1800))
      }
      const restored = await toolbarSnapshot()
      routeSessionSwitch = { attempted: true, alternate, restored }
    }
  }

  let beforeClose = await toolbarSnapshot()
  if (!beforeClose.session.actions.some(item => item.pressed === 'true')) {
    const reopenTarget = beforeClose.session.actions.find(item => item.routeState !== null)?.geometry ?? null
    if (reopenTarget !== null) {
      await pointerClick(reopenTarget)
      await new Promise(resolve => setTimeout(resolve, 500))
      beforeClose = await toolbarSnapshot()
    }
  }
  const closeTarget = beforeClose.session.actions.find(item => item.pressed === 'true')?.geometry ?? null
  if (closeTarget !== null) {
    await pointerClick(closeTarget)
    await new Promise(resolve => setTimeout(resolve, 500))
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
    await new Promise(resolve => setTimeout(resolve, 160))
  }
  const routeClosed = await toolbarSnapshot()
  screenshots['toolbar.route-closed'] = await annotateToolbar('route closed · active cleared', 'toolbar-route-closed-annotated')

  const originalViewport = routeActive.viewport
  await send('Emulation.setDeviceMetricsOverride', { width: Math.max(1100, originalViewport.width - 180), height: Math.max(760, originalViewport.height - 120), deviceScaleFactor: originalViewport.dpr, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 500))
  const resized = await toolbarSnapshot()
  await send('Emulation.clearDeviceMetricsOverride')
  await new Promise(resolve => setTimeout(resolve, 300))

  const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
  const six = value => value !== null && Math.abs(value - 6) <= 0.5
  const inactivePass = inactive.session.native?.pressed === 'false'
    && inactive.session.actions.every(item => item.pressed !== 'true' && transparent(item.background))
  const nativeActivePass = nativeActive.session.native?.pressed === 'true'
    && nativeActive.session.actions.every(item => item.pressed !== 'true' && transparent(item.background)
      && !item.className.includes('bg-text/5') && !item.className.includes('codex-toolbar-button'))
  const spacingPass = nativeActive.session.actionGaps.every(six) && six(nativeActive.session.nativeGap)
  const hoverPass = hovered.session.actions[0]?.background !== inactive.session.actions[0]?.background
    && hovered.session.actions.slice(1).every((item, index) => item.background === inactive.session.actions[index + 1]?.background)
    && hovered.session.actions.every(item => item.pressed !== 'true')
  const focusPass = focused.session.actions[1]?.focused === true && focused.session.actions[1]?.pressed !== 'true'
    && focused.session.actions[0]?.pressed !== 'true' && focused.session.native?.pressed === 'true'
  const routePressed = routeActive.session.actions.filter(item => item.pressed === 'true' && item.routeState === 'presented')
  const routePass = routePressed.length === 1
    && routePressed[0]?.owner === 'agent-trace-showcase'
    && routePressed[0]?.background === nativeActive.session.native?.background
    && routePressed[0]?.color === nativeActive.session.native?.color
    && routePressed[0]?.geometry?.width === nativeActive.session.native?.geometry?.width
    && routePressed[0]?.geometry?.height === nativeActive.session.native?.geometry?.height
    && routeActive.session.actions.filter(item => item.pressed !== 'true').every(item => transparent(item.background))
    && routeActive.session.native?.pressed === 'false'
    && routeActive.agentTracePresented === true
  const routeHoverPressed = routeHovered.session.actions.filter(item => item.pressed === 'true' && item.routeState === 'presented')
  const routeHoverPass = routeHoverPressed.length === 1
    && routeHoverPressed[0]?.background === nativeActiveHovered.session.native?.background
    && routeHoverPressed[0]?.background !== routePressed[0]?.background
    && routeHovered.session.actions.filter(item => item.pressed !== 'true').every(item => transparent(item.background))
  const routeClosePass = routeClosed.agentTracePresented === false
    && routeClosed.session.actions.every(item => item.pressed !== 'true' && item.routeState !== 'presented' && transparent(item.background))
  const routeSessionPass = routeSessionSwitch.attempted === false || (
    routeSessionSwitch.alternate.selectedThread === threadTarget?.id
    && routeSessionSwitch.alternate.agentTracePresented === false
    && routeSessionSwitch.alternate.session.actions.every(item => item.pressed !== 'true' && item.routeState !== 'presented')
    && routeSessionSwitch.restored.selectedThread === originalThread
    && routeSessionSwitch.restored.agentTracePresented === false
    && routeSessionSwitch.restored.session.actions.every(item => item.pressed !== 'true' && item.routeState !== 'presented')
  )
  const workspacePass = nativeActive.workspace.slot?.inlineWidth === '126px'
    && nativeActive.workspace.alignmentGroup?.hasMsAuto === true && six(nativeActive.workspace.outerGapFromSummary)
  const resizePass = resized.session.actionGaps.every(six) && six(resized.session.nativeGap)
    && resized.workspace.slot?.inlineWidth === '126px' && resized.session.root?.geometry?.right <= resized.viewport.width
  uiCatalogReport.assertions.push(
    { id: 'toolbar.state.inactive', pass: inactivePass, actual: inactive.session, expected: 'all controls inactive and transparent' },
    { id: 'toolbar.state.native-isolated', pass: nativeActivePass, actual: nativeActive.session, expected: 'only native summary pressed' },
    { id: 'toolbar.state.hover-isolated', pass: hoverPass, actual: hovered.session, expected: 'only hovered CordisX action changes background' },
    { id: 'toolbar.state.focus-isolated', pass: focusPass, actual: focused.session, expected: 'focus belongs to one unpressed sibling' },
    { id: 'toolbar.state.route-isolated', pass: routePass, actual: { route: routeActive.session, nativeReference: nativeActive.session.native }, expected: 'only Agent Trace uses the native-equivalent pressed token and 28px geometry' },
    { id: 'toolbar.state.route-hover-isolated', pass: routeHoverPass, actual: { route: routeHovered.session, nativeReference: nativeActiveHovered.session.native }, expected: 'only the pressed Agent Trace action uses the native-equivalent pressed-hover token' },
    { id: 'toolbar.state.route-closed', pass: routeClosePass, actual: routeClosed, expected: 'second real pointer activation closes the page and clears every active projection' },
    { id: 'toolbar.state.route-session-isolated', pass: routeSessionPass, actual: routeSessionSwitch, expected: 'active route state is cleared on A/B switch and does not return to A' },
    { id: 'toolbar.spacing.session', pass: spacingPass, actual: { actionGaps: nativeActive.session.actionGaps, nativeGap: nativeActive.session.nativeGap }, expected: '6px action and native boundary gaps' },
    { id: 'toolbar.spacing.workspace-contract', pass: workspacePass, actual: nativeActive.workspace, expected: '126px slot, ms-auto, 6px outer group gap' },
    { id: 'toolbar.resize', pass: resizePass, actual: resized, expected: 'state geometry survives renderer resize' },
    { id: 'toolbar.thread-switch-reconcile', pass: threadSwitch.attempted === false || (threadSwitch.restored && threadSwitch.rootConnected && threadSwitch.immediateBefore), actual: threadSwitch, expected: 'real thread switch restores the selected session and valid sibling seat' },
  )
  const toolbarRegression = { initialNativePressed, inactive, nativeActive, nativeActiveHovered, hovered, focused, routeActive, routeHovered, routeClosed, resized, threadSwitch, routeSessionSwitch }
  uiCatalogReport = { ...uiCatalogReport, screenshots, tooltips, toolbarRegression,
    result: uiCatalogReport.assertions.every(item => item.pass) ? 'pass' : 'fail' }
  console.log(`ui-catalog=${JSON.stringify(uiCatalogReport, null, 2)}`)
}

if (parsed.values.screenshot !== undefined) {
  const markerRect = await evaluateByValue(`(() => {
    const panel = document.querySelector('[data-cordisx-page]') ?? document.querySelector('[data-cordisx-demo-marker]')
    const rect = panel?.getBoundingClientRect()
    return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  await capture(markerRect, parsed.values.screenshot, 'CordisX marker')
}

if (parsed.values['app-screenshot'] !== undefined) {
  const captured = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  if (typeof captured.data !== 'string') throw new Error('CDP app screenshot returned no image')
  const screenshotPath = path.resolve(parsed.values['app-screenshot'])
  await mkdir(path.dirname(screenshotPath), { recursive: true })
  await writeFile(screenshotPath, Buffer.from(captured.data, 'base64'))
  console.log(`app-screenshot=${screenshotPath}`)
}

let authorizationReport
if (parsed.values['authorization-plugin'] !== undefined) {
  const pluginId = parsed.values['authorization-plugin']
  const decision = parsed.values['authorization-decision']
  if (decision !== undefined && !['allow', 'allow-once', 'deny'].includes(decision)) {
    throw new Error(`unknown authorization decision: ${decision}`)
  }
  const opened = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    document.querySelector('[data-permission-authorization] [data-authorization-decision="cancel"]')?.click()
    document.querySelector('.cxm-close')?.click()
    await runtime.setPluginBlocked(${JSON.stringify(pluginId)}, true)
    document.querySelector('[data-cordisx-manager-trigger]')?.click()
    document.querySelector('[data-tab="plugins"]')?.click()
    document.querySelector('[data-plugin-id=${JSON.stringify(pluginId)}]')?.click()
    document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
    document.querySelector('.cxm-plugin-runtime-action')?.click()
    await wait(180)
    const dialog = document.querySelector('[data-permission-authorization=${JSON.stringify(pluginId)}]')
    const rect = dialog?.getBoundingClientRect()
    const items = [...(dialog?.querySelectorAll('[role="listitem"]') ?? [])]
    const primary = dialog?.querySelector('[data-authorization-decision="allow"]')
    return rect === undefined ? null : {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      title: dialog.querySelector('h2')?.textContent ?? null,
      headings: dialog.querySelectorAll('h2').length,
      titleOccurrences: (dialog.textContent?.match(/启用授权/g) ?? []).length,
      flat: dialog.querySelector('.cxm-slot-card') === null && items.every(item => item.querySelector('[role="listitem"]') === null),
      primary: primary?.textContent ?? null,
      primaryFocused: document.activeElement === primary,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      items: items.map(item => ({
        capability: item.getAttribute('data-authorization-capability'),
        text: item.textContent?.trim() ?? '',
        checked: item.querySelector('input')?.checked ?? null,
        disabled: item.querySelector('input')?.disabled ?? null,
      })),
    }
  })()`, true)
  if (opened?.rect === undefined) throw new Error(`authorization dialog did not open for ${pluginId}`)
  if (parsed.values['authorization-screenshot'] !== undefined) {
    await capture(opened.rect, parsed.values['authorization-screenshot'], 'CordisX authorization dialog')
  }
  let completed
  if (decision !== undefined) {
    if (parsed.values['authorization-decline-optional']) {
      const optionalRect = await evaluateByValue(`(() => {
        const choice = [...document.querySelectorAll('[data-permission-authorization=${JSON.stringify(pluginId)}] [data-authorization-choice]')]
          .find(item => !item.disabled)
        const rect = choice?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      if (optionalRect === null) throw new Error('authorization dialog has no optional capability choice')
      await pointerClick(optionalRect)
    }
    const actionRect = await evaluateByValue(`(() => {
      const action = document.querySelector('[data-permission-authorization=${JSON.stringify(pluginId)}] [data-authorization-decision=${JSON.stringify(decision)}]')
      const rect = action?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    if (actionRect === null) throw new Error(`authorization action is unavailable: ${decision}`)
    await pointerClick(actionRect)
    await new Promise(resolve => setTimeout(resolve, 400))
    completed = await evaluateByValue(`(() => {
      const snapshot = globalThis.__cordisxRuntime.snapshot()
      return {
        dialogPresent: document.querySelector('[data-permission-authorization=${JSON.stringify(pluginId)}]') !== null,
        plugin: snapshot.plugins.find(item => item.id === ${JSON.stringify(pluginId)}) ?? null,
        permissions: snapshot.permissions.filter(item => item.identity.id === ${JSON.stringify(pluginId)}).map(item => ({
          capability: item.capability, required: item.required, policy: item.policy,
        })),
        browserPolicies: localStorage.getItem('cordisx.platform.permissionPolicies.v2'),
      }
    })()`)
  }
  authorizationReport = { pluginId, opened, decision: decision ?? null, completed: completed ?? null }
  console.log(`authorization=${JSON.stringify(authorizationReport, null, 2)}`)
}

let managerReport
let pluginConsoleReport
if (parsed.values['plugin-console-exercise']) {
  const owner = parsed.values['plugin-owner'] ?? 'console-showcase'
  pluginConsoleReport = await evaluateByValue(`(async () => {
    const owner = ${JSON.stringify(owner)}
    const runtime = globalThis.__cordisxRuntime
    if (runtime?.pluginConsole === undefined) throw new Error('Plugin Console runtime API is unavailable')
    document.querySelector('[data-permission-prompt] [data-permission-decision="deny"]')?.click()
    await new Promise(resolve => setTimeout(resolve, 120))
    const before = runtime.pluginConsole(owner)
    const silent = runtime.pluginConsole('silent-api')
    document.querySelector('[data-cordisx-manager-trigger]')?.click()
    document.querySelector('[data-tab="plugins"]')?.click()
    document.querySelector('[data-plugin-id="' + CSS.escape(owner) + '"]')?.click()
    document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
    const runtimePanel = document.querySelector('[role="tabpanel"][aria-label="运行状态"]')
    const pause = [...(runtimePanel?.querySelectorAll('.cxm-console-controls button') ?? [])].find(item => item.textContent === '暂停')
    pause?.click()
    const pausedPanel = document.querySelector('[role="tabpanel"][aria-label="运行状态"]')
    const paused = pause !== undefined && [...(pausedPanel?.querySelectorAll('.cxm-console-controls button') ?? [])].some(item => item.textContent === '继续')
    const initialFrame = pausedPanel?.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    await new Promise(resolve => setTimeout(resolve, 80))
    initialFrame?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: initialFrame.getBoundingClientRect().top + 7 }))
    const detailOpened = document.querySelector('[data-console-detail]') !== null
    const inspectorText = document.querySelector('[data-console-detail]')?.textContent ?? ''
    const kind = document.querySelector('select[aria-label="API / 类型"]')
    if (kind instanceof HTMLSelectElement) {
      kind.value = 'console'
      kind.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise(resolve => setTimeout(resolve, 80))
    const lunaFrame = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    const lunaText = lunaFrame?.querySelector('.luna-text-viewer-text')
    const scopedFiltered = lunaText?.textContent?.includes('console.log') === true && lunaText?.textContent?.includes('settings.get') !== true
    const firstLineAtTop = lunaFrame !== null && lunaText !== null
      && lunaText.getBoundingClientRect().top - lunaFrame.getBoundingClientRect().top < 16
    const contentDrivenHeight = lunaFrame !== null && lunaText !== null
      && lunaFrame.getBoundingClientRect().height <= Math.min(522, lunaText.getBoundingClientRect().height + 14)
    const lunaOnly = lunaFrame?.classList.contains('luna-log') === true
      && lunaFrame.querySelector('[data-console-entry], .cxm-console-hit-layer') === null
    const nativePayloads = lunaText?.textContent?.includes('arg[1]') === true
      && lunaText?.textContent?.includes('Error: inspectable error') === true
      && lunaText?.textContent?.includes('Array(3)') === true
    if (lunaFrame instanceof HTMLElement) {
      lunaFrame.style.maxHeight = '120px'
      lunaFrame.scrollTop = 0
      lunaFrame.dispatchEvent(new Event('scroll'))
    }
    const returnLatest = lunaFrame?.parentElement?.querySelector('.cxm-console-latest')
    const returnLatestVisible = returnLatest instanceof HTMLButtonElement && !returnLatest.hidden
    returnLatest?.click()
    const returnedToLatest = lunaFrame instanceof HTMLElement && lunaFrame.scrollTop > 0
    const managerModal = document.querySelector('[data-cordisx-manager-modal]')
    const originalThemeClass = document.documentElement.className
    document.documentElement.classList.remove('electron-dark')
    document.documentElement.classList.add('electron-light')
    await new Promise(resolve => setTimeout(resolve, 20))
    const lightTheme = managerModal?.getAttribute('data-cordisx-app-theme') === 'light'
      && lunaFrame?.classList.contains('luna-text-viewer-theme-light') === true
    document.documentElement.className = originalThemeClass
    await new Promise(resolve => setTimeout(resolve, 20))
    const darkTheme = managerModal?.getAttribute('data-cordisx-app-theme') === 'dark'
    const resumed = [...document.querySelectorAll('.cxm-console-controls button')].find(item => item.textContent === '继续')
    resumed?.click()
    const clear = [...document.querySelectorAll('.cxm-console-controls button')].find(item => item.textContent === '清空')
    clear?.click()
    const cleared = runtime.pluginConsole(owner).entries.length === 0
    await runtime.setPluginBlocked(owner, true)
    await runtime.setPluginBlocked(owner, false)
    await new Promise(resolve => setTimeout(resolve, 80))
    document.querySelector('[data-permission-prompt] [data-permission-decision="deny"]')?.click()
    await new Promise(resolve => setTimeout(resolve, 120))
    const after = runtime.pluginConsole(owner)
    const automatic = after.entries.filter(entry => entry.coverage === 'host-mediated')
    const terminal = automatic.filter(entry => ['success', 'failure', 'cancel'].includes(entry.phase))
    const screenshotFrame = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    if (screenshotFrame instanceof HTMLElement) {
      screenshotFrame.scrollTop = 0
      screenshotFrame.dispatchEvent(new Event('scroll'))
    }
    const screenshotPreparedAtTop = screenshotFrame instanceof HTMLElement && screenshotFrame.scrollTop === 0
    return {
      owner,
      before: {
        entries: before.entries.length,
        methods: [...new Set(before.entries.filter(entry => entry.kind === 'console').map(entry => entry.method))],
        sources: [...new Set(before.entries.map(entry => entry.source))],
        permissionDenied: before.entries.some(entry => entry.kind === 'permission' && entry.phase === 'deny'),
        success: before.entries.some(entry => entry.kind === 'invocation' && entry.phase === 'success'),
        failure: before.entries.some(entry => entry.kind === 'invocation' && entry.phase === 'failure'),
      },
      silent: {
        entries: silent.entries.length,
        automaticWithoutConsole: silent.entries.some(entry => entry.source === 'settings.get' && entry.phase === 'success')
          && !silent.entries.some(entry => entry.kind === 'console'),
      },
      ui: {
        paused, detailOpened, inspectorMetadataOnly: !inspectorText.includes('arg['), scopedFiltered, cleared,
        lunaOnly, nativePayloads, firstLineAtTop, contentDrivenHeight,
        returnLatestVisible, returnedToLatest, lightTheme, darkTheme, screenshotPreparedAtTop,
      },
      reload: {
        entries: after.entries.length,
        lifecycle: after.entries.some(entry => entry.phase === 'reload'),
        terminalCount: terminal.length,
      },
      privacy: {
        structuredOnly: automatic.every(entry => !JSON.stringify(entry).includes('initialMessage') && !JSON.stringify(entry).includes('secretRef')),
        partialObservability: after.partialObservability === true,
      },
    }
  })()`, true)
  console.log(`plugin-console=${JSON.stringify(pluginConsoleReport, null, 2)}`)
}
if (parsed.values['manager-screenshot'] !== undefined) {
  const managerTab = parsed.values['manager-tab'] ?? 'plugins'
  if (!['about', 'extension-points', 'routes', 'plugins', 'marketplace', 'settings'].includes(managerTab)) throw new Error(`unknown manager tab: ${managerTab}`)
  const managerPlugin = parsed.values['manager-plugin']
  const managerDetailTab = parsed.values['manager-detail-tab']
  if (managerDetailTab !== undefined && !['readme', 'config', 'permissions', 'runtime', 'extension-points', 'routes'].includes(managerDetailTab)) throw new Error(`unknown manager detail tab: ${managerDetailTab}`)
  const managerPermissionCapability = parsed.values['manager-permission-capability']
  if (managerPermissionCapability !== undefined && managerDetailTab !== 'permissions') throw new Error('--manager-permission-capability requires --manager-detail-tab permissions')
  const managerSettingsTab = parsed.values['manager-settings-tab']
  if (managerSettingsTab !== undefined && !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(managerSettingsTab)) {
    throw new Error(`invalid manager settings tab id: ${managerSettingsTab}`)
  }
  const managerExtensionPoint = parsed.values['manager-extension-point']
  const managerExtensionPointTab = parsed.values['manager-extension-point-tab']
  if (managerExtensionPointTab !== undefined && !['usage', 'information', 'diagnostics'].includes(managerExtensionPointTab)) throw new Error(`unknown manager extension point tab: ${managerExtensionPointTab}`)
  const managerRoute = parsed.values['manager-route']
  const managerMarketplaceTab = parsed.values['manager-marketplace-tab']
  if (managerMarketplaceTab !== undefined && !['overview', 'authors-source'].includes(managerMarketplaceTab)) throw new Error(`unknown manager marketplace tab: ${managerMarketplaceTab}`)
  const managerMarketplaceSource = parsed.values['manager-marketplace-source']
  if (managerMarketplaceSource !== undefined) {
    const sourceUrl = new URL(managerMarketplaceSource)
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username !== '' || sourceUrl.password !== '' || sourceUrl.hash !== '') {
      throw new Error('--manager-marketplace-source must be a credential-free HTTPS URL without a fragment')
    }
  }
  const managerViewportWidth = parsed.values['manager-viewport-width'] === undefined
    ? undefined
    : Number(parsed.values['manager-viewport-width'])
  if (managerViewportWidth !== undefined && (!Number.isInteger(managerViewportWidth) || managerViewportWidth < 400 || managerViewportWidth > 3840)) {
    throw new Error('--manager-viewport-width must be an integer between 400 and 3840')
  }
  const managerBreadcrumbWidth = parsed.values['manager-breadcrumb-width'] === undefined
    ? undefined
    : Number(parsed.values['manager-breadcrumb-width'])
  if (managerBreadcrumbWidth !== undefined && (!Number.isInteger(managerBreadcrumbWidth) || managerBreadcrumbWidth < 120 || managerBreadcrumbWidth > 800)) {
    throw new Error('--manager-breadcrumb-width must be an integer between 120 and 800')
  }
  if (managerViewportWidth !== undefined) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: managerViewportWidth,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
  const evaluatedManager = await send('Runtime.evaluate', {
    expression: `(async () => {
      const smokeLocale = ${JSON.stringify(locale)}
      const smokeTheme = ${JSON.stringify(colorScheme)}
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      const openedBy = trigger === null ? 'host-smoke-fallback' : 'manager-trigger'
      if (trigger !== null) trigger.click()
      else if (modal instanceof HTMLElement) modal.hidden = false
      const marketplaceSource = ${JSON.stringify(managerMarketplaceSource)}
      if (marketplaceSource !== undefined) {
        document.querySelector('[data-tab="settings"]')?.click()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        document.querySelector('[data-settings-tab="host:marketplace"]')?.click()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const existingRows = [...document.querySelectorAll('.cxm-source-list .cxm-source-row')]
        for (const row of existingRows) row.querySelector('.cxm-source-actions .cxm-mini-action:last-child')?.click()
        const removalDeadline = Date.now() + 5_000
        while (document.querySelector('.cxm-source-list .cxm-source-row') !== null && Date.now() < removalDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        const input = document.querySelector('.cxm-source-form .cxm-source-input')
        const form = document.querySelector('.cxm-source-form')
        if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) throw new Error('marketplace source form is unavailable')
        input.value = marketplaceSource
        form.requestSubmit()
        const sourceDeadline = Date.now() + 12_000
        let sourceState
        while (Date.now() < sourceDeadline) {
          const sourceRow = [...document.querySelectorAll('.cxm-source-list .cxm-source-row')]
            .find(row => row.querySelector('.cxm-source-url')?.textContent?.trim() === marketplaceSource)
          sourceState = sourceRow?.querySelector('.cxm-source-state')?.textContent?.trim()
          if (sourceState?.includes('已加载') === true || sourceState?.includes('加载失败') === true) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (sourceState?.includes('已加载') !== true) throw new Error('marketplace smoke source failed to load: ' + (sourceState ?? 'timeout'))
      }
      document.querySelector('[data-tab=${JSON.stringify(managerTab)}]')?.click()
      if (${JSON.stringify(managerTab)} === 'marketplace') {
        const deadline = Date.now() + 12_000
        while (document.querySelector('[aria-label="插件商店列表"] [data-marketplace-plugin], [aria-label="插件商店列表"] .cxm-empty') === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      const pluginId = ${JSON.stringify(managerPlugin)}
      if (pluginId !== undefined) {
        const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
          .find(element => element.getAttribute('data-plugin-id') === pluginId || element.getAttribute('data-marketplace-plugin') === pluginId)
        const primary = row?.matches('button') === true ? row : row?.querySelector('.cxm-plugin-primary')
        primary?.click()
      }
      const detailTab = ${JSON.stringify(managerDetailTab)}
      if (detailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
      const permissionCapability = ${JSON.stringify(managerPermissionCapability)}
      if (permissionCapability !== undefined) document.querySelector('[data-permission-open="' + CSS.escape(permissionCapability) + '"]')?.click()
      const settingsTab = ${JSON.stringify(managerSettingsTab)}
      if (settingsTab !== undefined) document.querySelector('[data-settings-tab="' + settingsTab + '"]')?.click()
      if (settingsTab !== undefined) await new Promise(resolve => setTimeout(resolve, 250))
      const extensionPointId = ${JSON.stringify(managerExtensionPoint)}
      if (extensionPointId !== undefined) document.querySelector('[data-extension-point-id="' + CSS.escape(extensionPointId) + '"]')?.click()
      const extensionPointTab = ${JSON.stringify(managerExtensionPointTab)}
      if (extensionPointTab !== undefined) document.querySelector('[data-extension-point-detail-tab="' + extensionPointTab + '"]')?.click()
      const routeId = ${JSON.stringify(managerRoute)}
      if (routeId !== undefined) document.querySelector('[data-route-id="' + CSS.escape(routeId) + '"]')?.click()
      const marketplaceTab = ${JSON.stringify(managerMarketplaceTab)}
      if (marketplaceTab !== undefined) document.querySelector('[data-marketplace-detail-tab="' + marketplaceTab + '"]')?.click()
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      const breadcrumbWidth = ${JSON.stringify(managerBreadcrumbWidth)}
      const heading = document.querySelector('.cxm-heading')
      if (breadcrumbWidth !== undefined && heading instanceof HTMLElement) {
        heading.style.flex = '0 1 ' + breadcrumbWidth + 'px'
        heading.style.width = breadcrumbWidth + 'px'
        window.dispatchEvent(new Event('resize'))
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (breadcrumbWidth !== undefined) {
        const overflow = document.querySelector('.cxm-breadcrumb-overflow')
        if (overflow instanceof HTMLDetailsElement) overflow.open = true
      }
      const dialog = document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')
      const rect = dialog?.getBoundingClientRect()
      const leadingRect = document.querySelector('.cxm-heading-leading')?.getBoundingClientRect()
      const firstTab = document.querySelector('.cxm-tabs .cxm-tab:first-child')
      const tabIconRect = firstTab?.querySelector('.cxm-tab-icon')?.getBoundingClientRect()
      const tabLabelRect = firstTab?.querySelector('.cxm-tab-content > span:last-child')?.getBoundingClientRect()
      const titleRect = document.querySelector('.cxm-heading-title')?.getBoundingClientRect()
      const breadcrumb = document.querySelector('.cxm-breadcrumbs')
      const breadcrumbItems = [...(breadcrumb?.querySelectorAll(':scope > .cxm-breadcrumb-list > .cxm-breadcrumb-item') ?? [])]
      const breadcrumbOrdered = breadcrumbItems.flatMap(item => {
        const menu = item.querySelector('.cxm-breadcrumb-menu')
        if (menu !== null) return [...menu.querySelectorAll('.cxm-breadcrumb-action')].map(action => action.textContent?.trim() ?? '')
        const label = item.querySelector(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current')
        return label === null ? [] : [label.textContent?.trim() ?? '']
      })
      const breadcrumbCurrent = breadcrumb?.querySelector('.cxm-breadcrumb-current')
      let externalDefaultPrevented
      if (${JSON.stringify(parsed.values['manager-click-external'])}) {
        const link = document.querySelector('.cxm-content a[href]')
        if (link !== null) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true })
          link.dispatchEvent(event)
          externalDefaultPrevented = event.defaultPrevented
        }
      }
      return rect === undefined ? null : {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        state: {
          modalHidden: modal?.hidden,
          openedBy,
          theme: {
            root: document.documentElement.getAttribute('data-theme'),
            projected: modal?.getAttribute('data-cordisx-app-theme') ?? null,
            source: modal?.getAttribute('data-cordisx-theme-source') ?? null,
            dialogBackground: dialog === null ? null : getComputedStyle(dialog).backgroundColor,
          },
          triggerExpanded: trigger?.getAttribute('aria-expanded'),
          externalDefaultPrevented,
          breadcrumb: {
            route: breadcrumb?.getAttribute('data-manager-page-route') ?? null,
            ordered: breadcrumbOrdered,
            inline: breadcrumbItems.flatMap(item => [...item.querySelectorAll(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current')].map(label => label.textContent?.trim() ?? '')),
            overflow: [...(breadcrumb?.querySelectorAll('.cxm-breadcrumb-menu .cxm-breadcrumb-action') ?? [])].map(item => item.textContent?.trim() ?? ''),
            overflowCount: Number(breadcrumb?.getAttribute('data-breadcrumb-overflow-count') ?? 0),
            overflowMenuOpen: breadcrumb?.querySelector('.cxm-breadcrumb-overflow')?.open ?? false,
            clientWidth: breadcrumb?.clientWidth ?? null,
            scrollWidth: breadcrumb?.scrollWidth ?? null,
            itemWidths: breadcrumbItems.map(item => item.getBoundingClientRect().width),
            current: breadcrumbCurrent?.textContent?.trim() ?? null,
            currentInteractive: breadcrumbCurrent?.matches('a,button') ?? null,
            ancestorTargets: [...(breadcrumb?.querySelectorAll('[data-breadcrumb-target]') ?? [])].map(item => item.getAttribute('data-breadcrumb-target')),
            backPresent: document.querySelector('.cxm-heading-leading.cxm-back') !== null,
          },
          nativeRoute: { url: location.href, historyLength: history.length },
          breadcrumbConstraintWidth: breadcrumbWidth ?? null,
          tabGeometry: leadingRect === undefined || tabIconRect === undefined || tabLabelRect === undefined || titleRect === undefined ? null : {
            headingLeadingCenterX: leadingRect.x + leadingRect.width / 2,
            firstTabIconCenterX: tabIconRect.x + tabIconRect.width / 2,
            headingTitleX: titleRect.x,
            firstTabLabelX: tabLabelRect.x,
          },
          permissions: [...document.querySelectorAll('[data-permission-item]')].map(item => ({
            capability: item.getAttribute('data-permission-item'),
            availability: item.querySelector('[data-permission-availability]')?.getAttribute('data-availability-state') ?? null,
            policyEditable: item.querySelector('select[data-permission-capability]') instanceof HTMLSelectElement,
            nestedList: item.querySelector('[role="listitem"]') !== null,
          })),
          permissionDetail: document.querySelector('[data-permission-detail]') === null ? null : {
            capability: document.querySelector('[data-permission-detail]')?.getAttribute('data-permission-detail') ?? null,
            providers: [...document.querySelectorAll('[data-permission-provider]')].map(item => ({
              id: item.getAttribute('data-permission-provider'),
              text: item.textContent?.trim() ?? '',
            })),
            policyEditable: document.querySelector('[data-permission-detail] select[data-permission-capability]') instanceof HTMLSelectElement,
            headings: [...document.querySelectorAll('[data-permission-detail] h1, [data-permission-detail] h2, [data-permission-detail] h3')].map(item => item.textContent?.trim() ?? ''),
          },
          extensionPointCatalog: document.querySelector('[aria-label="扩展点列表"]') === null ? null : {
            locale: document.documentElement.lang,
            rows: [...document.querySelectorAll('[aria-label="扩展点列表"] [data-extension-point-id]')].map(row => {
              const rect = row.getBoundingClientRect()
              const status = row.querySelector('.cxm-catalog-status')
              const statusRect = status?.getBoundingClientRect()
              return {
                id: row.getAttribute('data-extension-point-id'),
                state: row.getAttribute('data-extension-point-state'),
                title: row.querySelector('.cxm-catalog-title')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxm-catalog-description')?.textContent?.trim() ?? null,
                stableId: row.querySelector('.cxm-catalog-id')?.textContent?.trim() ?? null,
                hostIcon: row.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null,
                status: status?.textContent?.trim() ?? null,
                typeOrNormalTag: [...row.querySelectorAll('.cxm-kind-badge')].map(item => item.textContent?.trim() ?? ''),
                statusInsidePrimaryRow: statusRect === undefined || (statusRect.top >= rect.top && statusRect.bottom <= rect.bottom),
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
          marketplaceCatalog: document.querySelector('[aria-label="插件商店列表"]') === null ? null : {
            locale: document.documentElement.lang,
            permanentTrustWarning: (document.querySelector('.cxm-content')?.textContent ?? '').includes('商店收录、schema 校验和页面展示都不代表'),
            rows: [...document.querySelectorAll('[aria-label="插件商店列表"] [data-marketplace-plugin]')].map(row => {
              const primary = row.querySelector('.cxm-plugin-primary')
              const style = primary === null ? null : getComputedStyle(primary)
              return {
                id: row.getAttribute('data-marketplace-plugin'),
                role: row.getAttribute('role'),
                primaryButton: primary?.matches('button') ?? false,
                padding: style === null ? null : [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
                name: row.querySelector('.cxm-plugin-name')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxm-plugin-description')?.textContent?.trim() ?? null,
                version: row.querySelector('.cxm-plugin-meta-version')?.textContent?.trim() ?? null,
                source: row.querySelector('.cxm-plugin-meta-source')?.textContent?.trim() ?? null,
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
        },
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (evaluatedManager.exceptionDetails !== undefined) {
    const detail = evaluatedManager.exceptionDetails.exception?.description
      ?? evaluatedManager.exceptionDetails.text
      ?? 'unknown renderer exception'
    throw new Error(`CordisX manager smoke evaluation failed: ${detail}`)
  }
  const managerResult = evaluatedManager.result?.value ?? null
  managerReport = managerResult?.state ?? null
  console.log(`manager-state=${JSON.stringify(managerReport)}`)
  try {
    await capture(managerResult?.rect ?? null, parsed.values['manager-screenshot'], 'CordisX manager')
  } finally {
    if (managerBreadcrumbWidth !== undefined) {
      await send('Runtime.evaluate', {
        expression: `(() => {
          const heading = document.querySelector('.cxm-heading')
          if (!(heading instanceof HTMLElement)) return false
          heading.style.removeProperty('flex')
          heading.style.removeProperty('width')
          return true
        })()`,
        returnByValue: true,
      })
    }
    if (managerViewportWidth !== undefined) await send('Emulation.clearDeviceMetricsOverride')
  }
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

if (colorScheme !== undefined) {
  await send('Runtime.evaluate', {
    expression: 'globalThis.__cordisxRestoreSmokeTheme?.()',
  })
}

let generationReport
if (parsed.values.generation) {
  const beforeDispose = await evaluateByValue(`(() => ({
    ready: document.documentElement.dataset.cordisxReady === 'true',
    runtimePresent: globalThis.__cordisxRuntime !== undefined,
    surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
    outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
    pages: document.querySelectorAll('[data-cordisx-page]').length,
    settingsPages: document.querySelectorAll('[data-cordisx-settings-page]').length,
    tooltips: document.querySelectorAll('.cordisx-host-tooltip').length,
    styles: document.querySelectorAll('#cordisx-structured-styles, #cordisx-manager-style').length,
    trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
  }))()`)
  const afterDispose = await evaluateByValue(`(async () => {
    await globalThis.__cordisxRuntime?.dispose?.()
    return {
      ready: document.documentElement.dataset.cordisxReady === 'true',
      runtimePresent: globalThis.__cordisxRuntime !== undefined,
      surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
      outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
      pages: document.querySelectorAll('[data-cordisx-page]').length,
      settingsPages: document.querySelectorAll('[data-cordisx-settings-page]').length,
      tooltips: document.querySelectorAll('.cordisx-host-tooltip').length,
      styles: document.querySelectorAll('#cordisx-structured-styles, #cordisx-manager-style').length,
      trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
    }
  })()`, true)
  generationReport = { beforeDispose, afterDispose,
    cleaned: afterDispose.ready === false && afterDispose.runtimePresent === false && afterDispose.surfaces === 0
      && afterDispose.outlets === 0 && afterDispose.pages === 0 && afterDispose.tooltips === 0
      && afterDispose.settingsPages === 0
      && afterDispose.styles === 0 && afterDispose.trigger === false }
  console.log(`generation=${JSON.stringify(generationReport, null, 2)}`)
}

const interactionSafety = await evaluateByValue(`(() => ({
  pendingPermissionDialogs: document.querySelectorAll('[data-permission-authorization]').length,
  pendingLifecycleDialogs: document.querySelectorAll('.cxm-lifecycle-overlay').length,
}))()`)

if (parsed.values.report !== undefined) {
  const reportPath = path.resolve(parsed.values.report)
  const aggregate = {
    run: {
      rendererUrl: report.url,
      runtimeVersion: report.version,
      adapterCommit: parsed.values['adapter-commit'] ?? null,
      protocolCommit: parsed.values['protocol-commit'] ?? null,
      hostVersion: parsed.values['host-version'] ?? null,
      hostBuild: parsed.values['host-build'] ?? null,
      isolatedRenderer: true,
    },
    baseline: report,
    interactionSafety,
    ...(managerReport === undefined ? {} : { manager: managerReport }),
    ...(exerciseReport === undefined ? {} : { exercise: exerciseReport }),
    ...(settingsTabsReport === undefined ? {} : { managerSettings: settingsTabsReport }),
    ...(configExerciseReport === undefined ? {} : { pluginConfiguration: configExerciseReport }),
    ...(demoReport === undefined ? {} : { agentTraceDemo: demoReport }),
    ...(pluginLifecycleReport === undefined ? {} : { pluginLifecycle: pluginLifecycleReport }),
    ...(pluginConsoleReport === undefined ? {} : { pluginConsole: pluginConsoleReport }),
    ...(authorizationReport === undefined ? {} : { authorization: authorizationReport }),
    ...(managerLifecycleReport === undefined ? {} : { managerLifecycle: managerLifecycleReport }),
    ...(generationTransactionReport === undefined ? {} : { generationTransaction: generationTransactionReport }),
    ...(uiCatalogReport === undefined ? {} : { uiCatalog: uiCatalogReport }),
    ...(generationReport === undefined ? {} : { generation: generationReport }),
  }
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`)
  console.log(`report=${reportPath}`)
}

socket.close()

if (uiCatalogReport?.result === 'fail') {
  throw new Error('UI catalog smoke assertions failed; inspect the aggregated report')
}
if (settingsTabsReport?.passed === false) {
  throw new Error('manager settings smoke assertions failed; inspect the aggregated report')
}
if (configExerciseReport?.result === 'fail') {
  throw new Error('plugin configuration smoke assertions failed; inspect the aggregated report')
}
if (managerLifecycleReport?.result === 'fail') {
  throw new Error('manager lifecycle smoke assertions failed; inspect the aggregated report')
}
if (interactionSafety.pendingPermissionDialogs !== 0 || interactionSafety.pendingLifecycleDialogs !== 0) {
  throw new Error('live smoke left an interactive permission or lifecycle dialog open')
}
