export function managerInteractionExpression({
  locale,
  colorScheme,
  managerMarketplaceFixture,
  marketplaceClipboardExercise,
  openedBy,
  managerMarketplaceSource,
  managerTab,
  managerPlugin,
  managerDetailTab,
  managerPermissionCapability,
  managerSettingsTab,
  managerSettingsNavigationItem,
  channelManagerExercise,
  channelManagerExistingAccount,
  channelManagerExistingAccountSave,
  managerExtensionPoint,
  managerExtensionPointTab,
  managerRoute,
  managerMarketplaceTab,
  managerMarketplaceView,
  managerMarketplaceOpenMenu,
  managerOpenLocalPathForm,
  managerBreadcrumbWidth,
  pluginConsoleExercise,
  managerOpenSelect,
  managerConfigScrollPath,
  managerClickExternal,
}) {
  return `(async () => {
      const smokeLocale = ${JSON.stringify(locale)}
      const smokeTheme = ${JSON.stringify(colorScheme)}
      const nextPaint = () => new Promise(resolve => {
        const timer = setTimeout(resolve, 120)
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
      })
      const waitForElement = async (selector, timeout = 4_000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const element = document.querySelector(selector)
          if (element !== null) return element
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        return null
      }
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      await nextPaint()
      const marketplaceFixtureText = ${JSON.stringify(managerMarketplaceFixture)}
      const marketplaceClipboardExercise = ${JSON.stringify(marketplaceClipboardExercise)}
      const marketplaceClipboardLocal = {
        name: '剪贴板团队来源',
        description: '从结构化来源描述导入。',
        note: '真实 app:// smoke',
      }
      let marketplaceMenuKeyboard = null
      const trigger = document.querySelector('[data-cordisx-manager-trigger]')
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      const openedBy = ${JSON.stringify(openedBy)}
      if (!(modal instanceof HTMLElement) || modal.hidden || modal.querySelector('[role="dialog"], .cxr-dialog') === null) {
        throw new Error('CordisX manager became unavailable after the visibility gate')
      }
      const marketplaceSource = ${JSON.stringify(managerMarketplaceSource)}
      let marketplaceSourceConfigured = false
      if (marketplaceSource !== undefined) {
        document.querySelector('[data-tab="marketplace"]')?.click()
        const sourceMenu = await waitForElement('[data-marketplace-source-menu]')
        sourceMenu?.click()
        if (marketplaceClipboardExercise) {
          const clipboardPayload = JSON.stringify({
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-source.v1.schema.json',
            schemaVersion: 1,
            url: marketplaceSource,
            enabled: true,
            local: marketplaceClipboardLocal,
          })
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText: async () => clipboardPayload },
          })
          const clipboardAction = await waitForElement('[data-manager-menu-action="clipboard"]')
          if (!(clipboardAction instanceof HTMLButtonElement)) throw new Error('marketplace clipboard action is unavailable')
          const fixtureNow = 1_900_000_000_000
          const originalNow = Date.now
          Date.now = () => fixtureNow
          try {
            clipboardAction.click()
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
          } finally {
            Date.now = originalNow
          }
          const requestPrefix = fixtureNow.toString(36)
          for (let sequence = 1; sequence <= 16; sequence += 1) globalThis.__cordisxMarketplaceReceiveV1?.(JSON.stringify({
            requestId: requestPrefix + '-' + sequence.toString(36),
            ok: true,
            status: 200,
            url: marketplaceSource,
            text: marketplaceFixtureText,
          }))
        } else {
          const createAction = await waitForElement('[data-manager-menu-action="create"]')
          createAction?.click()
          const form = await waitForElement('[data-host-form="marketplace-source-create"]')
          const input = form?.querySelector('#cxm-marketplace-source-url')
          if (!(input instanceof HTMLElement) || !(form instanceof HTMLFormElement)) throw new Error('marketplace source form is unavailable')
          input.value = marketplaceSource
          input.onChange?.(marketplaceSource)
          if (marketplaceFixtureText === undefined) form.requestSubmit()
          else {
            const fixtureNow = 1_900_000_000_000
            const originalNow = Date.now
            Date.now = () => fixtureNow
            try { form.requestSubmit() } finally { Date.now = originalNow }
            const requestPrefix = fixtureNow.toString(36)
            for (let sequence = 1; sequence <= 16; sequence += 1) globalThis.__cordisxMarketplaceReceiveV1?.(JSON.stringify({
              requestId: requestPrefix + '-' + sequence.toString(36),
              ok: true,
              status: 200,
              url: marketplaceSource,
              text: marketplaceFixtureText,
            }))
          }
        }
        const sourceDeadline = Date.now() + 12_000
        let sourceState = 'timeout'
        while (Date.now() < sourceDeadline) {
          const sourceRow = [...document.querySelectorAll('[data-collection-item]')]
            .find(row => row.getAttribute('data-collection-item') === marketplaceSource)
          const status = sourceRow?.querySelector('.cxc-status')
          if (sourceRow !== undefined && status?.getAttribute('data-tone') !== 'progress') {
            sourceState = status?.getAttribute('aria-label') ?? 'loaded'
            break
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (sourceState !== 'loaded') throw new Error('marketplace smoke source failed to load: ' + sourceState)
        marketplaceSourceConfigured = true
        document.querySelector('[data-breadcrumb-target="primary:marketplace"]')?.click()
        await nextPaint()
      }
      document.querySelector('[data-tab=${JSON.stringify(managerTab)}]')?.click()
      if (${JSON.stringify(managerTab)} === 'marketplace') {
        const deadline = Date.now() + 12_000
        while (document.querySelector('[aria-label="插件商店列表"] [data-marketplace-plugin], [aria-label="插件商店列表"] .cxc-empty') === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      const pluginId = ${JSON.stringify(managerPlugin)}
      if (pluginId !== undefined) {
        const row = [...document.querySelectorAll('[data-plugin-id], [data-marketplace-plugin]')]
          .find(element => element.getAttribute('data-plugin-id') === pluginId || element.getAttribute('data-marketplace-plugin') === pluginId)
        const primary = row?.matches('button') === true ? row : row?.querySelector('.cxc-primary')
        primary?.click()
        const detailDeadline = Date.now() + 5_000
        const detailTabSelector = ${JSON.stringify(managerTab)} === 'marketplace'
          ? '[data-marketplace-detail-tab]'
          : '[data-plugin-detail-tab]'
        while (document.querySelector(detailTabSelector) === null && Date.now() < detailDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (document.querySelector(detailTabSelector) === null) throw new Error('plugin detail tabs did not mount for ' + pluginId)
      }
      const detailTab = ${JSON.stringify(managerDetailTab)}
      if (detailTab !== undefined) {
        document.querySelector('[data-plugin-detail-tab="' + detailTab + '"]')?.click()
        if (detailTab === 'config' && pluginId !== undefined) {
          const formDeadline = Date.now() + 5_000
          while (document.querySelector('[data-plugin-config-form="' + CSS.escape(pluginId) + '"]') === null && Date.now() < formDeadline) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (pluginId === 'cli-proxy-api') {
            const serviceDeadline = Date.now() + 15_000
            let readySince = 0
            while (Date.now() < serviceDeadline) {
              const seats = [...document.querySelectorAll('[data-plugin-service-config="cli-proxy-api"]')]
              const ready = seats.length === 1 && seats[0].querySelectorAll('[data-service-config]').length === 2
              if (ready) {
                if (readySince === 0) readySince = Date.now()
                if (Date.now() - readySince >= 750) break
              } else {
                readySince = 0
              }
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            const seats = [...document.querySelectorAll('[data-plugin-service-config="cli-proxy-api"]')]
            if (readySince === 0 || seats.length !== 1 || seats[0].querySelectorAll('[data-service-config]').length !== 2) {
              throw new Error('CLIProxy Provider service configuration did not become stably available')
            }
          }
        }
      }
      const permissionCapability = ${JSON.stringify(managerPermissionCapability)}
      if (permissionCapability !== undefined) document.querySelector('[data-permission-open="' + CSS.escape(permissionCapability) + '"]')?.click()
      const settingsTab = ${JSON.stringify(managerSettingsTab)}
      if (settingsTab !== undefined) document.querySelector('[data-settings-tab="' + settingsTab + '"]')?.click()
      if (settingsTab !== undefined) await new Promise(resolve => setTimeout(resolve, 250))
      const settingsNavigationItem = ${JSON.stringify(managerSettingsNavigationItem)}
      if (settingsNavigationItem !== undefined) {
        document.querySelector('[data-settings-navigation-item="' + CSS.escape(settingsNavigationItem) + '"]')?.click()
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      let channelManagerFlow = null
      let channelManagerExistingAccount = null
      if (${JSON.stringify(channelManagerExercise)}) {
        let list = document.querySelector('[data-channel-page="list"]')
        if (!(list instanceof HTMLElement)) {
          document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')?.click()
          const listDeadline = Date.now() + 2_000
          while (!(list instanceof HTMLElement) && Date.now() < listDeadline) {
            await nextPaint()
            list = document.querySelector('[data-channel-page="list"]')
          }
        }
        const create = document.querySelector('[data-channel-create="true"]')
        if (!(list instanceof HTMLElement) || !(create instanceof HTMLElement)) throw new Error('Channel list or create action is unavailable')
        create.click()
        await nextPaint()
        const form = document.querySelector('[data-channel-create-form="true"]')
        const name = document.querySelector('#channel-create-name')
        if (!(form instanceof HTMLFormElement) || !(name instanceof HTMLElement)) throw new Error('Channel local-simulator form is unavailable')
        const smokeName = 'Smoke local ' + Date.now()
        const smokeAccountId = smokeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'local'
        const smokeRecordId = 'simulator/' + smokeAccountId + '/local'
        name.onChange?.(smokeName)
        form.requestSubmit()
        const createdDeadline = Date.now() + 5_000
        let search = document.querySelector('[data-collection-search="channel-list"]')
        while (!(search instanceof HTMLInputElement) && Date.now() < createdDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
          search = document.querySelector('[data-collection-search="channel-list"]')
        }
        if (!(search instanceof HTMLInputElement)) {
          throw new Error('Channel search is unavailable: ' + JSON.stringify({
            pages: [...document.querySelectorAll('[data-channel-page]')].map(page => page.getAttribute('data-channel-page')),
            route: document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route') ?? null,
            status: document.querySelector('[data-channel-create-status="true"]')?.textContent?.trim() ?? null,
          }))
        }
        search.value = smokeName
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await nextPaint()
        const card = document.querySelector('[data-host-collection="channel-list"] [data-collection-item="' + CSS.escape(smokeRecordId) + '"] .cxc-primary')
        if (!(card instanceof HTMLElement) || card.hidden) throw new Error('Persisted local simulator card was not found after search')
        card.click()
        const configurationDeadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-configuration]') === null && Date.now() < configurationDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const configuration = document.querySelector('[data-channel-configuration]')
        const tabs = [...document.querySelectorAll('[data-manager-content-tabs] [data-manager-content-tab]')]
        const activateHostTab = async (id, marker) => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const route = document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route')
            if (route === id && document.querySelector(marker) !== null) return true
            // Host atomically replaces the declaration/body. A click during a
            // transition is deliberately ignored, so select the current Host
            // tab again on the next tick rather than retaining a stale button.
            const tab = document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="' + id + '"]')
            if (tab instanceof HTMLElement) tab.click()
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        }
        const runtimeAvailable = await activateHostTab('runtime', '[data-channel-detail-panel="runtime"]')
        const runtimeActionCount = document.querySelectorAll('[data-channel-runtime-action]').length
        const logsAvailable = await activateHostTab('logs', '[data-channel-logs="true"]')
        const logs = document.querySelector('[data-channel-logs="true"]')
        const logControlsPresent = logs?.querySelector('[data-channel-log-query="true"]') !== null
          && logs?.querySelector('[data-channel-log-outcome="true"]') !== null
          && logs?.querySelector('[data-channel-log-export="json"]') !== null
        const logExport = logs?.querySelector('[data-channel-log-export="json"]')
        const logsEmpty = logs?.querySelector('[data-channel-logs-empty="true"], [data-channel-logs-no-matches="true"]') !== null
        const sessionsAvailable = await activateHostTab('sessions', '[data-channel-detail-panel="sessions"]')
        const sessionPanel = document.querySelector('[data-channel-detail-panel="sessions"]')
        const bindingActions = [...sessionPanel?.querySelectorAll('[data-channel-binding-operation]') ?? []]
        const sessionEmpty = sessionPanel?.querySelector('[data-channel-session-actions="true"]') !== null
        const managerModal = document.querySelector('[data-cordisx-manager-modal]')
        const channelRoot = document.querySelector('[data-channel-manager]')
        channelManagerFlow = {
          list: list !== null,
          create: create !== null,
          searched: search.value === smokeName,
          card: card !== null,
          configuration: configuration !== null,
          tabs: tabs.map(tab => tab.getAttribute('data-manager-content-tab')),
          runtimeAvailable,
          runtimeActionCount,
          logsAvailable,
          logControlsPresent,
          logExportDisabled: logExport instanceof HTMLButtonElement ? logExport.disabled : null,
          logsEmpty,
          sessionsAvailable,
          bindingActionCount: bindingActions.length,
          bindingActionsEnabled: bindingActions.some(button => !button.disabled),
          sessionEmpty,
          expectedHeading: smokeName,
          hostHeading: document.querySelector('.cxm-heading-current-heading')?.textContent?.trim() ?? null,
          nestedChannelChrome: document.querySelector('[data-channel-manager] .cxc-channel-back, [data-channel-manager] .cxc-channel-tabs, [data-channel-manager] .cxc-channel-detail > h1, [data-channel-manager] .cxc-channel-detail > h2, [data-channel-manager] .cxc-channel-detail [role="tablist"]') !== null,
          hostTabs: tabs.length === 4 && document.querySelector('[data-manager-content-tabs]') !== null,
          managerFontSize: managerModal instanceof HTMLElement ? getComputedStyle(managerModal).fontSize : null,
          channelFontSize: channelRoot instanceof HTMLElement ? getComputedStyle(channelRoot).fontSize : null,
          secretRendered: /secretRef|keychain:|host-secret:/iu.test(document.querySelector('[data-channel-manager]')?.outerHTML ?? ''),
        }
        // Details are child manager-content routes.  Return through the Host
        // header rather than a plugin-owned back affordance, so the rest of
        // this data-plane exercise observes the declared root route again.
        const returnDeadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-page="list"]') === null && Date.now() < returnDeadline) {
          const back = document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')
          if (back instanceof HTMLElement) back.click()
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        channelManagerFlow.returnedToList = document.querySelector('[data-channel-page="list"]') !== null
      }
      if (${JSON.stringify(channelManagerExistingAccount)}) {
        let list = document.querySelector('[data-channel-page="list"]')
        if (!(list instanceof HTMLElement)) {
          document.querySelector('[data-cordisx-manager-modal] .cxm-heading-leading.cxm-back')?.click()
          const deadline = Date.now() + 2_000
          while (!(list instanceof HTMLElement) && Date.now() < deadline) {
            await nextPaint()
            list = document.querySelector('[data-channel-page="list"]')
          }
        }
        const card = document.querySelector('[data-channel-page="list"] [data-collection-item] .cxc-primary')
        if (!(list instanceof HTMLElement) || !(card instanceof HTMLElement)) throw new Error('Configured Channel account card is unavailable')
        card.click()
        const deadline = Date.now() + 5_000
        while (document.querySelector('[data-channel-configuration-form]') === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const form = document.querySelector('[data-channel-configuration-form]')
        const channelSwitch = form?.querySelector('.t-switch')
        const activateHostTab = async (id, marker) => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const route = document.querySelector('[data-manager-content-root]')?.getAttribute('data-manager-content-route')
            if (route === id && document.querySelector(marker) !== null) return true
            const tab = document.querySelector('[data-manager-content-tabs] [data-manager-content-tab="' + id + '"]')
            if (tab instanceof HTMLElement) tab.click()
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return false
        }
        const runtimeAvailable = await activateHostTab('runtime', '[data-channel-detail-panel="runtime"]')
        const runtimeActions = [...document.querySelectorAll('[data-channel-runtime-action]')]
        const logsAvailable = await activateHostTab('logs', '[data-channel-logs="true"]')
        const logs = document.querySelector('[data-channel-logs="true"]')
        const logsControlsPresent = logs?.querySelector('[data-channel-log-query="true"]') !== null
          && logs?.querySelector('[data-channel-log-outcome="true"]') !== null
          && logs?.querySelector('[data-channel-log-export="json"]') !== null
        const logExport = logs?.querySelector('[data-channel-log-export="json"]')
        const logsEmpty = logs?.querySelector('[data-channel-logs-empty="true"], [data-channel-logs-no-matches="true"]') !== null
        const sessionsAvailable = await activateHostTab('sessions', '[data-channel-detail-panel="sessions"]')
        const sessionPanel = document.querySelector('[data-channel-detail-panel="sessions"]')
        const bindingActions = [...sessionPanel?.querySelectorAll('[data-channel-binding-operation]') ?? []]
        const sessionEmpty = sessionPanel?.querySelector('[data-channel-session-actions="true"]') !== null
        const configurationAvailable = await activateHostTab('configuration', '[data-channel-configuration-form]')
        const activeForm = document.querySelector('[data-channel-configuration-form]')
        let saved = false
        let saveStatus = null
        if (${JSON.stringify(channelManagerExistingAccountSave)}) {
          if (!(activeForm instanceof HTMLFormElement)) throw new Error('Configured Channel account form is unavailable for save')
          activeForm.requestSubmit()
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            saveStatus = document.querySelector('[data-channel-configuration-status]')?.textContent?.trim() ?? null
            if (saveStatus !== null && saveStatus !== '' && !saveStatus.includes('正在保存') && !saveStatus.includes('Saving')) break
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          saved = saveStatus === '保存后重启相关服务生效' || saveStatus === 'Takes effect after restarting the service'
        }
        channelManagerExistingAccount = {
          list: list !== null,
          detail: document.querySelector('[data-channel-page="detail"]') !== null,
          form: activeForm !== null,
          configurationAvailable,
          switchValue: channelSwitch?.value ?? null,
          switchPropsValue: channelSwitch?.props?.value ?? null,
          switchAriaChecked: channelSwitch?.getAttribute('aria-checked') ?? null,
          switchShadowText: channelSwitch?.shadowRoot?.textContent?.trim() ?? null,
          saved,
          saveStatus,
          runtimeAvailable,
          runtimeActionCount: runtimeActions.length,
          runtimeActionsEnabled: runtimeActions.length === 3 && runtimeActions.every(button => !button.disabled),
          logsAvailable,
          logsControlsPresent,
          logExportDisabled: logExport instanceof HTMLButtonElement ? logExport.disabled : null,
          logsEmpty,
          sessionsAvailable,
          bindingActionCount: bindingActions.length,
          bindingActionsEnabled: bindingActions.some(button => !button.disabled),
          sessionEmpty,
          secretRendered: /secretRef|keychain:|host-secret:/iu.test(document.querySelector('[data-channel-manager]')?.outerHTML ?? ''),
        }
      }
      const extensionPointId = ${JSON.stringify(managerExtensionPoint)}
      if (extensionPointId !== undefined) document.querySelector('[data-extension-point-id="' + CSS.escape(extensionPointId) + '"]')?.click()
      const extensionPointTab = ${JSON.stringify(managerExtensionPointTab)}
      if (extensionPointTab !== undefined) document.querySelector('[data-extension-point-detail-tab="' + extensionPointTab + '"]')?.click()
      const routeId = ${JSON.stringify(managerRoute)}
      if (routeId !== undefined) document.querySelector('[data-route-id="' + CSS.escape(routeId) + '"]')?.click()
      const marketplaceTab = ${JSON.stringify(managerMarketplaceTab)}
      if (marketplaceTab !== undefined) document.querySelector('[data-marketplace-detail-tab="' + marketplaceTab + '"]')?.click()
      const marketplaceView = ${JSON.stringify(managerMarketplaceView)}
      if (marketplaceView === 'sources' || marketplaceView === 'create') {
        const sourceMenu = await waitForElement('[data-marketplace-source-menu]')
        sourceMenu?.click()
        const action = await waitForElement('[data-manager-menu-action="' + (marketplaceView === 'create' ? 'create' : 'manage') + '"]')
        action?.click()
        await waitForElement(marketplaceView === 'create'
          ? '[data-marketplace-source-page="create"]'
          : '[data-marketplace-source-page="index"]')
      }
      if (${JSON.stringify(managerMarketplaceOpenMenu)}) {
        const discoveryMenu = document.querySelector('[data-marketplace-source-menu]')
        let menuTrigger = discoveryMenu
        if (discoveryMenu !== null) discoveryMenu.click()
        else {
          const official = [...document.querySelectorAll('[data-collection-item]')]
            .find(item => item.getAttribute('data-collection-item') === 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
          menuTrigger = official?.querySelector('.cxc-menu-trigger') ?? null
          menuTrigger?.click()
        }
        await nextPaint()
        const openedPopup = document.querySelector('[data-manager-action-menu], .cxc-menu-popup')
        const initialFocus = document.activeElement
        initialFocus?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        const arrowMoved = openedPopup?.contains(document.activeElement) === true && document.activeElement !== initialFocus
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await nextPaint()
        const closed = document.querySelector('[data-manager-action-menu], .cxc-menu-popup') === null
        const focusRestored = document.activeElement === menuTrigger
        menuTrigger?.click()
        await nextPaint()
        marketplaceMenuKeyboard = {
          arrowMoved,
          closed,
          focusRestored,
          reopened: document.querySelector('[data-manager-action-menu], .cxc-menu-popup') !== null,
        }
      }
      if (${JSON.stringify(managerOpenLocalPathForm)}) {
        document.querySelector('[data-tab="plugins"]')?.click()
        await nextPaint()
        document.querySelector('[data-import-local-plugin]')?.click()
        await nextPaint()
      }
      if (smokeLocale !== undefined) document.documentElement.lang = smokeLocale
      if (smokeTheme !== undefined) document.documentElement.setAttribute('data-theme', smokeTheme)
      const breadcrumbWidth = ${JSON.stringify(managerBreadcrumbWidth)}
      const heading = document.querySelector('.cxm-heading')
      if (breadcrumbWidth !== undefined && heading instanceof HTMLElement) {
        heading.style.flex = '0 1 ' + breadcrumbWidth + 'px'
        heading.style.width = breadcrumbWidth + 'px'
        window.dispatchEvent(new Event('resize'))
      }
      await nextPaint()
      if (${JSON.stringify(pluginConsoleExercise)} && detailTab === 'runtime') {
        const consoleFrame = document.querySelector('[data-plugin-console="' + CSS.escape(pluginId) + '"]')
        const objectEntry = consoleFrame?.querySelector('[data-console-source="console.log"]')
        const expandable = objectEntry?.querySelector('.luna-console-preview')
        if (expandable != null) expandable.click()
        await nextPaint()
      }
      if (${JSON.stringify(managerOpenSelect)}) {
        const select = [...document.querySelectorAll('.t-select input')]
          .find(item => item.getClientRects().length > 0)
        if (!(select instanceof HTMLElement)) throw new Error('visible TDesign Select is unavailable')
        select.focus()
        select.click()
        await nextPaint()
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const configScrollPath = ${JSON.stringify(managerConfigScrollPath)}
      let configScroll = null
      if (configScrollPath !== undefined) {
        const item = document.querySelector('[data-config-path="' + CSS.escape(configScrollPath) + '"]')
        if (!(item instanceof HTMLElement)) throw new Error('Host config field is unavailable: ' + configScrollPath)
        item.scrollIntoView({ block: 'center', inline: 'nearest' })
        await nextPaint()
        const itemRect = item.getBoundingClientRect()
        const primitive = item.getAttribute('data-host-form-primitive')
        const control = item.querySelector('[data-host-form-primitive], [data-host-form-composite]')
        const controlRect = control?.getBoundingClientRect()
        configScroll = {
          path: configScrollPath,
          primitive,
          inViewport: itemRect.top >= 0 && itemRect.bottom <= innerHeight,
          controlInViewport: controlRect !== undefined && controlRect !== null
            && controlRect.top >= 0 && controlRect.bottom <= innerHeight,
          rect: { x: itemRect.x, y: itemRect.y, width: itemRect.width, height: itemRect.height },
        }
      }
      if (breadcrumbWidth !== undefined) {
        const overflow = document.querySelector('.cxm-breadcrumb-overflow')
        if (overflow instanceof HTMLDetailsElement) overflow.open = true
      }
      const dialog = document.querySelector('.cxm-lifecycle-dialog')
        ?? document.querySelector('[data-cordisx-manager-modal] [role="dialog"]')
      const rect = dialog?.getBoundingClientRect()
      const leadingRect = document.querySelector('.cxm-heading-leading')?.getBoundingClientRect()
      const firstTab = document.querySelector('.cxm-tabs .cxm-tab:first-child')
      const tabIconRect = firstTab?.querySelector('.cxm-tab-icon')?.getBoundingClientRect()
      const tabLabelRect = firstTab?.querySelector('.cxm-tab-content > span:last-child')?.getBoundingClientRect()
      const titleRect = document.querySelector('.cxm-heading-title')?.getBoundingClientRect()
      const breadcrumb = document.querySelector('.cxm-breadcrumbs')
      const breadcrumbItems = [...(breadcrumb?.querySelectorAll(':scope > .cxm-breadcrumb-list > .cxm-breadcrumb-item') ?? [])]
      const breadcrumbOrdered = breadcrumbItems.flatMap(item => {
        const menu = item.querySelector('.cxm-breadcrumb-menu')
        if (menu !== null) return [...menu.querySelectorAll('.cxm-breadcrumb-action')].map(action => action.textContent?.trim() ?? '')
        const label = item.querySelector(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current')
        return label === null ? [] : [label.textContent?.trim() ?? '']
      })
      const breadcrumbCurrent = breadcrumb?.querySelector('.cxm-breadcrumb-current')
      let externalDefaultPrevented
      if (${JSON.stringify(managerClickExternal)}) {
        const link = document.querySelector('.cxm-content a[href]')
        if (link !== null) {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true })
          link.dispatchEvent(event)
          externalDefaultPrevented = event.defaultPrevented
        }
      }
`
}
