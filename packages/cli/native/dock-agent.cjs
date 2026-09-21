'use strict'

// Loaded once into a verified CordisX-owned Electron main process. The
// inspector used to install it is closed before the Host is marked ready.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { app, nativeImage, nativeTheme } = require('electron')

let installed = false
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function privateFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const info = fs.fstatSync(fd)
    if (
      !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
      || info.size < PNG.length || info.size > 1024 * 1024
    ) throw new Error('Unsafe Dock image')
    const bytes = fs.readFileSync(fd)
    if (!bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('Invalid Dock image')
    const image = nativeImage.createFromBuffer(bytes)
    const size = image.getSize()
    if (image.isEmpty() || size.width < 16 || size.height < 16 || size.width > 1024 || size.height > 1024) {
      throw new Error('Invalid Dock image dimensions')
    }
    return image
  } finally {
    fs.closeSync(fd)
  }
}

// The Host passes its selected nativeImage to dock.setIcon, after applying
// its own icon preference and system appearance. Compare opaque pixel lightness
// on a small normalized bitmap so its source crop and resolution do not matter.
function hostAppearance(input) {
  if (input == null) return 'default'
  const image = typeof input === 'string' ? nativeImage.createFromPath(input) : input
  if (
    !image || typeof image.isEmpty !== 'function' || image.isEmpty()
    || typeof image.resize !== 'function'
  ) return null
  const bytes = image.resize({ width: 32, height: 32 }).toBitmap()
  let total = 0
  let pixels = 0
  for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
    if (bytes[offset + 3] < 128) continue
    total += bytes[offset] + bytes[offset + 1] + bytes[offset + 2]
    pixels++
  }
  return pixels ? (total / pixels / 3 >= 145 ? 'light' : 'dark') : null
}

exports.install = async function install(options) {
  if (installed || process.type !== 'browser' || process.pid !== options.pid) throw new Error('Invalid Dock owner')
  if (
    !/^[a-f0-9]{32}$/.test(options.entryId) || !/^[a-f0-9]{64}$/.test(options.token)
    || !path.isAbsolute(options.socketPath) || !path.isAbsolute(options.iconPath)
    || path.dirname(options.socketPath) !== path.dirname(options.iconPath)
    || options.lightIconPath !== path.join(path.dirname(options.iconPath), 'dock-light.png')
    || options.darkIconPath !== path.join(path.dirname(options.iconPath), 'dock-dark.png')
    || options.defaultIconPath !== path.join(path.dirname(options.iconPath), 'dock-default.png')
  ) {
    throw new Error('Invalid Dock scope')
  }
  const directory = fs.lstatSync(path.dirname(options.socketPath))
  if (
    !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
    || (directory.mode & 0o077) !== 0
  ) throw new Error('Unsafe Dock directory')
  if (fs.existsSync(options.socketPath)) {
    const old = fs.lstatSync(options.socketPath)
    if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('Unsafe stale Dock socket')
    fs.unlinkSync(options.socketPath)
  }
  if (!app.dock || typeof app.dock.setIcon !== 'function') throw new Error('Host Dock API unavailable')
  const original = app.dock.setIcon.bind(app.dock)
  let hasImage = false
  let selected = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light'
  const apply = () => {
    const file = fs.existsSync(options.iconPath)
      ? options.iconPath
      : selected === 'light'
      ? options.lightIconPath
      : selected === 'dark'
      ? options.darkIconPath
      : options.defaultIconPath
    if (!fs.existsSync(file)) {
      hasImage = false
      return
    }
    original(privateFile(file))
    hasImage = true
  }
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let text = ''
    let handled = false
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', chunk => {
      if (handled) return
      text += chunk
      if (text.length > 512) return socket.destroy()
      const end = text.indexOf('\n')
      if (end < 0) return
      handled = true
      const line = text.slice(0, end)
      text = ''
      try {
        const request = JSON.parse(line)
        if (
          Object.keys(request).length !== 3 || request.token !== options.token
          || request.entryId !== options.entryId || request.command !== 'refresh'
        ) throw new Error('Denied')
        apply()
        socket.end('{"ok":true}\n')
      } catch {
        socket.end('{"ok":false}\n')
      }
    })
  })
  server.on('error', () => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, resolve)
  })
  fs.chmodSync(options.socketPath, 0o600)
  app.once('before-quit', () => {
    server.close()
    try {
      fs.unlinkSync(options.socketPath)
    } catch {}
  })
  app.dock.setIcon = image => {
    try {
      selected = hostAppearance(image) ?? selected
    } catch {}
    const result = original(image)
    if (hasImage) {
      queueMicrotask(() => {
        try {
          apply()
        } catch {}
      })
    }
    return result
  }
  nativeTheme.on('updated', () => {
    // Follow the live system appearance when the Host does not issue another
    // setIcon call. A Host call after this event still wins by updating
    // selected before the deferred apply runs.
    selected = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light'
    if (hasImage) {
      setTimeout(() => {
        try {
          apply()
        } catch {}
      }, 50)
    }
  })
  // Automatic entries publish appearance variants rather than iconPath. Apply
  // one before Host startup can select its own icon, then apply once more when
  // Electron is ready so the final startup setIcon cannot win the race.
  if (
    [options.iconPath, options.lightIconPath, options.darkIconPath, options.defaultIconPath]
      .some(file => fs.existsSync(file))
  ) {
    apply()
    void app.whenReady().then(() =>
      setTimeout(() => {
        try {
          apply()
        } catch {}
      }, 250)
    ).catch(() => {})
  }
  installed = true
  return { pid: process.pid, entryId: options.entryId, ready: true }
}
