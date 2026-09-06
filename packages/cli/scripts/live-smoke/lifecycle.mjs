import { readFile } from 'node:fs/promises'
import path from 'node:path'
export async function runLifecycleExercises({
  values,
  send,
  report,
  evaluateByValue,
  capture,
  pointerClick,
  pressKey,
}) {
  let managerLifecycleReport

  let generationTransactionReport

  if (values['manager-lifecycle-source'] !== undefined) {
    const sourceDirectory = values['manager-lifecycle-source']
    const sourceManifest = JSON.parse(await readFile(path.join(sourceDirectory, 'cordisx.plugin.json'), 'utf8'))
    if (typeof sourceManifest.version !== 'string') throw new Error('manager lifecycle source has no package version')
    const lifecycleViewportWidth = values['manager-viewport-width'] === undefined
      ? 1280
      : Number(values['manager-viewport-width'])
    if (!Number.isInteger(lifecycleViewportWidth) || lifecycleViewportWidth < 400 || lifecycleViewportWidth > 3840) {
      throw new Error('--manager-viewport-width must be an integer between 400 and 3840')
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: lifecycleViewportWidth,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const reportPath = path.resolve(values.report)
    const extension = path.extname(reportPath)
    const stem = path.basename(reportPath, extension)
    const artifact = suffix => path.join(path.dirname(reportPath), `${stem}.${suffix}.png`)
    const installed = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate()
          if (value) return value
          await wait(50)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const rect = element => {
        const value = element?.getBoundingClientRect()
        return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height,
          right: value.right, bottom: value.bottom }
      }
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      document.querySelector('[data-permission-authorization] [data-authorization-decision="cancel"]')?.click()
      document.querySelector('[data-host-form="local-package-directory"] .cxf-actions button.t-button:first-child')?.click()
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      if (modal?.hidden !== false) {
        if (trigger !== null && modal?.hidden !== false) trigger.click()
        else if (modal instanceof HTMLElement) modal.hidden = false
      }
      document.querySelector('[data-tab="plugins"]')?.click()
      let preImportCleanup = false
      const current = runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')
      if (current?.package?.version === ${JSON.stringify(sourceManifest.version)}) {
        document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')?.click()
        const popup = await waitFor(() => document.querySelector('body > .cxc-menu-popup'), 'existing package menu')
        const uninstall = popup.querySelector('[data-collection-action="uninstall"]')
        if (!(uninstall instanceof HTMLButtonElement) || uninstall.disabled) throw new Error('existing package uninstall is unavailable')
        uninstall.click()
        const confirmation = await waitFor(() => document.querySelector('.cxm-lifecycle-overlay'), 'existing package uninstall confirmation')
        confirmation.querySelector('.cxm-lifecycle-actions button.t-button:last-child')?.click()
        await waitFor(() => !runtime.snapshot().plugins.some(item => item.id === 'lifecycle-smoke'), 'existing package cleanup')
        preImportCleanup = true
      }
      const revisionBefore = runtime.snapshot().pluginLifecycle?.revision ?? null
      const install = await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'local import action')
      install.click()
      const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog [data-import-local-path]'), 'local package input')
      input.value = ${JSON.stringify(sourceDirectory)}
      input.onChange?.(${JSON.stringify(sourceDirectory)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const submit = document.querySelector('[data-import-local-submit]')
      if (!(submit instanceof HTMLElement)) throw new Error('local import submit action is unavailable')
      submit.click()
      await waitFor(() => document.querySelector('[data-import-local-path]') === null, 'local import dialog close')
      const authorization = await waitFor(() => {
        const prompt = document.querySelector('[data-permission-authorization="lifecycle-smoke"]')
        if (prompt !== null) return { prompt, appliedWithoutPrompt: false }
        const error = [...document.querySelectorAll('.cxm-content .cxm-error')]
          .map(item => item.textContent?.trim()).find(Boolean)
        if (error) return { prompt: null, appliedWithoutPrompt: false, error }
        const revision = runtime.snapshot().pluginLifecycle?.revision ?? null
        return revision !== revisionBefore ? { prompt: null, appliedWithoutPrompt: true } : null
      }, 'local import authorization or applied revision')
      if (authorization.error) throw new Error('local import failed: ' + authorization.error)
      const authorizationState = authorization.prompt === null ? {
        mode: 'not-required', title: null, optional: null, primaryFocused: null,
      } : {
        mode: 'prompted',
        title: authorization.prompt.querySelector('h2')?.textContent ?? null,
        optional: authorization.prompt.querySelector('[data-authorization-choice="models.read"]')?.disabled === false,
        primaryFocused: document.activeElement === authorization.prompt.querySelector('[data-authorization-decision="allow"]'),
      }
      authorization.prompt?.querySelector('[data-authorization-decision="allow"]')?.click()
      await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'imported plugin row')
      const plugin = await waitFor(() => {
        const snapshot = runtime.snapshot()
        const item = snapshot.plugins.find(candidate => candidate.id === 'lifecycle-smoke' && candidate.status === 'active')
        return item !== undefined && (snapshot.pluginLifecycle?.revision ?? null) !== revisionBefore ? item : null
      }, 'active imported plugin')
      await runtime.settleRegistryProjection()
      await wait(180)
      const currentRow = await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"]'), 'current installed plugin row')
      return {
        appRenderer: location.href === 'app://-/index.html',
        authorization: authorizationState,
        preImportCleanup,
        revisionBefore,
        revision: runtime.snapshot().pluginLifecycle?.revision ?? null,
        plugin: { id: plugin.id, status: plugin.status, source: plugin.source, package: plugin.package },
        localSourceProjected: JSON.stringify(runtime.snapshot()).includes(${JSON.stringify(sourceDirectory)}),
        primaryRect: rect(currentRow.querySelector('[data-plugin-primary="lifecycle-smoke"]')),
        managerRect: rect(document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')),
      }
    })()`,
      true,
    )
    if (
      installed.primaryRect === null || installed.primaryRect.width <= 0 || installed.primaryRect.height <= 0
      || installed.managerRect === null
    ) throw new Error('installed lifecycle fixture is not visible')
    const screenshots = {
      installed: await capture(installed.managerRect, artifact('lifecycle-installed'), 'installed lifecycle plugin'),
    }

    const inspectPluginCard = async () =>
      await evaluateByValue(`(() => {
      const row = document.querySelector('[data-plugin-card="lifecycle-smoke"]')
      const primary = row?.querySelector('[data-plugin-primary="lifecycle-smoke"]')
      const actions = row?.querySelector('.cxc-actions')
      const rowRect = row?.getBoundingClientRect()
      const primaryRect = primary?.getBoundingClientRect()
      const actionRect = actions?.getBoundingClientRect()
      const style = actions === null || actions === undefined ? null : getComputedStyle(actions)
      const tooltip = document.querySelector('[role="tooltip"]')
      return {
        actionOpacity: style?.opacity ?? null,
        actionPointerEvents: style?.pointerEvents ?? null,
        actionWidth: actionRect?.width ?? null,
        rowWidth: rowRect?.width ?? null,
        rowHeight: rowRect?.height ?? null,
        primaryWidth: primaryRect?.width ?? null,
        focused: document.activeElement === primary,
        tooltip: tooltip?.textContent?.trim() ?? null,
        describedBy: primary?.getAttribute('aria-describedby') ?? null,
        badge: primary?.querySelector('.cxc-status')?.getAttribute('data-tone') ?? null,
        persistentStatusText: (primary?.textContent ?? '').includes('运行中'),
      }
    })()`)
    const hiddenActions = await inspectPluginCard()
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      pointerType: 'mouse',
      x: installed.primaryRect.x + installed.primaryRect.width / 2,
      y: installed.primaryRect.y + installed.primaryRect.height / 2,
    })
    let hoveredTooltip = await inspectPluginCard()
    for (let attempt = 0; attempt < 40 && hoveredTooltip.tooltip === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      hoveredTooltip = await inspectPluginCard()
    }
    screenshots.tooltip = await capture(
      installed.managerRect,
      artifact('lifecycle-tooltip'),
      'hovered plugin status tooltip',
    )
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      pointerType: 'mouse',
      x: installed.managerRect.x + 12,
      y: installed.managerRect.y + 12,
    })
    await new Promise(resolve => setTimeout(resolve, 80))
    const tooltipDismissed = await evaluateByValue(`document.querySelector('[role="tooltip"]') === null`)
    await evaluateByValue(`document.querySelector('[data-plugin-primary="lifecycle-smoke"]')?.focus()`)
    await new Promise(resolve => setTimeout(resolve, 180))
    const focusedActions = await inspectPluginCard()
    const cardInteraction = { hiddenActions, hoveredTooltip, focusedActions, tooltipDismissed }

    if (values['generation-transaction-exercise']) {
      generationTransactionReport = await evaluateByValue(
        `(async () => {
        const runtime = globalThis.__cordisxRuntime
        if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
        const targetId = 'lifecycle-smoke'
        const snapshot = runtime.snapshot()
        const target = snapshot.plugins.find(plugin => plugin.id === targetId)
        if (target?.package === undefined) throw new Error('lifecycle smoke activation package is unavailable')
        const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
        const CORDISX_PAGE_SCHEMA_V3 = schema + 'page.v3.schema.json'
        const CORDISX_ROUTE_SCHEMA_V2 = schema + 'route.v2.schema.json'
        let previous
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const activation = runtime.activePluginGeneration()
          if (activation.recordKind === 'active' && activation.transactionId === undefined
            && activation.plugins.some(plugin => plugin.id === targetId)) {
            previous = activation
            break
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (previous === undefined) throw new Error('installed activation did not reach committed last-good state')
        const transactionId = 'live-generation-' + Date.now()
        const transactionEpoch = transactionId + ':host'
        const candidateGeneration = target.package.moduleGeneration + ':candidate'
        const candidateDigest = 'sha256:' + 'e'.repeat(64)
        const candidate = {
          ...previous, recordKind: 'candidate', transactionId, revision: previous.revision + 1,
          lastGoodRevision: previous.revision,
          plugins: previous.plugins.map(plugin => plugin.id === targetId
            ? { ...plugin, digest: candidateDigest, moduleGeneration: candidateGeneration }
            : plugin),
        }
        const packageManifest = {
          $schema: schema + 'plugin-package.v1.schema.json', schemaVersion: 1, id: targetId,
          version: target.package.version, entry: './module.js', compatibility: { runtimeAbi: 1, protocol: 1 },
          dependencies: candidate.plugins.find(plugin => plugin.id === targetId).dependencies,
          runtimeManifest: {
            $schema: schema + 'plugin-manifest.v1.schema.json', schemaVersion: 1, id: targetId,
            name: 'Lifecycle Smoke Candidate', capabilities: [],
          },
        }
        const candidateModuleFactory = console => ({
          name: 'Lifecycle Smoke Candidate', inject: ['i18n', 'commands', 'pages', 'routes', 'slots'],
          apply(ctx) {
            globalThis.__cordisxGenerationLiveSmoke = { candidateReady: true, selfCommand: false }
            console.log('generation-candidate-ready', { transactionId })
            const message = key => ({ namespace: 'lifecycle-smoke-candidate', key })
            ctx.i18n.define({
              namespace: 'lifecycle-smoke-candidate', locale: 'en', default: true,
              messages: {
                'command.invoke': 'Run candidate lifecycle smoke',
                'page.title': 'Lifecycle candidate status',
                'page.description': 'Shows the staged generation status inside the controlled main workspace page.',
                'route.title': 'Open lifecycle candidate status',
                'route.description': 'Open from the lifecycle smoke navigation item to inspect the staged candidate in the main outlet.',
              },
            })
            ctx.i18n.define({
              namespace: 'lifecycle-smoke-candidate', locale: 'zh-CN',
              messages: {
                'command.invoke': '运行候选生命周期冒烟',
                'page.title': '生命周期候选状态',
                'page.description': '在受控主工作区页面内展示 staged generation 的当前状态。',
                'route.title': '打开生命周期候选状态',
                'route.description': '从生命周期冒烟导航项进入，在 main outlet 中检查 staged candidate。',
              },
            })
            const label = message('command.invoke')
            ctx.commands.register({ id: 'invoke', title: label }, () => {
              globalThis.__cordisxGenerationLiveSmoke.selfCommand = true
            })
            ctx.pages.register({
              $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'overview',
              title: message('page.title'), description: message('page.description'),
              icon: 'host:refresh', chrome: 'body-only',
            }, () => () => undefined)
            ctx.routes.register({
              $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'overview',
              path: '/lifecycle-smoke', outlet: 'main', page: 'overview',
              title: message('route.title'), description: message('route.description'),
            })
            ctx.slots.register({ name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95 }, {
              label, icon: 'host:refresh', route: { id: 'overview' },
            })
            void ctx.commands.execute({ id: 'invoke' })
            ctx.effect(() => () => { globalThis.__cordisxGenerationLiveSmoke.candidateDisposed = true }, 'generation live smoke cleanup')
          },
        })
        const nativeNode = document.querySelector('main') ?? document.body
        const nativeUrl = location.href
        // Snapshot localization diagnostics are derived lazily. Reach the
        // Host-private microtask fixed point before the transaction baseline so
        // a completed live projection cannot be misattributed to candidate stage.
        runtime.snapshot()
        await runtime.settleRegistryProjection()
        const liveBefore = runtime.snapshot()
        await runtime.settleRegistryProjection()
        let notifications = 0
        const unsubscribe = runtime.subscribe(() => { notifications += 1 })
        const consoleBefore = runtime.pluginConsole(targetId)
        const traceStart = runtime.generationNotificationTrace().length
        const readiness = await runtime.stagePluginMutation({
          transactionId, transactionEpoch, operation: 'update', previous, candidate, targetId,
          affectedPluginIds: [targetId],
          package: { manifest: packageManifest, digest: candidateDigest, identitySource: 'file:///cordisx-live-smoke/candidate/module.js' },
        }, undefined, candidateModuleFactory)
        await new Promise(resolve => setTimeout(resolve, 20))
        const staged = runtime.snapshot()
        const consoleStaged = runtime.pluginConsole(targetId)
        const stageNotifications = notifications
        const publication = await runtime.publishPluginMutation(transactionId)
        await new Promise(resolve => setTimeout(resolve, 20))
        const published = runtime.snapshot()
        const consolePublished = runtime.pluginConsole(targetId)
        const publishNotifications = notifications
        const cleanup = await runtime.completePluginMutation(transactionId)
        const cleanupNotifications = notifications
        const rollback = await runtime.rollbackPluginMutation(transactionId)
        await new Promise(resolve => setTimeout(resolve, 20))
        const restored = runtime.snapshot()
        const consoleRestored = runtime.pluginConsole(targetId)
        unsubscribe()
        const marker = entry => JSON.stringify(entry).includes('generation-candidate-ready')
        const oldGeneration = target.package.moduleGeneration
        return {
          transactionId, transactionEpoch, readiness, publication, cleanup, rollback,
          visibility: {
            stageSnapshotUnchanged: JSON.stringify(staged) === JSON.stringify(liveBefore),
            stageNotifications,
            stageConsoleHidden: !consoleStaged.entries.some(marker),
            publishedGeneration: published.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration ?? null,
            publishedConsoleVisible: consolePublished.entries.some(marker),
            restoredGeneration: restored.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration ?? null,
            restoredConsoleHidden: !consoleRestored.entries.some(marker),
            oldConsolePreserved: consoleBefore.entries.every(entry => consoleRestored.entries.some(item => item.entryId === entry.entryId)),
            notifications, publishNotifications, cleanupNotifications,
            notificationTrace: runtime.generationNotificationTrace().slice(traceStart),
          },
          readinessView: { ...globalThis.__cordisxGenerationLiveSmoke },
          continuity: {
            appRenderer: location.href === 'app://-/index.html' && location.href === nativeUrl,
            nativeNodeIdentity: (document.querySelector('main') ?? document.body) === nativeNode,
            runtimeIdentity: globalThis.__cordisxRuntime === runtime,
          },
          passed: JSON.stringify(staged) === JSON.stringify(liveBefore)
            && stageNotifications === 0 && !consoleStaged.entries.some(marker)
            && published.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration === candidateGeneration
            && consolePublished.entries.some(marker)
            && restored.plugins.find(plugin => plugin.id === targetId)?.package?.moduleGeneration === oldGeneration
            && !consoleRestored.entries.some(marker)
            && notifications === 2
            && cleanup.disposedAfter.plugins.some(plugin => plugin.id === targetId && plugin.moduleGeneration === oldGeneration)
            && rollback.disposedAfter.plugins.some(plugin => plugin.id === targetId && plugin.moduleGeneration === candidateGeneration)
            && globalThis.__cordisxGenerationLiveSmoke.selfCommand === true
            && globalThis.__cordisxGenerationLiveSmoke.candidateDisposed === true
            && location.href === 'app://-/index.html' && (document.querySelector('main') ?? document.body) === nativeNode
            && globalThis.__cordisxRuntime === runtime,
        }
      })()`,
        true,
      )
      console.log(`generation-transaction=${JSON.stringify(generationTransactionReport, null, 2)}`)
      if (generationTransactionReport.passed !== true) throw new Error('generation transaction smoke assertions failed')
    }

    // The direct generation transaction intentionally exercises the renderer
    // authority without mutating the durable package journal. End that scenario
    // here; run the full Manager lifecycle as a separate fresh-profile smoke so
    // its next Host transaction cannot inherit a renderer-only registry epoch.
    if (!values['generation-transaction-exercise']) {
      await pointerClick(installed.primaryRect)
      await new Promise(resolve => setTimeout(resolve, 180))
      const pointerNavigation = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const detail = document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null
      document.querySelector('.cxm-back')?.click()
      for (let attempt = 0; attempt < 80 && document.querySelector('[data-plugin-primary="lifecycle-smoke"]') === null; attempt += 1) await wait(25)
      return { detail, restored: document.querySelector('[data-plugin-primary="lifecycle-smoke"]') !== null }
    })()`,
        true,
      )

      const focusPrimary = async () =>
        await evaluateByValue(`(() => {
      const primary = document.querySelector('[data-plugin-primary="lifecycle-smoke"]')
      primary?.focus()
      return document.activeElement === primary
    })()`)
      const keyboardNavigation = {}
      keyboardNavigation.enterFocused = await focusPrimary()
      await pressKey('Enter', 'Enter', 13)
      await new Promise(resolve => setTimeout(resolve, 120))
      keyboardNavigation.enterDetail = await evaluateByValue(
        `document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null`,
      )
      await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
      await new Promise(resolve => setTimeout(resolve, 120))
      keyboardNavigation.spaceFocused = await focusPrimary()
      await pressKey(' ', 'Space', 32)
      await new Promise(resolve => setTimeout(resolve, 120))
      keyboardNavigation.spaceDetail = await evaluateByValue(
        `document.querySelector('[data-manager-page-route^="plugin:lifecycle-smoke:"]') !== null`,
      )
      await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
      await new Promise(resolve => setTimeout(resolve, 120))

      const exercised = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate()
          if (value) return value
          await wait(50)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const rect = element => {
        const value = element?.getBoundingClientRect()
        return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height,
          right: value.right, bottom: value.bottom }
      }
      const runtime = globalThis.__cordisxRuntime
      const counters = globalThis.__cordisxLifecycleSmoke
      if (runtime === undefined || counters === undefined) throw new Error('lifecycle fixture runtime state is unavailable')
      const initial = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }
      document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="reload"]')?.click()
      await waitFor(() => counters.apply === initial.apply + 1 && counters.dispose === initial.dispose + 1, 'owning plugin reload')
      const afterReload = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

      document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="disable"]')?.click()
      const disableDialog = await waitFor(() => document.querySelector('.cxm-lifecycle-overlay'), 'disable impact confirmation')
      const disableImpact = disableDialog.querySelector('.cxm-lifecycle-impact')?.textContent ?? ''
      disableDialog.querySelector('.cxm-lifecycle-actions button.t-button:last-child')?.click()
      await waitFor(() => runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'configured-disabled', 'disabled plugin')
      await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="enable"]:not(:disabled)'), 'disabled plugin actions')
      const afterDisable = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

      document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="enable"]')?.click()
      let enableAuthorization
      for (let attempt = 0; attempt < 120; attempt += 1) {
        enableAuthorization = document.querySelector('[data-permission-authorization="lifecycle-smoke"]') ?? undefined
        if (enableAuthorization !== undefined
          || runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active') break
        await wait(50)
      }
      enableAuthorization?.querySelector('[data-authorization-decision="allow-once"]')?.click()
      await waitFor(() => runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active', 'enabled plugin')
      await waitFor(() => document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="reload"]:not(:disabled)'), 'enabled plugin actions')
      const afterEnable = { ...counters, revision: runtime.snapshot().pluginLifecycle?.revision ?? null }

      document.querySelector('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="favorite"]')?.click()
      await waitFor(() => document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger'), 'favorite rerender')
      const routeAfterFavorite = document.querySelector('[data-manager-page-route="primary:plugins"]') !== null
      const replacementTrigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')
      const favoriteFocusRestored = document.activeElement?.matches?.('[data-plugin-card="lifecycle-smoke"] [data-plugin-action="favorite"]') ?? false
      const menuTrigger = replacementTrigger
      menuTrigger?.click()
      const popup = await waitFor(() => document.querySelector('body > .cxc-menu-popup'), 'plugin action menu')
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      const modalWasHidden = modal?.hidden === true
      if (modal instanceof HTMLElement) modal.hidden = false
      const managerRect = rect(modal?.querySelector('[role="dialog"]'))
      const popupRect = rect(popup)
      const menu = {
        portaled: popup.parentElement === document.body,
        actions: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
          action: item.getAttribute('data-collection-action'), disabled: item.disabled,
        })),
        bounded: popupRect !== null && popupRect.x >= 0 && popupRect.y >= 0
          && popupRect.right <= innerWidth && popupRect.bottom <= innerHeight,
        firstItemFocused: popup.contains(document.activeElement),
        shareText: popup.querySelector('[data-collection-action="share"]')?.textContent?.trim() ?? null,
        icons: [...popup.querySelectorAll('[role="menuitem"]')].map(item => ({
          action: item.getAttribute('data-collection-action'),
          icon: item.querySelector('[data-material-icon]')?.getAttribute('data-material-icon') ?? null,
        })),
        triggerRect: rect(replacementTrigger),
      }
      return {
        initial, afterReload, disableImpact, afterDisable, afterEnable,
        enableAuthorization: enableAuthorization === undefined ? 'persisted-policy' : 'allow-once',
        routeAfterFavorite, favoriteFocusRestored, favoriteStored: localStorage.getItem('cordisx.manager.favoritePlugins.v1:smoke'),
        menu, menuRect: managerRect, modalWasHidden,
      }
    })()`,
        true,
      )
      if (exercised.menuRect === null) throw new Error('lifecycle action menu is not visible')
      screenshots.menu = await capture(exercised.menuRect, artifact('lifecycle-menu'), 'lifecycle action menu')

      if (exercised.menu.triggerRect === null) throw new Error('lifecycle action menu trigger is not visible')
      // Close/reopen with a trusted pointer, then validate keyboard, external-dismiss,
      // diagnostic execution, and block/restore cleanup against the real renderer.
      await pointerClick(exercised.menu.triggerRect)
      const menuToggle = await evaluateByValue(`(() => ({
      closed: document.querySelector('body > .cxc-menu-popup') === null,
      triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger') ?? false,
    }))()`)
      await pointerClick(exercised.menu.triggerRect)
      await pressKey('ArrowDown', 'ArrowDown', 40)
      await pressKey('End', 'End', 35)
      const menuKeyboard = await evaluateByValue(`(() => {
      const popup = document.querySelector('body > .cxc-menu-popup')
      return {
        open: popup !== null,
        focusedMenuItem: popup?.contains(document.activeElement) ?? false,
        activeAction: document.activeElement?.getAttribute?.('data-collection-action') ?? null,
      }
    })()`)
      await pressKey('Escape', 'Escape', 27)
      const menuEscape = await evaluateByValue(`(() => ({
      closed: document.querySelector('body > .cxc-menu-popup') === null,
      triggerFocused: document.activeElement?.matches?.('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger') ?? false,
    }))()`)

      await pointerClick(exercised.menu.triggerRect)
      const diagnosticTarget = await evaluateByValue(`(() => {
      const button = document.querySelector('body > .cxc-menu-popup [data-collection-action="diagnostics"]')
      const rect = button?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
      if (diagnosticTarget === null || diagnosticTarget.width <= 0 || diagnosticTarget.height <= 0) {
        throw new Error('diagnostic menu action is not visible')
      }
      await pointerClick(diagnosticTarget)
      const diagnosticExecution = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('[data-manager-page-route="plugin:lifecycle-smoke:runtime"]') !== null) break
        await wait(25)
      }
      return {
        runtimeRoute: document.querySelector('[data-manager-page-route="plugin:lifecycle-smoke:runtime"]') !== null,
        popupClosed: document.querySelector('body > .cxc-menu-popup') === null,
      }
    })()`,
        true,
      )
      await evaluateByValue(`document.querySelector('.cxm-back')?.click()`)
      await new Promise(resolve => setTimeout(resolve, 120))

      const outsideTarget = await evaluateByValue(`(() => {
      const trigger = document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')
      const rect = trigger?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
      if (outsideTarget === null) throw new Error('lifecycle action menu trigger disappeared')
      await pointerClick(outsideTarget)
      const outsideDismissTarget = await evaluateByValue(`(() => {
      const target = document.querySelector('.cxm-heading')
      const rect = target?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
      if (outsideDismissTarget === null || outsideDismissTarget.width <= 0 || outsideDismissTarget.height <= 0) {
        throw new Error('manager outside-dismiss target is not visible')
      }
      await pointerClick(outsideDismissTarget)
      const outsideDismiss = await evaluateByValue(`document.querySelector('body > .cxc-menu-popup') === null`)

      await pointerClick(outsideTarget)
      const blockRestore = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const runtime = globalThis.__cordisxRuntime
      await runtime.setPluginBlocked('lifecycle-smoke', true)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (document.querySelector('body > .cxc-menu-popup') === null) break
        await wait(25)
      }
      const closedOnBlock = document.querySelector('body > .cxc-menu-popup') === null
      await runtime.setPluginBlocked('lifecycle-smoke', false)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active') break
        await wait(25)
      }
      return {
        closedOnBlock,
        restored: runtime.snapshot().plugins.find(item => item.id === 'lifecycle-smoke')?.status === 'active',
        counters: { ...globalThis.__cordisxLifecycleSmoke },
      }
    })()`,
        true,
      )

      const uninstallPlan = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      let popup = document.querySelector('body > .cxc-menu-popup')
      if (popup === null) {
        document.querySelector('[data-plugin-menu="lifecycle-smoke"] .cxc-menu-trigger')?.click()
        for (let attempt = 0; attempt < 80 && popup === null; attempt += 1) {
          popup = document.querySelector('body > .cxc-menu-popup')
          if (popup === null) await wait(25)
        }
      }
      const uninstall = popup?.querySelector('[data-collection-action="uninstall"]')
      if (!(uninstall instanceof HTMLButtonElement) || uninstall.disabled) throw new Error('uninstall menu action is unavailable')
      uninstall.click()
      let dialog
      for (let attempt = 0; attempt < 120 && dialog === undefined; attempt += 1) {
        dialog = document.querySelector('.cxm-lifecycle-overlay') ?? undefined
        if (dialog === undefined) await wait(50)
      }
      const value = dialog?.getBoundingClientRect()
      return value === undefined ? null : {
        text: dialog.textContent?.trim() ?? '',
        rect: { x: value.x, y: value.y, width: value.width, height: value.height },
      }
    })()`,
        true,
      )
      if (uninstallPlan?.rect === undefined) throw new Error('uninstall confirmation did not open')
      screenshots.uninstall = await capture(
        uninstallPlan.rect,
        artifact('lifecycle-uninstall'),
        'lifecycle uninstall confirmation',
      )

      const removed = await evaluateByValue(
        `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const runtime = globalThis.__cordisxRuntime
      const counters = globalThis.__cordisxLifecycleSmoke
      const beforeRevision = runtime.snapshot().pluginLifecycle?.revision ?? null
      const expectedDispose = counters.dispose + 1
      document.querySelector('.cxm-lifecycle-overlay .cxm-lifecycle-actions button.t-button:last-child')?.click()
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (!runtime.snapshot().plugins.some(item => item.id === 'lifecycle-smoke') && counters.dispose >= expectedDispose) break
        await wait(50)
      }
      const snapshot = runtime.snapshot()
      return {
        beforeRevision,
        afterRevision: snapshot.pluginLifecycle?.revision ?? null,
        removed: !snapshot.plugins.some(item => item.id === 'lifecycle-smoke'),
        registrationsRemoved: !snapshot.registrations.some(item => item.owner === 'lifecycle-smoke'),
        routesRemoved: !snapshot.navigation.routes.some(item => item.owner === 'lifecycle-smoke'),
        pagesRemoved: !snapshot.navigation.pages.some(item => item.owner === 'lifecycle-smoke'),
        counters: { ...counters },
        appRenderer: location.href === 'app://-/index.html',
      }
    })()`,
        true,
      )

      const assertions = {
        appRenderer: installed.appRenderer && removed.appRenderer,
        authorization: installed.authorization.mode === 'not-required'
          || (/^(安装|更新)授权$/.test(installed.authorization.title ?? '') && installed.authorization.optional
            && installed.authorization.primaryFocused),
        installedWithoutLocalPath: installed.plugin.status === 'active' && installed.localSourceProjected === false
          && installed.revision !== installed.revisionBefore
          && installed.plugin.package?.canonicalSource
            === 'https://github.com/cordisx/cordisx/tree/main/examples/plugins/lifecycle-smoke',
        cardPresentation: cardInteraction.hiddenActions.actionOpacity === '0'
          && cardInteraction.hiddenActions.actionPointerEvents === 'none'
          && Number(cardInteraction.hoveredTooltip.actionOpacity) > 0.9
          && cardInteraction.hoveredTooltip.actionPointerEvents === 'auto'
          && cardInteraction.focusedActions.actionOpacity === '1'
          && cardInteraction.hiddenActions.actionWidth > 0 && cardInteraction.focusedActions.actionWidth > 0
          && cardInteraction.hiddenActions.rowWidth === cardInteraction.hoveredTooltip.rowWidth
          && cardInteraction.hoveredTooltip.rowWidth === cardInteraction.focusedActions.rowWidth
          && cardInteraction.hiddenActions.rowHeight === cardInteraction.hoveredTooltip.rowHeight
          && cardInteraction.hoveredTooltip.rowHeight === cardInteraction.focusedActions.rowHeight
          && cardInteraction.hoveredTooltip.tooltip === '运行中' && cardInteraction.hoveredTooltip.describedBy !== null
          && cardInteraction.hoveredTooltip.badge === 'success' && cardInteraction.focusedActions.focused
          && !cardInteraction.hoveredTooltip.persistentStatusText && cardInteraction.tooltipDismissed,
        pointerNavigation: pointerNavigation.detail && pointerNavigation.restored,
        keyboardNavigation: Object.values(keyboardNavigation).every(Boolean),
        owningReloadOnly: exercised.afterReload.apply === exercised.initial.apply + 1
          && exercised.afterReload.dispose === exercised.initial.dispose + 1
          && exercised.afterReload.revision === exercised.initial.revision,
        disableEnable: exercised.disableImpact.includes('lifecycle-smoke')
          && exercised.afterDisable.dispose === exercised.afterReload.dispose + 1
          && exercised.afterEnable.apply === exercised.afterReload.apply + 1,
        profileFavorite: exercised.routeAfterFavorite && exercised.favoriteFocusRestored
          && JSON.parse(exercised.favoriteStored ?? '[]').includes('lifecycle-smoke'),
        menu: exercised.menu.portaled && exercised.menu.bounded && exercised.menu.firstItemFocused
          && exercised.menu.actions.some(item => item.action === 'share' && item.disabled === false)
          && exercised.menu.actions.some(item => item.action === 'uninstall' && item.disabled === false)
          && exercised.menu.icons.some(item => item.action === 'share' && item.icon === 'share-plugin')
          && exercised.menu.icons.some(item => item.action === 'source' && item.icon === 'authors-source')
          && exercised.menu.icons.some(item => item.action === 'diagnostics' && item.icon === 'diagnostics'),
        menuInteraction: menuToggle.closed && menuToggle.triggerFocused
          && menuKeyboard.open && menuKeyboard.focusedMenuItem && menuKeyboard.activeAction !== null
          && menuEscape.closed && menuEscape.triggerFocused
          && diagnosticExecution.runtimeRoute && diagnosticExecution.popupClosed
          && outsideDismiss && blockRestore.closedOnBlock && blockRestore.restored,
        uninstallImpact: uninstallPlan.text.includes('lifecycle-smoke') && uninstallPlan.text.includes('确认卸载'),
        uninstallCleanup: removed.removed && removed.registrationsRemoved && removed.routesRemoved
          && removed.pagesRemoved
          && removed.counters.dispose === blockRestore.counters.dispose + 1,
      }
      managerLifecycleReport = {
        result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
        installed,
        cardInteraction,
        pointerNavigation,
        keyboardNavigation,
        exercised,
        menuInteraction: { menuToggle, menuKeyboard, menuEscape, diagnosticExecution, outsideDismiss, blockRestore },
        uninstallPlan: { text: uninstallPlan.text },
        removed,
        screenshots,
        assertions,
      }
      console.log(`manager-lifecycle=${JSON.stringify(managerLifecycleReport, null, 2)}`)
    }
  }

  return { managerLifecycleReport, generationTransactionReport }
}
