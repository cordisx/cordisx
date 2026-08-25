#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { transform } from 'esbuild'
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
    'manager-settings-navigation-item': { type: 'string' },
    'manager-settings-navigation-exercise': { type: 'boolean', default: false },
    'manager-form-exercise': { type: 'boolean', default: false },
    'manager-open-local-path-form': { type: 'boolean', default: false },
    'manager-open-select': { type: 'boolean', default: false },
    'config-exercise': { type: 'boolean', default: false },
    'manager-lifecycle-source': { type: 'string' },
    'permission-v2-source': { type: 'string' },
    'permission-v2-expanded-source': { type: 'string' },
    'manager-extension-point': { type: 'string' },
    'manager-extension-point-tab': { type: 'string' },
    'manager-route': { type: 'string' },
    'manager-marketplace-tab': { type: 'string' },
    'manager-marketplace-view': { type: 'string' },
    'manager-marketplace-open-menu': { type: 'boolean', default: false },
    'manager-marketplace-clipboard-exercise': { type: 'boolean', default: false },
    'manager-marketplace-source': { type: 'string' },
    'manager-marketplace-fixture': { type: 'string' },
    'manager-click-external': { type: 'boolean', default: false },
    'manager-viewport-width': { type: 'string' },
    'manager-breadcrumb-width': { type: 'string' },
    'manager-theme-cycle': { type: 'boolean', default: false },
    'channel-data-plane': { type: 'boolean', default: false },
    'channel-manager-exercise': { type: 'boolean', default: false },
    'channel-manager-existing-account': { type: 'boolean', default: false },
    'channel-manager-existing-account-save': { type: 'boolean', default: false },
    'host-collection-menu-exercise': { type: 'boolean', default: false },
    'host-collection-menu-screenshot': { type: 'string' },
    'manager-light-screenshot': { type: 'string' },
    'manager-dark-screenshot': { type: 'string' },
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
    'plugin-console-expanded-screenshot': { type: 'string' },
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
  throw new Error('Usage: npm run smoke -- --port <port> [--color-scheme light|dark] [--locale en|zh-CN] [--screenshot <png>] [--app-screenshot <png>] [--host-collection-menu-exercise --host-collection-menu-screenshot <png> --report <json>] [--plugin-owner <id> --open-route <id> | --click-surface <id> --click-label <aria-label>] [--permission-capability <name> --permission-policy allow|ask|deny] [--manager-screenshot <png> --manager-tab <tab> --manager-plugin <id> --manager-detail-tab <tab> --manager-permission-capability <name> --manager-settings-tab <tab> --manager-settings-navigation-item <qualified-id> --manager-extension-point <id> --manager-extension-point-tab <tab> --manager-route <qualified-id> --manager-marketplace-tab <tab> --manager-marketplace-view discovery|sources|create --manager-marketplace-open-menu --manager-marketplace-clipboard-exercise --manager-marketplace-source <https-url> --manager-marketplace-fixture <absolute-json> --manager-click-external --manager-viewport-width <pixels> --manager-breadcrumb-width <pixels>] [--manager-lifecycle-source <absolute-directory> --report <json>] [--trigger-screenshot <png>]')
}
if (parsed.values['ui-catalog'] && parsed.values.report === undefined) {
  throw new Error('--ui-catalog requires --report so screenshots and machine-readable assertions share one artifact directory')
}
if (parsed.values['channel-data-plane'] && parsed.values.report === undefined) {
  throw new Error('--channel-data-plane requires --report')
}
if (parsed.values['channel-manager-exercise'] && (!parsed.values['channel-data-plane'] || parsed.values['manager-screenshot'] === undefined)) {
  throw new Error('--channel-manager-exercise requires --channel-data-plane and --manager-screenshot')
}
if (parsed.values['channel-manager-existing-account'] && (!parsed.values['channel-data-plane'] || parsed.values['manager-screenshot'] === undefined)) {
  throw new Error('--channel-manager-existing-account requires --channel-data-plane and --manager-screenshot')
}
if (parsed.values['channel-manager-existing-account-save'] && !parsed.values['channel-manager-existing-account']) {
  throw new Error('--channel-manager-existing-account-save requires --channel-manager-existing-account')
}
if (parsed.values['host-collection-menu-exercise'] && parsed.values.report === undefined) {
  throw new Error('--host-collection-menu-exercise requires --report')
}
if (parsed.values['host-collection-menu-screenshot'] !== undefined && !parsed.values['host-collection-menu-exercise']) {
  throw new Error('--host-collection-menu-screenshot requires --host-collection-menu-exercise')
}
if (parsed.values['plugin-console-exercise'] && parsed.values.report === undefined) {
  throw new Error('--plugin-console-exercise requires --report')
}
if (parsed.values['plugin-console-expanded-screenshot'] !== undefined && !parsed.values['plugin-console-exercise']) {
  throw new Error('--plugin-console-expanded-screenshot requires --plugin-console-exercise')
}

function pluginConsoleSmokeAssertions(report, owner) {
  const nonEmptyText = value => typeof value === 'string' && value.trim().length > 0
  const positiveRect = value => value !== null
    && typeof value === 'object'
    && typeof value.width === 'number' && value.width > 0
    && typeof value.height === 'number' && value.height > 0
  const expectedMethods = ['debug', 'log', 'info', 'warn', 'error']
  return {
    owner: report.owner === owner,
    'before.entries': report.before.entries > 0,
    'before.methods': expectedMethods.every(method => report.before.methods.includes(method)),
    'before.sources': report.before.sources.length > 0,
    'before.permissionDenied': report.before.permissionDenied,
    'before.success': report.before.success,
    'before.failure': report.before.failure,
    'silent.entries': report.silent.entries > 0,
    'silent.automaticWithoutConsole': report.silent.automaticWithoutConsole,
    'ui.paused': report.ui.paused,
    'ui.detailOpened': report.ui.detailOpened,
    'ui.inspectorMetadataOnly': report.ui.inspectorMetadataOnly,
    'ui.scopedFiltered': report.ui.scopedFiltered,
    'ui.cleared': report.ui.cleared,
    'ui.lunaOnly': report.ui.lunaOnly,
    'ui.nativePayloads': report.ui.nativePayloads,
    'ui.firstLineAtTop': report.ui.firstLineAtTop,
    'ui.contentDrivenHeight': report.ui.contentDrivenHeight,
    'ui.independentEntries': report.ui.independentEntries,
    'ui.independentEntryCount': report.ui.independentEntryCount > 0,
    'ui.mountedEntryCount': report.ui.mountedEntryCount === report.ui.independentEntryCount,
    'ui.levelVisuals': report.ui.levelVisuals,
    'ui.objectExpanded': report.ui.objectExpanded,
    'ui.coverageRemoved': report.ui.coverageRemoved,
    'ui.iconToolbar': report.ui.iconToolbar,
    'ui.pointerPaused': report.ui.pointerPaused,
    'ui.pointerPauseDetail.label': nonEmptyText(report.ui.pointerPauseDetail?.label),
    'ui.pointerPauseDetail.rect': positiveRect(report.ui.pointerPauseDetail?.rect),
    'ui.keyboardFocused': report.ui.keyboardFocused,
    'ui.keyboardResumed': report.ui.keyboardResumed,
    'ui.keyboardResumeDetail.label': nonEmptyText(report.ui.keyboardResumeDetail?.label),
    'ui.toolbarTooltip.text': nonEmptyText(report.ui.toolbarTooltip?.text),
    'ui.toolbarTooltip.describedBy': nonEmptyText(report.ui.toolbarTooltip?.describedBy),
    'ui.returnLatestVisible': report.ui.returnLatestVisible,
    'ui.returnedToLatest': report.ui.returnedToLatest,
    'ui.lightTheme': report.ui.lightTheme,
    'ui.darkTheme': report.ui.darkTheme,
    'ui.screenshotPreparedAtTop': report.ui.screenshotPreparedAtTop,
    'ui.runtimeChrome.lifecycleCollapsed': report.ui.runtimeChrome.lifecycleCollapsed,
    'ui.runtimeChrome.diagnosticsCollapsed': report.ui.runtimeChrome.diagnosticsCollapsed,
    'ui.runtimeChrome.expanded': report.ui.runtimeChrome.expanded,
    'ui.runtimeChrome.localized': report.ui.runtimeChrome.localized,
    'ui.runtimeChrome.expandedNoCjk': report.ui.runtimeChrome.expandedNoCjk,
    'reload.entries': report.reload.entries > 0,
    'reload.lifecycle': report.reload.lifecycle,
    'reload.terminalCount': report.reload.terminalCount > 0,
    'privacy.structuredOnly': report.privacy.structuredOnly,
    'privacy.partialObservability': report.privacy.partialObservability,
  }
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
if ((parsed.values['manager-light-screenshot'] !== undefined || parsed.values['manager-dark-screenshot'] !== undefined)
  && !parsed.values['manager-theme-cycle']) throw new Error('manager theme screenshots require --manager-theme-cycle')
if (parsed.values['manager-lifecycle-source'] !== undefined) {
  if (parsed.values.report === undefined) throw new Error('--manager-lifecycle-source requires --report')
  if (!path.isAbsolute(parsed.values['manager-lifecycle-source'])) {
    throw new Error('--manager-lifecycle-source must be an absolute local package directory')
  }
}
if ((parsed.values['permission-v2-source'] === undefined) !== (parsed.values['permission-v2-expanded-source'] === undefined)) {
  throw new Error('--permission-v2-source and --permission-v2-expanded-source must be provided together')
}
for (const option of ['permission-v2-source', 'permission-v2-expanded-source']) {
  const value = parsed.values[option]
  if (value !== undefined && !path.isAbsolute(value)) throw new Error(`--${option} must be an absolute local package directory`)
}
if (parsed.values['permission-v2-source'] !== undefined && parsed.values.report === undefined) {
  throw new Error('--permission-v2-source requires --report')
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
const runtimeExceptions = []
socket.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails
    runtimeExceptions.push(detail?.exception?.description ?? detail?.text ?? 'unknown renderer exception')
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
await send('Log.enable')
await send('Page.enable')
const locale = parsed.values.locale
let localeProjection
if (locale !== undefined) {
  if (!['en', 'zh-CN'].includes(locale)) throw new Error(`unknown smoke locale: ${locale}`)
  await send('Runtime.evaluate', {
    // DocumentLocaleAdapter is the production Host locale source. Keep its
    // document attribute projected while Codex initializes, then wait for the
    // runtime snapshot rather than injecting a test-only locale registry.
    expression: `(() => {
      globalThis.__cordisxRestoreSmokeLocale?.()
      const root = document.documentElement
      const previousLang = root.getAttribute('lang')
      let desired = ${JSON.stringify(locale)}
      const enforce = () => {
        if (root.lang !== desired) root.lang = desired
      }
      const observer = new MutationObserver(enforce)
      observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
      globalThis.__cordisxRestoreSmokeLocale = () => {
        observer.disconnect()
        if (previousLang === null) root.removeAttribute('lang')
        else root.setAttribute('lang', previousLang)
        delete globalThis.__cordisxRestoreSmokeLocale
        delete globalThis.__cordisxSetSmokeLocale
      }
      globalThis.__cordisxSetSmokeLocale = next => {
        if (!['en', 'zh-CN'].includes(next)) throw new Error('unsupported smoke locale')
        desired = next
        enforce()
      }
      enforce()
    })()`,
    returnByValue: true,
  })
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    localeProjection = await evaluateByValue(`(() => ({
      documentLocale: document.documentElement.lang,
      snapshotLocale: globalThis.__cordisxRuntime?.snapshot?.().localization?.locale ?? null,
      direction: globalThis.__cordisxRuntime?.snapshot?.().localization?.direction ?? null,
    }))()`)
    if (localeProjection.documentLocale === locale && localeProjection.snapshotLocale === locale) break
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  if (localeProjection?.documentLocale !== locale || localeProjection.snapshotLocale !== locale) {
    throw new Error(`Host locale projection did not settle: ${JSON.stringify(localeProjection)}`)
  }
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
      const themedControls = [host, switcher, trigger].filter(element => element instanceof HTMLElement)
      const records = themedControls.map(element => ({ element, style: element.getAttribute('style') }))
      const rendererClassName = document.documentElement.className
      const themeRecords = [document.documentElement, document.body]
        .filter(element => element instanceof HTMLElement)
        .map(element => ({ element, value: element.getAttribute('data-theme') }))
      const dark = ${JSON.stringify(colorScheme)} === 'dark'
      const expectedClass = dark ? 'electron-dark' : 'electron-light'
      const applyRendererTheme = () => {
        if (!document.documentElement.classList.contains(expectedClass)) {
          document.documentElement.classList.remove('electron-dark', 'electron-light')
          document.documentElement.classList.add(expectedClass)
        }
        if (document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(colorScheme)}) {
          document.documentElement.setAttribute('data-theme', ${JSON.stringify(colorScheme)})
        }
      }
      const themeObserver = new MutationObserver(applyRendererTheme)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
      globalThis.__cordisxRestoreSmokeTheme = () => {
        themeObserver.disconnect()
        for (const record of records) {
          if (record.style === null) record.element.removeAttribute('style')
          else record.element.setAttribute('style', record.style)
        }
        for (const record of themeRecords) {
          if (record.value === null) record.element.removeAttribute('data-theme')
          else record.element.setAttribute('data-theme', record.value)
        }
        document.documentElement.className = rendererClassName
        delete globalThis.__cordisxRestoreSmokeTheme
      }
      applyRendererTheme()
      if (host instanceof HTMLElement) {
        host.style.setProperty('background-color', dark ? '#1a1c1f' : '#ffffff', 'important')
        host.style.setProperty('color', dark ? '#f7f8f8' : '#1a1c1f', 'important')
      }
      if (switcher instanceof HTMLElement) switcher.style.setProperty('color', 'inherit', 'important')
      if (trigger instanceof HTMLElement) trigger.style.setProperty('color', 'inherit', 'important')
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
      serviceConfigBinding: {
        request: typeof globalThis.__cordisxServiceConfigRequestV1,
        receiver: typeof globalThis.__cordisxServiceConfigReceiveV1,
      },
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
if (false && parsed.values['manager-settings-exercise']) {
  const owner = parsed.values['plugin-owner'] ?? 'settings-tab-demo'
  const qualifiedTabId = `${owner}:settings`
  const initial = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    trigger?.click()
    document.querySelector('[data-tab="settings"]')?.click()
    await wait(700)
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

if (parsed.values['manager-settings-navigation-exercise']) {
  const owner = parsed.values['plugin-owner'] ?? 'settings-tab-demo'
  const qualifiedId = `${owner}:navigation`
  const source = await evaluateByValue(`globalThis.__cordisxRuntime?.snapshot?.().plugins?.find(item => item.id === ${JSON.stringify(owner)})?.source ?? null`)
  if (source === null) throw new Error(`settings navigation demo plugin source not found: ${owner}`)
  const ready = await evaluateByValue(`(async () => {
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (predicate()) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    }
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    if (trigger instanceof HTMLElement) trigger.click()
    else if (modal instanceof HTMLElement && modal.hidden) modal.hidden = false
    return await waitFor(() => document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null)
  })()`, true)
  const rowRect = await evaluateByValue(`(() => {
    const row = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]')
    if (!(row instanceof HTMLElement)) return null
    const rect = row.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
  })()`, true)
  if (rowRect === null) throw new Error(`settings navigation item is not interactable: ${qualifiedId}`)
  await pointerClick(rowRect)
  const initial = await evaluateByValue(`(async () => {
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (predicate()) return true
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return false
    }
    const mounted = await waitFor(() => document.querySelector('[data-settings-navigation-demo-content="mounted"]') !== null)
    const runtime = globalThis.__cordisxRuntime.snapshot()
    return {
      ready: ${JSON.stringify(ready)}, mounted,
      rows: [...document.querySelectorAll('[data-settings-navigation-item]')].map(row => ({ id: row.getAttribute('data-settings-navigation-item'), icon: row.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null, disabled: row.disabled })),
      settingsTabs: runtime.settingsTabs,
      legacySettings: document.querySelector('[data-tab="settings"],[data-settings-tab]') !== null,
      page: document.querySelector('[data-cordisx-manager-page="${qualifiedId}"]') !== null,
      hostHeader: document.querySelector('.cxm-heading-leading-stack [data-host-icon="host:settings"]') !== null,
      outlet: runtime.navigation.outlets.find(item => item.id === 'manager.content') ?? null,
    }
  })()`, true)
  await pressKey('ArrowUp', 'ArrowUp', 38)
  const keyboardUp = await evaluateByValue(`document.activeElement?.getAttribute('data-manager-navigation-id') ?? null`)
  await pressKey('ArrowDown', 'ArrowDown', 40)
  const keyboardDown = await evaluateByValue(`document.activeElement?.getAttribute('data-settings-navigation-item') ?? null`)
  const lifecycle = await evaluateByValue(`(async () => {
    const runtime = globalThis.__cordisxRuntime
    await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, 'manager.settings.navigation-items', 'deny')
    await new Promise(resolve => setTimeout(resolve, 140))
    const denied = { row: document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null, body: document.querySelector('[data-settings-navigation-demo-content]') !== null, fallback: document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current') === 'page', mounted: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.content')?.mounted ?? null }
    await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, 'manager.settings.navigation-items', 'allow')
    await new Promise(resolve => setTimeout(resolve, 140))
    const restored = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null
    return { denied, restored }
  })()`, true)
  const localeResult = await evaluateByValue(`(async () => {
    const target = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
    globalThis.__cordisxSetSmokeLocale(target)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const snapshot = globalThis.__cordisxRuntime.snapshot().localization.locale
      if (document.documentElement.lang === target && snapshot === target) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const title = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]')?.textContent?.trim() ?? null
    globalThis.__cordisxSetSmokeLocale(${JSON.stringify(locale ?? 'en')})
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const snapshot = globalThis.__cordisxRuntime.snapshot().localization.locale
      if (document.documentElement.lang === ${JSON.stringify(locale ?? 'en')} && snapshot === ${JSON.stringify(locale ?? 'en')}) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return { target, title, restored: document.documentElement.lang, snapshot: globalThis.__cordisxRuntime.snapshot().localization.locale }
  })()`, true)
  settingsTabsReport = {
    initial, keyboard: { up: keyboardUp, down: keyboardDown }, lifecycle, locale: localeResult,
    passed: initial.ready === true && initial.mounted === true && initial.rows.some(item => item.id === qualifiedId && item.icon === 'host:settings' && item.disabled === false)
      && initial.settingsTabs.length === 0 && initial.legacySettings === false && initial.page === true && initial.hostHeader === true && initial.outlet?.mounted === true
      && keyboardUp === 'marketplace' && keyboardDown === qualifiedId
      && lifecycle.denied.row === false && lifecycle.denied.body === false && lifecycle.denied.fallback === true && lifecycle.denied.mounted === false && lifecycle.restored === true
      && localeResult.snapshot === (locale ?? 'en') && localeResult.restored === (locale ?? 'en'),
  }
  console.log(`manager-settings-navigation=${JSON.stringify(settingsTabsReport, null, 2)}`)
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

let hostCollectionMenuReport
if (parsed.values['host-collection-menu-exercise']) {
  const source = await readFile(new URL('../src/renderer/host-collection.ts', import.meta.url), 'utf8')
  const compiled = await transform(source, {
    loader: 'ts', format: 'iife', globalName: '__cordisxHostCollectionSmokeModule', target: 'es2022',
  })
  await send('Emulation.setDeviceMetricsOverride', {
    width: 420, height: 800, deviceScaleFactor: 1, mobile: false,
  })
  try {
    const loaded = await send('Runtime.evaluate', { expression: compiled.code, returnByValue: true })
    if (loaded.exceptionDetails !== undefined) {
      throw new Error(loaded.exceptionDetails.exception?.description ?? loaded.exceptionDetails.text ?? 'Host collection smoke module failed to load')
    }
    const setup = await evaluateByValue(`(() => {
      globalThis.__cordisxHostCollectionMenuSmoke?.cleanup?.()
      const module = globalThis.__cordisxHostCollectionSmokeModule
      if (typeof module?.createHostCollection !== 'function') throw new Error('Host collection smoke module is unavailable')
      const style = document.createElement('style')
      style.dataset.hostCollectionMenuSmokeStyle = 'true'
      style.textContent = module.HOST_COLLECTION_STYLES
      document.head.append(style)
      const host = document.createElement('section')
      host.dataset.hostCollectionMenuSmoke = 'true'
      host.style.cssText = 'position:fixed;left:18px;top:72px;z-index:2147483645;width:360px;box-sizing:border-box;padding:16px;border:1px solid #c9ced6;border-radius:14px;background:#ffffff;color:#18202a;box-shadow:0 18px 54px rgb(0 0 0 / 24%);--cx-border:#c9ced6;--cx-primary:#2563eb;--cx-focus:#93c5fd;--cx-surface-raised:#ffffff;--cx-hover:#eff6ff;--cx-text:#18202a;--cx-muted:#657184;--cx-danger:#c62828;--cx-warning:#f59e0b;--cx-shadow:rgb(15 23 42 / 24%);--cx-disabled:.42'
      const heading = document.createElement('strong')
      heading.textContent = document.documentElement.lang === 'zh-CN' ? '集合菜单键盘验收' : 'Collection menu keyboard check'
      host.append(heading)
      document.body.append(host)
      const icon = value => () => {
        const node = document.createElement('span')
        node.textContent = value
        return node
      }
      let managerEscapeCount = 0
      const onManagerKeyDown = event => {
        if (event.defaultPrevented || event.key !== 'Escape') return
        managerEscapeCount += 1
      }
      document.addEventListener('keydown', onManagerKeyDown)
      const view = module.createHostCollection(document, {
        id: 'menu-smoke', label: 'Smoke collection', moreLabel: 'More actions', moreIcon: icon('⋯'),
        search: { enabled: false, reason: 'A fixed smoke fixture verifies the Host menu lifecycle.' },
        attachPortalTheme: popup => {
          popup.style.cssText += ';--cx-border:#c9ced6;--cx-primary:#2563eb;--cx-focus:#93c5fd;--cx-surface-raised:#ffffff;--cx-hover:#eff6ff;--cx-text:#18202a;--cx-muted:#657184;--cx-danger:#c62828;--cx-shadow:rgb(15 23 42 / 24%);--cx-disabled:.42'
          return () => {}
        },
        items: [{
          id: 'official-source', title: 'Official source', description: 'Keyboard-owned portaled actions',
          machineId: 'source.official', icon: icon('C'), onOpen: () => {},
          actions: [
            { id: 'share', label: 'Share', placement: 'overflow', icon: icon('S'), onInvoke: () => {} },
            { id: 'remove', label: 'Remove', placement: 'overflow', disabled: true, unavailableReason: 'Official sources cannot be removed.', icon: icon('R') },
            { id: 'diagnostics', label: 'Diagnostics', placement: 'overflow', icon: icon('D'), onInvoke: () => {} },
            { id: 'archive', label: 'Archive', placement: 'overflow', icon: icon('A'), onInvoke: () => {} },
          ],
        }],
      })
      host.append(view.element)
      const trigger = view.element.querySelector('.cxc-menu-trigger')
      if (!(trigger instanceof HTMLButtonElement)) throw new Error('Host collection menu trigger is unavailable')
      const triggerRect = trigger.getBoundingClientRect()
      globalThis.__cordisxHostCollectionMenuSmoke = {
        host, style, view, trigger, onManagerKeyDown,
        managerEscapeCount: () => managerEscapeCount,
        cleanup: () => {
          view.dispose()
          document.removeEventListener('keydown', onManagerKeyDown)
          host.remove()
          style.remove()
          delete globalThis.__cordisxHostCollectionMenuSmoke
          delete globalThis.__cordisxHostCollectionSmokeModule
        },
      }
      return { triggerRect: { x: triggerRect.x, y: triggerRect.y, width: triggerRect.width, height: triggerRect.height } }
    })()`)
    await pointerClick(setup.triggerRect)
    const initial = await evaluateByValue(`(() => {
      const smoke = globalThis.__cordisxHostCollectionMenuSmoke
      const popup = document.querySelector('body > .cxc-menu-popup')
      const disabled = popup?.querySelector('[data-collection-action="remove"]')
      const hostRect = smoke.host.getBoundingClientRect()
      const popupRect = popup?.getBoundingClientRect()
      const left = Math.min(hostRect.left, popupRect?.left ?? hostRect.left)
      const top = Math.min(hostRect.top, popupRect?.top ?? hostRect.top)
      const right = Math.max(hostRect.right, popupRect?.right ?? hostRect.right)
      const bottom = Math.max(hostRect.bottom, popupRect?.bottom ?? hostRect.bottom)
      return {
        open: popup !== null,
        portaled: popup?.parentElement === document.body,
        firstFocused: document.activeElement?.getAttribute('data-collection-action') === 'share',
        controls: smoke.trigger.getAttribute('aria-controls'), popupId: popup?.id ?? null,
        disabledNative: disabled?.disabled === true,
        disabledReason: disabled?.getAttribute('aria-description') ?? null,
        rect: { x: left, y: top, width: right - left, height: bottom - top },
      }
    })()`)
    if (parsed.values['host-collection-menu-screenshot'] !== undefined) {
      await capture(initial.rect, parsed.values['host-collection-menu-screenshot'], 'Host collection menu smoke')
    }
    await pressKey('ArrowDown', 'ArrowDown', 40)
    const arrowDown = await evaluateByValue(`document.activeElement?.getAttribute('data-collection-action') ?? null`)
    await pressKey('ArrowUp', 'ArrowUp', 38)
    const arrowUp = await evaluateByValue(`document.activeElement?.getAttribute('data-collection-action') ?? null`)
    await pressKey('End', 'End', 35)
    const end = await evaluateByValue(`document.activeElement?.getAttribute('data-collection-action') ?? null`)
    await pressKey('Home', 'Home', 36)
    const home = await evaluateByValue(`document.activeElement?.getAttribute('data-collection-action') ?? null`)
    await pressKey('ArrowUp', 'ArrowUp', 38)
    const wrappedUp = await evaluateByValue(`document.activeElement?.getAttribute('data-collection-action') ?? null`)
    await pressKey('Escape', 'Escape', 27)
    await new Promise(resolve => setTimeout(resolve, 40))
    const escape = await evaluateByValue(`(() => {
      const smoke = globalThis.__cordisxHostCollectionMenuSmoke
      return {
        closed: document.querySelector('body > .cxc-menu-popup') === null,
        focusRestored: document.activeElement === smoke.trigger,
        managerEscapeCount: smoke.managerEscapeCount(),
      }
    })()`)
    await pointerClick(setup.triggerRect)
    const reopened = await evaluateByValue(`document.querySelector('body > .cxc-menu-popup') !== null`)
    await evaluateByValue(`(() => { globalThis.__cordisxHostCollectionMenuSmoke.view.dispose(); return true })()`)
    await pressKey('Escape', 'Escape', 27)
    const dispose = await evaluateByValue(`(() => ({
      popupClosed: document.querySelector('body > .cxc-menu-popup') === null,
      managerEscapeCount: globalThis.__cordisxHostCollectionMenuSmoke.managerEscapeCount(),
    }))()`)
    hostCollectionMenuReport = {
      viewport: { width: 420, height: 800 }, initial,
      keyboard: { arrowDown, arrowUp, end, home, wrappedUp },
      escape, dispose, reopened,
    }
    hostCollectionMenuReport.passed = initial.open === true
      && initial.portaled === true
      && initial.firstFocused === true
      && initial.controls !== null && initial.controls === initial.popupId
      && initial.disabledNative === true
      && initial.disabledReason === 'Official sources cannot be removed.'
      && arrowDown === 'diagnostics'
      && arrowUp === 'share'
      && end === 'archive'
      && home === 'share'
      && wrappedUp === 'archive'
      && escape.closed === true
      && escape.focusRestored === true
      && escape.managerEscapeCount === 0
      && reopened === true
      && dispose.popupClosed === true
      && dispose.managerEscapeCount === 1
    console.log(`host-collection-menu=${JSON.stringify(hostCollectionMenuReport)}`)
  } finally {
    await send('Runtime.evaluate', { expression: 'globalThis.__cordisxHostCollectionMenuSmoke?.cleanup?.()' })
    await send('Emulation.clearDeviceMetricsOverride')
  }
  if (hostCollectionMenuReport?.passed !== true) {
    throw new Error(`Host collection menu smoke assertions failed: ${JSON.stringify(hostCollectionMenuReport)}`)
  }
}

let managerLifecycleReport
let generationTransactionReport
if (parsed.values['manager-lifecycle-source'] !== undefined) {
  const sourceDirectory = parsed.values['manager-lifecycle-source']
  const sourceManifest = JSON.parse(await readFile(path.join(sourceDirectory, 'cordisx.plugin.json'), 'utf8'))
  if (typeof sourceManifest.version !== 'string') throw new Error('manager lifecycle source has no package version')
  const lifecycleViewportWidth = parsed.values['manager-viewport-width'] === undefined
    ? 1280
    : Number(parsed.values['manager-viewport-width'])
  if (!Number.isInteger(lifecycleViewportWidth) || lifecycleViewportWidth < 400 || lifecycleViewportWidth > 3840) {
    throw new Error('--manager-viewport-width must be an integer between 400 and 3840')
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width: lifecycleViewportWidth,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
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
    document.querySelector('[data-host-form="local-package-directory"] .cxf-actions t-button:first-child')?.click()
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    if (modal?.hidden !== false) {
      if (trigger !== null && modal?.hidden !== false) trigger.click()
      else if (modal instanceof HTMLElement) modal.hidden = false
    }
    document.querySelector('[data-tab="plugins"]')?.click()
    let preImportCleanup = false
    const current = runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')
    if (current?.package?.version === ${JSON.stringify(sourceManifest.version)}) {
      document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')?.click()
      const popup = await waitFor(() => document.querySelector('body > .cxc-menu-popup'), 'existing package menu')
      const uninstall = popup.querySelector('[data-collection-action="uninstall"]')
      if (!(uninstall instanceof HTMLButtonElement) || uninstall.disabled) throw new Error('existing package uninstall is unavailable')
      uninstall.click()
      const confirmation = await waitFor(() => document.querySelector('.cxm-lifecycle-overlay'), 'existing package uninstall confirmation')
      confirmation.querySelector('.cxm-lifecycle-actions t-button:last-child')?.click()
      await waitFor(() => !runtime.snapshot().plugins.some(item => item.id === 'lifecycle-smoke'), 'existing package cleanup')
      preImportCleanup = true
    }
    const revisionBefore = runtime.snapshot().pluginLifecycle?.revision ?? null
    const install = await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'local import action')
    install.click()
    const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog [data-import-local-path]'), 'local package input')
    input.value = ${JSON.stringify(sourceDirectory)}
    input.onChange?.(${JSON.stringify(sourceDirectory)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = document.querySelector('[data-import-local-submit]')
    if (!(submit instanceof HTMLElement)) throw new Error('local import submit action is unavailable')
    submit.click()
    await waitFor(() => document.querySelector('[data-import-local-path]') === null, 'local import dialog close')
    const authorization = await waitFor(() => {
      const prompt = document.querySelector('[data-permission-authorization="lifecycle-smoke"]')
      if (prompt !== null) return { prompt, appliedWithoutPrompt: false }
      const error = [...document.querySelectorAll('.cxm-content .cxm-error')]
        .map(item => item.textContent?.trim()).find(Boolean)
      if (error) return { prompt: null, appliedWithoutPrompt: false, error }
      const revision = runtime.snapshot().pluginLifecycle?.revision ?? null
      return revision !== revisionBefore ? { prompt: null, appliedWithoutPrompt: true } : null
    }, 'local import authorization or applied revision')
    if (authorization.error) throw new Error('local import failed: ' + authorization.error)
    const authorizationState = authorization.prompt === null ? {
      mode: 'not-required', title: null, optional: null, primaryFocused: null,
    } : {
      mode: 'prompted',
      title: authorization.prompt.querySelector('h2')?.textContent ?? null,
      optional: authorization.prompt.querySelector('[data-authorization-choice="models.read"]')?.disabled === false,
      primaryFocused: document.activeElement === authorization.prompt.querySelector('[data-authorization-decision="allow"]'),
    }
    authorization.prompt?.querySelector('[data-authorization-decision="allow"]')?.click()
    await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'imported plugin row')
    const plugin = await waitFor(() => {
      const snapshot = runtime.snapshot()
      const item = snapshot.plugins.find(candidate => candidate.id === 'lifecycle-smoke' && candidate.status === 'active')
      return item !== undefined && (snapshot.pluginLifecycle?.revision ?? null) !== revisionBefore ? item : null
    }, 'active imported plugin')
    await runtime.settleRegistryProjection()
    await wait(180)
    const currentRow = await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'current installed plugin row')
    return {
      appRenderer: location.href === 'app://-/index.html',
      authorization: authorizationState,
      preImportCleanup,
      revisionBefore,
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

  const inspectPluginCard = async () => await evaluateByValue(`(() => {
    const row = document.querySelector('[data-plugin-card="lifecycle-smoke"]')
    const primary = row?.querySelector('[data-plugin-primary="lifecycle-smoke"]')
    const actions = row?.querySelector('.cxc-actions')
    const rowRect = row?.getBoundingClientRect()
    const primaryRect = primary?.getBoundingClientRect()
    const actionRect = actions?.getBoundingClientRect()
    const style = actions === null || actions === undefined ? null : getComputedStyle(actions)
    const tooltip = document.querySelector('[role="tooltip"]')
    return {
      actionOpacity: style?.opacity ?? null,
      actionPointerEvents: style?.pointerEvents ?? null,
      actionWidth: actionRect?.width ?? null,
      rowWidth: rowRect?.width ?? null,
      rowHeight: rowRect?.height ?? null,
      primaryWidth: primaryRect?.width ?? null,
      focused: document.activeElement === primary,
      tooltip: tooltip?.textContent?.trim() ?? null,
      describedBy: primary?.getAttribute('aria-describedby') ?? null,
      badge: primary?.querySelector('.cxc-status')?.getAttribute('data-tone') ?? null,
      persistentStatusText: (primary?.textContent ?? '').includes('运行中'),
    }
  })()`)
  const hiddenActions = await inspectPluginCard()
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    pointerType: 'mouse',
    x: installed.primaryRect.x + installed.primaryRect.width / 2,
    y: installed.primaryRect.y + installed.primaryRect.height / 2,
  })
  let hoveredTooltip = await inspectPluginCard()
  for (let attempt = 0; attempt < 40 && hoveredTooltip.tooltip === null; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    hoveredTooltip = await inspectPluginCard()
  }
  screenshots.tooltip = await capture(installed.managerRect, artifact('lifecycle-tooltip'), 'hovered plugin status tooltip')
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', pointerType: 'mouse', x: installed.managerRect.x + 12, y: installed.managerRect.y + 12,
  })
  await new Promise(resolve => setTimeout(resolve, 80))
  const tooltipDismissed = await evaluateByValue(`document.querySelector('[role="tooltip"]') === null`)
  await evaluateByValue(`document.querySelector('[data-plugin-primary="lifecycle-smoke"]')?.focus()`)
  await new Promise(resolve => setTimeout(resolve, 180))
  const focusedActions = await inspectPluginCard()
  const cardInteraction = { hiddenActions, hoveredTooltip, focusedActions, tooltipDismissed }

  if (parsed.values['generation-transaction-exercise']) {
    generationTransactionReport = await evaluateByValue(`(async () => {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      const targetId = 'lifecycle-smoke'
      const snapshot = runtime.snapshot()
      const target = snapshot.plugins.find(plugin => plugin.id === targetId)
      if (target?.package === undefined) throw new Error('lifecycle smoke activation package is unavailable')
      const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
      const CORDISX_PAGE_SCHEMA_V3 = schema + 'page.v3.schema.json'
      const CORDISX_ROUTE_SCHEMA_V2 = schema + 'route.v2.schema.json'
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
        name: 'Lifecycle Smoke Candidate', inject: ['i18n', 'commands', 'pages', 'routes', 'slots'],
        apply(ctx) {
          globalThis.__cordisxGenerationLiveSmoke = { candidateReady: true, selfCommand: false }
          console.log('generation-candidate-ready', { transactionId })
          const message = key => ({ namespace: 'lifecycle-smoke-candidate', key })
          ctx.i18n.define({
            namespace: 'lifecycle-smoke-candidate', locale: 'en', default: true,
            messages: {
              'command.invoke': 'Run candidate lifecycle smoke',
              'page.title': 'Lifecycle candidate status',
              'page.description': 'Shows the staged generation status inside the controlled main workspace page.',
              'route.title': 'Open lifecycle candidate status',
              'route.description': 'Open from the lifecycle smoke navigation item to inspect the staged candidate in the main outlet.',
            },
          })
          ctx.i18n.define({
            namespace: 'lifecycle-smoke-candidate', locale: 'zh-CN',
            messages: {
              'command.invoke': '运行候选生命周期冒烟',
              'page.title': '生命周期候选状态',
              'page.description': '在受控主工作区页面内展示 staged generation 的当前状态。',
              'route.title': '打开生命周期候选状态',
              'route.description': '从生命周期冒烟导航项进入，在 main outlet 中检查 staged candidate。',
            },
          })
          const label = message('command.invoke')
          ctx.commands.register({ id: 'invoke', title: label }, () => {
            globalThis.__cordisxGenerationLiveSmoke.selfCommand = true
          })
          ctx.pages.register({
            $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'overview',
            title: message('page.title'), description: message('page.description'),
            icon: 'host:refresh', chrome: 'body-only',
          }, () => () => undefined)
          ctx.routes.register({
            $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'overview',
            path: '/lifecycle-smoke', outlet: 'main', page: 'overview',
            title: message('route.title'), description: message('route.description'),
          })
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
    disableDialog.querySelector('.cxm-lifecycle-actions t-button:last-child')?.click()
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

    document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="favorite"]')?.click()
    await waitFor(() => document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger'), 'favorite rerender')
    const routeAfterFavorite = document.querySelector('[data-manager-page-route="primary:plugins"]') !== null
    const replacementTrigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')
    const favoriteFocusRestored = document.activeElement?.matches?.('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="favorite"]') ?? false
    const menuTrigger = replacementTrigger
    menuTrigger?.click()
    const popup = await waitFor(() => document.querySelector('body > .cxc-menu-popup'), 'plugin action menu')
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const modalWasHidden = modal?.hidden === true
    if (modal instanceof HTMLElement) modal.hidden = false
    const managerRect = rect(modal?.querySelector('[role="dialog"]'))
    const popupRect = rect(popup)
    const menu = {
      portaled: popup.parentElement === document.body,
      actions: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
        action: item.getAttribute('data-collection-action'), disabled: item.disabled,
      })),
      bounded: popupRect !== null && popupRect.x >= 0 && popupRect.y >= 0
        && popupRect.right <= innerWidth && popupRect.bottom <= innerHeight,
      firstItemFocused: popup.contains(document.activeElement),
      shareText: popup.querySelector('[data-collection-action="share"]')?.textContent?.trim() ?? null,
      icons: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
        action: item.getAttribute('data-collection-action'),
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
    closed: document.querySelector('body > .cxc-menu-popup') === null,
    triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger') ?? false,
  }))()`)
  await pointerClick(exercised.menu.triggerRect)
  await pressKey('ArrowDown', 'ArrowDown', 40)
  await pressKey('End', 'End', 35)
  const menuKeyboard = await evaluateByValue(`(() => {
    const popup = document.querySelector('body > .cxc-menu-popup')
    return {
      open: popup !== null,
      focusedMenuItem: popup?.contains(document.activeElement) ?? false,
      activeAction: document.activeElement?.getAttribute?.('data-collection-action') ?? null,
    }
  })()`)
  await pressKey('Escape', 'Escape', 27)
  const menuEscape = await evaluateByValue(`(() => ({
    closed: document.querySelector('body > .cxc-menu-popup') === null,
    triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger') ?? false,
  }))()`)

  await pointerClick(exercised.menu.triggerRect)
  const diagnosticTarget = await evaluateByValue(`(() => {
    const button = document.querySelector('body > .cxc-menu-popup [data-collection-action="diagnostics"]')
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
      popupClosed: document.querySelector('body > .cxc-menu-popup') === null,
    }
  })()`, true)
  await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 120))

  const outsideTarget = await evaluateByValue(`(() => {
    const trigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')
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
  const outsideDismiss = await evaluateByValue(`document.querySelector('body > .cxc-menu-popup') === null`)

  await pointerClick(outsideTarget)
  const blockRestore = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const runtime = globalThis.__cordisxRuntime
    await runtime.setPluginBlocked('lifecycle-smoke', true)
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('body > .cxc-menu-popup') === null) break
      await wait(25)
    }
    const closedOnBlock = document.querySelector('body > .cxc-menu-popup') === null
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
    let popup = document.querySelector('body > .cxc-menu-popup')
    if (popup === null) {
      document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')?.click()
      for (let attempt = 0; attempt < 80 && popup === null; attempt += 1) {
        popup = document.querySelector('body > .cxc-menu-popup')
        if (popup === null) await wait(25)
      }
    }
    const uninstall = popup?.querySelector('[data-collection-action="uninstall"]')
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
    document.querySelector('.cxm-lifecycle-overlay .cxm-lifecycle-actions t-button:last-child')?.click()
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
    authorization: installed.authorization.mode === 'not-required'
      || (/^(安装|更新)授权$/.test(installed.authorization.title ?? '') && installed.authorization.optional
        && installed.authorization.primaryFocused),
    installedWithoutLocalPath: installed.plugin.status === 'active' && installed.localSourceProjected === false
      && installed.revision !== installed.revisionBefore
      && installed.plugin.package?.canonicalSource === 'https://github.com/cordisx/cordisx/tree/main/examples/plugins/lifecycle-smoke',
    cardPresentation: cardInteraction.hiddenActions.actionOpacity === '0'
      && cardInteraction.hiddenActions.actionPointerEvents === 'none'
      && Number(cardInteraction.hoveredTooltip.actionOpacity) > 0.9
      && cardInteraction.hoveredTooltip.actionPointerEvents === 'auto'
      && cardInteraction.focusedActions.actionOpacity === '1'
      && cardInteraction.hiddenActions.actionWidth > 0 && cardInteraction.focusedActions.actionWidth > 0
      && cardInteraction.hiddenActions.rowWidth === cardInteraction.hoveredTooltip.rowWidth
      && cardInteraction.hoveredTooltip.rowWidth === cardInteraction.focusedActions.rowWidth
      && cardInteraction.hiddenActions.rowHeight === cardInteraction.hoveredTooltip.rowHeight
      && cardInteraction.hoveredTooltip.rowHeight === cardInteraction.focusedActions.rowHeight
      && cardInteraction.hoveredTooltip.tooltip === '运行中' && cardInteraction.hoveredTooltip.describedBy !== null
      && cardInteraction.hoveredTooltip.badge === 'success' && cardInteraction.focusedActions.focused
      && !cardInteraction.hoveredTooltip.persistentStatusText && cardInteraction.tooltipDismissed,
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
    installed, cardInteraction, pointerNavigation, keyboardNavigation, exercised,
    menuInteraction: { menuToggle, menuKeyboard, menuEscape, diagnosticExecution, outsideDismiss, blockRestore },
    uninstallPlan: { text: uninstallPlan.text }, removed,
    screenshots, assertions,
  }
  console.log(`manager-lifecycle=${JSON.stringify(managerLifecycleReport, null, 2)}`)
  }
}

let permissionV2Report
if (parsed.values['permission-v2-source'] !== undefined) {
  const pluginId = 'permission-v2-smoke'
  const sourceDirectory = parsed.values['permission-v2-source']
  const expandedSourceDirectory = parsed.values['permission-v2-expanded-source']
  const reportPath = path.resolve(parsed.values.report)
  const authorizationScreenshot = path.join(
    path.dirname(reportPath),
    `${path.basename(reportPath, path.extname(reportPath))}.permission-v2-authorization.png`,
  )
  const opened = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const value = predicate()
        if (value) return value
        await wait(50)
      }
      throw new Error('timed out waiting for ' + label)
    }
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    document.querySelector('[data-permission-authorization] [data-permission-action="cancel"]')?.click()
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    if (modal?.hidden !== false) document.querySelector('[data-cordisx-manager-trigger]')?.click()
    document.querySelector('[data-tab="plugins"]')?.click()
    const install = await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'local import action')
    install.click()
    const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog [data-import-local-path]'), 'local package input')
    input.value = ${JSON.stringify(sourceDirectory)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = document.querySelector('[data-import-local-submit]')
    if (!(submit instanceof HTMLElement)) throw new Error('local import submit action is unavailable')
    submit.click()
    const dialog = await waitFor(() => {
      const authorization = document.querySelector('.cxp-overlay[data-permission-authorization]')
      if (authorization !== null) return authorization
      const lifecycleError = document.querySelector('[data-cordisx-manager-modal] .cxm-content > .cxm-error')
        ?.textContent?.trim()
      if (lifecycleError) throw new Error('local package inspection failed: ' + lifecycleError)
      return null
    }, 'permission v2 install authorization')
    const rect = dialog.querySelector('[role="dialog"]')?.getBoundingClientRect()
    const items = [...dialog.querySelectorAll('[data-permission-capability]')].map(item => ({
      capability: item.getAttribute('data-permission-capability'),
      reviewMode: item.querySelector('[data-permission-review-mode]')?.getAttribute('data-permission-review-mode') ?? null,
      decisions: [...item.querySelectorAll('[data-permission-decision]')].map(input => ({
        decision: input.getAttribute('data-permission-decision'), checked: input.checked,
      })),
      text: item.textContent?.trim() ?? '',
    }))
    return rect === undefined ? null : {
      appRenderer: location.href === 'app://-/index.html',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      theme: dialog.getAttribute('data-cordisx-app-theme'),
      heading: dialog.querySelector('h2')?.textContent ?? null,
      headings: dialog.querySelectorAll('h2').length,
      items,
    }
  })()`, true)
  if (opened?.rect === undefined) throw new Error('permission v2 authorization dialog did not open')
  const screenshot = await capture(opened.rect, authorizationScreenshot, 'permission v2 authorization')
  const exercised = await evaluateByValue(`(async () => {
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const value = predicate()
        if (value) return value
        await wait(50)
      }
      throw new Error('timed out waiting for ' + label)
    }
    const runtime = globalThis.__cordisxRuntime
    if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
    const pluginId = ${JSON.stringify(pluginId)}
    const select = (capability, decision) => {
      const input = document.querySelector(
        '[data-permission-capability="' + CSS.escape(capability) + '"] [data-permission-decision="' + CSS.escape(decision) + '"]',
      )
      if (!(input instanceof HTMLInputElement)) throw new Error('missing permission choice ' + capability + '/' + decision)
      input.click()
    }
    select('agent.events.read', 'allow-once')
    select('tasks.catalog.read', 'allow-persistent')
    select('tasks.control', 'deny-persistent')
    document.querySelector('.cxp-overlay [data-permission-action="confirm"]')?.click()
    const installed = await waitFor(
      () => runtime.snapshot().plugins.find(item => item.id === pluginId && item.status === 'active'),
      'active permission v2 plugin',
    )
    await waitFor(
      () => document.querySelector('[data-import-local-plugin]:not(:disabled)'),
      'settled permission v2 install transaction',
    )
    const initialActivation = runtime.activePluginGeneration().plugins.find(item => item.id === pluginId)
    const narrowPlan = runtime.permissionAuthorizationPlanV2(pluginId)
    const taskFirst = await runtime.execute(pluginId, { id: 'probe-tasks' })
    const taskSecond = await runtime.execute(pluginId, { id: 'probe-tasks' })
    const taskPrompted = document.querySelector('[data-permission-authorization]') !== null

    const inspection = await runtime.requestPluginLifecycle({
      kind: 'inspect-local', sourceDirectory: ${JSON.stringify(expandedSourceDirectory)},
    })
    if (inspection.outcome !== 'planned' || inspection.candidateId === undefined) {
      throw new Error('expanded permission package did not produce an update candidate')
    }
    const expandedPlan = await runtime.permissionLifecycleReviewPlanV2({
      kind: 'candidate', candidateId: inspection.candidateId,
    })
    if (expandedPlan === undefined) throw new Error('expanded permission package did not produce a v2 plan')
    const expandedDecision = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v2.schema.json',
      schemaVersion: 2,
      planId: expandedPlan.planId,
      operation: expandedPlan.operation,
      profileId: expandedPlan.profileId,
      identity: expandedPlan.identity,
      binding: expandedPlan.binding,
      decisions: expandedPlan.declarations.map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: item.capability === 'agent.events.read' ? 'allow-once'
          : item.capability === 'tasks.catalog.read' ? 'allow-persistent' : 'deny-persistent',
      })),
    }
    const updated = await runtime.applyPermissionLifecycleReviewV2(expandedDecision)
    if (updated.outcome !== 'applied') throw new Error('expanded permission update was not applied')
    await waitFor(
      () => runtime.snapshot().plugins.find(item => item.id === pluginId && item.package?.version === '1.1.0' && item.status === 'active'),
      'updated permission v2 plugin',
    )
    await waitFor(
      () => document.querySelector('[data-import-local-plugin]:not(:disabled)'),
      'settled permission v2 update transaction',
    )
    const updatedActivation = runtime.activePluginGeneration().plugins.find(item => item.id === pluginId)
    const updatedPlan = runtime.permissionAuthorizationPlanV2(pluginId)
    const firstEvent = await runtime.execute(pluginId, { id: 'probe-agent-events' })
    const firstEventPrompted = document.querySelector('[data-permission-authorization]') !== null
    let secondSettled = false
    const secondEventPending = runtime.execute(pluginId, { id: 'probe-agent-events' }).then(value => {
      secondSettled = true
      return value
    })
    const runtimeDialog = await waitFor(
      () => document.querySelector('.cxp-overlay[data-permission-authorization]'),
      'runtime permission v2 prompt after allow-once consumption',
    )
    const runtimePrompt = {
      operation: runtimeDialog.querySelector('h2')?.textContent ?? null,
      secondSettledBeforeDecision: secondSettled,
      moduleGeneration: runtimeDialog.querySelector('[data-permission-capability="agent.events.read"]')?.textContent?.includes(updatedActivation?.moduleGeneration ?? '') ?? false,
    }
    const deny = runtimeDialog.querySelector(
      '[data-permission-capability="agent.events.read"] [data-permission-decision="deny-persistent"]',
    )
    if (!(deny instanceof HTMLInputElement)) throw new Error('runtime persistent deny is unavailable')
    deny.click()
    runtimeDialog.querySelector('[data-permission-action="confirm"]')?.click()
    const secondEvent = await secondEventPending
    const finalPlan = runtime.permissionAuthorizationPlanV2(pluginId)
    return {
      installed: { id: installed.id, status: installed.status, version: installed.package?.version ?? null },
      taskCalls: { first: taskFirst, second: taskSecond, prompted: taskPrompted },
      narrowPlan,
      expandedPlan,
      update: {
        outcome: updated.outcome,
        initialModuleGeneration: initialActivation?.moduleGeneration ?? null,
        updatedModuleGeneration: updatedActivation?.moduleGeneration ?? null,
        updatedPlan,
      },
      allowOnce: { first: firstEvent, firstPrompted: firstEventPrompted, second: secondEvent, runtimePrompt },
      finalPlan,
      appRenderer: location.href === 'app://-/index.html',
    }
  })()`, true)
  const narrowTasks = exercised.narrowPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
  const expandedTasks = exercised.expandedPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
  const expandedEvents = exercised.expandedPlan?.declarations?.find(item => item.capability === 'agent.events.read')
  const finalEvents = exercised.finalPlan?.declarations?.find(item => item.capability === 'agent.events.read')
  const finalTasks = exercised.finalPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
  const assertions = {
    appRenderer: opened.appRenderer && exercised.appRenderer,
    theme: opened.theme === (parsed.values['color-scheme'] ?? opened.theme),
    informationArchitecture: opened.headings === 1 && opened.items.length === 3,
    batchAndExplicit: opened.items.filter(item => item.reviewMode === 'batch-eligible').length === 1
      && opened.items.filter(item => item.reviewMode === 'explicit').length === 2,
    persistentAllow: narrowTasks?.policy === 'allow-persistent' && exercised.taskCalls.prompted === false
      && finalTasks?.policy === 'allow-persistent',
    scopeExpansion: narrowTasks?.scope?.providers?.length === 1 && expandedTasks?.scope?.providers?.length === 2
      && expandedTasks?.policy === 'ask' && expandedTasks?.decisionRequired === true
      && narrowTasks?.securityFingerprint !== expandedTasks?.securityFingerprint,
    generationInvalidation: exercised.update.initialModuleGeneration !== exercised.update.updatedModuleGeneration
      && expandedEvents?.policy === 'ask' && expandedEvents?.decisionRequired === true,
    exactAllowOnce: exercised.allowOnce.firstPrompted === false
      && exercised.allowOnce.runtimePrompt.secondSettledBeforeDecision === false
      && exercised.allowOnce.runtimePrompt.moduleGeneration === true,
    persistentDeny: exercised.allowOnce.second?.ok === false
      && exercised.allowOnce.second?.error?.code === 'permission-denied'
      && finalEvents?.policy === 'deny-persistent',
  }
  permissionV2Report = {
    result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
    opened,
    exercised,
    screenshot,
    assertions,
  }
  console.log(`permission-v2=${JSON.stringify(permissionV2Report, null, 2)}`)
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
        hostNativeAvailable: rootRect !== null && nativeRect !== null,
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
    const assert = (id, pass, actual, expected, skipped = false) => assertions.push({ id, pass: Boolean(pass), actual, expected, ...(skipped ? { skipped: true } : {}) })
    for (const point of points) {
      if (!point.hostNativeAvailable) {
        assert(point.id + '.session-unavailable', true,
          { availability: point.availability, registration: point.registration, geometry: point.geometry },
          'skipped because the clean isolated renderer has no native session anchor', true)
        continue
      }
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
      if (points.find(point => point.id === transition.id)?.hostNativeAvailable !== true) {
        assert(transition.id + '.policy-hide-restore', true, transition,
          'skipped because the clean isolated renderer has no native session anchor', true)
        continue
      }
      assert(transition.id + '.policy-hide-restore', transition.hidden && transition.restored && transition.nativeWhileDenied
        && transition.sameNative && transition.sameNativeParent, transition, 'hide/restore without changing native control')
    }
    assert('native.no-unexpected-child-mutations', mutation.unexpectedChildChanges === 0, mutation, 'only CordisX seat child changes')
    assert('native.no-attribute-mutations', mutation.nativeAttributeChanges === 0, mutation, 'no native style/hidden/aria-hidden mutations')
    const nativeSurfaceUnavailable = points.some(point => !point.hostNativeAvailable)
    assert('plugin.block-restore', nativeSurfaceUnavailable || (pluginBlock?.blocked === true && pluginBlock.nativeWhileBlocked === true
      && pluginBlock.restored === true && pluginBlock.sameNative === true), pluginBlock,
    nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'plugin block/restore without changing native controls', nativeSurfaceUnavailable)
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
    assert('composer.toolbar.items.appearance-preserved', nativeSurfaceUnavailable || (composerControl?.reduced === false && composerControl?.token === ''
      && composerControl.geometry.glyph?.width === 16 && composerControl.geometry.glyph?.height === 16),
    composerControl, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'composer keeps its existing 16px glyph and does not opt into the shell reduction', nativeSurfaceUnavailable)
    assert('manager.brand-trigger.size-preserved', nativeSurfaceUnavailable || (managerBrand.reduced === false && managerBrand.geometry.action?.width === 32
      && managerBrand.geometry.action?.height === 32 && managerBrand.geometry.glyph?.width === 20 && managerBrand.geometry.glyph?.height === 20
      && managerBrand.geometry.centered),
    managerBrand, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'brand trigger remains a 20px mark in its 32px button', nativeSurfaceUnavailable)
    const titlebar = [...document.querySelectorAll('header[data-app-shell-application-menu-bar]')].find(visible)
    const titlebarRect = rect(titlebar)
    const safeLeft = titlebarRect === null ? null : Math.max(12, Math.ceil(Math.min(...[...titlebar.querySelectorAll('button')]
      .filter(visible).map(button => button.getBoundingClientRect().x).filter(x => x >= titlebarRect.x + 64 && x < titlebarRect.x + 180), titlebarRect.x + 88) - titlebarRect.x))
    const sessionPoint = points.find(point => point.id === 'session.header.actions')
    assert('session.header.actions.safe-inset', nativeSurfaceUnavailable || (safeLeft !== null && sessionPoint?.geometry.root?.x >= safeLeft),
      { safeLeft, rootX: sessionPoint?.geometry.root?.x ?? null }, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'root starts after titlebar safe inset', nativeSurfaceUnavailable)
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
    const point = uiCatalogReport.points?.find(item => item.id === id)
    const sessionUnavailable = point?.hostNativeAvailable !== true
    uiCatalogReport.assertions.push({
      id: `${id}.tooltip`, pass: sessionUnavailable || evidence.pass, actual: evidence,
      expected: sessionUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'described, in viewport, dismissed',
      ...(sessionUnavailable ? { skipped: true } : {}),
    })
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

  let toolbarRegression
  const initialToolbarSnapshot = await toolbarSnapshot()
  const toolbarNativeGeometry = initialToolbarSnapshot.session.native?.geometry
  if (toolbarNativeGeometry === null || toolbarNativeGeometry === undefined) {
    // A clean isolated renderer has no selected session/native summary.  The
    // catalog itself is still useful there, but a pointer exercise against a
    // non-existent host control is neither a product failure nor valid smoke
    // evidence.
    const status = initialToolbarSnapshot.session.native === null ? 'session-unavailable' : 'native-geometry-unavailable'
    uiCatalogReport.assertions.push({
      id: 'toolbar.session-native',
      pass: true,
      skipped: true,
      actual: { status, session: initialToolbarSnapshot.session },
      expected: 'skipped when the isolated renderer has no session native control',
    })
    toolbarRegression = { status, skipped: true, initial: initialToolbarSnapshot }
  } else {
  let inactive = initialToolbarSnapshot
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
  toolbarRegression = { initialNativePressed, inactive, nativeActive, nativeActiveHovered, hovered, focused, routeActive, routeHovered, routeClosed, resized, threadSwitch, routeSessionSwitch }
  }
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
let managerFormExerciseFailure
let managerServiceConfigurationFailure
let pluginConsoleReport
let pluginConsoleAssertions
if (parsed.values['plugin-console-exercise']) {
  const owner = parsed.values['plugin-owner'] ?? 'console-showcase'
  const pluginConsoleLocale = locale === 'zh-CN'
    ? { kindSelect: 'API / 类型', runtimeSummary: '运行详情 · 运行中', diagnostics: '诊断' }
    : { kindSelect: 'API / type', runtimeSummary: 'Runtime details · Active', diagnostics: 'Diagnostics' }
  const toolbarTarget = await evaluateByValue(`(async () => {
    const owner = ${JSON.stringify(owner)}
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    document.querySelector('[data-permission-prompt] [data-permission-decision="deny"]')?.click()
    await wait(120)
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    if (modal?.hidden === true && trigger !== null) trigger.click()
    else if (modal instanceof HTMLElement && modal.hidden) modal.hidden = false
    if (document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]') === null) {
      document.querySelector('[data-tab="plugins"]')?.click()
      document.querySelector('[data-plugin-id="' + CSS.escape(owner) + '"]')?.click()
      document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
    }
    let button
    let rect
    for (let attempt = 0; attempt < 40; attempt += 1) {
      button = document.querySelector('[data-console-action="pause"]')
      button?.scrollIntoView({ block: 'center', inline: 'center' })
      rect = button?.getBoundingClientRect()
      if (rect !== undefined && rect.width > 0 && rect.height > 0) break
      await wait(25)
    }
    return rect === undefined || rect.width === 0 || rect.height === 0
      ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`, true)
  if (toolbarTarget === null) throw new Error('Plugin Console icon toolbar is unavailable')
  let pointerPaused
  let pointerTarget = toolbarTarget
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pointerClick(pointerTarget)
    await new Promise(resolve => setTimeout(resolve, 120))
    pointerPaused = await evaluateByValue(`(() => {
      const button = document.querySelector('[data-console-action="pause"]')
      const rect = button?.getBoundingClientRect()
      return {
        pressed: button?.getAttribute('aria-pressed') === 'true',
        label: button?.getAttribute('aria-label') ?? null,
        activeAction: document.activeElement?.getAttribute('data-console-action') ?? null,
        rect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })()`)
    if (pointerPaused.pressed) break
    pointerTarget = await evaluateByValue(`(() => {
      const rect = document.querySelector('[data-console-action="pause"]')?.getBoundingClientRect()
      return rect === undefined || rect.width === 0 || rect.height === 0
        ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    if (pointerTarget === null) break
  }
  if (pointerPaused.rect !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, pointerType: 'mouse' })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pointerPaused.rect.x + pointerPaused.rect.width / 2,
      y: pointerPaused.rect.y + pointerPaused.rect.height / 2,
      pointerType: 'mouse',
    })
  }
  await evaluateByValue(`(() => {
    document.querySelector('[data-console-action="pause"]')?.focus()
  })()`)
  let toolbarTooltip
  for (let attempt = 0; attempt < 20; attempt += 1) {
    toolbarTooltip = await evaluateByValue(`(() => {
      const button = document.querySelector('[data-console-action="pause"]')
      const tooltip = document.querySelector('[role="tooltip"]')
      return { text: tooltip?.textContent ?? null, describedBy: button?.getAttribute('aria-describedby') ?? null }
    })()`)
    if (toolbarTooltip.text !== null && toolbarTooltip.describedBy !== null) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const keyboardFocused = await evaluateByValue(`(() => {
    const button = document.querySelector('[data-console-action="pause"]')
    button?.focus()
    return document.activeElement === button
  })()`)
  await pressKey(' ', 'Space', 32)
  await new Promise(resolve => setTimeout(resolve, 80))
  const keyboardResumed = await evaluateByValue(`(() => {
    const button = document.querySelector('[data-console-action="pause"]')
    return { pressed: button?.getAttribute('aria-pressed') === 'false', label: button?.getAttribute('aria-label') ?? null }
  })()`)
  const consoleEntryFocused = await evaluateByValue(`(() => {
    const frame = document.querySelector('[data-plugin-console=${JSON.stringify(owner)}]')
    frame?.focus()
    return document.activeElement === frame
  })()`)
  if (!consoleEntryFocused) throw new Error('Plugin Console entry list cannot receive keyboard focus')
  await pressKey('ArrowDown', 'ArrowDown', 40)
  await new Promise(resolve => setTimeout(resolve, 80))
  pluginConsoleReport = await evaluateByValue(`(async () => {
    const owner = ${JSON.stringify(owner)}
    const runtime = globalThis.__cordisxRuntime
    if (runtime?.pluginConsole === undefined) throw new Error('Plugin Console runtime API is unavailable')
    document.querySelector('[data-permission-prompt] [data-permission-decision="deny"]')?.click()
    await new Promise(resolve => setTimeout(resolve, 120))
    const before = runtime.pluginConsole(owner)
    const silent = runtime.pluginConsole('silent-api')
    const modal = document.querySelector('[data-cordisx-manager-modal]')
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    if (modal?.hidden === true && trigger !== null) trigger.click()
    else if (modal instanceof HTMLElement && modal.hidden) modal.hidden = false
    if (document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]') === null) {
      document.querySelector('[data-tab="plugins"]')?.click()
      document.querySelector('[data-plugin-id="' + CSS.escape(owner) + '"]')?.click()
      document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
    }
    const consoleFrame = () => document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    const runtimePanel = consoleFrame()?.closest('[role="tabpanel"]')
    let pause = runtimePanel?.querySelector('[data-console-action="pause"]')
    if (pause?.getAttribute('aria-pressed') === 'true') {
      pause.click()
      pause = consoleFrame()?.closest('[role="tabpanel"]')?.querySelector('[data-console-action="pause"]')
    }
    pause?.click()
    const pausedPanel = consoleFrame()?.closest('[role="tabpanel"]')
    const paused = pause !== null && pausedPanel?.querySelector('[data-console-action="pause"]')?.getAttribute('aria-pressed') === 'true'
    const detailOpened = document.querySelector('[data-console-detail]') !== null
    const inspectorText = document.querySelector('[data-console-detail]')?.textContent ?? ''
    const kind = pausedPanel?.querySelector('t-select[aria-label=' + JSON.stringify(${JSON.stringify(pluginConsoleLocale.kindSelect)}) + ']')
    kind?.setSelectedValue?.('console', true)
    let lunaFrame
    for (let attempt = 0; attempt < 40; attempt += 1) {
      lunaFrame = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
      if (lunaFrame?.querySelector('[data-console-entry]') != null) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const lunaEntries = [...(lunaFrame?.querySelectorAll('[data-console-entry]') ?? [])]
    const scopedFiltered = lunaEntries.some(item => item.dataset.consoleSource === 'console.log')
      && !lunaEntries.some(item => item.dataset.consoleSource === 'settings.get')
    const firstEntry = lunaEntries[0]
    const firstLineAtTop = lunaFrame !== null && firstEntry !== undefined
      && firstEntry.getBoundingClientRect().top - lunaFrame.getBoundingClientRect().top < 16
    const contentDrivenHeight = lunaFrame !== null && lunaFrame.getBoundingClientRect().height <= 522
    const lunaOnly = lunaFrame?.classList.contains('luna-console') === true
      && lunaFrame.querySelector('.luna-text-viewer-text, pre, .cxm-console-hit-layer') === null
    const objectEntry = lunaEntries.find(item => item.dataset.consoleSource === 'console.log')
    objectEntry?.querySelector('.luna-console-preview')?.click()
    const errorEntry = lunaEntries.find(item => item.dataset.consoleSource === 'console.info')
    errorEntry?.querySelector('.luna-console-preview')?.click()
    const objectExpanded = objectEntry?.querySelector('.luna-object-viewer') != null
    const nativePayloads = objectEntry?.querySelectorAll('.luna-console-preview').length === 2
      && errorEntry?.querySelector('.luna-object-viewer')?.textContent?.includes('inspectable error') === true
    const independentEntryCount = before.entries.filter(entry => entry.kind === 'console').length
    const independentEntries = lunaEntries.length === independentEntryCount
    const levelVisuals = lunaEntries.some(item => item.querySelector('.luna-console-debug') !== null)
      && lunaEntries.some(item => item.querySelector('.luna-console-warn') !== null)
      && lunaEntries.some(item => item.querySelector('.luna-console-error') !== null)
    const coverageRemoved = !pausedPanel?.textContent?.includes('采集范围')
      && !pausedPanel?.textContent?.includes('Host API 自动切面')
    const toolbarButtons = [...(document.querySelectorAll('.cxm-console-action-toolbar [data-console-action]') ?? [])]
    const iconToolbar = toolbarButtons.length === 4 && toolbarButtons.every(item => item.textContent === '' && item.querySelector('[data-material-icon]') !== null)
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
    const originalTheme = document.documentElement.getAttribute('data-theme')
    globalThis.__cordisxRestoreSmokeTheme?.()
    document.documentElement.classList.remove('electron-dark')
    document.documentElement.classList.add('electron-light')
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise(resolve => setTimeout(resolve, 20))
    let lightTheme = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      lightTheme = managerModal?.getAttribute('data-cordisx-app-theme') === 'light'
        && lunaFrame?.classList.contains('luna-console-theme-light') === true
      if (lightTheme) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    document.documentElement.classList.remove('electron-light')
    document.documentElement.classList.add('electron-dark')
    document.documentElement.setAttribute('data-theme', 'dark')
    let darkTheme = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      darkTheme = managerModal?.getAttribute('data-cordisx-app-theme') === 'dark'
        && lunaFrame?.classList.contains('luna-console-theme-dark') === true
      if (darkTheme) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    document.documentElement.className = originalThemeClass
    if (originalTheme === null) document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', originalTheme)
    const resumed = document.querySelector('[data-console-action="pause"]')
    if (resumed?.getAttribute('aria-pressed') === 'true') resumed.click()
    const clear = document.querySelector('[data-console-action="clear"]')
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
    let screenshotFrame = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    if (screenshotFrame instanceof HTMLElement) {
      screenshotFrame.scrollTop = 0
      screenshotFrame.dispatchEvent(new Event('scroll'))
      screenshotFrame.querySelector('[data-console-source="console.log"] .luna-console-preview')?.click()
    }
    screenshotFrame = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')
    const screenshotPreparedAtTop = screenshotFrame instanceof HTMLElement && screenshotFrame.scrollTop === 0
    const runtimePanelForChrome = screenshotFrame?.closest('[role="tabpanel"]')
    const runtimeLifecycle = runtimePanelForChrome?.querySelector('[data-runtime-lifecycle="' + CSS.escape(owner) + '"]')
    const runtimeDiagnostics = runtimePanelForChrome?.querySelector('[data-runtime-diagnostics="platform"]')
    const lifecycleCollapsed = runtimeLifecycle instanceof HTMLDetailsElement && !runtimeLifecycle.open
    const diagnosticsCollapsed = runtimeDiagnostics instanceof HTMLDetailsElement && !runtimeDiagnostics.open
    runtimeLifecycle?.querySelector('summary')?.click()
    runtimeDiagnostics?.querySelector('summary')?.click()
    const runtimeChrome = {
      lifecycleCollapsed,
      diagnosticsCollapsed,
      expanded: runtimeLifecycle instanceof HTMLDetailsElement && runtimeLifecycle.open
        && runtimeDiagnostics instanceof HTMLDetailsElement && runtimeDiagnostics.open,
      localized: runtimeLifecycle?.querySelector('summary')?.textContent === ${JSON.stringify(pluginConsoleLocale.runtimeSummary)}
        && runtimeDiagnostics?.querySelector('summary')?.textContent === ${JSON.stringify(pluginConsoleLocale.diagnostics)},
      expandedNoCjk: ${JSON.stringify(locale !== 'zh-CN')} === false || !/[\u3400-\u9fff]/u.test(runtimeLifecycle?.textContent ?? ''),
    }
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
        independentEntries, independentEntryCount, mountedEntryCount: lunaEntries.length,
        levelVisuals, objectExpanded, coverageRemoved, iconToolbar,
        pointerPaused: ${JSON.stringify(pointerPaused.pressed)}, pointerPauseDetail: ${JSON.stringify(pointerPaused)},
        keyboardFocused: ${JSON.stringify(keyboardFocused)}, keyboardResumed: ${JSON.stringify(keyboardResumed.pressed)},
        keyboardResumeDetail: ${JSON.stringify(keyboardResumed)},
        toolbarTooltip: ${JSON.stringify(toolbarTooltip)},
        returnLatestVisible, returnedToLatest, lightTheme, darkTheme, screenshotPreparedAtTop, runtimeChrome,
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
  pluginConsoleAssertions = pluginConsoleSmokeAssertions(pluginConsoleReport, owner)
  pluginConsoleReport = { ...pluginConsoleReport, assertions: pluginConsoleAssertions }
  if (parsed.values['plugin-console-expanded-screenshot'] !== undefined) {
    const expandedRect = await evaluateByValue(`(() => {
      const lifecycle = document.querySelector('[data-runtime-lifecycle=${JSON.stringify(owner)}]')
      const panel = lifecycle?.closest('[role="tabpanel"]')
      const rect = panel?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    if (expandedRect === null) throw new Error('expanded Plugin Console runtime panel is unavailable')
    await capture(expandedRect, parsed.values['plugin-console-expanded-screenshot'], 'expanded Plugin Console runtime')
  }
  console.log(`plugin-console=${JSON.stringify(pluginConsoleReport, null, 2)}`)
}
if (parsed.values['manager-screenshot'] !== undefined) {
  const managerTab = parsed.values['manager-tab'] ?? 'plugins'
  if (!['about', 'extension-points', 'routes', 'plugins', 'marketplace', 'settings'].includes(managerTab)) throw new Error(`unknown manager tab: ${managerTab}`)
  const managerPlugin = parsed.values['manager-plugin']
  const managerDetailTab = parsed.values['manager-detail-tab']
  if (managerDetailTab !== undefined && !['readme', 'config', 'permissions', 'runtime', 'logs', 'extension-points', 'routes'].includes(managerDetailTab)) throw new Error(`unknown manager detail tab: ${managerDetailTab}`)
  const managerPermissionCapability = parsed.values['manager-permission-capability']
  if (managerPermissionCapability !== undefined && managerDetailTab !== 'permissions') throw new Error('--manager-permission-capability requires --manager-detail-tab permissions')
  const managerSettingsTab = parsed.values['manager-settings-tab']
  if (managerSettingsTab !== undefined && !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(managerSettingsTab)) {
    throw new Error(`invalid manager settings tab id: ${managerSettingsTab}`)
  }
  const managerSettingsNavigationItem = parsed.values['manager-settings-navigation-item']
    ?? (parsed.values['channel-data-plane'] ? 'channel:channels' : undefined)
  if (managerSettingsNavigationItem !== undefined && !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(managerSettingsNavigationItem)) {
    throw new Error(`invalid manager settings navigation item id: ${managerSettingsNavigationItem}`)
  }
  const managerExtensionPoint = parsed.values['manager-extension-point']
  const managerExtensionPointTab = parsed.values['manager-extension-point-tab']
  if (managerExtensionPointTab !== undefined && !['usage', 'information', 'diagnostics'].includes(managerExtensionPointTab)) throw new Error(`unknown manager extension point tab: ${managerExtensionPointTab}`)
  const managerRoute = parsed.values['manager-route']
  const managerMarketplaceTab = parsed.values['manager-marketplace-tab']
  if (managerMarketplaceTab !== undefined && !['overview', 'authors-source'].includes(managerMarketplaceTab)) throw new Error(`unknown manager marketplace tab: ${managerMarketplaceTab}`)
  const managerMarketplaceView = parsed.values['manager-marketplace-view']
  if (managerMarketplaceView !== undefined && !['discovery', 'sources', 'create'].includes(managerMarketplaceView)) {
    throw new Error(`unknown manager marketplace view: ${managerMarketplaceView}`)
  }
  if ((managerMarketplaceView !== undefined || parsed.values['manager-marketplace-open-menu']) && managerTab !== 'marketplace') {
    throw new Error('--manager-marketplace-view and --manager-marketplace-open-menu require --manager-tab marketplace')
  }
  const managerMarketplaceSource = parsed.values['manager-marketplace-source']
  if (managerMarketplaceSource !== undefined) {
    const sourceUrl = new URL(managerMarketplaceSource)
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username !== '' || sourceUrl.password !== '' || sourceUrl.hash !== '') {
      throw new Error('--manager-marketplace-source must be a credential-free HTTPS URL without a fragment')
    }
  }
  const managerMarketplaceFixturePath = parsed.values['manager-marketplace-fixture']
  if (parsed.values['manager-marketplace-clipboard-exercise']
    && (managerMarketplaceSource === undefined || managerMarketplaceFixturePath === undefined)) {
    throw new Error('--manager-marketplace-clipboard-exercise requires --manager-marketplace-source and --manager-marketplace-fixture')
  }
  if (parsed.values['manager-marketplace-clipboard-exercise'] && !parsed.values.generation) {
    throw new Error('--manager-marketplace-clipboard-exercise requires --generation so imported state and Host cleanup share one report')
  }
  if (managerMarketplaceFixturePath !== undefined && managerMarketplaceSource === undefined) {
    throw new Error('--manager-marketplace-fixture requires --manager-marketplace-source')
  }
  if (managerMarketplaceFixturePath !== undefined && !path.isAbsolute(managerMarketplaceFixturePath)) {
    throw new Error('--manager-marketplace-fixture must be an absolute JSON path')
  }
  const managerMarketplaceFixture = managerMarketplaceFixturePath === undefined
    ? undefined
    : await readFile(managerMarketplaceFixturePath, 'utf8')
  if (managerMarketplaceFixture !== undefined) JSON.parse(managerMarketplaceFixture)
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
      const nextPaint = () => new Promise(resolve => {
        const timer = setTimeout(resolve, 120)
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
      })
      const waitForElement = async (selector, timeout = 4_000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const element = document.querySelector(selector)
          if (element !== null) return element
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        return null
      }
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      await nextPaint()
      const marketplaceFixtureText = ${JSON.stringify(managerMarketplaceFixture)}
      const marketplaceClipboardExercise = ${JSON.stringify(parsed.values['manager-marketplace-clipboard-exercise'])}
      const marketplaceClipboardLocal = {
        name: '剪贴板团队来源',
        description: '从结构化来源描述导入。',
        note: '真实 app:// smoke',
      }
      let marketplaceMenuKeyboard = null
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      const openedBy = trigger === null ? 'host-smoke-fallback' : 'manager-trigger'
      if (modal?.hidden === true && trigger !== null) trigger.click()
      else if (modal instanceof HTMLElement && modal.hidden) modal.hidden = false
      const marketplaceSource = ${JSON.stringify(managerMarketplaceSource)}
      let marketplaceSourceConfigured = false
      if (marketplaceSource !== undefined) {
        document.querySelector('[data-tab="marketplace"]')?.click()
        const sourceMenu = await waitForElement('[data-marketplace-source-menu]')
        sourceMenu?.click()
        if (marketplaceClipboardExercise) {
          const clipboardPayload = JSON.stringify({
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-source.v1.schema.json',
            schemaVersion: 1,
            url: marketplaceSource,
            enabled: true,
            local: marketplaceClipboardLocal,
          })
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText: async () => clipboardPayload },
          })
          const clipboardAction = await waitForElement('[data-manager-menu-action="clipboard"]')
          if (!(clipboardAction instanceof HTMLButtonElement)) throw new Error('marketplace clipboard action is unavailable')
          const fixtureNow = 1_900_000_000_000
          const originalNow = Date.now
          Date.now = () => fixtureNow
          try {
            clipboardAction.click()
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
          } finally {
            Date.now = originalNow
          }
          const requestPrefix = fixtureNow.toString(36)
          for (let sequence = 1; sequence <= 16; sequence += 1) globalThis.__cordisxMarketplaceReceiveV1?.(JSON.stringify({
            requestId: requestPrefix + '-' + sequence.toString(36),
            ok: true,
            status: 200,
            url: marketplaceSource,
            text: marketplaceFixtureText,
          }))
        } else {
          const createAction = await waitForElement('[data-manager-menu-action="create"]')
          createAction?.click()
          const form = await waitForElement('[data-host-form="marketplace-source-create"]')
          const input = form?.querySelector('#cxm-marketplace-source-url')
          if (!(input instanceof HTMLElement) || !(form instanceof HTMLFormElement)) throw new Error('marketplace source form is unavailable')
          input.value = marketplaceSource
          input.onChange?.(marketplaceSource)
          if (marketplaceFixtureText === undefined) form.requestSubmit()
          else {
            const fixtureNow = 1_900_000_000_000
            const originalNow = Date.now
            Date.now = () => fixtureNow
            try { form.requestSubmit() } finally { Date.now = originalNow }
            const requestPrefix = fixtureNow.toString(36)
            for (let sequence = 1; sequence <= 16; sequence += 1) globalThis.__cordisxMarketplaceReceiveV1?.(JSON.stringify({
              requestId: requestPrefix + '-' + sequence.toString(36),
              ok: true,
              status: 200,
              url: marketplaceSource,
              text: marketplaceFixtureText,
            }))
          }
        }
        const sourceDeadline = Date.now() + 12_000
        let sourceState = 'timeout'
        while (Date.now() < sourceDeadline) {
          const sourceRow = [...document.querySelectorAll('[data-collection-item]')]
            .find(row => row.getAttribute('data-collection-item') === marketplaceSource)
          const status = sourceRow?.querySelector('.cxc-status')
          if (sourceRow !== undefined && status?.getAttribute('data-tone') !== 'progress') {
            sourceState = status?.getAttribute('aria-label') ?? 'loaded'
            break
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (sourceState !== 'loaded') throw new Error('marketplace smoke source failed to load: ' + sourceState)
        marketplaceSourceConfigured = true
        document.querySelector('[data-breadcrumb-target="primary:marketplace"]')?.click()
        await nextPaint()
      }
      document.querySelector('[data-tab=${JSON.stringify(managerTab)}]')?.click()
      if (${JSON.stringify(managerTab)} === 'marketplace') {
        const deadline = Date.now() + 12_000
        while (document.querySelector('[aria-label="插件商店列表"] [data-marketplace-plugin], [aria-label="插件商店列表"] .cxc-empty') === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      const pluginId = ${JSON.stringify(managerPlugin)}
      if (pluginId !== undefined) {
        const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
          .find(element => element.getAttribute('data-plugin-id') === pluginId || element.getAttribute('data-marketplace-plugin') === pluginId)
        const primary = row?.matches('button') === true ? row : row?.querySelector('.cxc-primary')
        primary?.click()
        const detailDeadline = Date.now() + 5_000
        while (document.querySelector('[data-plugin-detail-tab]') === null && Date.now() < detailDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (document.querySelector('[data-plugin-detail-tab]') === null) throw new Error('plugin detail tabs did not mount for ' + pluginId)
      }
      const detailTab = ${JSON.stringify(managerDetailTab)}
      if (detailTab !== undefined) {
        document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
        if (detailTab === 'config' && pluginId !== undefined) {
          const formDeadline = Date.now() + 5_000
          while (document.querySelector('[data-plugin-config-form="' + CSS.escape(pluginId) + '"]') === null && Date.now() < formDeadline) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (pluginId === 'cli-proxy-api') {
            const serviceDeadline = Date.now() + 15_000
            let readySince = 0
            while (Date.now() < serviceDeadline) {
              const seats = [...document.querySelectorAll('[data-plugin-service-config="cli-proxy-api"]')]
              const ready = seats.length === 1 && seats[0].querySelectorAll('[data-service-config]').length === 2
              if (ready) {
                if (readySince === 0) readySince = Date.now()
                if (Date.now() - readySince >= 750) break
              } else {
                readySince = 0
              }
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            const seats = [...document.querySelectorAll('[data-plugin-service-config="cli-proxy-api"]')]
            if (readySince === 0 || seats.length !== 1 || seats[0].querySelectorAll('[data-service-config]').length !== 2) {
              throw new Error('CLIProxy Provider service configuration did not become stably available')
            }
          }
        }
      }
      const permissionCapability = ${JSON.stringify(managerPermissionCapability)}
      if (permissionCapability !== undefined) document.querySelector('[data-permission-open="' + CSS.escape(permissionCapability) + '"]')?.click()
      const settingsTab = ${JSON.stringify(managerSettingsTab)}
      if (settingsTab !== undefined) document.querySelector('[data-settings-tab="' + settingsTab + '"]')?.click()
      if (settingsTab !== undefined) await new Promise(resolve => setTimeout(resolve, 250))
      const settingsNavigationItem = ${JSON.stringify(managerSettingsNavigationItem)}
      if (settingsNavigationItem !== undefined) {
        document.querySelector('[data-settings-navigation-item="' + CSS.escape(settingsNavigationItem) + '"]')?.click()
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      let channelManagerFlow = null
      let channelManagerExistingAccount = null
      if (${JSON.stringify(parsed.values['channel-manager-exercise'])}) {
        let list = document.querySelector('[data-channel-page="list"]')
        if (!(list instanceof HTMLElement)) {
          document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')?.click()
          const listDeadline = Date.now() + 2_000
          while (!(list instanceof HTMLElement) && Date.now() < listDeadline) {
            await nextPaint()
            list = document.querySelector('[data-channel-page="list"]')
          }
        }
        const create = document.querySelector('[data-channel-create="true"]')
        if (!(list instanceof HTMLElement) || !(create instanceof HTMLElement)) throw new Error('Channel list or create action is unavailable')
        create.click()
        await nextPaint()
        const form = document.querySelector('[data-channel-create-form="true"]')
        const name = document.querySelector('#channel-create-name')
        if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLElement)) throw new Error('Channel local-simulator form is unavailable')
        const smokeName = 'Smoke local ' + Date.now()
        const smokeAccountId = smokeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'local'
        const smokeRecordId = 'simulator/' + smokeAccountId + '/local'
        name.onChange?.(smokeName)
        form.requestSubmit()
        const createdDeadline = Date.now() + 5_000
        let search = document.querySelector('[data-collection-search="channel-list"]')
        while (!(search instanceof HTMLInputElement) && Date.now() < createdDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
          search = document.querySelector('[data-collection-search="channel-list"]')
        }
        if (!(search instanceof HTMLInputElement)) {
          throw new Error('Channel search is unavailable: ' + JSON.stringify({
            pages: [...document.querySelectorAll('[data-channel-page]')].map(page => page.getAttribute('data-channel-page')),
            route: document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route') ?? null,
            status: document.querySelector('[data-channel-create-status="true"]')?.textContent?.trim() ?? null,
          }))
        }
        search.value = smokeName
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await nextPaint()
        const card = document.querySelector('[data-host-collection="channel-list"] [data-collection-item="' + CSS.escape(smokeRecordId) + '"] .cxc-primary')
        if (!(card instanceof HTMLElement) || card.hidden) throw new Error('Persisted local simulator card was not found after search')
        card.click()
        const configurationDeadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-configuration]') === null && Date.now() < configurationDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const configuration = document.querySelector('[data-channel-configuration]')
        const tabs = [...document.querySelectorAll('[data-manager-content-tabs] [data-manager-content-tab]')]
        const activateHostTab = async (id, marker) => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const route = document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route')
            if (route === id && document.querySelector(marker) !== null) return true
            // Host atomically replaces the declaration/body. A click during a
            // transition is deliberately ignored, so select the current Host
            // tab again on the next tick rather than retaining a stale button.
            const tab = document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="' + id + '"]')
            if (tab instanceof HTMLElement) tab.click()
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        }
        const runtimeAvailable = await activateHostTab('runtime', '[data-channel-detail-panel="runtime"]')
        const runtimeActionCount = document.querySelectorAll('[data-channel-runtime-action]').length
        const logsAvailable = await activateHostTab('logs', '[data-channel-logs="true"]')
        const logs = document.querySelector('[data-channel-logs="true"]')
        const logControlsPresent = logs?.querySelector('[data-channel-log-query="true"]') !== null
          && logs?.querySelector('[data-channel-log-outcome="true"]') !== null
          && logs?.querySelector('[data-channel-log-export="json"]') !== null
        const logExport = logs?.querySelector('[data-channel-log-export="json"]')
        const logsEmpty = logs?.querySelector('[data-channel-logs-empty="true"], [data-channel-logs-no-matches="true"]') !== null
        const sessionsAvailable = await activateHostTab('sessions', '[data-channel-detail-panel="sessions"]')
        const sessionPanel = document.querySelector('[data-channel-detail-panel="sessions"]')
        const bindingActions = [...sessionPanel?.querySelectorAll('[data-channel-binding-operation]') ?? []]
        const sessionEmpty = sessionPanel?.querySelector('[data-channel-session-actions="true"]') !== null
        const managerModal = document.querySelector('[data-cordisx-manager-modal]')
        const channelRoot = document.querySelector('[data-channel-manager]')
        channelManagerFlow = {
          list: list !== null,
          create: create !== null,
          searched: search.value === smokeName,
          card: card !== null,
          configuration: configuration !== null,
          tabs: tabs.map(tab => tab.getAttribute('data-manager-content-tab')),
          runtimeAvailable,
          runtimeActionCount,
          logsAvailable,
          logControlsPresent,
          logExportDisabled: logExport instanceof HTMLButtonElement ? logExport.disabled : null,
          logsEmpty,
          sessionsAvailable,
          bindingActionCount: bindingActions.length,
          bindingActionsEnabled: bindingActions.some(button => !button.disabled),
          sessionEmpty,
          expectedHeading: smokeName,
          hostHeading: document.querySelector('.cxm-heading-current-heading')?.textContent?.trim() ?? null,
          nestedChannelChrome: document.querySelector('[data-channel-manager] .cxc-channel-back, [data-channel-manager] .cxc-channel-tabs, [data-channel-manager] .cxc-channel-detail > h1, [data-channel-manager] .cxc-channel-detail > h2, [data-channel-manager] .cxc-channel-detail [role="tablist"]') !== null,
          hostTabs: tabs.length === 4 && document.querySelector('[data-manager-content-tabs]') !== null,
          managerFontSize: managerModal instanceof HTMLElement ? getComputedStyle(managerModal).fontSize : null,
          channelFontSize: channelRoot instanceof HTMLElement ? getComputedStyle(channelRoot).fontSize : null,
          secretRendered: /secretRef|keychain:|host-secret:/iu.test(document.querySelector('[data-channel-manager]')?.outerHTML ?? ''),
        }
        // Details are child manager-content routes.  Return through the Host
        // header rather than a plugin-owned back affordance, so the rest of
        // this data-plane exercise observes the declared root route again.
        const returnDeadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-page="list"]') === null && Date.now() < returnDeadline) {
          const back = document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')
          if (back instanceof HTMLElement) back.click()
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        channelManagerFlow.returnedToList = document.querySelector('[data-channel-page="list"]') !== null
      }
      if (${JSON.stringify(parsed.values['channel-manager-existing-account'])}) {
        let list = document.querySelector('[data-channel-page="list"]')
        if (!(list instanceof HTMLElement)) {
          document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')?.click()
          const deadline = Date.now() + 2_000
          while (!(list instanceof HTMLElement) && Date.now() < deadline) {
            await nextPaint()
            list = document.querySelector('[data-channel-page="list"]')
          }
        }
        const card = document.querySelector('[data-channel-page="list"] [data-collection-item] .cxc-primary')
        if (!(list instanceof HTMLElement) || !(card instanceof HTMLElement)) throw new Error('Configured Channel account card is unavailable')
        card.click()
        const deadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-configuration-form]') === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const form = document.querySelector('[data-channel-configuration-form]')
        const channelSwitch = form?.querySelector('t-switch')
        const activateHostTab = async (id, marker) => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const route = document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route')
            if (route === id && document.querySelector(marker) !== null) return true
            const tab = document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="' + id + '"]')
            if (tab instanceof HTMLElement) tab.click()
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        }
        const runtimeAvailable = await activateHostTab('runtime', '[data-channel-detail-panel="runtime"]')
        const runtimeActions = [...document.querySelectorAll('[data-channel-runtime-action]')]
        const logsAvailable = await activateHostTab('logs', '[data-channel-logs="true"]')
        const logs = document.querySelector('[data-channel-logs="true"]')
        const logsControlsPresent = logs?.querySelector('[data-channel-log-query="true"]') !== null
          && logs?.querySelector('[data-channel-log-outcome="true"]') !== null
          && logs?.querySelector('[data-channel-log-export="json"]') !== null
        const logExport = logs?.querySelector('[data-channel-log-export="json"]')
        const logsEmpty = logs?.querySelector('[data-channel-logs-empty="true"], [data-channel-logs-no-matches="true"]') !== null
        const sessionsAvailable = await activateHostTab('sessions', '[data-channel-detail-panel="sessions"]')
        const sessionPanel = document.querySelector('[data-channel-detail-panel="sessions"]')
        const bindingActions = [...sessionPanel?.querySelectorAll('[data-channel-binding-operation]') ?? []]
        const sessionEmpty = sessionPanel?.querySelector('[data-channel-session-actions="true"]') !== null
        const configurationAvailable = await activateHostTab('configuration', '[data-channel-configuration-form]')
        const activeForm = document.querySelector('[data-channel-configuration-form]')
        let saved = false
        let saveStatus = null
        if (${JSON.stringify(parsed.values['channel-manager-existing-account-save'])}) {
          if (!(activeForm instanceof HTMLFormElement)) throw new Error('Configured Channel account form is unavailable for save')
          activeForm.requestSubmit()
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            saveStatus = document.querySelector('[data-channel-configuration-status]')?.textContent?.trim() ?? null
            if (saveStatus !== null && saveStatus !== '' && !saveStatus.includes('正在保存') && !saveStatus.includes('Saving')) break
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          saved = saveStatus === '保存后重启相关服务生效' || saveStatus === 'Takes effect after restarting the service'
        }
        channelManagerExistingAccount = {
          list: list !== null,
          detail: document.querySelector('[data-channel-page="detail"]') !== null,
          form: activeForm !== null,
          configurationAvailable,
          switchValue: channelSwitch?.value ?? null,
          switchPropsValue: channelSwitch?.props?.value ?? null,
          switchAriaChecked: channelSwitch?.getAttribute('aria-checked') ?? null,
          switchShadowText: channelSwitch?.shadowRoot?.textContent?.trim() ?? null,
          saved,
          saveStatus,
          runtimeAvailable,
          runtimeActionCount: runtimeActions.length,
          runtimeActionsEnabled: runtimeActions.length === 3 && runtimeActions.every(button => !button.disabled),
          logsAvailable,
          logsControlsPresent,
          logExportDisabled: logExport instanceof HTMLButtonElement ? logExport.disabled : null,
          logsEmpty,
          sessionsAvailable,
          bindingActionCount: bindingActions.length,
          bindingActionsEnabled: bindingActions.some(button => !button.disabled),
          sessionEmpty,
          secretRendered: /secretRef|keychain:|host-secret:/iu.test(document.querySelector('[data-channel-manager]')?.outerHTML ?? ''),
        }
      }
      const extensionPointId = ${JSON.stringify(managerExtensionPoint)}
      if (extensionPointId !== undefined) document.querySelector('[data-extension-point-id="' + CSS.escape(extensionPointId) + '"]')?.click()
      const extensionPointTab = ${JSON.stringify(managerExtensionPointTab)}
      if (extensionPointTab !== undefined) document.querySelector('[data-extension-point-detail-tab="' + extensionPointTab + '"]')?.click()
      const routeId = ${JSON.stringify(managerRoute)}
      if (routeId !== undefined) document.querySelector('[data-route-id="' + CSS.escape(routeId) + '"]')?.click()
      const marketplaceTab = ${JSON.stringify(managerMarketplaceTab)}
      if (marketplaceTab !== undefined) document.querySelector('[data-marketplace-detail-tab="' + marketplaceTab + '"]')?.click()
      const marketplaceView = ${JSON.stringify(managerMarketplaceView)}
      if (marketplaceView === 'sources' || marketplaceView === 'create') {
        const sourceMenu = await waitForElement('[data-marketplace-source-menu]')
        sourceMenu?.click()
        const action = await waitForElement('[data-manager-menu-action="' + (marketplaceView === 'create' ? 'create' : 'manage') + '"]')
        action?.click()
        await waitForElement(marketplaceView === 'create'
          ? '[data-marketplace-source-page="create"]'
          : '[data-marketplace-source-page="index"]')
      }
      if (${JSON.stringify(parsed.values['manager-marketplace-open-menu'])}) {
        const discoveryMenu = document.querySelector('[data-marketplace-source-menu]')
        let menuTrigger = discoveryMenu
        if (discoveryMenu !== null) discoveryMenu.click()
        else {
          const official = [...document.querySelectorAll('[data-collection-item]')]
            .find(item => item.getAttribute('data-collection-item') === 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
          menuTrigger = official?.querySelector('.cxc-menu-trigger') ?? null
          menuTrigger?.click()
        }
        await nextPaint()
        const openedPopup = document.querySelector('[data-manager-action-menu], .cxc-menu-popup')
        const initialFocus = document.activeElement
        initialFocus?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        const arrowMoved = openedPopup?.contains(document.activeElement) === true && document.activeElement !== initialFocus
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await nextPaint()
        const closed = document.querySelector('[data-manager-action-menu], .cxc-menu-popup') === null
        const focusRestored = document.activeElement === menuTrigger
        menuTrigger?.click()
        await nextPaint()
        marketplaceMenuKeyboard = {
          arrowMoved,
          closed,
          focusRestored,
          reopened: document.querySelector('[data-manager-action-menu], .cxc-menu-popup') !== null,
        }
      }
      if (${JSON.stringify(parsed.values['manager-open-local-path-form'])}) {
        document.querySelector('[data-tab="plugins"]')?.click()
        await nextPaint()
        document.querySelector('[data-import-local-plugin]')?.click()
        await nextPaint()
      }
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      const breadcrumbWidth = ${JSON.stringify(managerBreadcrumbWidth)}
      const heading = document.querySelector('.cxm-heading')
      if (breadcrumbWidth !== undefined && heading instanceof HTMLElement) {
        heading.style.flex = '0 1 ' + breadcrumbWidth + 'px'
        heading.style.width = breadcrumbWidth + 'px'
        window.dispatchEvent(new Event('resize'))
      }
      await nextPaint()
      if (${JSON.stringify(parsed.values['plugin-console-exercise'])} && detailTab === 'runtime') {
        const consoleFrame = document.querySelector('[data-plugin-console="' + CSS.escape(pluginId) + '"]')
        const objectEntry = consoleFrame?.querySelector('[data-console-source="console.log"]')
        const expandable = objectEntry?.querySelector('.luna-console-preview')
        if (expandable != null) expandable.click()
        await nextPaint()
      }
      if (${JSON.stringify(parsed.values['manager-open-select'])}) {
        const select = [...document.querySelectorAll('t-select[data-host-form-primitive="select"]')]
          .find(item => item.getClientRects().length > 0)
        if (!(select instanceof HTMLElement)) throw new Error('visible TDesign Select is unavailable')
        select.focus()
        select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        await nextPaint()
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (breadcrumbWidth !== undefined) {
        const overflow = document.querySelector('.cxm-breadcrumb-overflow')
        if (overflow instanceof HTMLDetailsElement) overflow.open = true
      }
      const dialog = document.querySelector('.cxm-lifecycle-dialog')
        ?? document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')
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
          hostForms: [...document.querySelectorAll('[data-host-form]')].filter(form => form.getClientRects().length > 0).map(form => {
            const grid = form.querySelector('.cxf-form-grid')
            const firstControl = [...form.querySelectorAll('t-input[id], t-textarea[id], t-select[id], input[id], textarea[id], select[id]')]
              .find(control => control instanceof HTMLElement && control.getClientRects().length > 0
                && !control.matches(':disabled,[aria-disabled="true"]'))
            const firstRect = firstControl?.getBoundingClientRect()
            return {
              id: form.getAttribute('data-host-form'),
              state: form.getAttribute('data-state'),
              direction: getComputedStyle(form).direction,
              gridColumns: grid === null ? null : getComputedStyle(grid).gridTemplateColumns,
              horizontalOverflow: form.scrollWidth > form.clientWidth + 1,
              developerMetadataVisible: ['Schemastery', 'Revision', '实时发布（不重载）'].some(text => (form.closest('[role="tabpanel"]')?.textContent ?? '').includes(text)),
              items: [...form.querySelectorAll('.cxf-item')].map(item => ({
                path: item.getAttribute('data-config-path'),
                primitive: item.getAttribute('data-host-form-primitive'),
                label: item.querySelector('.cxf-label')?.textContent?.trim() ?? null,
                help: item.querySelector('.cxf-help')?.textContent?.trim() ?? null,
                error: item.querySelector('.cxf-error:not([hidden])')?.textContent?.trim() ?? null,
                invalid: item.getAttribute('data-invalid'),
                customSeatVisible: item.querySelector('.cxf-custom-seat:not([hidden])') !== null,
                sensitiveControlCount: item.getAttribute('data-host-form-primitive') === 'sensitive-unavailable'
                  ? item.querySelectorAll('input,textarea,select,t-input,t-textarea,t-select').length : null,
              })),
              controls: [...form.querySelectorAll('[data-host-form-primitive],input,textarea')].filter((control, index, all) => all.indexOf(control) === index).map(control => ({
                primitive: control.getAttribute('data-host-form-primitive'), tag: control.tagName.toLowerCase(),
                type: control instanceof HTMLInputElement ? control.type : null, id: control.id,
                required: control.getAttribute('aria-required'), invalid: control.getAttribute('aria-invalid'),
                describedBy: control.getAttribute('aria-describedby'), disabled: control.matches(':disabled,[aria-disabled="true"]'),
                placeholder: control.getAttribute('placeholder'),
                shadowPlaceholder: (() => {
                  const roots = control.shadowRoot === null ? [] : [control.shadowRoot]
                  while (roots.length > 0) {
                    const root = roots.shift()
                    const textControl = root?.querySelector('input,textarea')
                    if (textControl !== null && textControl !== undefined) return textControl.getAttribute('placeholder')
                    for (const child of root?.querySelectorAll('*') ?? []) {
                      if (child.shadowRoot !== null) roots.push(child.shadowRoot)
                    }
                  }
                  return null
                })(),
              })),
              firstControlRect: firstRect === undefined ? null : { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
            }
          }),
          serviceConfigs: [...document.querySelectorAll('[data-plugin-service-config]')].map(seat => ({
            pluginId: seat.getAttribute('data-plugin-service-config'),
            services: [...seat.querySelectorAll('[data-service-config]')].map(section => {
              const form = section.closest('form')
              const footer = form?.querySelector('.cxm-service-config-footer')
              const sectionRect = section.getBoundingClientRect()
              const footerRect = footer?.getBoundingClientRect()
              return {
                id: section.getAttribute('data-service-config'),
                applies: section.getAttribute('data-config-applies'),
                form: form?.getAttribute('data-service-config-form') ?? null,
                fullWidth: section.querySelector('.cxf-item')?.getAttribute('data-full-width') ?? null,
                nativeSelects: section.querySelectorAll('select').length,
                nestedControlChrome: section.classList.contains('cxm-settings-group') && section.querySelector('.cxf-form-grid') !== null,
                stickyFooter: footer instanceof HTMLElement && getComputedStyle(footer).position === 'sticky',
                orphanedFooter: footerRect !== undefined && footerRect.bottom > 0 && footerRect.top < innerHeight
                  && !(sectionRect.bottom > 0 && sectionRect.top < innerHeight),
              }
            }),
            message: seat.textContent?.trim() ?? '',
          })),
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
          channelDataPlane: (() => {
            const runtime = globalThis.__cordisxRuntime
            const snapshot = runtime?.snapshot?.()
            if (snapshot === undefined) return null
            const plugin = snapshot.plugins.find(item => item.id === 'channel')
            const registration = snapshot.registrations.find(item => (
              item.surface === 'manager.settings.navigation-items'
              && item.qualifiedId === 'channel:channels'
            ))
            const route = snapshot.navigation.routes.find(item => item.qualifiedId === 'channel:settings')
            const page = snapshot.navigation.pages.find(item => item.qualifiedId === 'channel:settings')
            const outlet = snapshot.navigation.outlets.find(item => item.id === 'manager.content')
            return {
              locale: document.documentElement.lang,
              plugin: plugin === undefined ? null : {
                status: plugin.status,
                schemaKind: plugin.configuration.schemaKind,
                configFields: plugin.configuration.fields.length,
              },
              registration: registration === undefined ? null : {
                valid: registration.valid,
                pending: registration.pending,
                visible: registration.visible,
                authorized: registration.authorized,
                group: registration.group,
                routeId: registration.item?.route?.id ?? null,
              },
              route: route === undefined ? null : {
                valid: route.valid,
                outlet: route.definition.outlet,
                path: route.definition.path,
                page: route.definition.page,
                diagnostics: route.productMetadata.diagnostics.length,
              },
              page: page === undefined ? null : {
                chrome: page.metadata.chrome,
                icon: page.metadata.icon,
                diagnostics: page.productMetadata.diagnostics.length,
              },
              outlet: outlet === undefined ? null : {
                available: outlet.available,
                mounted: outlet.mounted,
                activeRoute: outlet.activeRoute ?? null,
              },
              navigationItem: document.querySelector('[data-settings-navigation-item="channel:channels"]') === null ? null : {
                label: document.querySelector('[data-settings-navigation-item="channel:channels"]')?.textContent?.trim() ?? null,
                icon: document.querySelector('[data-settings-navigation-item="channel:channels"] [data-host-icon]')?.getAttribute('data-host-icon') ?? null,
              },
              pageTitle: document.querySelector('.cxm-heading-current-heading')?.textContent?.trim() ?? null,
              mounted: document.querySelector('[data-channel-manager]') !== null,
              managerFlow: channelManagerFlow,
              existingAccount: channelManagerExistingAccount,
            }
          })(),
          tabGeometry: leadingRect === undefined || tabIconRect === undefined || tabLabelRect === undefined || titleRect === undefined ? null : {
            headingLeadingCenterX: leadingRect.x + leadingRect.width / 2,
            firstTabIconCenterX: tabIconRect.x + tabIconRect.width / 2,
            headingTitleX: titleRect.x,
            firstTabLabelX: tabLabelRect.x,
          },
          permissions: [...document.querySelectorAll('[data-permission-item]')].map(item => ({
            capability: item.getAttribute('data-permission-item'),
            availability: item.querySelector('[data-permission-availability]')?.getAttribute('data-availability-state') ?? null,
            policyEditable: item.querySelector('t-select[data-permission-capability][data-tdesign-version="1.2.10"]') !== null,
            nestedList: item.querySelector('[role="listitem"]') !== null,
          })),
          permissionDetail: document.querySelector('[data-permission-detail]') === null ? null : {
            capability: document.querySelector('[data-permission-detail]')?.getAttribute('data-permission-detail') ?? null,
            providers: [...document.querySelectorAll('[data-permission-provider]')].map(item => ({
              id: item.getAttribute('data-permission-provider'),
              text: item.textContent?.trim() ?? '',
            })),
            policyEditable: document.querySelector('[data-permission-detail] t-select[data-permission-capability][data-tdesign-version="1.2.10"]') !== null,
            headings: [...document.querySelectorAll('[data-permission-detail] h1, [data-permission-detail] h2, [data-permission-detail] h3')].map(item => item.textContent?.trim() ?? ''),
          },
          marketplace: (() => {
            const managerContent = document.querySelector('.cxm-content')
            const discovery = document.querySelector('[data-marketplace-discovery-page]')
            const tools = discovery?.querySelector('.cxm-marketplace-discovery-tools')
            const search = tools?.querySelector('[data-collection-search="marketplace"]')
            const filters = tools?.querySelector('.cxm-marketplace-filter-row')
            const results = discovery?.querySelector('[data-marketplace-results-scroll]')
            const sourcePage = document.querySelector('[data-marketplace-source-page]')
            const sourceForm = sourcePage?.querySelector('[data-host-form^="marketplace-source-"]')
            const popup = document.querySelector('[data-manager-action-menu], .cxc-menu-popup')
            const box = element => {
              const rect = element?.getBoundingClientRect()
              return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }
            const contentStyle = managerContent === null ? null : getComputedStyle(managerContent)
            const resultsStyle = results == null ? null : getComputedStyle(results)
            const searchRect = search?.getBoundingClientRect()
            const filterRect = filters?.getBoundingClientRect()
            const official = [...document.querySelectorAll('[data-collection-item]')]
              .find(item => item.getAttribute('data-collection-item') === 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
            const imported = marketplaceSource === undefined ? undefined : [...document.querySelectorAll('[data-collection-item]')]
              .find(item => item.getAttribute('data-collection-item') === marketplaceSource)
            const persistedImported = marketplaceSource === undefined ? undefined : (() => {
              try {
                const value = JSON.parse(localStorage.getItem('cordisx.manager.marketplaceSources.v2') ?? 'null')
                return value?.sources?.find?.(item => item?.url === marketplaceSource) ?? null
              } catch {
                return null
              }
            })()
            const remove = popup?.querySelector('[data-collection-action="remove"]')
            return {
              view: discovery !== null
                ? 'discovery'
                : sourcePage?.getAttribute('data-marketplace-source-page') === 'index'
                  ? 'sources'
                  : sourcePage?.getAttribute('data-marketplace-source-page') ?? null,
              geometry: { content: box(managerContent), discovery: box(discovery), tools: box(tools), search: box(search), filters: box(filters), results: box(results), sourceForm: box(sourceForm) },
              discovery: discovery === null ? null : {
                contentOverflowY: contentStyle?.overflowY ?? null,
                resultsOverflowY: resultsStyle?.overflowY ?? null,
                onlyResultsScroll: contentStyle?.overflowY === 'hidden' && ['auto', 'scroll'].includes(resultsStyle?.overflowY ?? ''),
                filterBelowSearch: searchRect !== undefined && filterRect !== undefined && filterRect.top >= searchRect.bottom - 1,
                documentationPrimaryActionAbsent: ![...document.querySelectorAll('a,button')].some(item => /docs|文档/iu.test(item.textContent ?? '')),
                fullWidth: discovery.clientWidth >= (managerContent?.clientWidth ?? 0)
                  - Number.parseFloat(contentStyle?.paddingLeft ?? '0')
                  - Number.parseFloat(contentStyle?.paddingRight ?? '0') - 1,
                resultCount: document.querySelectorAll('[data-marketplace-plugin]').length,
              },
              sources: sourcePage === null ? null : {
                count: document.querySelectorAll('[data-collection-item]').length,
                officialPresent: official !== undefined,
                officialDeleteDisabled: remove instanceof HTMLButtonElement ? remove.disabled : null,
                manualReloadAbsent: ![...document.querySelectorAll('button')].some(item => item.textContent?.includes('重新加载')),
                topLevelSettingsTabAbsent: document.querySelector('[data-settings-tab="host:marketplace"]') === null,
                formFullWidth: sourceForm == null || sourcePage === null
                  ? null : sourceForm.getBoundingClientRect().width >= sourcePage.getBoundingClientRect().width - 1,
                untouchedErrorAbsent: sourceForm == null || sourceForm.querySelector('.cxf-error:not([hidden])') === null,
                nativeUrlErrorAbsent: !document.body.textContent?.includes("Failed to construct 'URL'"),
                primaryDeveloperTermsAbsent: !/Host|profile|canonical identity|marketplace-source\.v1|renderer|启动器|渲染器|规范标识/iu.test(sourcePage?.textContent ?? ''),
                clipboardImport: marketplaceClipboardExercise ? {
                  rowPresent: imported !== undefined,
                  title: imported?.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                  description: imported?.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                  machineId: imported?.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                  local: persistedImported?.local ?? null,
                  noticeVisible: sourcePage?.querySelector('.cxf-alert[data-tone="info"]') !== null,
                } : null,
              },
              menu: popup === null ? null : {
                portaled: popup.parentElement === document.body,
                theme: popup.getAttribute('data-cordisx-app-theme'),
                managerTheme: document.querySelector('[data-cordisx-manager-modal]')?.getAttribute('data-cordisx-app-theme') ?? null,
                firstItemFocused: popup.querySelector('button:not(:disabled)') === document.activeElement,
                keyboard: marketplaceMenuKeyboard,
                bounded: (() => {
                  const rect = popup.getBoundingClientRect()
                  return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                })(),
              },
            }
          })(),
          tdesign: {
            version: document.querySelector('[data-tdesign-version]')?.getAttribute('data-tdesign-version') ?? null,
            hostOwnedControlCount: document.querySelectorAll('[data-host-form-primitive][data-tdesign-version="1.2.10"]').length,
            selectCount: document.querySelectorAll('t-select[data-host-form-primitive="select"]').length,
            nativeHostSelectCount: document.querySelectorAll('[data-cordisx-manager-modal] select').length,
            groupCardCount: document.querySelectorAll('.cxf-form-grid, .cxm-settings-group').length,
            portalCount: document.querySelectorAll('[data-cxf-tdesign-portal-host]').length,
            popupVisible: [...document.querySelectorAll('[data-cxf-tdesign-portal-host]')].some(host => host.shadowRoot?.querySelector('.cxf-tdesign-listbox:not([hidden])') !== null),
            popupOptionCount: [...document.querySelectorAll('[data-cxf-tdesign-portal-host]')].reduce((count, host) => count + (host.shadowRoot?.querySelector('.cxf-tdesign-listbox:not([hidden])')?.querySelectorAll('t-option').length ?? 0), 0),
            popupTheme: (() => {
              const listbox = [...document.querySelectorAll('[data-cxf-tdesign-portal-host]')]
                .map(host => host.shadowRoot?.querySelector('.cxf-tdesign-listbox:not([hidden])'))
                .find(item => item instanceof HTMLElement)
              if (!(listbox instanceof HTMLElement)) return null
              const style = getComputedStyle(listbox)
              const rect = listbox.getBoundingClientRect()
              const activeOption = listbox.querySelector('t-option[data-active="true"]')
              const activeSurface = activeOption?.shadowRoot?.querySelector('.t-select-option, [part], div') ?? activeOption
              const activeStyle = activeSurface instanceof Element ? getComputedStyle(activeSurface) : null
              const optionStyle = activeOption instanceof Element ? getComputedStyle(activeOption) : null
              return { background: style.backgroundColor, color: style.color, placement: listbox.dataset.placement ?? null,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                activeOption: activeOption === null ? null : {
                  selected: activeOption.getAttribute('aria-selected'),
                  background: activeStyle?.backgroundColor ?? null,
                  color: activeStyle?.color ?? null,
                  selectedToken: optionStyle?.getPropertyValue('--td-bg-color-container-select').trim() ?? null,
                  activeToken: optionStyle?.getPropertyValue('--td-bg-color-container-active').trim() ?? null,
                  hoverToken: optionStyle?.getPropertyValue('--td-bg-color-container-hover').trim() ?? null,
                  disabledToken: optionStyle?.getPropertyValue('--td-bg-color-component-disabled').trim() ?? null,
                } }
            })(),
            activeElement: document.activeElement?.tagName.toLowerCase() ?? null,
            selectState: (() => {
              const select = [...document.querySelectorAll('t-select[data-host-form-primitive="select"]')]
                .find(item => item.getClientRects().length > 0 && item.getAttribute('aria-expanded') === 'true')
                ?? [...document.querySelectorAll('t-select[data-host-form-primitive="select"]')].find(item => item.getClientRects().length > 0)
              if (select === undefined) return null
              const tokens = getComputedStyle(select)
              const shadowSurfaces = select.shadowRoot === null ? [] : [...select.shadowRoot.querySelectorAll('*')]
                .map(item => ({
                  tag: item.tagName.toLowerCase(), className: item.className,
                  background: getComputedStyle(item).backgroundColor, color: getComputedStyle(item).color,
                }))
                .filter(item => item.background !== 'rgba(0, 0, 0, 0)' && item.background !== 'transparent')
                .slice(0, 8)
              return {
                tabIndex: select.tabIndex,
                ariaExpanded: select.getAttribute('aria-expanded'),
                adapterExpanded: select.getAttribute('data-popup-visible'),
                officialPopupVisible: select.popupVisible ?? null,
                shadowText: select.shadowRoot?.textContent?.trim().slice(0, 120) ?? null,
                containerToken: tokens.getPropertyValue('--td-bg-color-container').trim(),
                specialToken: tokens.getPropertyValue('--td-bg-color-specialcomponent').trim(),
                selectedToken: tokens.getPropertyValue('--td-bg-color-container-select').trim(),
                colorScheme: tokens.colorScheme,
                shadowSurfaces,
              }
            })(),
          },
          hostCollections: [...document.querySelectorAll('[data-host-collection]')].map(collection => {
            const list = collection.querySelector('.cxc-list')
            const cards = [...collection.querySelectorAll('.cxc-card')]
            const action = collection.querySelector('.cxc-action:not(:disabled), .cxc-menu-trigger:not(:disabled)')
            const actionStyle = action === null ? null : getComputedStyle(action.closest('.cxc-actions'))
            const actionsRestOpacity = actionStyle?.opacity ?? null
            const listStyle = list === null ? null : getComputedStyle(list)
            const cardRects = cards.map(card => card.getBoundingClientRect())
            const rowTops = [...new Set(cardRects.filter(rect => rect.width > 0).map(rect => Math.round(rect.top)))]
            const firstRowTop = rowTops[0]
            let actionsFocusOpacity = null
            let actionsFocusWithin = null
            let actionsFocusPointerEvents = null
            if (action instanceof HTMLElement) {
              const previous = document.activeElement
              const actionLayer = action.closest('.cxc-actions')
              const previousTransition = actionLayer instanceof HTMLElement ? actionLayer.style.transition : ''
              if (actionLayer instanceof HTMLElement) actionLayer.style.transition = 'none'
              action.focus()
              const focusedStyle = getComputedStyle(actionLayer)
              actionsFocusOpacity = focusedStyle.opacity
              actionsFocusPointerEvents = focusedStyle.pointerEvents
              actionsFocusWithin = action.closest('.cxc-card')?.matches(':focus-within') ?? false
              if (previous instanceof HTMLElement) previous.focus()
              else action.blur()
              if (actionLayer instanceof HTMLElement) actionLayer.style.transition = previousTransition
            }
            return {
              id: collection.getAttribute('data-host-collection'),
              search: collection.querySelector('.cxc-search-input') !== null,
              chevrons: collection.querySelectorAll('.cxm-chevron').length,
              itemCount: collection.querySelectorAll('[data-collection-item]').length,
              visibleColumns: firstRowTop === undefined ? 0 : cardRects.filter(rect => Math.round(rect.top) === firstRowTop).length,
              cardWidths: [...new Set(cardRects.filter(rect => rect.width > 0).map(rect => Math.round(rect.width)))],
              gridTemplateColumns: listStyle?.gridTemplateColumns ?? null,
              actionsPosition: actionStyle?.position ?? null,
              actionsRestOpacity,
              actionsFocusOpacity,
              actionsFocusWithin,
              actionsFocusPointerEvents,
              primaryButtons: collection.querySelectorAll('.cxc-primary[data-collection-open]').length,
              items: cards.map(card => ({
                title: card.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: card.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                machineId: card.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
              })),
              primaryDeveloperInternals: [
                'ctx.',
                'outlet',
                'session.content',
                'manager.settings.',
                'body-only',
                'Host chrome',
                'schemaVersion',
                'verificationPolicy',
              ].filter(token => {
                const primaryText = [
                  collection.textContent ?? '',
                  ...[...collection.querySelectorAll('input')].map(input => input.getAttribute('placeholder') ?? ''),
                ].join(' ')
                return primaryText.includes(token)
              }),
            }
          }),
          extensionPointCatalog: document.querySelector('[aria-label="扩展点列表"]') === null ? null : {
            locale: document.documentElement.lang,
            rows: [...document.querySelectorAll('[aria-label="扩展点列表"] [data-extension-point-id]')].map(row => {
              const rect = row.getBoundingClientRect()
              const status = row.querySelector('.cxc-status')
              const statusRect = status?.getBoundingClientRect()
              return {
                id: row.getAttribute('data-extension-point-id'),
                state: row.getAttribute('data-extension-point-state'),
                title: row.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                stableId: row.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                hostIcon: row.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null,
                status: status?.textContent?.trim() ?? null,
                typeOrNormalTag: [...row.querySelectorAll('.cxm-kind-badge')].map(item => item.textContent?.trim() ?? ''),
                statusInsidePrimaryRow: statusRect === undefined || (statusRect.top >= rect.top && statusRect.bottom <= rect.bottom),
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
          routePageCatalog: document.querySelector('[data-host-collection="routes"], [data-host-collection^="plugin-routes-"]') === null ? null : (() => {
            const panel = document.querySelector('.cxm-content')
            const collection = document.querySelector('[data-host-collection="routes"], [data-host-collection^="plugin-routes-"]')
            const rows = [...(collection?.querySelectorAll('[data-route-product-row], [data-page-product-row]') ?? [])].map(row => {
              const rect = row?.getBoundingClientRect()
              return {
                kind: row?.hasAttribute('data-route-product-row') === true ? 'route' : 'page',
                id: row?.getAttribute('data-route-product-row') ?? row?.getAttribute('data-page-product-row'),
                title: row?.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row?.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                ariaLabel: row?.getAttribute('aria-label') ?? null,
                hostIcon: row?.querySelector('[data-material-icon]')?.getAttribute('data-material-icon') ?? null,
                machineId: row?.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                status: row?.querySelector('.cxc-status')?.getAttribute('aria-label') ?? null,
                chevron: row?.querySelector('.cxm-chevron') !== null,
                tags: row?.querySelectorAll('.cxm-kind-badge,.cxm-badge,.cxm-status').length ?? 0,
                horizontalOverflow: row instanceof HTMLElement ? row.scrollWidth > row.clientWidth + 1 : null,
                insidePanel: rect === undefined || panel === null ? null : (() => {
                  const panelRect = panel.getBoundingClientRect()
                  return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1
                })(),
              }
            })
            return {
              locale: document.documentElement.lang,
              pageRoute: document.querySelector('[data-manager-page-route]')?.getAttribute('data-manager-page-route') ?? null,
              listRole: collection?.querySelector('.cxc-list')?.getAttribute('role') ?? null,
              rowCount: rows.length,
              rows,
              fallbackPlaceholderVisible: (panel?.textContent ?? '').includes('受控页面 mount'),
              contentHorizontalOverflow: panel instanceof HTMLElement ? panel.scrollWidth > panel.clientWidth + 1 : null,
              search: (() => {
                const input = document.querySelector('input[type="search"]')
                return input === null ? null : {
                  ariaLabel: input.getAttribute('aria-label'),
                  placeholder: input.getAttribute('placeholder'),
                }
              })(),
            }
          })(),
          marketplaceCatalog: document.querySelector('[aria-label="插件商店列表"]') === null ? null : {
            locale: document.documentElement.lang,
            permanentTrustWarning: (document.querySelector('.cxm-content')?.textContent ?? '').includes('商店收录、schema 校验和页面展示都不代表'),
            sourceConfigured: marketplaceSourceConfigured,
            certifiedOnly: document.querySelector('[data-marketplace-certified-only]')?.getAttribute('aria-pressed') ?? null,
            fixedChrome: (() => {
              const content = document.querySelector('.cxm-content')
              const discovery = document.querySelector('[data-marketplace-discovery-page]')
              const tools = discovery?.querySelector('.cxm-marketplace-discovery-tools')
              const toolbar = tools?.querySelector('.cxm-toolbar')
              const search = toolbar?.querySelector('.cxc-search')
              const filters = tools?.querySelector('.cxm-marketplace-filter-row')
              const results = discovery?.querySelector('[data-marketplace-results-scroll]')
              const list = results?.querySelector('.cxc-list')
              const sourceMenu = toolbar?.querySelector('[data-marketplace-source-menu]')
              return {
                discoveryMode: content?.getAttribute('data-marketplace-discovery') ?? null,
                contentOverflowY: content === null ? null : getComputedStyle(content).overflowY,
                resultsOverflowY: results === null || results === undefined ? null : getComputedStyle(results).overflowY,
                listOverflowY: list === null || list === undefined ? null : getComputedStyle(list).overflowY,
                searchBeforeSourceMenu: search !== null && search !== undefined && sourceMenu !== null && sourceMenu !== undefined
                  ? Boolean(search.compareDocumentPosition(sourceMenu) & Node.DOCUMENT_POSITION_FOLLOWING)
                  : false,
                filtersBelowSearch: search !== null && search !== undefined && filters !== null && filters !== undefined
                  ? filters.getBoundingClientRect().top >= search.getBoundingClientRect().bottom - 1
                  : false,
                documentationButtons: [...(discovery?.querySelectorAll('a,button') ?? [])]
                  .filter(item => item.textContent?.includes('文档')).length,
                sourceManagementRight: sourceMenu !== null && sourceMenu !== undefined,
              }
            })(),
            primaryDeveloperInternals: [...document.querySelectorAll('[aria-label="插件商店列表"] .cxc-card')]
              .flatMap(card => ['schemaVersion', 'integrity', 'ranking', 'outlet', 'mount', 'verificationPolicy']
                .filter(token => (card.textContent ?? '').includes(token))),
            rows: [...document.querySelectorAll('[aria-label="插件商店列表"] [data-marketplace-plugin]')].map(row => {
              const primary = row.querySelector('.cxc-primary')
              const style = primary === null ? null : getComputedStyle(primary)
              return {
                id: row.getAttribute('data-marketplace-plugin'),
                role: row.getAttribute('role'),
                primaryButton: primary?.matches('button') ?? false,
                padding: style === null ? null : [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
                name: row.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                machineId: row.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                official: row.getAttribute('data-marketplace-official'),
                certified: row.getAttribute('data-marketplace-certified'),
                rankingTier: row.getAttribute('data-marketplace-ranking-tier'),
                rankingTrustBoost: row.getAttribute('data-marketplace-ranking-trust-boost'),
                rankingExplanation: row.getAttribute('data-marketplace-ranking-explanation'),
                badges: [...row.querySelectorAll('[data-trust-dimension]')].map(badge => ({
                  dimension: badge.getAttribute('data-trust-dimension'),
                  label: badge.textContent?.trim() ?? null,
                  ariaLabel: badge.getAttribute('aria-label'),
                  icon: badge.querySelector('[data-material-icon]')?.getAttribute('data-material-icon') ?? null,
                })),
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
          marketplaceTrustDetail: document.querySelector('[data-marketplace-trust-dimension]') === null ? null : {
            dimensions: [...document.querySelectorAll('[data-marketplace-trust-dimension]')].map(item => ({
              dimension: item.getAttribute('data-marketplace-trust-dimension'),
              text: item.textContent?.trim() ?? null,
              evidence: item.querySelector('a')?.href ?? null,
            })),
            boundary: document.querySelector('[data-marketplace-trust-boundary]')?.textContent?.trim() ?? null,
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
  if (managerTab === 'marketplace') {
    const marketplaceState = managerReport?.marketplace
    const requestedView = managerMarketplaceView ?? 'discovery'
    if (marketplaceState?.view !== requestedView) {
      throw new Error(`Marketplace smoke opened the wrong view: ${JSON.stringify(marketplaceState)}`)
    }
    if (requestedView === 'discovery') {
      const discovery = marketplaceState.discovery
      if (discovery?.onlyResultsScroll !== true
        || discovery.filterBelowSearch !== true
        || discovery.documentationPrimaryActionAbsent !== true
        || discovery.fullWidth !== true) {
        throw new Error(`Marketplace discovery IA assertions failed: ${JSON.stringify(discovery)}`)
      }
    } else {
      const sources = marketplaceState.sources
      if (sources?.manualReloadAbsent !== true
        || sources.topLevelSettingsTabAbsent !== true
        || sources.formFullWidth === false
        || sources.untouchedErrorAbsent !== true
        || sources.nativeUrlErrorAbsent !== true
        || sources.primaryDeveloperTermsAbsent !== true
        || (requestedView === 'sources' && sources.officialPresent !== true)) {
        throw new Error(`Marketplace source IA assertions failed: ${JSON.stringify(sources)}`)
      }
      if (requestedView === 'sources' && parsed.values['manager-marketplace-open-menu']
        && sources.officialDeleteDisabled !== true) {
        throw new Error(`Marketplace official source delete boundary failed: ${JSON.stringify(sources)}`)
      }
      if (parsed.values['manager-marketplace-clipboard-exercise']) {
        const imported = sources.clipboardImport
        if (imported?.rowPresent !== true
          || imported.title !== '剪贴板团队来源'
          || imported.description !== '从结构化来源描述导入。'
          || imported.machineId !== managerMarketplaceSource
          || imported.local?.name !== '剪贴板团队来源'
          || imported.local?.description !== '从结构化来源描述导入。'
          || imported.local?.note !== '真实 app:// smoke'
          || imported.noticeVisible !== true) {
          throw new Error(`Marketplace clipboard/local override assertions failed: ${JSON.stringify(imported)}`)
        }
      }
    }
    if (parsed.values['manager-marketplace-open-menu']) {
      const menu = marketplaceState.menu
      if (menu?.portaled !== true || menu.bounded !== true || menu.firstItemFocused !== true || menu.theme !== menu.managerTheme
        || menu.keyboard?.arrowMoved !== true || menu.keyboard.closed !== true
        || menu.keyboard.focusRestored !== true || menu.keyboard.reopened !== true) {
        throw new Error(`Marketplace menu portal assertions failed: ${JSON.stringify(menu)}`)
      }
    }
  }
  if (parsed.values['channel-data-plane']) {
    const channel = managerReport?.channelDataPlane
    const channelLocale = channel?.locale
    const channelNavigationTitle = channelLocale === 'zh-CN' ? '渠道配置' : 'Channel settings'
    if (channel?.plugin?.status !== 'active'
      || channel.plugin.schemaKind !== 'none'
      || channel.plugin.configFields !== 0
      || channel.registration?.valid !== true
      || channel.registration.pending !== false
      || channel.registration.visible !== true
      || channel.registration.authorized !== true
      || channel.registration.group !== 'after-settings'
      || channel.registration.routeId !== 'settings'
      || channel.route?.valid !== true
      || channel.route.outlet !== 'manager.content'
      || channel.route.path !== '/manager/extensions/channels'
      || channel.route.page !== 'settings'
      || channel.route.diagnostics !== 0
      || channel.page?.chrome !== 'standard'
      || channel.page.icon !== 'host:layers'
      || channel.page.diagnostics !== 0
      || channel.outlet?.available !== true
      || channel.outlet.mounted !== true
      || !['channel:settings', 'channel:configuration', 'channel:runtime', 'channel:logs', 'channel:sessions', 'channel:create'].includes(channel.outlet.activeRoute)
      || channel.navigationItem?.label !== channelNavigationTitle
      || channel.navigationItem.icon !== 'host:layers'
      || typeof channel.pageTitle !== 'string' || channel.pageTitle.trim() === ''
      || channel.mounted !== true) {
      throw new Error(`Channel data-plane smoke assertions failed: ${JSON.stringify(channel)}`)
    }
    if (parsed.values['channel-manager-exercise'] && (channel.managerFlow?.list !== true
      || channel.managerFlow.create !== true
      || channel.managerFlow.searched !== true
      || channel.managerFlow.card !== true
      || channel.managerFlow.configuration !== true
      || channel.managerFlow.tabs?.join(',') !== 'configuration,runtime,logs,sessions'
      || channel.managerFlow.runtimeAvailable !== true
      || channel.managerFlow.logsAvailable !== true
      || channel.managerFlow.sessionsAvailable !== true
      || channel.managerFlow.logControlsPresent !== true
      || (channel.managerFlow.logsEmpty === true && channel.managerFlow.logExportDisabled !== true)
      || (channel.managerFlow.bindingActionCount !== 3 && channel.managerFlow.sessionEmpty !== true)
      || channel.managerFlow.hostHeading !== channel.managerFlow.expectedHeading
      || channel.managerFlow.nestedChannelChrome !== false
      || channel.managerFlow.hostTabs !== true
      || channel.managerFlow.managerFontSize !== channel.managerFlow.channelFontSize
      || channel.managerFlow.returnedToList !== true
      || channel.managerFlow.secretRendered !== false)) {
      throw new Error(`Channel Manager flow smoke assertions failed: ${JSON.stringify(channel.managerFlow)}`)
    }
    if (parsed.values['channel-manager-existing-account'] && (channel.existingAccount?.list !== true
      || channel.existingAccount.detail !== true || channel.existingAccount.form !== true
      || channel.existingAccount.configurationAvailable !== true
      || !['true', 'false'].includes(channel.existingAccount.switchValue)
      || channel.existingAccount.switchPropsValue !== channel.existingAccount.switchValue
      || channel.existingAccount.switchAriaChecked !== channel.existingAccount.switchValue
      || channel.existingAccount.runtimeAvailable !== true
      || channel.existingAccount.runtimeActionCount !== 3
      || channel.existingAccount.runtimeActionsEnabled !== true
      || channel.existingAccount.logsAvailable !== true
      || channel.existingAccount.logsControlsPresent !== true
      || (channel.existingAccount.logsEmpty === true && channel.existingAccount.logExportDisabled !== true)
      || channel.existingAccount.sessionsAvailable !== true
      || (channel.existingAccount.bindingActionCount !== 3 && channel.existingAccount.sessionEmpty !== true)
      || channel.existingAccount.secretRendered !== false)) {
      throw new Error(`Channel existing-account smoke assertions failed: ${JSON.stringify(channel.existingAccount)}`)
    }
    if (parsed.values['channel-manager-existing-account-save'] && channel.existingAccount?.saved !== true) {
      throw new Error(`Channel existing-account save smoke assertions failed: ${JSON.stringify(channel.existingAccount)}`)
    }
  }
  if (managerPlugin === 'cli-proxy-api' && managerDetailTab === 'config') {
    const serviceConfigs = managerReport?.serviceConfigs?.find(config => config.pluginId === 'cli-proxy-api')?.services
    if (!Array.isArray(serviceConfigs) || serviceConfigs.length !== 2
      || serviceConfigs.some(config => config.fullWidth !== 'true' || config.nativeSelects !== 0
        || config.nestedControlChrome !== false || config.stickyFooter !== false || config.orphanedFooter !== false)) {
      managerServiceConfigurationFailure = `CLIProxy Provider detail form assertions failed: ${JSON.stringify(managerReport?.serviceConfigs)}`
    }
  }
  if (managerTab === 'about') {
    const aboutState = async () => await evaluateByValue(`(() => {
      const action = document.querySelector('.cxm-about-action')
      const item = action?.closest('.cxm-about-action-item')
      const actions = action?.closest('.cxm-about-actions')
      const title = action?.querySelector('.cxm-about-action-title')
      const copy = action?.querySelector('.cxm-about-action-copy')
      const arrow = action?.querySelector('.cxm-about-action-arrow')
      if (!(action instanceof HTMLAnchorElement) || !(item instanceof HTMLElement) || !(actions instanceof HTMLElement)
        || !(title instanceof HTMLElement) || !(copy instanceof HTMLElement) || !(arrow instanceof HTMLElement)) return null
      const rect = action.getBoundingClientRect()
      const itemRect = item.getBoundingClientRect()
      const style = element => getComputedStyle(element)
      const simpleRect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height })
      const leftTarget = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2)
      const rightTarget = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2)
      return {
        rect: simpleRect(rect), itemRect: simpleRect(itemRect),
        hovered: action.matches(':hover'), focused: document.activeElement === action,
        focusVisible: action.matches(':focus-visible'),
        anchorBackground: style(action).backgroundColor,
        anchorOutline: style(action).outlineColor,
        anchorOutlineOffset: style(action).outlineOffset,
        titleColor: style(title).color, titleBackground: style(title).backgroundColor,
        copyColor: style(copy).color, copyBackground: style(copy).backgroundColor,
        arrowColor: style(arrow).color,
        wholeRowHitTarget: action.contains(leftTarget) && action.contains(rightTarget),
        rowOwnsTextAndIcon: action.contains(title) && action.contains(copy) && action.contains(arrow),
        fillsItem: Math.abs(rect.width - itemRect.width) <= 1,
        horizontalOverflow: actions.scrollWidth > actions.clientWidth + 1 || action.scrollWidth > action.clientWidth + 1,
        separatorColor: style(item).borderTopColor,
        containerBorder: [style(actions).borderTopColor, style(actions).borderBottomColor],
      }
    })()`)
    const rest = await aboutState()
    if (rest === null) throw new Error('manager About action row is unavailable')
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: rest.rect.x + rest.rect.width / 2, y: rest.rect.y + rest.rect.height / 2, pointerType: 'mouse',
    })
    await evaluateByValue(`new Promise(resolve => setTimeout(resolve, 120))`, true)
    const hover = await aboutState()
    await evaluateByValue(`(() => { document.querySelector('.cxm-about-action')?.focus(); return true })()`)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
    })
    await evaluateByValue(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true)
    const focus = await aboutState()
    const transparent = value => value === 'transparent' || value === 'rgba(0, 0, 0, 0)'
    const sameRect = (left, right) => left !== null && right !== null
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(left.rect[key] - right.rect[key]) <= 0.5)
    const passed = hover?.hovered === true
      && hover.anchorBackground !== rest.anchorBackground
      && transparent(rest.titleBackground) && transparent(rest.copyBackground)
      && transparent(hover.titleBackground) && transparent(hover.copyBackground)
      && hover.arrowColor !== rest.arrowColor
      && hover.wholeRowHitTarget === true && hover.rowOwnsTextAndIcon === true && hover.fillsItem === true
      && hover.horizontalOverflow === false && sameRect(rest, hover)
      && focus?.focused === true && focus.focusVisible === true
      && focus.anchorBackground === hover.anchorBackground
      && focus.titleBackground === hover.titleBackground && focus.copyBackground === hover.copyBackground
      && hover.separatorColor === rest.separatorColor
      && JSON.stringify(hover.containerBorder) === JSON.stringify(rest.containerBorder)
    managerReport = { ...managerReport, aboutInteraction: { rest, hover, focus, passed } }
    if (!passed) throw new Error('manager About whole-row hover/focus exercise failed')
  }
  if (parsed.values['manager-form-exercise']) {
    // The initial manager projection is intentionally captured before the
    // interaction.  It may be below the current viewport, so never reuse its
    // old (and possibly negative) rect for a physical pointer event.
    const formControl = await evaluateByValue(`(async () => {
      const control = [...document.querySelectorAll('t-input[id], t-textarea[id], t-select[id], input[id], textarea[id], select[id]')]
        .find(item => item instanceof HTMLElement && item.getClientRects().length > 0
          && !item.matches(':disabled,[aria-disabled="true"]'))
      if (!(control instanceof HTMLElement)) return null
      control.scrollIntoView({ block: 'center', inline: 'nearest' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const rect = control.getBoundingClientRect()
      return {
        id: control.id || null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        inViewport: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
          && rect.right <= innerWidth && rect.bottom <= innerHeight,
      }
    })()`, true)
    const firstRect = formControl?.rect
    if (firstRect === undefined || firstRect === null || formControl.inViewport !== true) {
      managerReport = { ...managerReport, hostFormInteraction: { pointer: null, keyboard: null, passed: false } }
      managerFormExerciseFailure = 'manager form exercise found no visible focusable Host form control'
    } else {
      await pointerClick(firstRect)
      const pointer = await evaluateByValue(`(() => {
      const focusPath = []
      let active = document.activeElement
      while (active instanceof HTMLElement) {
        focusPath.push({ tag: active.tagName.toLowerCase(), id: active.id || null, role: active.getAttribute('role') })
        const nested = active.shadowRoot?.activeElement
        if (!(nested instanceof HTMLElement)) break
        active = nested
      }
      return {
        primitive: document.activeElement?.getAttribute('data-host-form-primitive') ?? null,
        id: document.activeElement?.id ?? null,
        focusPath,
      }
      })()`)
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      })
      const keyboard = await evaluateByValue(`(() => {
      const focusPath = []
      let active = document.activeElement
      while (active instanceof HTMLElement) {
        focusPath.push({ tag: active.tagName.toLowerCase(), id: active.id || null, role: active.getAttribute('role') })
        const nested = active.shadowRoot?.activeElement
        if (!(nested instanceof HTMLElement)) break
        active = nested
      }
      return {
        primitive: document.activeElement?.getAttribute('data-host-form-primitive') ?? null,
        id: document.activeElement?.id ?? null,
        tag: document.activeElement?.tagName.toLowerCase() ?? null,
        focusPath,
      }
      })()`)
      managerReport = { ...managerReport, hostFormInteraction: {
        target: formControl, pointer, keyboard,
        passed: formControl.inViewport === true && pointer.id !== null && keyboard.tag !== 'body'
          && (keyboard.id !== pointer.id || JSON.stringify(keyboard.focusPath) !== JSON.stringify(pointer.focusPath)),
      } }
      if (managerReport.hostFormInteraction.passed !== true) managerFormExerciseFailure = 'manager Host form mouse/keyboard exercise failed'
    }
    console.log(`manager-form-interaction=${JSON.stringify(managerReport.hostFormInteraction)}`)
  }
  console.log(`manager-state=${JSON.stringify(managerReport)}`)
  try {
    await capture(managerResult?.rect ?? null, parsed.values['manager-screenshot'], 'CordisX manager')
  } finally {
    if (parsed.values['manager-open-local-path-form']) {
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.cxm-lifecycle-dialog .cxf-actions t-button:first-child')?.click()`,
        returnByValue: true,
      })
    }
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
    if (managerViewportWidth !== undefined && !parsed.values['manager-theme-cycle']) await send('Emulation.clearDeviceMetricsOverride')
  }
}

let managerThemeReport
if (parsed.values['manager-theme-cycle']) {
  const inspectManagerTheme = async (theme, reopen) => {
    const evaluated = await send('Runtime.evaluate', {
      expression: `(async () => {
        const root = document.documentElement
        if (${JSON.stringify(theme === 'light')}) globalThis.__cordisxRestoreSmokeTheme?.()
        globalThis.__cordisxRestoreManagerThemeSmoke ??= {
          className: root.className,
          dataTheme: root.getAttribute('data-theme'),
        }
        const trigger = document.querySelector('[data-cordisx-manager-trigger]')
        const modal = document.querySelector('[data-cordisx-manager-modal]')
        if (modal === null) return null
        root.classList.remove('electron-dark', 'electron-light')
        root.classList.add(${JSON.stringify(theme === 'light' ? 'electron-light' : 'electron-dark')})
        root.setAttribute('data-theme', ${JSON.stringify(theme)})
        if (${reopen} && !modal.hidden) document.querySelector('.cxm-close')?.click()
        if (modal.hidden && trigger !== null) trigger.click()
        else if (modal.hidden) modal.hidden = false
        const themePluginId = ${JSON.stringify(parsed.values['manager-plugin'])}
        const themeDetailTab = ${JSON.stringify(parsed.values['manager-detail-tab'])}
        if (themePluginId === undefined) {
          if (!${JSON.stringify(parsed.values['manager-open-select'])}) document.querySelector('[data-tab="about"]')?.click()
        } else {
          document.querySelector('[data-tab="plugins"]')?.click()
          await new Promise(resolve => requestAnimationFrame(resolve))
          const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
            .find(item => item.getAttribute('data-plugin-id') === themePluginId || item.getAttribute('data-marketplace-plugin') === themePluginId)
          ;(row?.matches('button') === true ? row : row?.querySelector('.cxm-plugin-primary'))?.click()
          await new Promise(resolve => requestAnimationFrame(resolve))
          if (themeDetailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + themeDetailTab + '"]')?.click()
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 120)
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
        })
        const projectionDeadline = Date.now() + 2_000
        while (modal.dataset.cordisxAppTheme !== ${JSON.stringify(theme)} && Date.now() < projectionDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (modal.dataset.cordisxAppTheme !== ${JSON.stringify(theme)}) {
          throw new Error('Host theme projection did not reach ${theme}')
        }
        if (${JSON.stringify(parsed.values['manager-open-select'])}) {
          // Closing the Manager deliberately clears its detail route. Reopen
          // the same structured Host route before checking the portaled
          // control, rather than treating a stale DOM node as evidence.
          const pluginId = ${JSON.stringify(parsed.values['manager-plugin'])}
          const detailTab = ${JSON.stringify(parsed.values['manager-detail-tab'])}
          const permissionCapability = ${JSON.stringify(parsed.values['manager-permission-capability'])}
          if (pluginId !== undefined) {
            document.querySelector('[data-tab="plugins"]')?.click()
            await new Promise(resolve => requestAnimationFrame(resolve))
            const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
              .find(item => item.getAttribute('data-plugin-id') === pluginId || item.getAttribute('data-marketplace-plugin') === pluginId)
            ;(row?.matches('button') === true ? row : row?.querySelector('.cxc-primary'))?.click()
            await new Promise(resolve => requestAnimationFrame(resolve))
            if (detailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
            if (permissionCapability !== undefined) document.querySelector('[data-permission-open="' + CSS.escape(permissionCapability) + '"]')?.click()
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          }
          const select = [...document.querySelectorAll('t-select[data-host-form-primitive="select"]')]
            .find(item => item.getClientRects().length > 0)
          if (!(select instanceof HTMLElement)) throw new Error('visible TDesign Select is unavailable after theme projection')
          if (select.getAttribute('aria-expanded') !== 'true') {
            select.focus()
            select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          }
        }
        const dialog = modal.querySelector('[role="dialog"]')
        const marks = [...modal.querySelectorAll('img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]')]
        const navIcon = document.querySelector('[data-tab="plugins"] .cxm-nav-icon')
        const headingIcon = document.querySelector('.cxm-heading-leading')
        const popup = [...document.querySelectorAll('[data-cxf-tdesign-portal-host]')]
          .map(host => host.shadowRoot?.querySelector('.cxf-tdesign-listbox:not([hidden])'))
          .find(item => item instanceof HTMLElement)
        const visibleSelect = [...document.querySelectorAll('t-select[data-host-form-primitive="select"]')]
          .find(item => item.getClientRects().length > 0)
        return {
          rect: dialog === null ? null : (() => {
            const rect = dialog.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })(),
          systemTheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
          appTheme: modal.dataset.cordisxAppTheme ?? null,
          themeSource: modal.dataset.cordisxThemeSource ?? null,
          modalHidden: modal.hidden,
          navIconColor: navIcon === null ? null : getComputedStyle(navIcon).color,
          headingIconColor: headingIcon === null ? null : getComputedStyle(headingIcon).color,
          selectControl: visibleSelect instanceof HTMLElement ? (() => {
            const tokens = getComputedStyle(visibleSelect)
            const shadowSurfaces = visibleSelect.shadowRoot === null ? [] : [...visibleSelect.shadowRoot.querySelectorAll('*')]
              .map(item => ({
                tag: item.tagName.toLowerCase(), className: item.className,
                background: getComputedStyle(item).backgroundColor, color: getComputedStyle(item).color,
              }))
              .filter(item => item.background !== 'rgba(0, 0, 0, 0)' && item.background !== 'transparent')
              .slice(0, 8)
            return {
              containerToken: tokens.getPropertyValue('--td-bg-color-container').trim(),
              specialToken: tokens.getPropertyValue('--td-bg-color-specialcomponent').trim(),
              selectedToken: tokens.getPropertyValue('--td-bg-color-container-select').trim(),
              colorScheme: tokens.colorScheme,
              shadowSurfaces,
            }
          })() : null,
          selectPopup: popup instanceof HTMLElement ? {
            background: getComputedStyle(popup).backgroundColor,
            color: getComputedStyle(popup).color,
            optionCount: popup.querySelectorAll('t-option[data-tdesign-version="1.2.10"]').length,
            activeOption: (() => {
              const option = popup.querySelector('t-option[data-active="true"]')
              const surface = option?.shadowRoot?.querySelector('.t-select-option, [part], div') ?? option
              const style = surface instanceof Element ? getComputedStyle(surface) : null
              const tokens = option instanceof Element ? getComputedStyle(option) : null
              return option === null ? null : {
                selected: option.getAttribute('aria-selected'),
                background: style?.backgroundColor ?? null,
                color: style?.color ?? null,
                selectedToken: tokens?.getPropertyValue('--td-bg-color-container-select').trim() ?? null,
                activeToken: tokens?.getPropertyValue('--td-bg-color-container-active').trim() ?? null,
                hoverToken: tokens?.getPropertyValue('--td-bg-color-container-hover').trim() ?? null,
                disabledToken: tokens?.getPropertyValue('--td-bg-color-component-disabled').trim() ?? null,
              }
            })(),
          } : null,
          marks: marks.map(mark => ({
            background: mark.dataset.hostBackground ?? null,
            lightAsset: decodeURIComponent(mark.src).includes('CordisX mark for light backgrounds'),
            darkAsset: decodeURIComponent(mark.src).includes('CordisX mark for dark backgrounds'),
            selectable: getComputedStyle(mark).userSelect,
            draggable: mark.draggable,
            ariaHidden: mark.getAttribute('aria-hidden'),
          })),
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evaluated.exceptionDetails !== undefined) {
      throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'manager theme evaluation failed')
    }
    return evaluated.result?.value ?? null
  }

  const light = await inspectManagerTheme('light', false)
  if (parsed.values['manager-light-screenshot'] !== undefined) {
    await capture(light?.rect ?? null, parsed.values['manager-light-screenshot'], 'CordisX Manager light theme')
  }
  const darkReopened = await inspectManagerTheme('dark', true)
  if (parsed.values['manager-dark-screenshot'] !== undefined) {
    await capture(darkReopened?.rect ?? null, parsed.values['manager-dark-screenshot'], 'CordisX Manager dark theme')
  }
  managerThemeReport = { light, darkReopened }
  console.log(`manager-theme=${JSON.stringify(managerThemeReport)}`)
  await send('Runtime.evaluate', {
    expression: `(() => {
      const root = document.documentElement
      const previous = globalThis.__cordisxRestoreManagerThemeSmoke
      if (previous !== null && typeof previous === 'object') {
        root.className = previous.className
        if (previous.dataTheme === null) root.removeAttribute('data-theme')
        else root.setAttribute('data-theme', previous.dataTheme)
      }
      delete globalThis.__cordisxRestoreManagerThemeSmoke
    })()`,
  })
  if (parsed.values['manager-viewport-width'] !== undefined) await send('Emulation.clearDeviceMetricsOverride')
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
  if (generationReport.cleaned !== true) throw new Error(`generation cleanup smoke assertions failed: ${JSON.stringify(generationReport)}`)
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
    ...(runtimeExceptions.length === 0 ? {} : { runtimeExceptions }),
    ...(localeProjection === undefined ? {} : { localeProjection }),
    interactionSafety,
    ...(managerReport === undefined ? {} : { manager: managerReport }),
    ...(managerThemeReport === undefined ? {} : { managerTheme: managerThemeReport }),
    ...(hostCollectionMenuReport === undefined ? {} : { hostCollectionMenu: hostCollectionMenuReport }),
    ...(exerciseReport === undefined ? {} : { exercise: exerciseReport }),
    ...(settingsTabsReport === undefined ? {} : { managerSettings: settingsTabsReport }),
    ...(configExerciseReport === undefined ? {} : { pluginConfiguration: configExerciseReport }),
    ...(demoReport === undefined ? {} : { agentTraceDemo: demoReport }),
    ...(pluginLifecycleReport === undefined ? {} : { pluginLifecycle: pluginLifecycleReport }),
    ...(pluginConsoleReport === undefined ? {} : { pluginConsole: pluginConsoleReport }),
    ...(authorizationReport === undefined ? {} : { authorization: authorizationReport }),
    ...(managerLifecycleReport === undefined ? {} : { managerLifecycle: managerLifecycleReport }),
    ...(permissionV2Report === undefined ? {} : { permissionV2: permissionV2Report }),
    ...(generationTransactionReport === undefined ? {} : { generationTransaction: generationTransactionReport }),
    ...(uiCatalogReport === undefined ? {} : { uiCatalog: uiCatalogReport }),
    ...(generationReport === undefined ? {} : { generation: generationReport }),
  }
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`)
  console.log(`report=${reportPath}`)
}

if (locale !== undefined) {
  await send('Runtime.evaluate', {
    expression: 'globalThis.__cordisxRestoreSmokeLocale?.()',
  })
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
if (permissionV2Report?.result === 'fail') {
  throw new Error('permission v2 smoke assertions failed; inspect the aggregated report')
}
if (interactionSafety.pendingPermissionDialogs !== 0 || interactionSafety.pendingLifecycleDialogs !== 0) {
  throw new Error('live smoke left an interactive permission or lifecycle dialog open')
}
if (managerFormExerciseFailure !== undefined) throw new Error(managerFormExerciseFailure)
if (managerServiceConfigurationFailure !== undefined) throw new Error(managerServiceConfigurationFailure)
if (pluginConsoleAssertions !== undefined) {
  const failures = Object.entries(pluginConsoleAssertions)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)
  if (failures.length > 0) throw new Error(`plugin Console smoke assertions failed: ${failures.join(', ')}`)
}
