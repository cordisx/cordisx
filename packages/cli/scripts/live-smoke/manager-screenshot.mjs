import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { managerInteractionExpression } from './manager-interaction-expression.mjs'
import { managerStateExpression } from './manager-state-expression.mjs'

export async function runManagerScreenshot({
  values,
  ensureManagerVisible,
  send,
  locale,
  colorScheme,
  managerReport,
  managerServiceConfigurationFailure,
  managerFormExerciseFailure,
  evaluateByValue,
  pointerClick,
  capture,
}) {
  const managerOpenState = await ensureManagerVisible()
  const managerTab = values['manager-tab'] ?? 'plugins'
  if (!['about', 'extension-points', 'routes', 'plugins', 'marketplace', 'settings'].includes(managerTab)) {
    throw new Error(`unknown manager tab: ${managerTab}`)
  }
  const managerPlugin = values['manager-plugin']
  const managerDetailTab = values['manager-detail-tab']
  if (
    managerDetailTab !== undefined
    && !['readme', 'config', 'permissions', 'runtime', 'logs', 'extension-points', 'routes'].includes(managerDetailTab)
  ) throw new Error(`unknown manager detail tab: ${managerDetailTab}`)
  const managerConfigScrollPath = values['manager-config-scroll-path']
  if (managerConfigScrollPath !== undefined && !/^[a-zA-Z0-9_.-]+$/.test(managerConfigScrollPath)) {
    throw new Error('--manager-config-scroll-path must be a dot-separated Host config path')
  }
  if (managerConfigScrollPath !== undefined && managerDetailTab !== 'config') {
    throw new Error('--manager-config-scroll-path requires --manager-detail-tab config')
  }
  const managerPermissionCapability = values['manager-permission-capability']
  if (managerPermissionCapability !== undefined && managerDetailTab !== 'permissions') {
    throw new Error('--manager-permission-capability requires --manager-detail-tab permissions')
  }
  const managerSettingsTab = values['manager-settings-tab']
  if (
    managerSettingsTab !== undefined && !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(managerSettingsTab)
  ) {
    throw new Error(`invalid manager settings tab id: ${managerSettingsTab}`)
  }
  const managerSettingsNavigationItem = values['manager-settings-navigation-item']
    ?? (values['channel-data-plane'] ? 'channel:channels' : undefined)
  if (
    managerSettingsNavigationItem !== undefined
    && !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(managerSettingsNavigationItem)
  ) {
    throw new Error(`invalid manager settings navigation item id: ${managerSettingsNavigationItem}`)
  }
  const managerExtensionPoint = values['manager-extension-point']
  const managerExtensionPointTab = values['manager-extension-point-tab']
  if (
    managerExtensionPointTab !== undefined
    && !['usage', 'information', 'diagnostics'].includes(managerExtensionPointTab)
  ) throw new Error(`unknown manager extension point tab: ${managerExtensionPointTab}`)
  const managerRoute = values['manager-route']
  const managerMarketplaceTab = values['manager-marketplace-tab']
  if (managerMarketplaceTab !== undefined && !['overview', 'authors-source'].includes(managerMarketplaceTab)) {
    throw new Error(`unknown manager marketplace tab: ${managerMarketplaceTab}`)
  }
  const managerMarketplaceView = values['manager-marketplace-view']
  if (managerMarketplaceView !== undefined && !['discovery', 'sources', 'create'].includes(managerMarketplaceView)) {
    throw new Error(`unknown manager marketplace view: ${managerMarketplaceView}`)
  }
  if (
    (managerMarketplaceView !== undefined || values['manager-marketplace-open-menu'])
    && managerTab !== 'marketplace'
  ) {
    throw new Error('--manager-marketplace-view and --manager-marketplace-open-menu require --manager-tab marketplace')
  }
  const managerMarketplaceSource = values['manager-marketplace-source']
  if (managerMarketplaceSource !== undefined) {
    const sourceUrl = new URL(managerMarketplaceSource)
    if (
      sourceUrl.protocol !== 'https:' || sourceUrl.username !== '' || sourceUrl.password !== '' || sourceUrl.hash !== ''
    ) {
      throw new Error('--manager-marketplace-source must be a credential-free HTTPS URL without a fragment')
    }
  }
  const managerMarketplaceFixturePath = values['manager-marketplace-fixture']
  if (
    values['manager-marketplace-clipboard-exercise']
    && (managerMarketplaceSource === undefined || managerMarketplaceFixturePath === undefined)
  ) {
    throw new Error(
      '--manager-marketplace-clipboard-exercise requires --manager-marketplace-source and --manager-marketplace-fixture',
    )
  }
  if (values['manager-marketplace-clipboard-exercise'] && !values.generation) {
    throw new Error(
      '--manager-marketplace-clipboard-exercise requires --generation so imported state and Host cleanup share one report',
    )
  }
  if (managerMarketplaceFixturePath !== undefined && managerMarketplaceSource === undefined) {
    throw new Error('--manager-marketplace-fixture requires --manager-marketplace-source')
  }
  if (managerMarketplaceFixturePath !== undefined && !path.isAbsolute(managerMarketplaceFixturePath)) {
    throw new Error('--manager-marketplace-fixture must be an absolute JSON path')
  }
  const managerMarketplaceFixture = managerMarketplaceFixturePath === undefined
    ? undefined
    : await readFile(managerMarketplaceFixturePath, 'utf8')
  if (managerMarketplaceFixture !== undefined) JSON.parse(managerMarketplaceFixture)
  const managerViewportWidth = values['manager-viewport-width'] === undefined
    ? undefined
    : Number(values['manager-viewport-width'])
  if (
    managerViewportWidth !== undefined
    && (!Number.isInteger(managerViewportWidth) || managerViewportWidth < 400 || managerViewportWidth > 3840)
  ) {
    throw new Error('--manager-viewport-width must be an integer between 400 and 3840')
  }
  const managerBreadcrumbWidth = values['manager-breadcrumb-width'] === undefined
    ? undefined
    : Number(values['manager-breadcrumb-width'])
  if (
    managerBreadcrumbWidth !== undefined
    && (!Number.isInteger(managerBreadcrumbWidth) || managerBreadcrumbWidth < 120 || managerBreadcrumbWidth > 800)
  ) {
    throw new Error('--manager-breadcrumb-width must be an integer between 120 and 800')
  }
  if (managerViewportWidth !== undefined) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: managerViewportWidth,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
  const evaluatedManager = await send('Runtime.evaluate', {
    expression: managerInteractionExpression({
      locale,
      colorScheme,
      managerMarketplaceFixture,
      marketplaceClipboardExercise: values['manager-marketplace-clipboard-exercise'],
      openedBy: managerOpenState.openedBy,
      managerMarketplaceSource,
      managerTab,
      managerPlugin,
      managerDetailTab,
      managerPermissionCapability,
      managerSettingsTab,
      managerSettingsNavigationItem,
      channelManagerExercise: values['channel-manager-exercise'],
      channelManagerExistingAccount: values['channel-manager-existing-account'],
      channelManagerExistingAccountSave: values['channel-manager-existing-account-save'],
      managerExtensionPoint,
      managerExtensionPointTab,
      managerRoute,
      managerMarketplaceTab,
      managerMarketplaceView,
      managerMarketplaceOpenMenu: values['manager-marketplace-open-menu'],
      managerOpenLocalPathForm: values['manager-open-local-path-form'],
      managerBreadcrumbWidth,
      pluginConsoleExercise: values['plugin-console-exercise'],
      managerOpenSelect: values['manager-open-select'],
      managerConfigScrollPath,
      managerClickExternal: values['manager-click-external'],
    }) + managerStateExpression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (evaluatedManager.exceptionDetails !== undefined) {
    const detail = evaluatedManager.exceptionDetails.exception?.description
      ?? evaluatedManager.exceptionDetails.text
      ?? 'unknown renderer exception'
    throw new Error(`CordisX manager smoke evaluation failed: ${detail}`)
  }
  const managerResult = evaluatedManager.result?.value ?? null
  managerReport = managerResult?.state ?? null
  if (managerTab === 'marketplace') {
    const marketplaceState = managerReport?.marketplace
    const requestedView = managerPlugin === undefined ? (managerMarketplaceView ?? 'discovery') : 'detail'
    if (marketplaceState?.view !== requestedView) {
      throw new Error(`Marketplace smoke opened the wrong view: ${JSON.stringify(marketplaceState)}`)
    }
    if (requestedView === 'detail') {
      const trustDetail = managerReport?.marketplaceTrustDetail
      const dimensions = trustDetail?.dimensions ?? []
      const official = dimensions.find(item => item.dimension === 'official')
      const certified = dimensions.find(item => item.dimension === 'certified')
      if (
        dimensions.length !== 2
        || official?.evidence === null || certified?.evidence === null
        || !/PermissionBroker|权限/iu.test(official?.text ?? '')
        || !/policy|策略/iu.test(certified?.text ?? '')
        || !/absolute safety|绝对安全/iu.test(certified?.text ?? '')
        || !/interface capabilities|界面能力/iu.test(certified?.text ?? '')
        || !/absolute safety|绝对安全/iu.test(trustDetail?.boundary ?? '')
      ) {
        throw new Error(`Marketplace trust detail assertions failed: ${JSON.stringify(trustDetail)}`)
      }
    } else if (requestedView === 'discovery') {
      const discovery = marketplaceState.discovery
      if (
        discovery?.onlyResultsScroll !== true
        || discovery.filterBelowSearch !== true
        || discovery.documentationPrimaryActionAbsent !== true
        || discovery.fullWidth !== true
      ) {
        throw new Error(`Marketplace discovery IA assertions failed: ${JSON.stringify(discovery)}`)
      }
      if (managerMarketplaceFixture !== undefined) {
        const row = managerReport?.marketplaceCatalog?.rows?.find(item => item.id === 'trusted-smoke')
        if (
          row?.official !== 'true'
          || row.certified !== 'true'
          || row.rankingOfficialPriority !== '1'
          || !String(row.rankingExplanation ?? '').includes('认证状态不参与排序')
          || row.badges?.map(badge => badge.dimension).join(',') !== 'official,certified'
          || row.badges?.every(badge => typeof badge.ariaLabel === 'string' && badge.ariaLabel.length > 0) !== true
          || row.badges?.map(badge => badge.icon).join(',') !== 'trust.official,trust.certified'
        ) {
          throw new Error(`Marketplace trust list assertions failed: ${JSON.stringify(row)}`)
        }
      }
    } else {
      const sources = marketplaceState.sources
      if (
        sources?.manualReloadAbsent !== true
        || sources.topLevelSettingsTabAbsent !== true
        || sources.formFullWidth === false
        || sources.untouchedErrorAbsent !== true
        || sources.nativeUrlErrorAbsent !== true
        || sources.primaryDeveloperTermsAbsent !== true
        || (requestedView === 'sources' && sources.officialPresent !== true)
      ) {
        throw new Error(`Marketplace source IA assertions failed: ${JSON.stringify(sources)}`)
      }
      if (
        requestedView === 'sources' && values['manager-marketplace-open-menu']
        && sources.officialDeleteDisabled !== true
      ) {
        throw new Error(`Marketplace official source delete boundary failed: ${JSON.stringify(sources)}`)
      }
      if (values['manager-marketplace-clipboard-exercise']) {
        const imported = sources.clipboardImport
        if (
          imported?.rowPresent !== true
          || imported.title !== '剪贴板团队来源'
          || imported.description !== '从结构化来源描述导入。'
          || imported.machineId !== managerMarketplaceSource
          || imported.local?.name !== '剪贴板团队来源'
          || imported.local?.description !== '从结构化来源描述导入。'
          || imported.local?.note !== '真实 app:// smoke'
          || imported.noticeVisible !== true
        ) {
          throw new Error(`Marketplace clipboard/local override assertions failed: ${JSON.stringify(imported)}`)
        }
      }
    }
    if (values['manager-marketplace-open-menu']) {
      const menu = marketplaceState.menu
      if (
        menu?.portaled !== true || menu.bounded !== true || menu.firstItemFocused !== true
        || menu.theme !== menu.managerTheme
        || menu.keyboard?.arrowMoved !== true || menu.keyboard.closed !== true
        || menu.keyboard.focusRestored !== true || menu.keyboard.reopened !== true
      ) {
        throw new Error(`Marketplace menu portal assertions failed: ${JSON.stringify(menu)}`)
      }
    }
  }
  if (values['channel-data-plane']) {
    const channel = managerReport?.channelDataPlane
    const channelLocale = channel?.locale
    const channelNavigationTitle = channelLocale === 'zh-CN' ? '渠道配置' : 'Channel settings'
    if (
      channel?.plugin?.status !== 'active'
      || channel.plugin.schemaKind !== 'none'
      || channel.plugin.configFields !== 0
      || channel.registration?.valid !== true
      || channel.registration.pending !== false
      || channel.registration.visible !== true
      || channel.registration.authorized !== true
      || channel.registration.group !== 'after-settings'
      || channel.registration.routeId !== 'settings'
      || channel.route?.valid !== true
      || channel.route.outlet !== 'manager.content'
      || channel.route.path !== '/manager/extensions/channels'
      || channel.route.page !== 'settings'
      || channel.route.diagnostics !== 0
      || channel.page?.chrome !== 'standard'
      || channel.page.icon !== 'host:layers'
      || channel.page.diagnostics !== 0
      || channel.outlet?.available !== true
      || channel.outlet.mounted !== true
      || ![
        'channel:settings',
        'channel:configuration',
        'channel:runtime',
        'channel:logs',
        'channel:sessions',
        'channel:create',
      ].includes(channel.outlet.activeRoute)
      || channel.navigationItem?.label !== channelNavigationTitle
      || channel.navigationItem.icon !== 'host:layers'
      || typeof channel.pageTitle !== 'string' || channel.pageTitle.trim() === ''
      || channel.mounted !== true
    ) {
      throw new Error(`Channel data-plane smoke assertions failed: ${JSON.stringify(channel)}`)
    }
    if (
      values['channel-manager-exercise'] && (channel.managerFlow?.list !== true
        || channel.managerFlow.create !== true
        || channel.managerFlow.searched !== true
        || channel.managerFlow.card !== true
        || channel.managerFlow.configuration !== true
        || channel.managerFlow.tabs?.join(',') !== 'configuration,runtime,logs,sessions'
        || channel.managerFlow.runtimeAvailable !== true
        || channel.managerFlow.logsAvailable !== true
        || channel.managerFlow.sessionsAvailable !== true
        || channel.managerFlow.logControlsPresent !== true
        || (channel.managerFlow.logsEmpty === true && channel.managerFlow.logExportDisabled !== true)
        || (channel.managerFlow.bindingActionCount !== 3 && channel.managerFlow.sessionEmpty !== true)
        || channel.managerFlow.hostHeading !== channel.managerFlow.expectedHeading
        || channel.managerFlow.nestedChannelChrome !== false
        || channel.managerFlow.hostTabs !== true
        || channel.managerFlow.managerFontSize !== channel.managerFlow.channelFontSize
        || channel.managerFlow.returnedToList !== true
        || channel.managerFlow.secretRendered !== false)
    ) {
      throw new Error(`Channel Manager flow smoke assertions failed: ${JSON.stringify(channel.managerFlow)}`)
    }
    if (
      values['channel-manager-existing-account'] && (channel.existingAccount?.list !== true
        || channel.existingAccount.detail !== true || channel.existingAccount.form !== true
        || channel.existingAccount.configurationAvailable !== true
        || !['true', 'false'].includes(channel.existingAccount.switchValue)
        || channel.existingAccount.switchPropsValue !== channel.existingAccount.switchValue
        || channel.existingAccount.switchAriaChecked !== channel.existingAccount.switchValue
        || channel.existingAccount.runtimeAvailable !== true
        || channel.existingAccount.runtimeActionCount !== 3
        || channel.existingAccount.runtimeActionsEnabled !== true
        || channel.existingAccount.logsAvailable !== true
        || channel.existingAccount.logsControlsPresent !== true
        || (channel.existingAccount.logsEmpty === true && channel.existingAccount.logExportDisabled !== true)
        || channel.existingAccount.sessionsAvailable !== true
        || (channel.existingAccount.bindingActionCount !== 3 && channel.existingAccount.sessionEmpty !== true)
        || channel.existingAccount.secretRendered !== false)
    ) {
      throw new Error(`Channel existing-account smoke assertions failed: ${JSON.stringify(channel.existingAccount)}`)
    }
    if (values['channel-manager-existing-account-save'] && channel.existingAccount?.saved !== true) {
      throw new Error(
        `Channel existing-account save smoke assertions failed: ${JSON.stringify(channel.existingAccount)}`,
      )
    }
  }
  if (managerPlugin === 'cli-proxy-api' && managerDetailTab === 'config') {
    const serviceConfigs = managerReport?.serviceConfigs?.find(config => config.pluginId === 'cli-proxy-api')?.services
    if (
      !Array.isArray(serviceConfigs) || serviceConfigs.length !== 2
      || serviceConfigs.some(config =>
        config.fullWidth !== 'true' || config.nativeSelects !== 0
        || config.nestedControlChrome !== false || config.stickyFooter !== false || config.orphanedFooter !== false
      )
    ) {
      managerServiceConfigurationFailure = `CLIProxy Provider detail form assertions failed: ${
        JSON.stringify(managerReport?.serviceConfigs)
      }`
    }
  }
  if (managerTab === 'about') {
    const aboutState = async () =>
      await evaluateByValue(`(() => {
        const action = document.querySelector('.cxm-about-action')
        const item = action?.closest('.cxm-about-action-item')
        const actions = action?.closest('.cxm-about-actions')
        const title = action?.querySelector('.cxm-about-action-title')
        const copy = action?.querySelector('.cxm-about-action-copy')
        const arrow = action?.querySelector('.cxm-about-action-arrow')
        if (!(action instanceof HTMLAnchorElement) || !(item instanceof HTMLElement) || !(actions instanceof HTMLElement)
          || !(title instanceof HTMLElement) || !(copy instanceof HTMLElement) || !(arrow instanceof HTMLElement)) return null
        const rect = action.getBoundingClientRect()
        const itemRect = item.getBoundingClientRect()
        const style = element => getComputedStyle(element)
        const simpleRect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height })
        const leftTarget = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2)
        const rightTarget = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2)
        return {
          rect: simpleRect(rect), itemRect: simpleRect(itemRect),
          hovered: action.matches(':hover'), focused: document.activeElement === action,
          focusVisible: action.matches(':focus-visible'),
          anchorBackground: style(action).backgroundColor,
          anchorOutline: style(action).outlineColor,
          anchorOutlineOffset: style(action).outlineOffset,
          titleColor: style(title).color, titleBackground: style(title).backgroundColor,
          copyColor: style(copy).color, copyBackground: style(copy).backgroundColor,
          arrowColor: style(arrow).color,
          wholeRowHitTarget: action.contains(leftTarget) && action.contains(rightTarget),
          rowOwnsTextAndIcon: action.contains(title) && action.contains(copy) && action.contains(arrow),
          fillsItem: Math.abs(rect.width - itemRect.width) <= 1,
          horizontalOverflow: actions.scrollWidth > actions.clientWidth + 1 || action.scrollWidth > action.clientWidth + 1,
          separatorColor: style(item).borderTopColor,
          containerBorder: [style(actions).borderTopColor, style(actions).borderBottomColor],
        }
      })()`)
    const rest = await aboutState()
    if (rest === null) throw new Error('manager About action row is unavailable')
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rest.rect.x + rest.rect.width / 2,
      y: rest.rect.y + rest.rect.height / 2,
      pointerType: 'mouse',
    })
    await evaluateByValue(`new Promise(resolve => setTimeout(resolve, 120))`, true)
    const hover = await aboutState()
    await evaluateByValue(`(() => { document.querySelector('.cxm-about-action')?.focus(); return true })()`)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      modifiers: 8,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      modifiers: 8,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    await evaluateByValue(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true)
    const focus = await aboutState()
    const transparent = value => value === 'transparent' || value === 'rgba(0, 0, 0, 0)'
    const sameRect = (left, right) =>
      left !== null && right !== null
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(left.rect[key] - right.rect[key]) <= 0.5)
    const passed = hover?.hovered === true
      && hover.anchorBackground !== rest.anchorBackground
      && transparent(rest.titleBackground) && transparent(rest.copyBackground)
      && transparent(hover.titleBackground) && transparent(hover.copyBackground)
      && hover.arrowColor !== rest.arrowColor
      && hover.wholeRowHitTarget === true && hover.rowOwnsTextAndIcon === true && hover.fillsItem === true
      && hover.horizontalOverflow === false && sameRect(rest, hover)
      && focus?.focused === true && focus.focusVisible === true
      && focus.anchorBackground === hover.anchorBackground
      && focus.titleBackground === hover.titleBackground && focus.copyBackground === hover.copyBackground
      && hover.separatorColor === rest.separatorColor
      && JSON.stringify(hover.containerBorder) === JSON.stringify(rest.containerBorder)
    managerReport = { ...managerReport, aboutInteraction: { rest, hover, focus, passed } }
    if (!passed) throw new Error('manager About whole-row hover/focus exercise failed')
  }
  if (values['manager-form-exercise']) {
    // The initial manager projection is intentionally captured before the
    // interaction.  It may be below the current viewport, so never reuse its
    // old (and possibly negative) rect for a physical pointer event.
    const formControl = await evaluateByValue(
      `(async () => {
        const control = [...document.querySelectorAll('input.t-input__inner[id], textarea.t-textarea__inner[id], .t-select input[id], input[id], textarea[id], select[id]')]
          .find(item => item instanceof HTMLElement && item.getClientRects().length > 0
            && !item.matches(':disabled,[aria-disabled="true"]'))
        if (!(control instanceof HTMLElement)) return null
        control.scrollIntoView({ block: 'center', inline: 'nearest' })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const rect = control.getBoundingClientRect()
        return {
          id: control.id || null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          inViewport: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
            && rect.right <= innerWidth && rect.bottom <= innerHeight,
        }
      })()`,
      true,
    )
    const firstRect = formControl?.rect
    if (firstRect === undefined || firstRect === null || formControl.inViewport !== true) {
      managerReport = { ...managerReport, hostFormInteraction: { pointer: null, keyboard: null, passed: false } }
      managerFormExerciseFailure = 'manager form exercise found no visible focusable Host form control'
    } else {
      await pointerClick(firstRect)
      const pointer = await evaluateByValue(`(() => {
        const focusPath = []
        let active = document.activeElement
        while (active instanceof HTMLElement) {
          focusPath.push({ tag: active.tagName.toLowerCase(), id: active.id || null, role: active.getAttribute('role') })
          const nested = active.shadowRoot?.activeElement
          if (!(nested instanceof HTMLElement)) break
          active = nested
        }
        return {
          primitive: document.activeElement?.getAttribute('data-host-form-primitive') ?? null,
          id: document.activeElement?.id ?? null,
          focusPath,
        }
        })()`)
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      })
      const keyboard = await evaluateByValue(`(() => {
        const focusPath = []
        let active = document.activeElement
        while (active instanceof HTMLElement) {
          focusPath.push({ tag: active.tagName.toLowerCase(), id: active.id || null, role: active.getAttribute('role') })
          const nested = active.shadowRoot?.activeElement
          if (!(nested instanceof HTMLElement)) break
          active = nested
        }
        return {
          primitive: document.activeElement?.getAttribute('data-host-form-primitive') ?? null,
          id: document.activeElement?.id ?? null,
          tag: document.activeElement?.tagName.toLowerCase() ?? null,
          focusPath,
        }
        })()`)
      managerReport = {
        ...managerReport,
        hostFormInteraction: {
          target: formControl,
          pointer,
          keyboard,
          passed: formControl.inViewport === true && pointer.id !== null && keyboard.tag !== 'body'
            && (keyboard.id !== pointer.id || JSON.stringify(keyboard.focusPath) !== JSON.stringify(pointer.focusPath)),
        },
      }
      if (managerReport.hostFormInteraction.passed !== true) {
        managerFormExerciseFailure = 'manager Host form mouse/keyboard exercise failed'
      }
    }
    console.log(`manager-form-interaction=${JSON.stringify(managerReport.hostFormInteraction)}`)
  }
  if (values['manager-form-value-exercise']) {
    const galleryId = 'form-schema-gallery'
    const expected = 'CordisX smoke workspace'
    const target = await evaluateByValue(
      `(async () => {
        const field = document.querySelector('[data-plugin-config-form="${galleryId}"] [data-config-path="workspaceName"]')
        const control = field?.querySelector('input.t-input__inner')
        if (!(field instanceof HTMLElement) || !(control instanceof HTMLElement)) return null
        control.scrollIntoView({ block: 'center', inline: 'nearest' })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const rect = control.getBoundingClientRect()
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, inViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight }
      })()`,
      true,
    )
    if (target?.inViewport !== true) {
      throw new Error('gallery workspace input is unavailable for React input exercise')
    }
    await send('Page.bringToFront')
    await pointerClick(target.rect)
    const focused = await evaluateByValue(
      `(() => {
        const input = document.querySelector('[data-plugin-config-form="${galleryId}"] [data-config-path="workspaceName"] input.t-input__inner')
        if (!(input instanceof HTMLInputElement)) return null
        input.focus()
        input.select()
        return { active: document.activeElement?.tagName.toLowerCase() ?? null, selected: input.selectionStart === 0 && input.selectionEnd === input.value.length }
      })()`,
      true,
    )
    if (focused?.active !== 'input' || focused.selected !== true) {
      throw new Error('official TDesign React input did not accept keyboard focus')
    }
    // This is a trusted CDP text delivery to the actual focused React input;
    // do not paper over a delivery failure with a synthetic event or callback.
    await send('Input.insertText', { text: expected })
    const draft = await evaluateByValue(
      `(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const form = document.querySelector('[data-plugin-config-form="${galleryId}"]')
        const control = form?.querySelector('[data-config-path="workspaceName"] input.t-input__inner')
        const input = control
        return { state: form?.getAttribute('data-state') ?? null, value: control?.value ?? null, inputValue: input?.value ?? null }
      })()`,
      true,
    )
    if (
      draft?.state !== 'dirty' || draft.inputValue !== expected || String(draft.value).includes('[object CustomEvent]')
    ) {
      throw new Error(
        'official TDesign input did not deliver its typed value to the Host draft: ' + JSON.stringify({ draft }),
      )
    }
    const saveTarget = await evaluateByValue(
      `(() => {
        const save = document.querySelector('[data-plugin-config-form="${galleryId}"] button[type="submit"]')
        const rect = save?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`,
      true,
    )
    if (saveTarget === null || saveTarget.width <= 0 || saveTarget.height <= 0) {
      throw new Error('gallery save action did not appear in the sticky form action bar')
    }
    await pointerClick(saveTarget)
    const saved = await evaluateByValue(
      `(async () => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const plugin = globalThis.__cordisxRuntime?.snapshot().plugins.find(item => item.id === '${galleryId}')
          const field = plugin?.configuration?.fields?.find(item => item.path?.join('.') === 'workspaceName')
          if (field?.value === '${expected}') return { value: field.value, revision: plugin.configuration.revision }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return null
      })()`,
      true,
    )
    if (saved === null) {
      throw new Error('gallery typed value did not persist through the isolated Host configuration writer')
    }
    const reopened = await evaluateByValue(
      `(async () => {
        const previousForm = document.querySelector('[data-plugin-config-form="${galleryId}"]')
        const close = document.querySelector('.cxr-header [aria-label="Close CordisX Manager"], .cxr-header [aria-label="关闭 CordisX 管理器"]')
        if (!(close instanceof HTMLButtonElement)) throw new Error('Manager close action is unavailable')
        close.click()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if (previousForm?.isConnected) throw new Error('Manager did not dispose its closed form')
        document.querySelector('[data-cordisx-manager-trigger]')?.click()
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        document.querySelector('[data-tab="plugins"]')?.click()
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const row = document.querySelector('[data-plugin-id="${galleryId}"]')
          if (row instanceof HTMLElement) { row.click(); break }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const tab = document.querySelector('[data-plugin-detail-tab="config"]')
          if (tab instanceof HTMLElement) { tab.click(); break }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const control = document.querySelector('[data-plugin-config-form="${galleryId}"] [data-config-path="workspaceName"] input.t-input__inner')
          if (control instanceof HTMLElement) {
            const inputValue = control.value ?? null
            if (control.closest('[data-plugin-config-form]') !== previousForm && inputValue === '${expected}' && String(control.value).includes('[object CustomEvent]') === false) return { value: control.value, inputValue }
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return null
      })()`,
      true,
    )
    if (reopened === null) throw new Error('gallery saved value did not survive Manager reopen')
    managerReport = { ...managerReport, hostFormValueInteraction: { target, draft, saved, reopened, passed: true } }
    console.log(`manager-form-value-interaction=${JSON.stringify(managerReport.hostFormValueInteraction)}`)
  }
  console.log(`manager-state=${JSON.stringify(managerReport)}`)
  try {
    await capture(managerResult?.rect ?? null, values['manager-screenshot'], 'CordisX manager')
  } finally {
    if (values['manager-open-local-path-form']) {
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.cxm-lifecycle-dialog .cxf-actions button.t-button:first-child')?.click()`,
        returnByValue: true,
      })
    }
    if (managerBreadcrumbWidth !== undefined) {
      await send('Runtime.evaluate', {
        expression: `(() => {
            const heading = document.querySelector('.cxm-heading')
            if (!(heading instanceof HTMLElement)) return false
            heading.style.removeProperty('flex')
            heading.style.removeProperty('width')
            return true
          })()`,
        returnByValue: true,
      })
    }
    if (managerViewportWidth !== undefined && !values['manager-theme-cycle']) {
      await send('Emulation.clearDeviceMetricsOverride')
    }
  }

  return { managerReport, managerServiceConfigurationFailure, managerFormExerciseFailure }
}
