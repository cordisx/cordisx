import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function finalizeLiveSmoke({
  values,
  send,
  capture,
  ensureManagerClosed,
  colorScheme,
  evaluateByValue,
  report,
  runtimeExceptions,
  localeProjection,
  managerReport,
  hostCollectionMenuReport,
  exerciseReport,
  settingsTabsReport,
  configExerciseReport,
  demoReport,
  pluginLifecycleReport,
  pluginConsoleReport,
  authorizationReport,
  managerLifecycleReport,
  permissionV2Report,
  generationTransactionReport,
  uiCatalogReport,
  locale,
  socket,
  managerFormExerciseFailure,
  managerServiceConfigurationFailure,
  pluginConsoleAssertions,
}) {
  let managerThemeReport

  if (values['manager-theme-cycle']) {
    const inspectManagerTheme = async (theme, reopen) => {
      const evaluated = await send('Runtime.evaluate', {
        expression: `(async () => {
          const root = document.documentElement
          if (${JSON.stringify(theme === 'light')}) globalThis.__cordisxRestoreSmokeTheme?.()
          globalThis.__cordisxRestoreManagerThemeSmoke ??= {
            className: root.className,
            dataTheme: root.getAttribute('data-theme'),
          }
          const trigger = document.querySelector('[data-cordisx-manager-trigger]')
          const modal = document.querySelector('[data-cordisx-manager-modal]')
          if (modal === null) return null
          root.classList.remove('electron-dark', 'electron-light')
          root.classList.add(${JSON.stringify(theme === 'light' ? 'electron-light' : 'electron-dark')})
          root.setAttribute('data-theme', ${JSON.stringify(theme)})
          if (${reopen} && !modal.hidden) document.querySelector('.cxm-close')?.click()
          if (modal.hidden && trigger !== null) trigger.click()
          else if (modal.hidden) modal.hidden = false
          const themePluginId = ${JSON.stringify(values['manager-plugin'])}
          const themeDetailTab = ${JSON.stringify(values['manager-detail-tab'])}
          if (themePluginId === undefined) {
            if (!${JSON.stringify(values['manager-open-select'])}) document.querySelector('[data-tab="about"]')?.click()
          } else {
            document.querySelector('[data-tab="plugins"]')?.click()
            await new Promise(resolve => requestAnimationFrame(resolve))
            const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
              .find(item => item.getAttribute('data-plugin-id') === themePluginId || item.getAttribute('data-marketplace-plugin') === themePluginId)
            ;(row?.matches('button') === true ? row : row?.querySelector('.cxm-plugin-primary'))?.click()
            await new Promise(resolve => requestAnimationFrame(resolve))
            if (themeDetailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + themeDetailTab + '"]')?.click()
          }
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 120)
            requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
          })
          const projectionDeadline = Date.now() + 2_000
          while (modal.dataset.cordisxAppTheme !== ${JSON.stringify(theme)} && Date.now() < projectionDeadline) {
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          if (modal.dataset.cordisxAppTheme !== ${JSON.stringify(theme)}) {
            throw new Error('Host theme projection did not reach ${theme}')
          }
          if (${JSON.stringify(values['manager-open-select'])}) {
            // Closing the Manager deliberately clears its detail route. Reopen
            // the same structured Host route before checking the portaled
            // control, rather than treating a stale DOM node as evidence.
            const pluginId = ${JSON.stringify(values['manager-plugin'])}
            const detailTab = ${JSON.stringify(values['manager-detail-tab'])}
            const permissionCapability = ${JSON.stringify(values['manager-permission-capability'])}
            if (pluginId !== undefined) {
              document.querySelector('[data-tab="plugins"]')?.click()
              await new Promise(resolve => requestAnimationFrame(resolve))
              const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
                .find(item => item.getAttribute('data-plugin-id') === pluginId || item.getAttribute('data-marketplace-plugin') === pluginId)
              ;(row?.matches('button') === true ? row : row?.querySelector('.cxc-primary'))?.click()
              await new Promise(resolve => requestAnimationFrame(resolve))
              if (detailTab !== undefined) document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
              if (permissionCapability !== undefined) document.querySelector('[data-permission-open="' + CSS.escape(permissionCapability) + '"]')?.click()
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            }
            const select = [...document.querySelectorAll('.t-select input')]
              .find(item => item.getClientRects().length > 0)
            if (!(select instanceof HTMLElement)) throw new Error('visible TDesign Select is unavailable after theme projection')
            if (![...document.querySelectorAll('.cxr-root .t-select__dropdown')].some(popup => popup.getClientRects().length > 0)) {
              select.focus()
              select.click()
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            }
          }
          const dialog = modal.querySelector('[role="dialog"]')
          const marks = [...modal.querySelectorAll('img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]')]
          const navIcon = document.querySelector('[data-tab="plugins"] .cxm-nav-icon')
          const headingIcon = document.querySelector('.cxm-heading-leading')
          const popup = [...document.querySelectorAll('.cxr-root .t-select__dropdown')].find(item => item.getClientRects().length > 0)
          const visibleSelect = [...document.querySelectorAll('.t-select input')]
            .find(item => item.getClientRects().length > 0)
          return {
            rect: dialog === null ? null : (() => {
              const rect = dialog.getBoundingClientRect()
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            })(),
            systemTheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            appTheme: modal.dataset.cordisxAppTheme ?? null,
            themeSource: modal.dataset.cordisxThemeSource ?? null,
            modalHidden: modal.hidden,
            navIconColor: navIcon === null ? null : getComputedStyle(navIcon).color,
            headingIconColor: headingIcon === null ? null : getComputedStyle(headingIcon).color,
            selectControl: visibleSelect instanceof HTMLElement ? (() => {
              const tokens = getComputedStyle(visibleSelect)
              const controlSurfaces = [...visibleSelect.closest('.t-select').querySelectorAll('*')]
                .map(item => ({
                  tag: item.tagName.toLowerCase(), className: item.className,
                  background: getComputedStyle(item).backgroundColor, color: getComputedStyle(item).color,
                }))
                .filter(item => item.background !== 'rgba(0, 0, 0, 0)' && item.background !== 'transparent')
                .slice(0, 8)
              return {
                containerToken: tokens.getPropertyValue('--td-bg-color-container').trim(),
                specialToken: tokens.getPropertyValue('--td-bg-color-specialcomponent').trim(),
                selectedToken: tokens.getPropertyValue('--td-bg-color-container-select').trim(),
                colorScheme: tokens.colorScheme,
                controlSurfaces,
              }
            })() : null,
            selectPopup: popup instanceof HTMLElement ? {
              background: getComputedStyle(popup).backgroundColor,
              color: getComputedStyle(popup).color,
              optionCount: popup.querySelectorAll('.t-select-option').length,
              activeOption: (() => {
                const option = popup.querySelector('.t-select-option.t-is-selected, .t-select-option.t-select-option__hover')
                const surface = option
                const style = surface instanceof Element ? getComputedStyle(surface) : null
                const tokens = option instanceof Element ? getComputedStyle(option) : null
                return option === null ? null : {
                  selected: option.getAttribute('aria-selected'),
                  background: style?.backgroundColor ?? null,
                  color: style?.color ?? null,
                  selectedToken: tokens?.getPropertyValue('--td-bg-color-container-select').trim() ?? null,
                  activeToken: tokens?.getPropertyValue('--td-bg-color-container-active').trim() ?? null,
                  hoverToken: tokens?.getPropertyValue('--td-bg-color-container-hover').trim() ?? null,
                  disabledToken: tokens?.getPropertyValue('--td-bg-color-component-disabled').trim() ?? null,
                }
              })(),
            } : null,
            marks: marks.map(mark => ({
              background: mark.dataset.hostBackground ?? null,
              lightAsset: decodeURIComponent(mark.src).includes('CordisX mark for light backgrounds'),
              darkAsset: decodeURIComponent(mark.src).includes('CordisX mark for dark backgrounds'),
              selectable: getComputedStyle(mark).userSelect,
              draggable: mark.draggable,
              ariaHidden: mark.getAttribute('aria-hidden'),
            })),
          }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (evaluated.exceptionDetails !== undefined) {
        throw new Error(
          evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text
            ?? 'manager theme evaluation failed',
        )
      }
      return evaluated.result?.value ?? null
    }

    const light = await inspectManagerTheme('light', false)
    if (values['manager-light-screenshot'] !== undefined) {
      await capture(light?.rect ?? null, values['manager-light-screenshot'], 'CordisX Manager light theme')
    }
    const darkReopened = await inspectManagerTheme('dark', true)
    if (values['manager-dark-screenshot'] !== undefined) {
      await capture(darkReopened?.rect ?? null, values['manager-dark-screenshot'], 'CordisX Manager dark theme')
    }
    managerThemeReport = { light, darkReopened }
    console.log(`manager-theme=${JSON.stringify(managerThemeReport)}`)
    await send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.documentElement
        const previous = globalThis.__cordisxRestoreManagerThemeSmoke
        if (previous !== null && typeof previous === 'object') {
          root.className = previous.className
          if (previous.dataTheme === null) root.removeAttribute('data-theme')
          else root.setAttribute('data-theme', previous.dataTheme)
        }
        delete globalThis.__cordisxRestoreManagerThemeSmoke
      })()`,
    })
    if (values['manager-viewport-width'] !== undefined) await send('Emulation.clearDeviceMetricsOverride')
  }

  if (values['trigger-screenshot'] !== undefined) {
    await ensureManagerClosed()
    const evaluatedTrigger = await send('Runtime.evaluate', {
      expression: `(() => {
        const trigger = document.querySelector('[data-cordisx-manager-trigger]')
        const switcher = trigger?.previousElementSibling
        const right = trigger?.getBoundingClientRect()
        if (right === undefined) return null
        const switcherRect = switcher?.getBoundingClientRect()
        const left = switcherRect !== undefined && switcherRect.width > 0 && switcherRect.height > 0 ? switcherRect : right
        const x = Math.min(left.x, right.x)
        const y = Math.min(left.y, right.y)
        const edge = Math.max(left.right, right.right)
        const bottom = Math.max(left.bottom, right.bottom)
        return { x, y, width: edge - x, height: bottom - y }
      })()`,
      returnByValue: true,
    })
    await capture(evaluatedTrigger.result?.value ?? null, values['trigger-screenshot'], 'CordisX manager trigger')
  }

  if (colorScheme !== undefined) {
    await send('Runtime.evaluate', {
      expression: 'globalThis.__cordisxRestoreSmokeTheme?.()',
    })
  }

  let generationReport

  if (values.generation) {
    const beforeDispose = await evaluateByValue(`(() => ({
      ready: document.documentElement.dataset.cordisxReady === 'true',
      runtimePresent: globalThis.__cordisxRuntime !== undefined,
      surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
      outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
      pages: document.querySelectorAll('[data-cordisx-page]').length,
      settingsPages: document.querySelectorAll('[data-cordisx-settings-page]').length,
      tooltips: document.querySelectorAll('.cordisx-host-tooltip').length,
      styles: document.querySelectorAll('#cordisx-structured-styles, #cordisx-manager-style').length,
      trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
    }))()`)
    const afterDispose = await evaluateByValue(
      `(async () => {
      await globalThis.__cordisxRuntime?.dispose?.()
      return {
        ready: document.documentElement.dataset.cordisxReady === 'true',
        runtimePresent: globalThis.__cordisxRuntime !== undefined,
        surfaces: document.querySelectorAll('[data-cordisx-surface-host]').length,
        outlets: document.querySelectorAll('[data-cordisx-page-outlet]').length,
        pages: document.querySelectorAll('[data-cordisx-page]').length,
        settingsPages: document.querySelectorAll('[data-cordisx-settings-page]').length,
        tooltips: document.querySelectorAll('.cordisx-host-tooltip').length,
        styles: document.querySelectorAll('#cordisx-structured-styles, #cordisx-manager-style').length,
        trigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
      }
    })()`,
      true,
    )
    generationReport = {
      beforeDispose,
      afterDispose,
      cleaned: afterDispose.ready === false && afterDispose.runtimePresent === false && afterDispose.surfaces === 0
        && afterDispose.outlets === 0 && afterDispose.pages === 0 && afterDispose.tooltips === 0
        && afterDispose.settingsPages === 0
        && afterDispose.styles === 0 && afterDispose.trigger === false,
    }
    console.log(`generation=${JSON.stringify(generationReport, null, 2)}`)
    if (generationReport.cleaned !== true) {
      throw new Error(`generation cleanup smoke assertions failed: ${JSON.stringify(generationReport)}`)
    }
  }

  const interactionSafety = await evaluateByValue(`(() => ({
    pendingPermissionDialogs: document.querySelectorAll('[data-permission-authorization]').length,
    pendingLifecycleDialogs: document.querySelectorAll('.cxm-lifecycle-overlay').length,
  }))()`)

  if (values.report !== undefined) {
    const reportPath = path.resolve(values.report)
    const aggregate = {
      run: {
        rendererUrl: report.url,
        runtimeVersion: report.version,
        adapterCommit: values['adapter-commit'] ?? null,
        protocolCommit: values['protocol-commit'] ?? null,
        hostVersion: values['host-version'] ?? null,
        hostBuild: values['host-build'] ?? null,
        isolatedRenderer: true,
      },
      baseline: report,
      ...(runtimeExceptions.length === 0 ? {} : { runtimeExceptions }),
      ...(localeProjection === undefined ? {} : { localeProjection }),
      interactionSafety,
      ...(managerReport === undefined ? {} : { manager: managerReport }),
      ...(managerThemeReport === undefined ? {} : { managerTheme: managerThemeReport }),
      ...(hostCollectionMenuReport === undefined ? {} : { hostCollectionMenu: hostCollectionMenuReport }),
      ...(exerciseReport === undefined ? {} : { exercise: exerciseReport }),
      ...(settingsTabsReport === undefined ? {} : { managerSettings: settingsTabsReport }),
      ...(configExerciseReport === undefined ? {} : { pluginConfiguration: configExerciseReport }),
      ...(demoReport === undefined ? {} : { agentTraceDemo: demoReport }),
      ...(pluginLifecycleReport === undefined ? {} : { pluginLifecycle: pluginLifecycleReport }),
      ...(pluginConsoleReport === undefined ? {} : { pluginConsole: pluginConsoleReport }),
      ...(authorizationReport === undefined ? {} : { authorization: authorizationReport }),
      ...(managerLifecycleReport === undefined ? {} : { managerLifecycle: managerLifecycleReport }),
      ...(permissionV2Report === undefined ? {} : { permissionV2: permissionV2Report }),
      ...(generationTransactionReport === undefined ? {} : { generationTransaction: generationTransactionReport }),
      ...(uiCatalogReport === undefined ? {} : { uiCatalog: uiCatalogReport }),
      ...(generationReport === undefined ? {} : { generation: generationReport }),
    }
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`)
    console.log(`report=${reportPath}`)
  }

  if (locale !== undefined) {
    await send('Runtime.evaluate', {
      expression: 'globalThis.__cordisxRestoreSmokeLocale?.()',
    })
  }

  socket.close()

  if (uiCatalogReport?.result === 'fail') {
    throw new Error('UI catalog smoke assertions failed; inspect the aggregated report')
  }

  if (settingsTabsReport?.passed === false) {
    throw new Error('manager settings smoke assertions failed; inspect the aggregated report')
  }

  if (configExerciseReport?.result === 'fail') {
    throw new Error('plugin configuration smoke assertions failed; inspect the aggregated report')
  }

  if (managerLifecycleReport?.result === 'fail') {
    throw new Error('manager lifecycle smoke assertions failed; inspect the aggregated report')
  }

  if (permissionV2Report?.result === 'fail') {
    throw new Error('permission v2 smoke assertions failed; inspect the aggregated report')
  }

  if (interactionSafety.pendingPermissionDialogs !== 0 || interactionSafety.pendingLifecycleDialogs !== 0) {
    throw new Error('live smoke left an interactive permission or lifecycle dialog open')
  }

  if (managerFormExerciseFailure !== undefined) throw new Error(managerFormExerciseFailure)

  if (managerServiceConfigurationFailure !== undefined) throw new Error(managerServiceConfigurationFailure)

  if (pluginConsoleAssertions !== undefined) {
    const failures = Object.entries(pluginConsoleAssertions)
      .filter(([, passed]) => passed !== true)
      .map(([name]) => name)
    if (failures.length > 0) throw new Error(`plugin Console smoke assertions failed: ${failures.join(', ')}`)
  }
}
