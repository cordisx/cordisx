import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { transform } from 'esbuild'
export async function runHostCollectionExercises({
  values,
  send,
  capture,
  report,
  evaluateByValue,
  pointerClick,
  pressKey,
}) {
  if (values['fetch-url'] !== undefined) {
    const fetched = await send('Runtime.evaluate', {
      expression: `(async () => {
        const result = {}
        try {
          const response = await fetch(${JSON.stringify(values['fetch-url'])})
          result.fetch = { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 120) }
        } catch (error) {
          result.fetch = { ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }
        }
        result.xhr = await new Promise(resolve => {
          const request = new XMLHttpRequest()
          request.open('GET', ${JSON.stringify(values['fetch-url'])})
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

  let hostCollectionMenuReport

  if (values['host-collection-menu-exercise']) {
    const source = await readFile(new URL('../src/renderer/host-collection.ts', import.meta.url), 'utf8')
    const compiled = await transform(source, {
      loader: 'ts',
      format: 'iife',
      globalName: '__cordisxHostCollectionSmokeModule',
      target: 'es2022',
    })
    await send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    try {
      const loaded = await send('Runtime.evaluate', { expression: compiled.code, returnByValue: true })
      if (loaded.exceptionDetails !== undefined) {
        throw new Error(
          loaded.exceptionDetails.exception?.description ?? loaded.exceptionDetails.text
            ?? 'Host collection smoke module failed to load',
        )
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
      if (values['host-collection-menu-screenshot'] !== undefined) {
        await capture(initial.rect, values['host-collection-menu-screenshot'], 'Host collection menu smoke')
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
        viewport: { width: 420, height: 800 },
        initial,
        keyboard: { arrowDown, arrowUp, end, home, wrappedUp },
        escape,
        dispose,
        reopened,
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

  return { hostCollectionMenuReport }
}
