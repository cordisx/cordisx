export async function runSettingsExercises({
  values,
  evaluateByValue,
  pointerClick,
  send,
  locale,
  pressKey,
}) {
  let exerciseReport

  let settingsTabsReport

  let configExerciseReport

  if (false && values['manager-settings-exercise']) {
    const owner = values['plugin-owner'] ?? 'settings-tab-demo'
    const qualifiedTabId = `${owner}:settings`
    const initial = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      trigger?.click()
      document.querySelector('[data-tab="settings"]')?.click()
      await wait(700)
      const main = document.querySelector('[data-app-shell-main-content-layout]')
      const selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')
      globalThis.__cordisxSettingsSmokeNative = { main, selected }
      const snapshot = runtime.snapshot()
      const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
      const panel = document.querySelector('[data-settings-root] [role="tabpanel"]')
      return {
        url: location.href,
        tabs: [...document.querySelectorAll('[data-settings-tab]')].map(element => ({
          id: element.getAttribute('data-settings-tab'),
          owner: element.getAttribute('data-settings-owner'),
          title: element.textContent?.trim() ?? '',
          role: element.getAttribute('role'),
          selected: element.getAttribute('aria-selected'),
          tabIndex: element.tabIndex,
          icon: element.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null,
        })),
        projection: snapshot.settingsTabs,
        structuredHeader: tab !== null
          && tab.querySelector('.cxm-tab-content') !== null
          && tab.querySelector('[data-host-icon]') !== null
          && tab.querySelector('section, style') === null,
        panel: panel === null ? null : {
          role: panel.getAttribute('role'),
          labelledBy: panel.getAttribute('aria-labelledby'),
          controls: tab?.getAttribute('aria-controls') ?? null,
        },
        points: ['manager.settings.tabs', 'manager.settings.content'].map(id => {
          const point = snapshot.extensionPoints.points.find(item => item.id === id)
          return point === undefined ? null : {
            id, available: point.available, usingPluginCount: point.usingPluginCount,
            activePluginCount: point.activePluginCount,
          }
        }),
        native: {
          mainPresent: main !== null,
          mainConnected: main?.isConnected ?? false,
          selectedId: selected?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
          selectedConnected: selected?.isConnected ?? false,
        },
      }
    })()`,
      true,
    )

    const tabRect = async () =>
      await evaluateByValue(`(() => {
      const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
      const rect = tab?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    const firstRect = await tabRect()
    if (firstRect === null) throw new Error(`manager settings demo tab not found: ${qualifiedTabId}`)
    await pointerClick(firstRect)
    await new Promise(resolve => setTimeout(resolve, 250))
    const mounted = await evaluateByValue(`(() => {
      const runtime = globalThis.__cordisxRuntime
      const tab = document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]')
      const panel = document.querySelector('[data-settings-root] [role="tabpanel"]')
      const page = panel?.querySelector('[data-cordisx-settings-page="${qualifiedTabId}"]')
      return {
        activeTab: tab?.getAttribute('aria-selected') === 'true' ? ${JSON.stringify(qualifiedTabId)} : null,
        focusedTab: document.activeElement?.getAttribute('data-settings-tab') ?? null,
        contentMounted: page?.querySelector('[data-settings-demo-content="mounted"]') !== null,
        bodyOnly: page !== null && page.querySelector('[data-cordisx-page-chrome]') === null,
        controlledBody: page?.parentElement?.hasAttribute('data-settings-panel-body') ?? false,
        panelLabel: panel?.getAttribute('aria-labelledby') ?? null,
        outlet: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.settings.content'),
        url: location.href,
      }
    })()`)

    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39,
    })
    await new Promise(resolve => setTimeout(resolve, 220))
    const keyboard = await evaluateByValue(`(() => ({
      selected: document.querySelector('[data-settings-tab][aria-selected="true"]')?.getAttribute('data-settings-tab') ?? null,
      focused: document.activeElement?.getAttribute('data-settings-tab') ?? null,
      pluginContentPresent: document.querySelector('[data-settings-demo-content]') !== null,
    }))()`)

    const mountAgain = async () => {
      const rect = await tabRect()
      if (rect === null) throw new Error(`manager settings demo tab did not restore: ${qualifiedTabId}`)
      await pointerClick(rect)
      await new Promise(resolve => setTimeout(resolve, 220))
    }
    await mountAgain()
    const source = await evaluateByValue(
      `globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === ${
        JSON.stringify(owner)
      })?.source ?? null`,
    )
    if (source === null) throw new Error(`manager settings demo plugin source not found: ${owner}`)

    const denyPoint = async (pointId) =>
      await evaluateByValue(
        `(async () => {
      const runtime = globalThis.__cordisxRuntime
      await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, ${
          JSON.stringify(pointId)
        }, 'deny')
      await new Promise(resolve => setTimeout(resolve, 220))
      return {
        tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
        contentPresent: document.querySelector('[data-settings-demo-content]') !== null,
        fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
        outletMounted: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.settings.content')?.mounted ?? null,
      }
    })()`,
        true,
      )
    const restorePoint = async (pointId) =>
      await evaluateByValue(
        `(async () => {
      const runtime = globalThis.__cordisxRuntime
      await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${JSON.stringify(owner)}, ${
          JSON.stringify(pointId)
        }, 'inherit')
      await new Promise(resolve => setTimeout(resolve, 220))
      return {
        tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
        fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
      }
    })()`,
        true,
      )

    const surfaceDenied = await denyPoint('manager.settings.tabs')
    const surfaceRestored = await restorePoint('manager.settings.tabs')
    await mountAgain()
    const outletDenied = await denyPoint('manager.settings.content')
    const outletRestored = await restorePoint('manager.settings.content')
    await mountAgain()

    const blocked = await evaluateByValue(
      `(async () => {
      const runtime = globalThis.__cordisxRuntime
      await runtime.setPluginBlocked(${JSON.stringify(owner)}, true)
      await new Promise(resolve => setTimeout(resolve, 220))
      return {
        status: runtime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
        tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
        contentPresent: document.querySelector('[data-settings-demo-content]') !== null,
        fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
      }
    })()`,
      true,
    )
    const restored = await evaluateByValue(
      `(async () => {
      const runtime = globalThis.__cordisxRuntime
      await runtime.setPluginBlocked(${JSON.stringify(owner)}, false)
      await new Promise(resolve => setTimeout(resolve, 260))
      return {
        status: runtime.snapshot().plugins.find(item => item.id === ${JSON.stringify(owner)})?.status ?? null,
        tabPresent: document.querySelector('[data-settings-tab=${JSON.stringify(qualifiedTabId)}]') !== null,
        fallbackSelected: document.querySelector('[data-settings-tab="host:marketplace"]')?.getAttribute('aria-selected') === 'true',
      }
    })()`,
      true,
    )

    const locale = await evaluateByValue(
      `(async () => {
      const original = document.documentElement.lang
      const projectedLocale = original.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
      document.documentElement.lang = projectedLocale
      await new Promise(resolve => setTimeout(resolve, 260))
      const projected = document.querySelector('[data-settings-tab=${
        JSON.stringify(qualifiedTabId)
      }]')?.textContent?.trim() ?? null
      const runtimeTitle = globalThis.__cordisxRuntime.snapshot().settingsTabs.find(item => item.id === ${
        JSON.stringify(qualifiedTabId)
      })?.title ?? null
      document.documentElement.lang = original
      await new Promise(resolve => setTimeout(resolve, 260))
      return {
        original, projectedLocale, projected, runtimeTitle,
        expectedProjected: projectedLocale.toLowerCase().startsWith('zh') ? '演示插件' : 'Demo plugin',
        expectedRestored: original.toLowerCase().startsWith('zh') ? '演示插件' : 'Demo plugin',
        restored: document.querySelector('[data-settings-tab=${
        JSON.stringify(qualifiedTabId)
      }]')?.textContent?.trim() ?? null,
      }
    })()`,
      true,
    )
    await mountAgain()

    const final = await evaluateByValue(`(() => {
      const refs = globalThis.__cordisxSettingsSmokeNative
      const snapshot = globalThis.__cordisxRuntime.snapshot()
      const accesses = snapshot.extensionPoints.accessDiagnostics
        .filter(item => item.request.identity.pluginId === ${JSON.stringify(owner)}
          && ['manager.settings.tabs', 'manager.settings.content'].includes(item.request.identity.pointId))
      return {
        url: location.href,
        contentMounted: document.querySelector('[data-settings-demo-content="mounted"]') !== null,
        native: {
          sameMain: refs?.main === document.querySelector('[data-app-shell-main-content-layout]'),
          mainConnected: refs?.main?.isConnected ?? false,
          sameSelected: refs?.selected === document.querySelector('[data-app-action-sidebar-thread-selected="true"]'),
          selectedConnected: refs?.selected?.isConnected ?? false,
          selectedStable: refs?.selected == null
            ? document.querySelector('[data-app-action-sidebar-thread-selected="true"]') === null
            : refs.selected === document.querySelector('[data-app-action-sidebar-thread-selected="true"]') && refs.selected.isConnected,
        },
        access: {
          operations: [...new Set(accesses.map(item => item.request.operation))],
          generations: [...new Set(accesses.map(item => item.request.generation))],
          allAttributed: accesses.length >= 3 && accesses.every(item => item.request.identity.source === ${
      JSON.stringify(source)
    }),
        },
      }
    })()`)
    settingsTabsReport = {
      owner,
      qualifiedTabId,
      initial,
      mounted,
      keyboard,
      policy: { surfaceDenied, surfaceRestored, outletDenied, outletRestored },
      lifecycle: { blocked, restored },
      locale,
      final,
      passed: initial.url === 'app://-/index.html'
        && initial.structuredHeader === true
        && initial.tabs.map(item => item.id).join(',')
          === ['host:marketplace', qualifiedTabId, 'host:runtime', 'host:launcher'].join(',')
        && mounted.contentMounted === true && mounted.bodyOnly === true && mounted.controlledBody === true
        && mounted.url === initial.url && keyboard.selected === 'host:runtime' && keyboard.focused === 'host:runtime'
        && surfaceDenied.tabPresent === false && surfaceDenied.contentPresent === false
        && surfaceDenied.fallbackSelected === true
        && outletDenied.tabPresent === false && outletDenied.contentPresent === false
        && outletDenied.fallbackSelected === true
        && surfaceRestored.tabPresent === true && surfaceRestored.fallbackSelected === true
        && outletRestored.tabPresent === true && outletRestored.fallbackSelected === true
        && blocked.status === 'blocked' && blocked.tabPresent === false && blocked.contentPresent === false
        && blocked.fallbackSelected === true
        && restored.status === 'active' && restored.tabPresent === true && restored.fallbackSelected === true
        && locale.projected === locale.expectedProjected && locale.runtimeTitle === locale.expectedProjected
        && locale.restored === locale.expectedRestored
        && final.url === initial.url && final.contentMounted === true
        && final.native.sameMain === true && final.native.mainConnected === true
        && final.native.selectedStable === true
        && final.access.operations.includes('surface.route.navigate')
        && final.access.operations.includes('outlet.route.navigate')
        && final.access.operations.includes('outlet.page.mount')
        && final.access.allAttributed === true,
    }
    console.log(`manager-settings=${JSON.stringify(settingsTabsReport, null, 2)}`)
  }

  if (values['manager-settings-navigation-exercise']) {
    const owner = values['plugin-owner'] ?? 'settings-tab-demo'
    const qualifiedId = `${owner}:navigation`
    const source = await evaluateByValue(
      `globalThis.__cordisxRuntime?.snapshot?.().plugins?.find(item => item.id === ${
        JSON.stringify(owner)
      })?.source ?? null`,
    )
    if (source === null) throw new Error(`settings navigation demo plugin source not found: ${owner}`)
    const ready = await evaluateByValue(
      `(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      if (trigger instanceof HTMLElement) trigger.click()
      else if (modal instanceof HTMLElement && modal.hidden) modal.hidden = false
      return await waitFor(() => document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null)
    })()`,
      true,
    )
    const rowRect = await evaluateByValue(
      `(() => {
      const row = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]')
      if (!(row instanceof HTMLElement)) return null
      const rect = row.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
    })()`,
      true,
    )
    if (rowRect === null) throw new Error(`settings navigation item is not interactable: ${qualifiedId}`)
    await pointerClick(rowRect)
    const initial = await evaluateByValue(
      `(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (predicate()) return true
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      }
      const mounted = await waitFor(() => document.querySelector('[data-settings-navigation-demo-content="mounted"]') !== null)
      const runtime = globalThis.__cordisxRuntime.snapshot()
      return {
        ready: ${JSON.stringify(ready)}, mounted,
        rows: [...document.querySelectorAll('[data-settings-navigation-item]')].map(row => ({ id: row.getAttribute('data-settings-navigation-item'), icon: row.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null, disabled: row.disabled })),
        settingsTabs: runtime.settingsTabs,
        legacySettings: document.querySelector('[data-tab="settings"],[data-settings-tab]') !== null,
        page: document.querySelector('[data-cordisx-manager-page="${qualifiedId}"]') !== null,
        hostHeader: document.querySelector('.cxm-heading-leading-stack [data-host-icon="host:settings"]') !== null,
        outlet: runtime.navigation.outlets.find(item => item.id === 'manager.content') ?? null,
      }
    })()`,
      true,
    )
    await pressKey('ArrowUp', 'ArrowUp', 38)
    const keyboardUp = await evaluateByValue(
      `document.activeElement?.getAttribute('data-manager-navigation-id') ?? null`,
    )
    await pressKey('ArrowDown', 'ArrowDown', 40)
    const keyboardDown = await evaluateByValue(
      `document.activeElement?.getAttribute('data-settings-navigation-item') ?? null`,
    )
    const lifecycle = await evaluateByValue(
      `(async () => {
      const runtime = globalThis.__cordisxRuntime
      await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${
        JSON.stringify(owner)
      }, 'manager.settings.navigation-items', 'deny')
      await new Promise(resolve => setTimeout(resolve, 140))
      const denied = { row: document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null, body: document.querySelector('[data-settings-navigation-demo-content]') !== null, fallback: document.querySelector('[data-tab="plugins"]')?.getAttribute('aria-current') === 'page', mounted: runtime.snapshot().navigation.outlets.find(item => item.id === 'manager.content')?.mounted ?? null }
      await runtime.setExtensionPointPolicy(${JSON.stringify(source)}, ${
        JSON.stringify(owner)
      }, 'manager.settings.navigation-items', 'allow')
      await new Promise(resolve => setTimeout(resolve, 140))
      const restored = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]') !== null
      return { denied, restored }
    })()`,
      true,
    )
    const localeResult = await evaluateByValue(
      `(async () => {
      const target = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
      globalThis.__cordisxSetSmokeLocale(target)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const snapshot = globalThis.__cordisxRuntime.snapshot().localization.locale
        if (document.documentElement.lang === target && snapshot === target) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      const title = document.querySelector('[data-settings-navigation-item="${qualifiedId}"]')?.textContent?.trim() ?? null
      globalThis.__cordisxSetSmokeLocale(${JSON.stringify(locale ?? 'en')})
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const snapshot = globalThis.__cordisxRuntime.snapshot().localization.locale
        if (document.documentElement.lang === ${JSON.stringify(locale ?? 'en')} && snapshot === ${
        JSON.stringify(locale ?? 'en')
      }) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return { target, title, restored: document.documentElement.lang, snapshot: globalThis.__cordisxRuntime.snapshot().localization.locale }
    })()`,
      true,
    )
    settingsTabsReport = {
      initial,
      keyboard: { up: keyboardUp, down: keyboardDown },
      lifecycle,
      locale: localeResult,
      passed: initial.ready === true && initial.mounted === true && initial.rows.some(item =>
        item.id === qualifiedId && item.icon === 'host:settings' && item.disabled === false
      )
        && initial.settingsTabs.length === 0 && initial.legacySettings === false && initial.page === true
        && initial.hostHeader === true && initial.outlet?.mounted === true
        && keyboardUp === 'marketplace' && keyboardDown === qualifiedId
        && lifecycle.denied.row === false && lifecycle.denied.body === false && lifecycle.denied.fallback === true
        && lifecycle.denied.mounted === false && lifecycle.restored === true
        && localeResult.snapshot === (locale ?? 'en') && localeResult.restored === (locale ?? 'en'),
    }
    console.log(`manager-settings-navigation=${JSON.stringify(settingsTabsReport, null, 2)}`)
  }

  if (values['config-exercise']) {
    configExerciseReport = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const value = predicate()
          if (value) return value
          await wait(50)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      const openPluginConfig = async owner => {
        document.querySelector('[data-cordisx-manager-trigger]')?.click()
        document.querySelector('[data-tab="plugins"]')?.click()
        await waitFor(() => document.querySelector('[data-plugin-id="' + owner + '"]'), owner + ' manager row')
        document.querySelector('[data-plugin-id="' + owner + '"]')?.click()
        await waitFor(() => document.querySelector('[data-plugin-detail-tab="config"]'), owner + ' detail tabs')
        document.querySelector('[data-plugin-detail-tab="config"]')?.click()
        return waitFor(() => document.querySelector('[data-plugin-config-form="' + owner + '"]'), owner + ' config form')
      }
      const edit = async (owner, path, value, selector) => {
        const before = runtime.snapshot().plugins.find(plugin => plugin.id === owner)
        const form = await openPluginConfig(owner)
        const field = form.querySelector('[data-config-path="' + path + '"]')
        const control = await waitFor(() => field?.querySelector(selector), owner + ' ' + path + ' control')
        const label = field?.querySelector('label')
        const labelOwnsControl = label?.htmlFor !== '' && label?.htmlFor === control.id
        const panelText = form.closest('[role="tabpanel"]')?.textContent ?? ''
        const productSurface = {
          label: label?.textContent ?? null,
          rawPathVisible: field?.querySelector('.cxm-config-path') !== null,
          summaryGridVisible: form.closest('[role="tabpanel"]')?.querySelector('.cxm-detail-grid') !== null,
          internalMetadataVisible: ['Schemastery', 'Revision', '实时发布（不重载）'].some(value => panelText.includes(value)),
        }
        control.value = String(value)
        control.dispatchEvent(new Event('input', { bubbles: true }))
        form.requestSubmit()
        const after = await waitFor(() => {
          const plugin = runtime.snapshot().plugins.find(item => item.id === owner)
          return plugin?.configuration.revision === (before?.configuration.revision ?? -1) + 1 ? plugin : undefined
        }, owner + ' revision commit')
        return {
          beforeRevision: before?.configuration.revision ?? null,
          afterRevision: after.configuration.revision,
          applies: after.configuration.applies,
          labelOwnsControl,
          controlType: control.type,
          panelRole: form.closest('[role="tabpanel"]')?.getAttribute('role') ?? null,
          productSurface,
        }
      }
      const liveState = globalThis.__cordisxConfigFixture
      const restartState = globalThis.__cordisxRestartConfigFixture
      if (liveState === undefined || restartState === undefined) throw new Error('config smoke fixture state is unavailable')
      const before = {
        liveApply: liveState.liveApply,
        liveDispose: liveState.liveDispose,
        restartApply: [...restartState.restartApply],
        restartDispose: restartState.restartDispose,
      }
      const live = await edit('live-config', 'timeout', 47, 'input[type="range"]')
      document.querySelector('.cxm-back')?.click()
      const restart = await edit('restart-config', 'label', 'smoke-restart', 'input[type="text"]')
      const after = {
        liveApply: liveState.liveApply,
        liveDispose: liveState.liveDispose,
        liveValues: [...liveState.liveValues],
        restartApply: [...restartState.restartApply],
        restartDispose: restartState.restartDispose,
      }
      const assertions = {
        appRenderer: location.href === 'app://-/index.html',
        structuredForms: live.panelRole === 'tabpanel' && restart.panelRole === 'tabpanel',
        accessibleLabels: live.labelOwnsControl && restart.labelOwnsControl,
        productTaskSurface: !live.productSurface.rawPathVisible && !restart.productSurface.rawPathVisible
          && !live.productSurface.summaryGridVisible && !restart.productSurface.summaryGridVisible
          && !live.productSurface.internalMetadataVisible && !restart.productSurface.internalMetadataVisible,
        customRenderer: live.controlType === 'range',
        liveWithoutReload: after.liveApply === before.liveApply && after.liveDispose === before.liveDispose
          && after.liveValues.at(-1) === 47,
        owningRestartOnly: after.restartApply.length === before.restartApply.length + 1
          && after.restartApply.at(-1) === 'smoke-restart' && after.restartDispose === before.restartDispose + 1
          && after.liveApply === before.liveApply,
        revisionsCommitted: live.afterRevision === live.beforeRevision + 1
          && restart.afterRevision === restart.beforeRevision + 1,
      }
      return {
        result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
        url: location.href,
        live,
        restart,
        before,
        after,
        assertions,
      }
    })()`,
      true,
    )
    console.log(`configExercise=${JSON.stringify(configExerciseReport, null, 2)}`)
  }

  if (values.exercise) {
    await evaluateByValue(`(() => {
      document.querySelector('.cxm-close')?.click()
      for (const page of document.querySelectorAll('[data-cordisx-page]')) {
        page.querySelector('button[aria-label="Close"]')?.click()
      }
    })()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    const separatorBefore = await evaluateByValue(`(() => {
      const separator = [...document.querySelectorAll('[role="separator"]')]
        .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-orientation') === 'vertical')
        .sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0]
      const rect = separator?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    let drag = { attempted: false }
    if (separatorBefore !== null && separatorBefore !== undefined) {
      const startX = separatorBefore.x + separatorBefore.width / 2
      const startY = Math.max(80, separatorBefore.y + Math.min(separatorBefore.height / 2, 300))
      const endX = startX + 36
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY })
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: startX,
        y: startY,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: startY, button: 'left', buttons: 1 })
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: endX,
        y: startY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      await new Promise(resolve => setTimeout(resolve, 350))
      const separatorAfter = await evaluateByValue(`(() => {
        const separator = [...document.querySelectorAll('[role="separator"]')]
          .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-orientation') === 'vertical')
          .sort((left, right) => right.getBoundingClientRect().height - left.getBoundingClientRect().height)[0]
        const rect = separator?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      drag = {
        attempted: true,
        before: separatorBefore,
        after: separatorAfter,
        deltaX: separatorAfter === null ? null : separatorAfter.x - separatorBefore.x,
      }
      if (separatorAfter !== null) {
        const restoreX = separatorAfter.x + separatorAfter.width / 2
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: restoreX, y: startY })
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: restoreX,
          y: startY,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        })
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY, button: 'left', buttons: 1 })
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: startX,
          y: startY,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        })
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }

    exerciseReport = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      document.querySelector('.cxm-close')?.click()
      for (const page of document.querySelectorAll('[data-cordisx-page]')) {
        page.querySelector('button[aria-label="Close"]')?.click()
      }
      await wait(100)
      const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
      const button = label => [...document.querySelectorAll('button')]
        .filter(visible)
        .filter(element => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim()) === label)
        .at(-1)
      const rect = element => {
        const value = element?.getBoundingClientRect()
        return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height }
      }
      const selectedRaw = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
      const sessionId = selectedRaw?.startsWith('local:') ? selectedRaw.slice('local:'.length) : undefined
      if (sessionId === undefined) throw new Error('exercise requires a selected local native session')
      const nativeRootFor = id => {
        const candidates = [...document.querySelectorAll([
          '[data-codex-thread-reference-drop-target]',
          '[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]',
        ].join(','))]
          .filter(visible)
          .filter(element => [...element.querySelectorAll('[data-response-annotation-conversation]')]
            .some(child => child.getAttribute('data-response-annotation-conversation') === id)
            && [...element.querySelectorAll('[data-above-composer-conversation-id]')]
              .some(child => child.getAttribute('data-above-composer-conversation-id') === id))
        return candidates.length === 1 ? candidates[0] : undefined
      }
      const nativeRoot = nativeRootFor(sessionId)
      if (nativeRoot === undefined) throw new Error('native session content root not found')
      const nativeParent = nativeRoot.parentElement
      const initialMain = document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]')
      const initialNative = {
        rootConnected: nativeRoot.isConnected,
        parentConnected: nativeParent?.isConnected ?? false,
        display: getComputedStyle(nativeRoot).display,
        visibility: getComputedStyle(nativeRoot).visibility,
        mainRect: rect(initialMain),
        sessionRect: rect(nativeRoot),
        childCount: nativeRoot.childElementCount,
      }
      let nativeMutationCount = 0
      const observer = new MutationObserver(records => {
        for (const record of records) {
          const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement
          if (target?.closest?.('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]')) continue
          const changed = [...record.addedNodes, ...record.removedNodes]
          const onlyCordisX = changed.length > 0 && changed.every(node => node.nodeType === Node.ELEMENT_NODE
            && node.matches?.('[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]'))
          if (!onlyCordisX) nativeMutationCount += 1
        }
      })
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })

      const hideSidebar = button('隐藏边栏')
      const sidebarBefore = rect(document.querySelector('[role="separator"][aria-orientation="vertical"]'))
      hideSidebar?.click()
      await wait(500)
      const collapsed = button('显示边栏') !== undefined
      const collapsedMain = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
      button('显示边栏')?.click()
      await wait(500)
      const expanded = button('隐藏边栏') !== undefined
      const sidebarAfter = rect(document.querySelector('[role="separator"][aria-orientation="vertical"]'))

      const panelResult = {}
      for (const [key, label] of [['bottom', '切换底部面板显示'], ['right', '显示/隐藏侧边面板']]) {
        const control = button(label)
        const before = control?.getAttribute('aria-pressed') ?? null
        const mainBefore = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
        control?.click()
        await wait(500)
        const afterControl = button(label)
        const after = afterControl?.getAttribute('aria-pressed') ?? null
        const mainAfter = rect(document.querySelector('[data-app-shell-main-content-layout="thread-edge-scroll"]'))
        panelResult[key] = { found: control !== undefined, before, after, mainBefore, mainAfter }
        if (control !== undefined && before !== after) {
          afterControl?.click()
          await wait(350)
        }
      }

      await runtime.navigate('slot-showcase', { id: 'main.analytics' })
      await wait(120)
      const mainPage = document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')
      const back = mainPage?.querySelector('button[aria-label="Back"]')
      const pageBackEnabled = back !== null && back?.disabled === false
      const nativeNavigationButton = label => [...document.querySelectorAll('button')]
        .filter(visible)
        .filter(element => element.getAttribute('aria-label') === label)
        .filter(element => element.closest('[data-browser-sidebar-toolbar]') === null)
        .find(element => element.closest('[data-test-id="header-shell-slot"]') !== null)
        ?? [...document.querySelectorAll('button')]
          .filter(visible)
          .find(element => element.getAttribute('aria-label') === label
            && element.closest('[data-browser-sidebar-toolbar]') === null)
      const nativeBackAfterPush = nativeNavigationButton('返回') ?? nativeNavigationButton('Back')
      const nativeForwardAfterPush = nativeNavigationButton('前进') ?? nativeNavigationButton('Forward')
      const nativeBackEnabledAfterPush = nativeBackAfterPush?.disabled === false
      const nativeForwardEnabledAfterPush = nativeForwardAfterPush?.disabled === false
      const browserHistoryAfterPush = { length: history.length, state: history.state }
      nativeBackAfterPush?.click()
      await wait(350)
      const mainAfterBack = runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')
      const nativeForwardAfterBack = nativeNavigationButton('前进') ?? nativeNavigationButton('Forward')
      const nativeForwardEnabledAfterBack = nativeForwardAfterBack?.disabled === false
      nativeForwardAfterBack?.click()
      await wait(350)
      const mainAfterForward = runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')
      document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"] button[aria-label="Close"]')?.click()
      await wait(250)
      const mainAfterClose = runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')

      await runtime.navigate('slot-showcase', { id: 'app.overview' })
      await wait(120)
      const appPage = document.querySelector('[data-cordisx-page="slot-showcase:app.overview"]')
      const originalLang = document.documentElement.lang
      const originalText = appPage?.textContent ?? ''
      const projectedLang = originalLang.toLowerCase().startsWith('zh') ? 'en' : 'zh-CN'
      document.documentElement.lang = projectedLang
      await wait(180)
      const projectedText = appPage?.textContent ?? ''
      document.documentElement.lang = originalLang
      await wait(180)
      const restoredText = appPage?.textContent ?? ''
      appPage?.querySelector('button[aria-label="Close"]')?.click()
      await wait(120)

      await runtime.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId } })
      await wait(200)
      const sessionPage = document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]')
      const nativeDuringPage = {
        sameRoot: nativeRootFor(sessionId) === nativeRoot,
        sameParent: nativeRoot.parentElement === nativeParent,
        connected: nativeRoot.isConnected,
        display: getComputedStyle(nativeRoot).display,
        visibility: getComputedStyle(nativeRoot).visibility,
        pageRect: rect(sessionPage),
        active: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
      }

      const alternate = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .filter(visible)
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') !== selectedRaw)
      const alternateId = alternate?.getAttribute('data-app-action-sidebar-thread-id') ?? null
      alternate?.click()
      await wait(1800)
      const switched = {
        selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
        oldNativeRootConnected: nativeRoot.isConnected,
        outlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
        pagePresent: document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]') !== null,
      }
      const originalRow = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === selectedRaw)
      originalRow?.click()
      await wait(1800)
      const returned = {
        selected: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
        outlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'session.content'),
        autoRestoredPage: document.querySelector('[data-cordisx-page="slot-showcase:session.analytics"]') !== null,
      }

      await runtime.setPluginBlocked('slot-showcase', true)
      await wait(120)
      const blocked = {
        plugin: runtime.snapshot().plugins.find(plugin => plugin.id === 'slot-showcase')?.status,
        commands: runtime.snapshot().commands.length,
        registrationsRendered: runtime.snapshot().registrations.filter(item => item.rendered).length,
        pages: document.querySelectorAll('[data-cordisx-page]').length,
      }
      await runtime.setPluginBlocked('slot-showcase', false)
      await wait(180)
      const restored = {
        plugin: runtime.snapshot().plugins.find(plugin => plugin.id === 'slot-showcase')?.status,
        commands: runtime.snapshot().commands.length,
        registrationsRendered: runtime.snapshot().registrations.filter(item => item.rendered).length,
      }
      let finalNavigate = 'started'
      void runtime.navigate('slot-showcase', { id: 'main.analytics' }).then(
        () => { finalNavigate = 'settled' },
        error => { finalNavigate = 'rejected:' + String(error) },
      )
      await wait(180)
      observer.disconnect()
      return {
        sessionId,
        alternateId,
        initialNative,
        sidebar: { before: sidebarBefore, collapsed, collapsedMain, expanded, after: sidebarAfter },
        panels: panelResult,
        history: {
          pageBackEnabled,
          nativeBackEnabledAfterPush,
          nativeForwardEnabledAfterPush,
          nativeForwardEnabledAfterBack,
          browserAfterPush: browserHistoryAfterPush,
          afterBack: mainAfterBack,
          afterForward: mainAfterForward,
          afterClose: mainAfterClose,
        },
        localization: {
          originalLang, projectedLang,
          changed: originalText !== projectedText,
          restored: originalText === restoredText,
          originalSample: originalText.slice(0, 160),
          projectedSample: projectedText.slice(0, 160),
        },
        nativeDuringPage,
        sessionSwitch: { switched, returned },
        nativeMutationCount,
        blocked,
        restored,
        finalNavigate,
        browserUrlUnchanged: location.href === 'app://-/index.html',
        finalOutlet: runtime.snapshot().navigation.outlets.find(outlet => outlet.id === 'main'),
      }
    })()`,
      true,
    )
    exerciseReport.drag = drag
    console.log(`exercise=${JSON.stringify(exerciseReport, null, 2)}`)
  }

  return { exerciseReport, settingsTabsReport, configExerciseReport }
}
