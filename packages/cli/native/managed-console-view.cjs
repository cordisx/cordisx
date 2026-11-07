'use strict'

const { randomUUID } = require('node:crypto')

function consoleOrigin(value) {
  const parsed = new URL(value)
  if (
    parsed.origin !== value || !['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) throw new Error('Invalid managed console origin')
  return parsed
}

function targetWithin(origin, target) {
  try {
    return new URL(target).origin === origin && target.startsWith(origin + '/')
  } catch {
    return false
  }
}

// Main-process primitive. Only the owned Launcher may supply the verified window,
// exact origin, destination and newly issued cookie. Never expose this to preload,
// ipcRenderer, page JavaScript, or a plugin-selected BrowserWindow.
async function createManagedConsoleView(electron, window, input, onEnded = () => {}) {
  const origin = consoleOrigin(input.origin).origin
  if (!targetWithin(origin, input.url) || window.isDestroyed()) throw new Error('Invalid managed console target')
  const cookie = input.cookie
  if (
    !/^__Host-[a-zA-Z0-9_-]{1,80}$/.test(cookie.name) || !/^[a-zA-Z0-9_-]{32,128}$/.test(cookie.value)
    || !Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= Date.now() / 1000
  ) {
    throw new Error('Invalid managed console session')
  }

  // WebContents sessions are separate from the parent profile and other views.
  const partition = electron.session.fromPartition('cordisx-managed-console-' + randomUUID(), { cache: false })
  const view = new electron.WebContentsView({
    webPreferences: {
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    },
  })
  const contents = view.webContents
  let attached = false
  let closed = false
  const cancel = event => event.preventDefault()
  const denyForeignNavigation = (event, target) => {
    if (!targetWithin(origin, event.url ?? target)) cancel(event)
  }
  const close = async () => {
    if (closed) return
    closed = true
    window.removeListener('closed', onWindowClosed)
    if (attached && !window.isDestroyed()) window.contentView.removeChildView(view)
    if (!contents.isDestroyed()) contents.close()
    // Leave egress blocked for the retired partition even if teardown fails.
    await partition.clearStorageData()
  }
  const onWindowClosed = () => {
    void close().catch(() => {})
  }
  try {
    // Partition isolation alone does not isolate a cookie by port. Deny requests
    // outside the one verified origin before dispatch, including redirects.
    partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: closed || !targetWithin(origin, details.url) })
    })
    partition.webRequest.onCompleted(details => {
      if (details.url === origin + '/auth/logout' && details.method === 'POST' && details.statusCode === 204) onEnded()
    })
    partition.setPermissionCheckHandler(() => false)
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.on('will-download', cancel)
    contents.once('render-process-gone', onEnded)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', cancel)
    contents.on('will-navigate', denyForeignNavigation)
    contents.on('will-frame-navigate', denyForeignNavigation)
    contents.on('will-redirect', denyForeignNavigation)
    window.once('closed', onWindowClosed)

    await partition.cookies.set({
      url: origin + '/',
      name: cookie.name,
      value: cookie.value,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: cookie.expirationDate,
    })
    if (closed || window.isDestroyed()) throw new Error('Managed console window closed')
    await contents.loadURL(input.url)
    if (closed || window.isDestroyed()) throw new Error('Managed console window closed')
    view.setVisible(false)
    window.contentView.addChildView(view)
    attached = true
  } catch {
    await close().catch(() => {})
    throw new Error('Could not open isolated managed console')
  }

  return {
    setBounds(bounds) {
      if (closed || window.isDestroyed()) return
      const { width, height } = window.getContentBounds()
      const zoom = window.webContents.getZoomFactor()
      const { x, y, width: w, height: h } = bounds
      const x1 = Math.ceil(x * zoom)
      const y1 = Math.ceil(y * zoom)
      const x2 = Math.floor((x + w) * zoom)
      const y2 = Math.floor((y + h) * zoom)
      const valid = [x, y, w, h].every(Number.isSafeInteger) && Number.isFinite(zoom) && zoom > 0
        && x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= width && y2 <= height
      if (valid) view.setBounds({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 })
      view.setVisible(valid)
    },
    hide() {
      if (!closed) view.setVisible(false)
    },
    close,
  }
}

module.exports = { createManagedConsoleView }
