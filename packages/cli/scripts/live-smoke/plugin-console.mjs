function pluginConsoleSmokeAssertions(report, owner) {
  const nonEmptyText = value => typeof value === 'string' && value.trim().length > 0
  const positiveRect = value =>
    value !== null
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
    'ui.fillsRemainingHeight': report.ui.fillsRemainingHeight,
    'ui.logsOnlyConsoleTools': report.ui.logsOnlyConsoleTools,
    'ui.independentEntries': report.ui.independentEntries,
    'ui.independentEntryCount': report.ui.independentEntryCount > 0,
    'ui.mountedEntryCount': report.ui.mountedEntryCount === report.ui.independentEntryCount,
    'ui.levelVisuals': report.ui.levelVisuals,
    'ui.objectExpanded': report.ui.objectExpanded,
    'ui.coverageRemoved': report.ui.coverageRemoved,
    'ui.iconToolbar': report.ui.iconToolbar,
    'ui.runtimeConsoleSummary': report.ui.runtimeConsoleSummary,
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
    'ui.runtimeChrome.runtimeDetailsAbsent': report.ui.runtimeChrome.runtimeDetailsAbsent,
    'ui.runtimeChrome.diagnosticsCollapsed': report.ui.runtimeChrome.diagnosticsCollapsed,
    'ui.runtimeChrome.runtimeStatusOnly': report.ui.runtimeChrome.runtimeStatusOnly,
    'ui.runtimeChrome.diagnosticsExpanded': report.ui.runtimeChrome.diagnosticsExpanded,
    'ui.runtimeChrome.diagnosticsLocalized': report.ui.runtimeChrome.diagnosticsLocalized,
    'ui.runtimeChrome.diagnosticsNoCjk': report.ui.runtimeChrome.diagnosticsNoCjk,
    'reload.entries': report.reload.entries > 0,
    'reload.lifecycle': report.reload.lifecycle,
    'reload.terminalCount': report.reload.terminalCount > 0,
    'privacy.structuredOnly': report.privacy.structuredOnly,
    'privacy.partialObservability': report.privacy.partialObservability,
  }
}

export async function runPluginConsoleExercise({
  values,
  locale,
  evaluateByValue,
  pointerClick,
  send,
  pressKey,
  capture,
}) {
  let managerReport

  let managerFormExerciseFailure

  let managerServiceConfigurationFailure

  let pluginConsoleReport

  let pluginConsoleAssertions

  if (values['plugin-console-exercise']) {
    const owner = values['plugin-owner'] ?? 'console-showcase'
    const pluginConsoleLocale = locale === 'zh-CN'
      ? { kindSelect: 'API / 类型', diagnostics: '诊断' }
      : { kindSelect: 'API / type', diagnostics: 'Diagnostics' }
    const toolbarTarget = await evaluateByValue(
      `(async () => {
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
        document.querySelector('[data-plugin-detail-tab="logs"]')?.click()
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
    })()`,
      true,
    )
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
    pluginConsoleReport = await evaluateByValue(
      `(async () => {
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
        document.querySelector('[data-plugin-detail-tab="logs"]')?.click()
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
      const kind = pausedPanel?.querySelector('t-select[aria-label=' + JSON.stringify(${
        JSON.stringify(pluginConsoleLocale.kindSelect)
      }) + ']')
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
      const logsPanel = lunaFrame?.closest('[role="tabpanel"]')
      const workspaceRect = lunaFrame?.closest('.cxm-console-workspace')?.getBoundingClientRect()
      const frameRect = lunaFrame?.getBoundingClientRect()
      const fillsRemainingHeight = frameRect !== undefined && workspaceRect !== undefined
        && frameRect.height >= 160 && Math.abs(frameRect.bottom - workspaceRect.bottom) <= 2
      const logsOnlyConsoleTools = logsPanel?.classList.contains('cxm-console-panel') === true
        && logsPanel.querySelector('.cxm-runtime-console-summary') === null
        && logsPanel.querySelector('[data-runtime-lifecycle]') === null
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
      const iconToolbar = toolbarButtons.length === 5 && toolbarButtons.every(item => item.textContent === '' && item.querySelector('[data-material-icon]') !== null)
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
      document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 40))
      const runtimePanelForChrome = document.querySelector('[data-plugin-runtime-status="' + CSS.escape(owner) + '"]')?.closest('[role="tabpanel"]')
      const runtimeLifecycle = runtimePanelForChrome?.querySelector('[data-runtime-lifecycle="' + CSS.escape(owner) + '"]')
      const runtimeDiagnostics = runtimePanelForChrome?.querySelector('[data-runtime-diagnostics="platform"]')
      const runtimeConsoleSummary = runtimePanelForChrome?.querySelectorAll('.cxm-runtime-console-metric').length === 4
      document.querySelector('[data-plugin-detail-tab="logs"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 40))
      const logsPanelForDiagnostics = document.querySelector('[data-plugin-console="' + CSS.escape(owner) + '"]')?.closest('[role="tabpanel"]')
      const logsDiagnostics = logsPanelForDiagnostics?.querySelector('[data-runtime-diagnostics="platform"]')
      const diagnosticsCollapsed = logsDiagnostics instanceof HTMLDetailsElement && !logsDiagnostics.open
      logsDiagnostics?.querySelector('summary')?.click()
      const runtimeChrome = {
        runtimeDetailsAbsent: logsPanelForDiagnostics?.querySelector('[data-runtime-lifecycle]') === null,
        diagnosticsCollapsed,
        runtimeStatusOnly: runtimeLifecycle === null && runtimeDiagnostics === null,
        diagnosticsExpanded: logsDiagnostics instanceof HTMLDetailsElement && logsDiagnostics.open,
        diagnosticsLocalized: logsDiagnostics?.querySelector('summary')?.textContent === ${
        JSON.stringify(pluginConsoleLocale.diagnostics)
      },
        diagnosticsNoCjk: ${
        JSON.stringify(locale !== 'zh-CN')
      } === false || !/[\u3400-\u9fff]/u.test(logsDiagnostics?.textContent ?? ''),
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
          lunaOnly, nativePayloads, firstLineAtTop, fillsRemainingHeight, logsOnlyConsoleTools,
          independentEntries, independentEntryCount, mountedEntryCount: lunaEntries.length,
          levelVisuals, objectExpanded, coverageRemoved, iconToolbar, runtimeConsoleSummary,
          pointerPaused: ${JSON.stringify(pointerPaused.pressed)}, pointerPauseDetail: ${JSON.stringify(pointerPaused)},
          keyboardFocused: ${JSON.stringify(keyboardFocused)}, keyboardResumed: ${
        JSON.stringify(keyboardResumed.pressed)
      },
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
    })()`,
      true,
    )
    pluginConsoleAssertions = pluginConsoleSmokeAssertions(pluginConsoleReport, owner)
    pluginConsoleReport = { ...pluginConsoleReport, assertions: pluginConsoleAssertions }
    if (values['plugin-console-expanded-screenshot'] !== undefined) {
      const expandedRect = await evaluateByValue(`(() => {
        const diagnostics = document.querySelector('[data-runtime-diagnostics="platform"]')
        const panel = diagnostics?.closest('[role="tabpanel"]')
        const rect = panel?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      if (expandedRect === null) throw new Error('expanded Plugin Console diagnostics panel is unavailable')
      await capture(
        expandedRect,
        values['plugin-console-expanded-screenshot'],
        'expanded Plugin Console diagnostics',
      )
    }
    console.log(`plugin-console=${JSON.stringify(pluginConsoleReport, null, 2)}`)
  }

  return {
    managerReport,
    managerFormExerciseFailure,
    managerServiceConfigurationFailure,
    pluginConsoleReport,
    pluginConsoleAssertions,
  }
}
