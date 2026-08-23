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
    'manager-settings-tab': { type: 'string' },
    'manager-extension-point': { type: 'string' },
    'manager-extension-point-tab': { type: 'string' },
    'manager-route': { type: 'string' },
    'manager-marketplace-tab': { type: 'string' },
    'manager-click-external': { type: 'boolean', default: false },
    'trigger-screenshot': { type: 'string' },
    'color-scheme': { type: 'string' },
    'fetch-url': { type: 'string' },
    report: { type: 'string' },
    'select-thread': { type: 'string' },
    'plugin-owner': { type: 'string' },
    'open-route': { type: 'string' },
    'session-id': { type: 'string' },
    exercise: { type: 'boolean', default: false },
    generation: { type: 'boolean', default: false },
  },
})
const port = Number(parsed.values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: npm run smoke -- --port <port> [--color-scheme light|dark] [--screenshot <png>] [--app-screenshot <png>] [--plugin-owner <id> --open-route <id>] [--manager-screenshot <png> --manager-tab <tab> --manager-plugin <id> --manager-detail-tab <tab> --manager-settings-tab <tab> --manager-extension-point <id> --manager-extension-point-tab <tab> --manager-route <qualified-id> --manager-marketplace-tab <tab> --manager-click-external] [--trigger-screenshot <png>]')
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
      globalThis.__cordisxRestoreSmokeTheme = () => {
        for (const record of records) {
          if (record.style === null) record.element.removeAttribute('style')
          else record.element.setAttribute('style', record.style)
        }
        delete globalThis.__cordisxRestoreSmokeTheme
      }
      const dark = ${JSON.stringify(colorScheme)} === 'dark'
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
  const selected = await send('Runtime.evaluate', {
    expression: `(async () => {
      document.querySelector('.cxm-close')?.click()
      const id = ${JSON.stringify(parsed.values['select-thread'])}
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === id)
      if (row === undefined) return { clicked: false, id }
      row.click()
      await new Promise(resolve => setTimeout(resolve, 1800))
      return {
        clicked: true,
        id,
        selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(`thread=${JSON.stringify(selected.result?.value)}`)
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
      })) ?? [],
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
if (parsed.values.report !== undefined) {
  const reportPath = path.resolve(parsed.values.report)
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`report=${reportPath}`)
}

async function evaluateByValue(expression, awaitPromise = false) {
  const value = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (value.exceptionDetails !== undefined) throw new Error(value.exceptionDetails.text ?? 'CDP evaluation failed')
  return value.result?.value
}

let exerciseReport
if (parsed.values.exercise) {
  await evaluateByValue(`(async () => {
    document.querySelector('.cxm-close')?.click()
    for (const page of document.querySelectorAll('[data-cordisx-page]')) {
      page.querySelector('button[aria-label="Close"]')?.click()
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  })()`, true)
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
    const nativeRootFor = id => [...document.querySelectorAll('[data-codex-thread-reference-drop-target]')]
      .filter(visible)
      .find(element => [...element.querySelectorAll('[data-response-annotation-conversation]')]
        .some(child => child.getAttribute('data-response-annotation-conversation') === id))
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
    await runtime.navigate('slot-showcase', { id: 'main.analytics' })
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
      browserHistoryUnchanged: location.href === 'app://-/index.html',
      finalOutlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main'),
    }
  })()`, true)
  exerciseReport.drag = drag
  console.log(`exercise=${JSON.stringify(exerciseReport, null, 2)}`)
  if (parsed.values.report !== undefined) {
    const reportPath = path.resolve(parsed.values.report)
    await writeFile(reportPath, `${JSON.stringify({ baseline: report, exercise: exerciseReport }, null, 2)}\n`)
  }
}

if (parsed.values.generation) {
  const beforeDispose = await evaluateByValue(`(() => ({
    ready: document.documentElement.dataset.cordisxReady === 'true',
    surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
    outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
    trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
  }))()`)
  const afterDispose = await evaluateByValue(`(async () => {
    await globalThis.__cordisxRuntime?.dispose?.()
    return {
      ready: document.documentElement.dataset.cordisxReady === 'true',
      surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
      outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
      pages: document.querySelectorAll('[data-cordisx-page]').length,
      trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
    }
  })()`, true)
  const generationReport = { beforeDispose, afterDispose }
  console.log(`generation=${JSON.stringify(generationReport, null, 2)}`)
  if (parsed.values.report !== undefined) {
    const reportPath = path.resolve(parsed.values.report)
    await writeFile(reportPath, `${JSON.stringify({ baseline: report, generation: generationReport }, null, 2)}\n`)
  }
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

if (parsed.values['manager-screenshot'] !== undefined) {
  const managerTab = parsed.values['manager-tab'] ?? 'plugins'
  if (!['about', 'extension-points', 'routes', 'plugins', 'marketplace', 'settings'].includes(managerTab)) throw new Error(`unknown manager tab: ${managerTab}`)
  const managerPlugin = parsed.values['manager-plugin']
  const managerDetailTab = parsed.values['manager-detail-tab']
  if (managerDetailTab !== undefined && !['readme', 'config', 'permissions', 'runtime', 'extension-points', 'routes'].includes(managerDetailTab)) throw new Error(`unknown manager detail tab: ${managerDetailTab}`)
  const managerSettingsTab = parsed.values['manager-settings-tab']
  if (managerSettingsTab !== undefined && !['marketplace', 'runtime', 'launcher'].includes(managerSettingsTab)) throw new Error(`unknown manager settings tab: ${managerSettingsTab}`)
  const managerExtensionPoint = parsed.values['manager-extension-point']
  const managerExtensionPointTab = parsed.values['manager-extension-point-tab']
  if (managerExtensionPointTab !== undefined && !['usage', 'information', 'diagnostics'].includes(managerExtensionPointTab)) throw new Error(`unknown manager extension point tab: ${managerExtensionPointTab}`)
  const managerRoute = parsed.values['manager-route']
  const managerMarketplaceTab = parsed.values['manager-marketplace-tab']
  if (managerMarketplaceTab !== undefined && !['overview', 'authors-source'].includes(managerMarketplaceTab)) throw new Error(`unknown manager marketplace tab: ${managerMarketplaceTab}`)
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
      const extensionPointId = ${JSON.stringify(managerExtensionPoint)}
      if (extensionPointId !== undefined) document.querySelector('[data-extension-point-id="' + CSS.escape(extensionPointId) + '"]')?.click()
      const extensionPointTab = ${JSON.stringify(managerExtensionPointTab)}
      if (extensionPointTab !== undefined) document.querySelector('[data-extension-point-detail-tab="' + extensionPointTab + '"]')?.click()
      const routeId = ${JSON.stringify(managerRoute)}
      if (routeId !== undefined) document.querySelector('[data-route-id="' + CSS.escape(routeId) + '"]')?.click()
      const marketplaceTab = ${JSON.stringify(managerMarketplaceTab)}
      if (marketplaceTab !== undefined) document.querySelector('[data-marketplace-detail-tab="' + marketplaceTab + '"]')?.click()
      const dialog = document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')
      const rect = dialog?.getBoundingClientRect()
      const leadingRect = document.querySelector('.cxm-heading-leading')?.getBoundingClientRect()
      const firstTab = document.querySelector('.cxm-tabs .cxm-tab:first-child')
      const tabIconRect = firstTab?.querySelector('.cxm-tab-icon')?.getBoundingClientRect()
      const tabLabelRect = firstTab?.querySelector('.cxm-tab-content > span:last-child')?.getBoundingClientRect()
      const titleRect = document.querySelector('.cxm-heading h2')?.getBoundingClientRect()
      let externalDefaultPrevented
      if (${JSON.stringify(parsed.values['manager-click-external'])}) {
        const link = document.querySelector('.cxm-content a[href]')
        if (link !== null) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true })
          link.dispatchEvent(event)
          externalDefaultPrevented = event.defaultPrevented
        }
      }
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      return rect === undefined ? null : {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        state: {
          modalHidden: modal?.hidden,
          triggerExpanded: trigger?.getAttribute('aria-expanded'),
          externalDefaultPrevented,
          tabGeometry: leadingRect === undefined || tabIconRect === undefined || tabLabelRect === undefined || titleRect === undefined ? null : {
            headingLeadingCenterX: leadingRect.x + leadingRect.width / 2,
            firstTabIconCenterX: tabIconRect.x + tabIconRect.width / 2,
            headingTitleX: titleRect.x,
            firstTabLabelX: tabLabelRect.x,
          },
        },
      }
    })()`,
    returnByValue: true,
  })
  const managerResult = evaluatedManager.result?.value ?? null
  console.log(`manager-state=${JSON.stringify(managerResult?.state ?? null)}`)
  await capture(managerResult?.rect ?? null, parsed.values['manager-screenshot'], 'CordisX manager')
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

socket.close()
