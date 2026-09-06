export async function runEnvironmentSetup({
  values,
  send,
  evaluateByValue,
  pointerClick,
}) {
  const locale = values.locale

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

  const colorScheme = values['color-scheme']

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

  if (values['select-thread'] !== undefined) {
    const target = await send('Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('.cxm-close')?.click()
        const id = ${JSON.stringify(values['select-thread'])}
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === id)
        const rect = row?.getBoundingClientRect()
        return rect === undefined ? null : { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`,
      returnByValue: true,
    })
    const value = target.result?.value
    if (value === null || value === undefined) throw new Error(`thread row not found: ${values['select-thread']}`)
    await pointerClick(value)
    await new Promise(resolve => setTimeout(resolve, 1800))
    const selected = await send('Runtime.evaluate', {
      expression: `(() => ({ clicked: true, id: ${JSON.stringify(values['select-thread'])},
        selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null }))()`,
      returnByValue: true,
    })
    console.log(`thread=${JSON.stringify(selected.result?.value)}`)
  }

  if (values['permission-capability'] !== undefined) {
    const policy = values['permission-policy']
    if (!['allow', 'ask', 'deny'].includes(policy)) throw new Error(`unknown permission policy: ${policy}`)
    const permission = await send('Runtime.evaluate', {
      expression: `(async () => {
        const owner = ${JSON.stringify(values['plugin-owner'] ?? 'slot-showcase')}
        const capabilities = ${JSON.stringify(values['permission-capability'])}
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

  if (values['click-surface'] !== undefined) {
    const target = await send('Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('.cxm-close')?.click()
        for (const page of document.querySelectorAll('[data-cordisx-page]')) page.querySelector('button[aria-label="Close"]')?.click()
        const surface = ${JSON.stringify(values['click-surface'])}
        const label = ${JSON.stringify(values['click-label'])}
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
    if (value?.rect === undefined) throw new Error(`surface pointer target not found: ${values['click-surface']}`)
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
          error: document.querySelector('[data-cordisx-surface-host=${
        JSON.stringify(values['click-surface'])
      }] button')?.dataset.error ?? null,
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

  if (values['demo-kind'] !== undefined) {
    const allowed = new Set([
      'followup',
      'steer',
      'inject',
      'pre-step',
      'system-prompt-section',
      'system-prompt-context',
    ])
    for (const kind of values['demo-kind']) {
      if (!allowed.has(kind)) throw new Error(`unknown Agent Trace demo kind: ${kind}`)
    }
    const platformMode = await evaluateByValue(`globalThis.__cordisxRuntime?.snapshot?.().platform?.mode ?? null`)
    if (platformMode !== 'unavailable') {
      throw new Error(
        `refusing Agent Trace smoke writes while adapter mode is ${
          String(platformMode)
        }; use an unavailable isolated renderer`,
      )
    }
    const before = await evaluateByValue(`(() => ({
      page: document.querySelector('[data-agent-trace-showcase="true"]') !== null,
      rows: document.querySelectorAll('[data-agent-trace-showcase="true"] .cxt-row').length,
    }))()`)
    if (!before.page) throw new Error('Agent Trace page must be mounted before --demo-kind')
    const invocations = []
    for (const kind of values['demo-kind']) {
      const target = await evaluateByValue(`(() => {
        const button = document.querySelector('[data-agent-trace-showcase="true"] [data-demo-kind=${
        JSON.stringify(kind)
      }]')
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
    if (values['clear-demo']) {
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

  if (values['plugin-lifecycle']) {
    const owner = values['plugin-owner']
    const surface = values['click-surface']
    const label = values['click-label']
    if (owner === undefined || surface === undefined) {
      throw new Error('--plugin-lifecycle requires --plugin-owner and --click-surface')
    }
    const beforeClose = await evaluateByValue(`(() => {
      const page = document.querySelector('[data-cordisx-page]')
      const pageClose = page?.querySelector('button[aria-label="Close"]')
      const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
      JSON.stringify(surface)
    }) + '"]')
      const surfaceButtons = [...(root?.querySelectorAll('button') ?? [])]
      const surfaceToggle = ${JSON.stringify(label)} === undefined
        ? surfaceButtons.find(item => item.getAttribute('aria-pressed') === 'true')
        : surfaceButtons.find(item => item.getAttribute('aria-label') === ${
      JSON.stringify(label)
    } && item.getAttribute('aria-pressed') === 'true')
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
      pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
      JSON.stringify(surface)
    }) + '"]')?.querySelectorAll('button') ?? [])]
        .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${
      JSON.stringify(label)
    })?.getAttribute('aria-pressed') ?? null,
    }))()`)
    const reopenTarget = await evaluateByValue(`(() => {
      const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
      JSON.stringify(surface)
    }) + '"]')
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
      pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
      JSON.stringify(surface)
    }) + '"]')?.querySelectorAll('button') ?? [])]
        .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${
      JSON.stringify(label)
    })?.getAttribute('aria-pressed') ?? null,
    }))()`)
    const blocked = await evaluateByValue(
      `(async () => {
      await globalThis.__cordisxRuntime.setPluginBlocked(${JSON.stringify(owner)}, true)
      await new Promise(resolve => setTimeout(resolve, 120))
      const snapshot = globalThis.__cordisxRuntime.snapshot()
      return {
        status: snapshot.plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
        surfaceEntries: document.querySelectorAll('[data-cordisx-surface-host="' + CSS.escape(${
        JSON.stringify(surface)
      }) + '"] button').length,
        pages: snapshot.navigation.pages.filter(page => page.qualifiedId.startsWith(${
        JSON.stringify(`${owner}:`)
      })).length,
        commands: snapshot.commands.filter(command => command.qualifiedId.startsWith(${
        JSON.stringify(`${owner}:`)
      })).length,
        routes: snapshot.navigation.routes.filter(route => route.qualifiedId.startsWith(${
        JSON.stringify(`${owner}:`)
      })).length,
      }
    })()`,
      true,
    )
    const staleInvocation = await evaluateByValue(
      `(async () => {
      globalThis.__cordisxAgentTraceStaleEntry?.click()
      await new Promise(resolve => setTimeout(resolve, 100))
      return {
        page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
        status: globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${
        JSON.stringify(owner)
      })?.status ?? null,
      }
    })()`,
      true,
    )
    const restored = await evaluateByValue(
      `(async () => {
      await globalThis.__cordisxRuntime.setPluginBlocked(${JSON.stringify(owner)}, false)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const root = document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
        JSON.stringify(surface)
      }) + '"]')
        const buttons = [...(root?.querySelectorAll('button') ?? [])]
        const button = ${JSON.stringify(label)} === undefined
          ? buttons[0]
          : buttons.find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)})
        if (button !== undefined) {
          const rect = button.getBoundingClientRect()
          return {
            status: globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${
        JSON.stringify(owner)
      })?.status ?? null,
            freshEntry: button !== globalThis.__cordisxAgentTraceStaleEntry,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return null
    })()`,
      true,
    )
    if (restored?.rect === undefined) throw new Error('plugin did not restore its surface entry')
    await pointerClick(restored.rect)
    await new Promise(resolve => setTimeout(resolve, 200))
    const afterRestoreClick = await evaluateByValue(`(() => ({
      page: document.querySelector('[data-cordisx-page]')?.getAttribute('data-cordisx-page') ?? null,
      outlet: document.querySelector('[data-cordisx-page]')?.closest('[data-cordisx-page-outlet]')?.getAttribute('data-cordisx-page-outlet') ?? null,
      pressed: [...(document.querySelector('[data-cordisx-surface-host="' + CSS.escape(${
      JSON.stringify(surface)
    }) + '"]')?.querySelectorAll('button') ?? [])]
        .find(item => ${JSON.stringify(label)} === undefined || item.getAttribute('aria-label') === ${
      JSON.stringify(label)
    })?.getAttribute('aria-pressed') ?? null,
    }))()`)
    pluginLifecycleReport = { beforeClose, afterClose, reopened, blocked, staleInvocation, restored, afterRestoreClick }
    console.log(`plugin-lifecycle=${JSON.stringify(pluginLifecycleReport)}`)
  }

  if (values['open-route'] !== undefined) {
    const opened = await send('Runtime.evaluate', {
      expression: `(async () => {
        document.querySelector('.cxm-close')?.click()
        for (const page of document.querySelectorAll('[data-cordisx-page]')) {
          page.querySelector('button[aria-label="Close"]')?.click()
        }
        await new Promise(resolve => setTimeout(resolve, 80))
        const route = ${JSON.stringify(values['open-route'])}
        const sessionId = ${JSON.stringify(values['session-id'])}
        const owner = ${JSON.stringify(values['plugin-owner'] ?? 'slot-showcase')}
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

  return { locale, localeProjection, colorScheme, demoReport, pluginLifecycleReport }
}
