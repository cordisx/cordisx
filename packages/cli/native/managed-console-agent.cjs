'use strict'

const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { timingSafeEqual } = require('node:crypto')
const { createManagedConsoleView } = require('./managed-console-view.cjs')

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function primaryWindows(electron) {
  return electron.BrowserWindow.getAllWindows().filter(window => {
    if (window.isDestroyed()) return false
    try {
      const url = new URL(window.webContents.getURL())
      return url.protocol === 'app:' && url.hostname === '-' && url.pathname === '/index.html'
    } catch {
      return false
    }
  })
}

async function install(options) {
  const electron = require('electron')
  if (
    process.type !== 'browser' || process.pid !== options.pid || !/^[a-f0-9]{64}$/.test(options.token)
    || !path.isAbsolute(options.socketPath) || typeof electron.WebContentsView !== 'function'
  ) return { ready: false }
  const directory = await fs.lstat(path.dirname(options.socketPath))
  if (!directory.isDirectory() || directory.uid !== process.getuid() || directory.mode & 0o077) return { ready: false }
  const token = Buffer.from(options.token)
  let occupied = false
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    const closeForWindow = () => socket.destroy()
    const authorizationTimer = setTimeout(closeForWindow, 5000)
    let buffer = ''
    let authorized = false
    let handle
    let window
    let parentContents
    let reserved = false
    const reply = (status) => socket.write(JSON.stringify({ status }) + '\n')
    socket.on('error', closeForWindow)
    socket.once('close', () => {
      clearTimeout(authorizationTimer)
      sockets.delete(socket)
      parentContents?.removeListener('did-start-navigation', closeForWindow)
      window?.removeListener('closed', closeForWindow)
      if (reserved) occupied = false
      void handle?.close().catch(() => {})
    })
    const open = async message => {
      const candidate = Buffer.from(typeof message?.token === 'string' ? message.token : '')
      if (
        !exact(message, ['action', 'token', 'origin', 'url', 'cookie']) || message.action !== 'open'
        || candidate.length !== token.length || !timingSafeEqual(candidate, token) || occupied
        || !exact(message.cookie, ['name', 'value', 'expirationDate'])
      ) return socket.destroy()
      const [primary, other] = primaryWindows(electron)
      if (!primary || other) return socket.destroy()
      occupied = true
      reserved = true
      window = primary
      window.once('closed', closeForWindow)
      parentContents = window.webContents
      parentContents.on('did-start-navigation', closeForWindow)
      try {
        const mounted = await createManagedConsoleView(electron, primary, message, closeForWindow)
        if (socket.destroyed) {
          await mounted.close()
          return
        }
        handle = mounted
        authorized = true
        clearTimeout(authorizationTimer)
        reply('mounted')
      } catch {
        socket.destroy()
      }
    }
    let opening = false
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 4096) return socket.destroy()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (!authorized) {
            if (opening) return socket.destroy()
            opening = true
            void open(message).catch(closeForWindow)
          } else if (
            exact(message, ['action', 'bounds']) && message.action === 'bounds'
            && exact(message.bounds, ['x', 'y', 'width', 'height'])
          ) {
            handle.setBounds(message.bounds)
          } else if (exact(message, ['action']) && message.action === 'hide') {
            handle.hide()
          } else {
            return socket.destroy()
          }
        } catch {
          return socket.destroy()
        }
      }
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.socketPath, resolve)
    })
    await fs.chmod(options.socketPath, 0o600)
  } catch {
    server.close()
    return { ready: false }
  }
  server.on('error', () => {})
  electron.app.once('before-quit', () => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { ready: true, pid: process.pid }
}

module.exports = { install }
