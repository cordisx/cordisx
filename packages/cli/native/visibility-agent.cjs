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
const tracked = new Set()
const requested = new Set()
const requestedOpacity = new Map()
let releasePoll

function gateWindow(window, wasRequested) {
  if (!window || window.isDestroyed()) return
  tracked.add(window)
  if (wasRequested) requested.add(window)
  if (!requestedOpacity.has(window)) requestedOpacity.set(window, window.getOpacity())
  originalSetOpacity.call(window, 0)
  originalHide.call(window)
}

function onWindow(_event, window) {
  gateWindow(window, window.isVisible())
}

function bindElectron(electron) {
  if (BrowserWindow) return
  if (!electron || typeof electron !== 'object' || !electron.app || !electron.BrowserWindow) {
    throw new Error('Electron visibility API unavailable')
  }
  ;({ app, BrowserWindow } = electron)
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

exports.releaseWhenReady = function releaseWhenReady(options) {
  if (
    !installed || !gated || releasePoll !== undefined || process.pid !== ownerPID || options.pid !== ownerPID
    || typeof options.statePath !== 'string' || !options.statePath.startsWith('/')
    || typeof options.instanceToken !== 'string' || !/^[a-f0-9]{32,}$/u.test(options.instanceToken)
  ) throw new Error('Invalid visibility gate readiness watch')
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
