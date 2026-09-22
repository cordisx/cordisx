'use strict'

const { readFileSync } = require('node:fs')

// Installed at the owned main process' inspect-brk boundary before the Host's
// first application line can show a BrowserWindow.

let installed = false
let gated = true
let ownerPID = 0
let app
let BrowserWindow
let originalShow
let originalShowInactive
let originalHide
let originalFocus
let originalRestore
let originalSetOpacity
let ipcMain
let originalIpcHandle
let rendererMessageHandlerInstalled = false
const tracked = new Set()
const requested = new Set()
const requestedOpacity = new Map()
const rendererReady = new Set()
const rendererPaintPending = new Set()
let nativeContentReady = false
let nativeContentReadyResolve
const nativeContentReadyPromise = new Promise(resolve => {
  nativeContentReadyResolve = resolve
})
let releasePoll

const RENDERER_MESSAGE_CHANNEL = 'codex_desktop:message-from-view'
// The Host's primary renderer sends `ready` after its route tree mounts, then
// advances first_content_visible after two visible animation frames. Mirror
// that public Electron paint boundary without reading React state or DOM shape.
const PAINT_READY_EXPRESSION = `new Promise(resolve => {
  if (document.visibilityState !== 'visible') return resolve(false)
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.visibilityState === 'visible')))
})`

function restoreIpcHandle() {
  if (ipcMain && originalIpcHandle && ipcMain.handle !== originalIpcHandle) ipcMain.handle = originalIpcHandle
}

function markNativeContentReady(window) {
  if (
    nativeContentReady || !window || window.isDestroyed() || !requested.has(window)
    || !rendererReady.has(window.webContents)
  ) return
  const webContents = window.webContents
  if (!webContents || webContents.isDestroyed?.() || rendererPaintPending.has(webContents)) return
  rendererPaintPending.add(webContents)
  Promise.resolve(webContents.executeJavaScript(PAINT_READY_EXPRESSION, true)).then(painted => {
    rendererPaintPending.delete(webContents)
    if (
      painted !== true || nativeContentReady || window.isDestroyed() || !requested.has(window)
      || window.webContents !== webContents || webContents.isDestroyed?.()
    ) return
    nativeContentReady = true
    nativeContentReadyResolve()
  }, () => {
    rendererPaintPending.delete(webContents)
  })
}

function observeRendererReady(webContents) {
  if (!webContents || webContents.isDestroyed?.() || webContents.getURL?.() !== 'app://-/index.html') return
  rendererReady.add(webContents)
  markNativeContentReady(BrowserWindow.fromWebContents(webContents))
}

function installRendererReadyObserver() {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('Electron renderer readiness API unavailable')
  }
  originalIpcHandle = ipcMain.handle
  ipcMain.handle = function handle(channel, listener) {
    if (channel !== RENDERER_MESSAGE_CHANNEL) return originalIpcHandle.call(this, channel, listener)
    if (rendererMessageHandlerInstalled) throw new Error('Renderer readiness handler was registered more than once')
    rendererMessageHandlerInstalled = true
    restoreIpcHandle()
    return originalIpcHandle.call(this, channel, function rendererMessageHandler(event, message, ...rest) {
      if (message && typeof message === 'object' && message.type === 'ready') {
        observeRendererReady(event?.sender)
      }
      return listener.call(this, event, message, ...rest)
    })
  }
}

function gateWindow(window, wasRequested) {
  if (!window || window.isDestroyed()) return
  tracked.add(window)
  if (wasRequested) requested.add(window)
  if (!requestedOpacity.has(window)) requestedOpacity.set(window, window.getOpacity())
  originalSetOpacity.call(window, 0)
  if (wasRequested) {
    originalShowInactive.call(window)
    markNativeContentReady(window)
  } else originalHide.call(window)
}

function onWindow(_event, window) {
  gateWindow(window, window.isVisible())
}

function bindElectron(electron) {
  if (BrowserWindow) return
  if (!electron || typeof electron !== 'object' || !electron.app || !electron.BrowserWindow) {
    throw new Error('Electron visibility API unavailable')
  }
  ;({ app, BrowserWindow, ipcMain } = electron)
  originalShow = BrowserWindow.prototype.show
  originalShowInactive = BrowserWindow.prototype.showInactive
  originalHide = BrowserWindow.prototype.hide
  originalFocus = BrowserWindow.prototype.focus
  originalRestore = BrowserWindow.prototype.restore
  originalSetOpacity = BrowserWindow.prototype.setOpacity
}

exports.install = function install(options, electron) {
  if (installed && process.pid === options.pid && ownerPID === options.pid) {
    return { pid: process.pid, ready: true }
  }
  if (installed || process.type !== 'browser' || process.pid !== options.pid) {
    throw new Error('Invalid visibility gate owner')
  }
  bindElectron(electron ?? process.mainModule.require('electron'))
  ownerPID = options.pid
  BrowserWindow.prototype.show = function show() {
    if (gated) return gateWindow(this, true)
    return originalShow.call(this)
  }
  BrowserWindow.prototype.showInactive = function showInactive() {
    if (gated) return gateWindow(this, true)
    return originalShowInactive.call(this)
  }
  BrowserWindow.prototype.hide = function hide() {
    if (gated) {
      requested.delete(this)
      return gateWindow(this, false)
    }
    return originalHide.call(this)
  }
  BrowserWindow.prototype.focus = function focus() {
    if (gated) return gateWindow(this, true)
    return originalFocus.call(this)
  }
  BrowserWindow.prototype.restore = function restore() {
    if (gated) return gateWindow(this, true)
    return originalRestore.call(this)
  }
  BrowserWindow.prototype.setOpacity = function setOpacity(opacity) {
    if (gated) {
      tracked.add(this)
      requestedOpacity.set(this, opacity)
      return originalSetOpacity.call(this, 0)
    }
    return originalSetOpacity.call(this, opacity)
  }
  app.on('browser-window-created', onWindow)
  installRendererReadyObserver()
  for (const window of BrowserWindow.getAllWindows()) gateWindow(window, window.isVisible())
  installed = true
  return { pid: process.pid, ready: true }
}

function reveal(options) {
  if (!installed || !gated || process.pid !== ownerPID || options.pid !== ownerPID) {
    throw new Error('Invalid visibility gate release')
  }
  gated = false
  app.removeListener('browser-window-created', onWindow)
  BrowserWindow.prototype.show = originalShow
  BrowserWindow.prototype.showInactive = originalShowInactive
  BrowserWindow.prototype.hide = originalHide
  BrowserWindow.prototype.focus = originalFocus
  BrowserWindow.prototype.restore = originalRestore
  BrowserWindow.prototype.setOpacity = originalSetOpacity
  restoreIpcHandle()
  for (const window of tracked) {
    if (!window.isDestroyed()) originalSetOpacity.call(window, requestedOpacity.get(window) ?? 1)
  }
  for (const window of requested) {
    if (!window.isDestroyed()) {
      if (window.isMinimized()) originalRestore.call(window)
      originalShow.call(window)
    }
  }
  tracked.clear()
  requested.clear()
  requestedOpacity.clear()
  return { pid: process.pid, revealed: true }
}

exports.releaseWhenReady = async function releaseWhenReady(options) {
  if (
    !installed || !gated || releasePoll !== undefined || process.pid !== ownerPID || options.pid !== ownerPID
    || typeof options.statePath !== 'string' || !options.statePath.startsWith('/')
    || typeof options.instanceToken !== 'string' || !/^[a-f0-9]{32,}$/u.test(options.instanceToken)
  ) throw new Error('Invalid visibility gate readiness watch')
  await nativeContentReadyPromise
  const poll = () => {
    let state
    try {
      state = JSON.parse(readFileSync(options.statePath, 'utf8'))
    } catch {
      return
    }
    if (
      state?.phase !== 'ready' || state.hostPid !== ownerPID
      || state.instanceToken !== options.instanceToken
    ) return
    clearInterval(releasePoll)
    releasePoll = undefined
    reveal(options)
  }
  releasePoll = setInterval(poll, 20)
  releasePoll.unref()
  poll()
  return { pid: process.pid, armed: true }
}
