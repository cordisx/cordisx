import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function createLiveSmokeBrowserTools(send) {
  async function evaluateByValue(expression, awaitPromise = false) {
    const value = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (value.exceptionDetails !== undefined) throw new Error(value.exceptionDetails.text ?? 'CDP evaluation failed')
    return value.result?.value
  }

  async function ensureManagerVisible() {
    const state = await evaluateByValue(
      `(async () => {
      const visibleManager = () => {
        const modal = document.querySelector('[data-cordisx-manager-modal]')
        const dialog = modal?.querySelector('[role="dialog"], .cxr-dialog')
        if (!(modal instanceof HTMLElement) || modal.hidden || !(dialog instanceof HTMLElement)) return null
        const rect = dialog.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 ? modal : null
      }
      let modal = visibleManager()
      if (modal !== null) return { visible: true, openedBy: 'already-open' }
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const legacyModal = document.querySelector('[data-cordisx-manager-modal][hidden]')
      if (trigger instanceof HTMLElement) trigger.click()
      else if (legacyModal instanceof HTMLElement) legacyModal.hidden = false
      else return { visible: false, openedBy: 'unavailable' }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        modal = visibleManager()
        if (modal !== null) {
          return {
            visible: true,
            openedBy: trigger instanceof HTMLElement ? 'manager-trigger' : 'legacy-fallback',
          }
        }
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return { visible: false, openedBy: trigger instanceof HTMLElement ? 'manager-trigger' : 'legacy-fallback' }
    })()`,
      true,
    )
    if (state?.visible !== true) throw new Error(`CordisX manager is not visible: ${JSON.stringify(state)}`)
    return state
  }

  async function ensureManagerClosed() {
    const state = await evaluateByValue(
      `(async () => {
      const visibleManager = () => {
        const modal = document.querySelector('[data-cordisx-manager-modal]')
        const dialog = modal?.querySelector('[role="dialog"], .cxr-dialog')
        if (!(modal instanceof HTMLElement) || modal.hidden || !(dialog instanceof HTMLElement)) return null
        const rect = dialog.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 ? modal : null
      }
      if (visibleManager() === null) return { closed: true, closedBy: 'already-closed' }
      const close = document.querySelector('[data-cordisx-manager-modal] [aria-label="关闭"], [data-cordisx-manager-modal] .cxm-close')
      if (!(close instanceof HTMLElement)) return { closed: false, closedBy: 'unavailable' }
      close.click()
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (visibleManager() === null) return { closed: true, closedBy: 'manager-close' }
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return { closed: false, closedBy: 'manager-close' }
    })()`,
      true,
    )
    if (state?.closed !== true) throw new Error(`CordisX manager did not close: ${JSON.stringify(state)}`)
    return state
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

  return { evaluateByValue, ensureManagerVisible, ensureManagerClosed, capture }
}
