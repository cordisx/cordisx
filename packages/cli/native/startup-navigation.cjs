'use strict'

// Launcher-owned early-main agent. It gates only the observed packaged primary
// BrowserWindow.loadURL call, allowing Owl/browser initialization to continue.
// It neither creates windows nor changes installed Host files or account state.
exports.createBarrier = function createBarrier(electron, owner, options) {
  if (owner.pid !== options.pid || owner.type !== 'browser' || !options.generation) {
    throw new Error('Invalid navigation barrier owner')
  }
  if (options.seedURL !== undefined && !options.seedURL.startsWith('data:text/html;charset=utf-8,')) {
    throw new Error('Only an owned static loading document can seed the renderer')
  }
  const primaryURL = 'app://-/index.html'
  const { BrowserWindow } = electron
  const original = BrowserWindow.prototype.loadURL
  if (BrowserWindow.getAllWindows().some(w => w.webContents.getURL() === primaryURL)) {
    throw new Error('Primary navigation already started')
  }
  let phase = 'waiting-window'
  let pending, failure, targetId, discovering, rendererBeforeSeed, rendererAfterSeed, loadingShownAt
  const nativeEvents = []
  const timer = setTimeout(() => {
    if (phase === 'navigation-released') return
    phase = 'failed'
    failure = 'navigation-barrier-deadline'
    // Do not reject the Host's load promise: its catch path loads a fallback
    // page. Keep navigation held until the owner terminates this child.
  }, options.deadlineMs ?? 30000)
  timer.unref?.()
  function authorize(request) {
    if (request.pid !== owner.pid || request.generation !== options.generation) {
      throw new Error('Navigation barrier owner mismatch')
    }
  }
  function usable() {
    return pending && !pending.window.isDestroyed() && !pending.window.webContents.isDestroyed()
  }
  function snapshot() {
    return {
      pid: owner.pid,
      generation: options.generation,
      phase,
      failure,
      loadingShownAt,
      nativeEvents: nativeEvents.slice(-8),
      ...(pending ? { windowId: pending.window.id, webContentsId: pending.window.webContents.id } : {}),
      ...(targetId ? { targetId } : {}),
      ...(options.seedURL ? { initialDocumentURL: options.seedURL, rendererBeforeSeed, rendererAfterSeed } : {}),
    }
  }
  function wrapped(url, ...args) {
    if (url !== primaryURL) return original.call(this, url, ...args)
    if (pending || phase !== 'waiting-window') {
      phase = 'failed'
      failure = 'unexpected-additional-primary-navigation'
      // An exception would activate the Host's fallback navigation. Hold both
      // requests until the supervising owner observes failure and exits.
      return new Promise(() => {})
    }
    phase = 'navigation-held'
    const result = new Promise((resolve, reject) => {
      pending = { window: this, url, args, resolve, reject }
    })
    this.once('closed', () => {
      clearTimeout(timer)
      if (phase === 'navigation-released') return
      phase = 'failed'
      failure = 'owned-window-closed'
    })
    const note = event => {
      const url = this.webContents.getURL()
      nativeEvents.push({
        event,
        document: url === primaryURL ? 'app' : url === options.seedURL ? 'owned-loading' : 'other',
        rendererPid: this.webContents.getOSProcessId?.() ?? null,
      })
    }
    this.webContents.on?.('did-finish-load', () => note('did-finish-load'))
    this.on('ready-to-show', () => note('ready-to-show'))
    if (options.seedURL) {
      phase = 'seeding-owned-loading-document'
      rendererBeforeSeed = this.webContents.getOSProcessId?.() ?? null
      Promise.resolve().then(() => original.call(this, options.seedURL)).then(() => {
        if (!usable() || phase !== 'seeding-owned-loading-document') return
        rendererAfterSeed = this.webContents.getOSProcessId?.() ?? null
        phase = 'navigation-held'
        if (options.showSeed) {
          this.show()
          this.focus()
          loadingShownAt = Date.now()
        }
      }).catch(() => {
        phase = 'failed'
        failure = 'owned-loading-document-failed'
      })
    }
    return result
  }
  BrowserWindow.prototype.loadURL = wrapped
  return {
    snapshot(request) {
      authorize(request)
      return snapshot()
    },
    async identifyTarget(request) {
      authorize(request)
      if (!usable() || phase !== 'navigation-held') throw new Error('No held primary navigation')
      if (targetId) return snapshot()
      if (discovering) return discovering
      const contents = pending.window.webContents
      const debug = contents.debugger
      if (debug.isAttached()) throw new Error('Owned renderer debugger already attached; refusing takeover')
      discovering = (async () => {
        let attached = false
        try {
          debug.attach('1.3')
          attached = true
          const { targetInfo } = await debug.sendCommand('Target.getTargetInfo')
          if (
            !usable() || phase !== 'navigation-held' || targetInfo?.type !== 'page'
            || !targetInfo.targetId
            || !(options.seedURL ? targetInfo.url === options.seedURL : ['', 'about:blank'].includes(targetInfo.url))
          ) {
            throw new Error('Held blank target identity unavailable')
          }
          targetId = targetInfo.targetId
          return snapshot()
        } finally {
          if (attached && !contents.isDestroyed() && debug.isAttached()) debug.detach()
        }
      })()
      return discovering
    },
    releaseNavigation(request, proof) {
      authorize(request)
      if (
        !usable() || phase !== 'navigation-held' || !targetId
        || proof?.targetId !== targetId || proof.windowId !== pending.window.id
        || proof.webContentsId !== pending.window.webContents.id
        || typeof proof.identifier !== 'string' || !proof.identifier
        || typeof proof.sessionId !== 'string' || !proof.sessionId
      ) {
        throw new Error('Missing exact-target pre-document registration receipt')
      }
      if (BrowserWindow.prototype.loadURL !== wrapped) throw new Error('Navigation hook changed')
      phase = 'navigation-released'
      clearTimeout(timer)
      BrowserWindow.prototype.loadURL = original
      // Fulfil the exact original Host call with its original options/result.
      try {
        const value = original.call(pending.window, pending.url, ...pending.args)
        Promise.resolve(value).then(pending.resolve, pending.reject)
      } catch (error) {
        pending.reject(error)
      }
      return snapshot()
    },
  }
}

exports.install = (options, electron) =>
  exports.createBarrier(
    electron,
    { pid: process.pid, type: process.type },
    options,
  )
