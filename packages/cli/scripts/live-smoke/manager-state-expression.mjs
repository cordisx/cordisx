export const managerStateExpression = `      return rect === undefined ? null : {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        state: {
          modalHidden: modal?.hidden,
          openedBy,
          theme: {
            root: document.documentElement.getAttribute('data-theme'),
            projected: modal?.getAttribute('data-cordisx-app-theme') ?? null,
            source: modal?.getAttribute('data-cordisx-theme-source') ?? null,
            dialogBackground: dialog === null ? null : getComputedStyle(dialog).backgroundColor,
          },
          triggerExpanded: trigger?.getAttribute('aria-expanded'),
          externalDefaultPrevented,
          hostForms: [...document.querySelectorAll('[data-plugin-config-form]')].filter(form => form.getClientRects().length > 0).map(form => {
            const grid = form.querySelector('.cxf-form-grid')
            const firstControl = [...form.querySelectorAll('input.t-input__inner[id], textarea.t-textarea__inner[id], .t-select input[id], input[id], textarea[id], select[id]')]
              .find(control => control instanceof HTMLElement && control.getClientRects().length > 0
                && !control.matches(':disabled,[aria-disabled="true"]'))
            const firstRect = firstControl?.getBoundingClientRect()
            return {
              id: form.getAttribute('data-plugin-config-form'),
              state: form.getAttribute('data-state'),
              direction: getComputedStyle(form).direction,
              gridColumns: grid === null ? null : getComputedStyle(grid).gridTemplateColumns,
              horizontalOverflow: form.scrollWidth > form.clientWidth + 1,
              developerMetadataVisible: ['Schemastery', 'Revision', '实时发布（不重载）'].some(text => (form.closest('[role="tabpanel"]')?.textContent ?? '').includes(text)),
              items: [...form.querySelectorAll('.cxf-item')].map(item => ({
                path: item.getAttribute('data-config-path'),
                primitive: item.getAttribute('data-host-form-primitive'),
                label: item.querySelector('.cxf-field-label')?.textContent?.trim() ?? null,
                help: item.querySelector('.cxf-help')?.textContent?.trim() ?? null,
                error: item.querySelector('.cxf-error:not([hidden])')?.textContent?.trim() ?? null,
                invalid: item.getAttribute('data-invalid'),
                customSeatVisible: item.querySelector('.cxf-custom-seat:not([hidden])') !== null,
                sensitiveControlCount: item.getAttribute('data-host-form-primitive') === 'sensitive-unavailable'
                  ? item.querySelectorAll('input,textarea,select,input.t-input__inner,textarea.t-textarea__inner,.t-select input').length : null,
              })),
              controls: [...form.querySelectorAll('[data-host-form-primitive],input,textarea')].filter((control, index, all) => all.indexOf(control) === index).map(control => ({
                primitive: control.getAttribute('data-host-form-primitive'), tag: control.tagName.toLowerCase(),
                type: control instanceof HTMLInputElement ? control.type : null, id: control.id,
                required: control.getAttribute('aria-required'), invalid: control.getAttribute('aria-invalid'),
                describedBy: control.getAttribute('aria-describedby'), disabled: control.matches(':disabled,[aria-disabled="true"]'),
                placeholder: control.getAttribute('placeholder'),

              })),
              firstControlRect: firstRect === undefined ? null : { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
            }
          }),
          serviceConfigs: [...document.querySelectorAll('[data-plugin-service-config]')].map(seat => ({
            pluginId: seat.getAttribute('data-plugin-service-config'),
            services: [...seat.querySelectorAll('[data-service-config]')].map(section => {
              const form = section.closest('form')
              const footer = form?.querySelector('.cxm-service-config-footer')
              const sectionRect = section.getBoundingClientRect()
              const footerRect = footer?.getBoundingClientRect()
              return {
                id: section.getAttribute('data-service-config'),
                applies: section.getAttribute('data-config-applies'),
                form: form?.getAttribute('data-service-config-form') ?? null,
                fullWidth: section.querySelector('.cxf-item')?.getAttribute('data-full-width') ?? null,
                nativeSelects: section.querySelectorAll('select').length,
                nestedControlChrome: section.classList.contains('cxm-settings-group') && section.querySelector('.cxf-form-grid') !== null,
                stickyFooter: footer instanceof HTMLElement && getComputedStyle(footer).position === 'sticky',
                orphanedFooter: footerRect !== undefined && footerRect.bottom > 0 && footerRect.top < innerHeight
                  && !(sectionRect.bottom > 0 && sectionRect.top < innerHeight),
              }
            }),
            message: seat.textContent?.trim() ?? '',
          })),
          breadcrumb: {
            route: breadcrumb?.getAttribute('data-manager-page-route') ?? null,
            ordered: breadcrumbOrdered,
            inline: breadcrumbItems.flatMap(item => [...item.querySelectorAll(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current')].map(label => label.textContent?.trim() ?? '')),
            overflow: [...(breadcrumb?.querySelectorAll('.cxm-breadcrumb-menu .cxm-breadcrumb-action') ?? [])].map(item => item.textContent?.trim() ?? ''),
            overflowCount: Number(breadcrumb?.getAttribute('data-breadcrumb-overflow-count') ?? 0),
            overflowMenuOpen: breadcrumb?.querySelector('.cxm-breadcrumb-overflow')?.open ?? false,
            clientWidth: breadcrumb?.clientWidth ?? null,
            scrollWidth: breadcrumb?.scrollWidth ?? null,
            itemWidths: breadcrumbItems.map(item => item.getBoundingClientRect().width),
            current: breadcrumbCurrent?.textContent?.trim() ?? null,
            currentInteractive: breadcrumbCurrent?.matches('a,button') ?? null,
            ancestorTargets: [...(breadcrumb?.querySelectorAll('[data-breadcrumb-target]') ?? [])].map(item => item.getAttribute('data-breadcrumb-target')),
            backPresent: document.querySelector('.cxm-heading-leading.cxm-back') !== null,
          },
          nativeRoute: { url: location.href, historyLength: history.length },
          breadcrumbConstraintWidth: breadcrumbWidth ?? null,
          channelDataPlane: (() => {
            const runtime = globalThis.__cordisxRuntime
            const snapshot = runtime?.snapshot?.()
            if (snapshot === undefined) return null
            const plugin = snapshot.plugins.find(item => item.id === 'channel')
            const registration = snapshot.registrations.find(item => (
              item.surface === 'manager.settings.navigation-items'
              && item.qualifiedId === 'channel:channels'
            ))
            const route = snapshot.navigation.routes.find(item => item.qualifiedId === 'channel:settings')
            const page = snapshot.navigation.pages.find(item => item.qualifiedId === 'channel:settings')
            const outlet = snapshot.navigation.outlets.find(item => item.id === 'manager.content')
            return {
              locale: document.documentElement.lang,
              plugin: plugin === undefined ? null : {
                status: plugin.status,
                schemaKind: plugin.configuration.schemaKind,
                configFields: plugin.configuration.fields.length,
              },
              registration: registration === undefined ? null : {
                valid: registration.valid,
                pending: registration.pending,
                visible: registration.visible,
                authorized: registration.authorized,
                group: registration.group,
                routeId: registration.item?.route?.id ?? null,
              },
              route: route === undefined ? null : {
                valid: route.valid,
                outlet: route.definition.outlet,
                path: route.definition.path,
                page: route.definition.page,
                diagnostics: route.productMetadata.diagnostics.length,
              },
              page: page === undefined ? null : {
                chrome: page.metadata.chrome,
                icon: page.metadata.icon,
                diagnostics: page.productMetadata.diagnostics.length,
              },
              outlet: outlet === undefined ? null : {
                available: outlet.available,
                mounted: outlet.mounted,
                activeRoute: outlet.activeRoute ?? null,
              },
              navigationItem: document.querySelector('[data-settings-navigation-item="channel:channels"]') === null ? null : {
                label: document.querySelector('[data-settings-navigation-item="channel:channels"]')?.textContent?.trim() ?? null,
                icon: document.querySelector('[data-settings-navigation-item="channel:channels"] [data-host-icon]')?.getAttribute('data-host-icon') ?? null,
              },
              pageTitle: document.querySelector('.cxm-heading-current-heading')?.textContent?.trim() ?? null,
              mounted: document.querySelector('[data-channel-manager]') !== null,
              managerFlow: channelManagerFlow,
              existingAccount: channelManagerExistingAccount,
            }
          })(),
          tabGeometry: leadingRect === undefined || tabIconRect === undefined || tabLabelRect === undefined || titleRect === undefined ? null : {
            headingLeadingCenterX: leadingRect.x + leadingRect.width / 2,
            firstTabIconCenterX: tabIconRect.x + tabIconRect.width / 2,
            headingTitleX: titleRect.x,
            firstTabLabelX: tabLabelRect.x,
          },
          configScroll,
          permissions: [...document.querySelectorAll('[data-permission-item]')].map(item => ({
            capability: item.getAttribute('data-permission-item'),
            availability: item.querySelector('[data-permission-availability]')?.getAttribute('data-availability-state') ?? null,
            policyEditable: item.querySelector('.t-select input[data-permission-capability]') !== null,
            nestedList: item.querySelector('[role="listitem"]') !== null,
          })),
          permissionDetail: document.querySelector('[data-permission-detail]') === null ? null : {
            capability: document.querySelector('[data-permission-detail]')?.getAttribute('data-permission-detail') ?? null,
            providers: [...document.querySelectorAll('[data-permission-provider]')].map(item => ({
              id: item.getAttribute('data-permission-provider'),
              text: item.textContent?.trim() ?? '',
            })),
            policyEditable: document.querySelector('[data-permission-detail] .t-select input[data-permission-capability]') !== null,
            headings: [...document.querySelectorAll('[data-permission-detail] h1, [data-permission-detail] h2, [data-permission-detail] h3')].map(item => item.textContent?.trim() ?? ''),
          },
          marketplace: (() => {
            const managerContent = document.querySelector('.cxm-content')
            const discovery = document.querySelector('[data-marketplace-discovery-page]')
            const tools = discovery?.querySelector('.cxm-marketplace-discovery-tools')
            const search = tools?.querySelector('[data-collection-search="marketplace"]')
            const filters = tools?.querySelector('.cxm-marketplace-filter-row')
            const results = discovery?.querySelector('[data-marketplace-results-scroll]')
            const sourcePage = document.querySelector('[data-marketplace-source-page]')
            const sourceForm = sourcePage?.querySelector('[data-host-form^="marketplace-source-"]')
            const popup = document.querySelector('[data-manager-action-menu], .cxc-menu-popup')
            const box = element => {
              const rect = element?.getBoundingClientRect()
              return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }
            const contentStyle = managerContent === null ? null : getComputedStyle(managerContent)
            const resultsStyle = results == null ? null : getComputedStyle(results)
            const searchRect = search?.getBoundingClientRect()
            const filterRect = filters?.getBoundingClientRect()
            const official = [...document.querySelectorAll('[data-collection-item]')]
              .find(item => item.getAttribute('data-collection-item') === 'https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
            const imported = marketplaceSource === undefined ? undefined : [...document.querySelectorAll('[data-collection-item]')]
              .find(item => item.getAttribute('data-collection-item') === marketplaceSource)
            const persistedImported = marketplaceSource === undefined ? undefined : (() => {
              try {
                const value = JSON.parse(localStorage.getItem('cordisx.manager.marketplaceSources.v2') ?? 'null')
                return value?.sources?.find?.(item => item?.url === marketplaceSource) ?? null
              } catch {
                return null
              }
            })()
            const remove = popup?.querySelector('[data-collection-action="remove"]')
            return {
              view: discovery !== null
                ? 'discovery'
                : document.querySelector('[data-marketplace-trust-dimension]') !== null
                  ? 'detail'
                : sourcePage?.getAttribute('data-marketplace-source-page') === 'index'
                  ? 'sources'
                  : sourcePage?.getAttribute('data-marketplace-source-page') ?? null,
              geometry: { content: box(managerContent), discovery: box(discovery), tools: box(tools), search: box(search), filters: box(filters), results: box(results), sourceForm: box(sourceForm) },
              discovery: discovery === null ? null : {
                contentOverflowY: contentStyle?.overflowY ?? null,
                resultsOverflowY: resultsStyle?.overflowY ?? null,
                onlyResultsScroll: contentStyle?.overflowY === 'hidden' && ['auto', 'scroll'].includes(resultsStyle?.overflowY ?? ''),
                filterBelowSearch: searchRect !== undefined && filterRect !== undefined && filterRect.top >= searchRect.bottom - 1,
                documentationPrimaryActionAbsent: ![...document.querySelectorAll('a,button')].some(item => /docs|文档/iu.test(item.textContent ?? '')),
                fullWidth: discovery.clientWidth >= (managerContent?.clientWidth ?? 0)
                  - Number.parseFloat(contentStyle?.paddingLeft ?? '0')
                  - Number.parseFloat(contentStyle?.paddingRight ?? '0') - 1,
                resultCount: document.querySelectorAll('[data-marketplace-plugin]').length,
              },
              sources: sourcePage === null ? null : {
                count: document.querySelectorAll('[data-collection-item]').length,
                officialPresent: official !== undefined,
                officialDeleteDisabled: remove instanceof HTMLButtonElement ? remove.disabled : null,
                manualReloadAbsent: ![...document.querySelectorAll('button')].some(item => item.textContent?.includes('重新加载')),
                topLevelSettingsTabAbsent: document.querySelector('[data-settings-tab="host:marketplace"]') === null,
                formFullWidth: sourceForm == null || sourcePage === null
                  ? null : sourceForm.getBoundingClientRect().width >= sourcePage.getBoundingClientRect().width - 1,
                untouchedErrorAbsent: sourceForm == null || sourceForm.querySelector('.cxf-error:not([hidden])') === null,
                nativeUrlErrorAbsent: !document.body.textContent?.includes("Failed to construct 'URL'"),
                primaryDeveloperTermsAbsent: !/Host|profile|canonical identity|marketplace-source\.v1|renderer|启动器|渲染器|规范标识/iu.test(sourcePage?.textContent ?? ''),
                clipboardImport: marketplaceClipboardExercise ? {
                  rowPresent: imported !== undefined,
                  title: imported?.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                  description: imported?.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                  machineId: imported?.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                  local: persistedImported?.local ?? null,
                  noticeVisible: sourcePage?.querySelector('.cxf-alert[data-tone="info"]') !== null,
                } : null,
              },
              menu: popup === null ? null : {
                portaled: popup.parentElement === document.body,
                theme: popup.getAttribute('data-cordisx-app-theme'),
                managerTheme: document.querySelector('[data-cordisx-manager-modal]')?.getAttribute('data-cordisx-app-theme') ?? null,
                firstItemFocused: popup.querySelector('button:not(:disabled)') === document.activeElement,
                keyboard: marketplaceMenuKeyboard,
                bounded: (() => {
                  const rect = popup.getBoundingClientRect()
                  return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                })(),
              },
            }
          })(),
          tdesign: {
            hostOwnedControlCount: document.querySelectorAll('.cxr-root .cxf-control-seat .t-input, .cxr-root .cxf-control-seat .t-checkbox, .cxr-root .cxf-control-seat .t-switch').length,
            selectCount: document.querySelectorAll('.cxr-root .t-select').length,
            nativeHostSelectCount: document.querySelectorAll('[data-cordisx-manager-modal] select').length,
            groupCardCount: document.querySelectorAll('.cxf-form-grid').length,
            portalCount: document.querySelectorAll('.cxr-root .t-popup').length,
            popupVisible: [...document.querySelectorAll('.cxr-root .t-select__dropdown')].some(popup => popup.getClientRects().length > 0),
            popupOptionCount: [...document.querySelectorAll('.cxr-root .t-select__dropdown')].filter(popup => popup.getClientRects().length > 0).reduce((count, popup) => count + popup.querySelectorAll('.t-select-option').length, 0),
            popupTheme: (() => {
              const listbox = [...document.querySelectorAll('.cxr-root .t-select__dropdown')].find(item => item.getClientRects().length > 0)
              if (!(listbox instanceof HTMLElement)) return null
              const style = getComputedStyle(listbox)
              const rect = listbox.getBoundingClientRect()
              const activeOption = listbox.querySelector('.t-select-option.t-is-selected, .t-select-option.t-select-option__hover')
              const activeStyle = activeOption instanceof Element ? getComputedStyle(activeOption) : null
              return { background: style.backgroundColor, color: style.color,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                activeOption: activeOption === null ? null : {
                  selected: activeOption.classList.contains('t-is-selected'),
                  background: activeStyle?.backgroundColor ?? null,
                  color: activeStyle?.color ?? null,
                } }
            })(),
            activeElement: document.activeElement?.tagName.toLowerCase() ?? null,
            selectState: (() => {
              const select = [...document.querySelectorAll('.cxr-root .t-select input')].find(item => item.getClientRects().length > 0)
              if (select === undefined) return null
              const tokens = getComputedStyle(select)
              return {
                tabIndex: select.tabIndex,
                value: select.value,
                containerToken: tokens.getPropertyValue('--td-bg-color-container').trim(),
                selectedToken: tokens.getPropertyValue('--td-bg-color-container-select').trim(),
                colorScheme: tokens.colorScheme,
              }
            })(),
          },
          hostCollections: [...document.querySelectorAll('[data-host-collection]')].map(collection => {
            const list = collection.querySelector('.cxc-list')
            const cards = [...collection.querySelectorAll('.cxc-card')]
            const action = collection.querySelector('.cxc-action:not(:disabled), .cxc-menu-trigger:not(:disabled)')
            const actionStyle = action === null ? null : getComputedStyle(action.closest('.cxc-actions'))
            const actionsRestOpacity = actionStyle?.opacity ?? null
            const listStyle = list === null ? null : getComputedStyle(list)
            const cardRects = cards.map(card => card.getBoundingClientRect())
            const listRect = list?.getBoundingClientRect()
            const rowTops = [...new Set(cardRects.filter(rect => rect.width > 0).map(rect => Math.round(rect.top)))]
            const firstRowTop = rowTops[0]
            let actionsFocusOpacity = null
            let actionsFocusWithin = null
            let actionsFocusPointerEvents = null
            if (action instanceof HTMLElement) {
              const previous = document.activeElement
              const actionLayer = action.closest('.cxc-actions')
              const previousTransition = actionLayer instanceof HTMLElement ? actionLayer.style.transition : ''
              if (actionLayer instanceof HTMLElement) actionLayer.style.transition = 'none'
              action.focus()
              const focusedStyle = getComputedStyle(actionLayer)
              actionsFocusOpacity = focusedStyle.opacity
              actionsFocusPointerEvents = focusedStyle.pointerEvents
              actionsFocusWithin = action.closest('.cxc-card')?.matches(':focus-within') ?? false
              if (previous instanceof HTMLElement) previous.focus()
              else action.blur()
              if (actionLayer instanceof HTMLElement) actionLayer.style.transition = previousTransition
            }
            return {
              id: collection.getAttribute('data-host-collection'),
              search: collection.querySelector('.cxc-search-input') !== null,
              chevrons: collection.querySelectorAll('.cxm-chevron').length,
              itemCount: collection.querySelectorAll('[data-collection-item]').length,
              visibleColumns: firstRowTop === undefined ? 0 : cardRects.filter(rect => Math.round(rect.top) === firstRowTop).length,
              cardWidths: [...new Set(cardRects.filter(rect => rect.width > 0).map(rect => Math.round(rect.width)))],
              cardHeights: [...new Set(cardRects.filter(rect => rect.height > 0).map(rect => Math.round(rect.height)))],
              listHeight: listRect === undefined ? null : Math.round(listRect.height),
              cardsUseContentHeight: listRect === undefined || cardRects.length === 0 || cardRects.every(rect => rect.height < listRect.height - 2),
              gridTemplateColumns: listStyle?.gridTemplateColumns ?? null,
              actionsPosition: actionStyle?.position ?? null,
              actionsRestOpacity,
              actionsFocusOpacity,
              actionsFocusWithin,
              actionsFocusPointerEvents,
              primaryButtons: collection.querySelectorAll('.cxc-primary[data-collection-open]').length,
              items: cards.map(card => ({
                title: card.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: card.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                machineId: card.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
              })),
              primaryDeveloperInternals: [
                'ctx.',
                'outlet',
                'session.content',
                'manager.settings.',
                'body-only',
                'Host chrome',
                'schemaVersion',
                'verificationPolicy',
              ].filter(token => {
                const primaryText = [
                  collection.textContent ?? '',
                  ...[...collection.querySelectorAll('input')].map(input => input.getAttribute('placeholder') ?? ''),
                ].join(' ')
                return primaryText.includes(token)
              }),
            }
          }),
          headerChrome: (() => {
            const header = document.querySelector('.cxm-heading')
            const close = document.querySelector('.cxm-close')
            const glyph = close?.querySelector('.cxm-close-icon')
            const closeRect = close?.getBoundingClientRect()
            const glyphRect = glyph?.getBoundingClientRect()
            const closeStyle = close === null ? null : getComputedStyle(close)
            return {
              descriptions: [...(header?.querySelectorAll(':scope > p') ?? [])].map(item => item.textContent?.trim() ?? ''),
              breadcrumbOverflowCount: header?.querySelector('.cxm-breadcrumbs')?.getAttribute('data-breadcrumb-overflow-count') ?? null,
              breadcrumbLabels: [...(header?.querySelectorAll('.cxm-breadcrumb-action, .cxm-breadcrumb-current') ?? [])]
                .map(item => item.textContent?.trim() ?? ''),
              close: {
                isButton: close?.matches('button') ?? false,
                seat: closeRect === undefined ? null : { width: Math.round(closeRect.width), height: Math.round(closeRect.height) },
                glyph: glyphRect === undefined ? null : { width: Math.round(glyphRect.width), height: Math.round(glyphRect.height) },
                idleBackground: closeStyle?.backgroundColor ?? null,
                idleBorder: closeStyle?.borderTopWidth ?? null,
              },
            }
          })(),
          extensionPointCatalog: document.querySelector('[data-host-collection="extension-points"]') === null ? null : {
            locale: document.documentElement.lang,
            header: (() => {
              const header = document.querySelector('.cxm-heading')
              return {
                title: header?.querySelector('.cxm-heading-current-heading')?.textContent?.trim() ?? null,
                descriptions: [...(header?.querySelectorAll(':scope > p') ?? [])].map(item => item.textContent?.trim() ?? ''),
              }
            })(),
            compactIconLayout: (() => {
              const collection = document.querySelector('[data-host-collection="extension-points"]')
              const row = collection?.querySelector('[data-extension-point-id]')
              const seat = row?.querySelector('.cxc-icon-seat')
              const glyph = seat?.querySelector('[data-host-icon]')
              const seatRect = seat?.getBoundingClientRect()
              const glyphRect = glyph?.getBoundingClientRect()
              return {
                density: collection?.getAttribute('data-density') ?? null,
                seat: seatRect === undefined ? null : { width: Math.round(seatRect.width), height: Math.round(seatRect.height) },
                glyph: glyphRect === undefined ? null : { width: Math.round(glyphRect.width), height: Math.round(glyphRect.height) },
                iconButtons: collection?.querySelectorAll('.cxc-icon-seat button').length ?? 0,
              }
            })(),
            rows: [...document.querySelectorAll('[data-host-collection="extension-points"] [data-extension-point-id]')].map(row => {
              const rect = row.getBoundingClientRect()
              const status = row.querySelector('.cxc-status')
              const statusRect = status?.getBoundingClientRect()
              return {
                id: row.getAttribute('data-extension-point-id'),
                state: row.getAttribute('data-extension-point-state'),
                title: row.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                stableId: row.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                hostIcon: row.querySelector('[data-host-icon]')?.getAttribute('data-host-icon') ?? null,
                status: status?.textContent?.trim() ?? null,
                typeOrNormalTag: [...row.querySelectorAll('.cxm-kind-badge')].map(item => item.textContent?.trim() ?? ''),
                statusInsidePrimaryRow: statusRect === undefined || (statusRect.top >= rect.top && statusRect.bottom <= rect.bottom),
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
          routePageCatalog: document.querySelector('[data-host-collection="routes"], [data-host-collection^="plugin-routes-"]') === null ? null : (() => {
            const panel = document.querySelector('.cxm-content')
            const collection = document.querySelector('[data-host-collection="routes"], [data-host-collection^="plugin-routes-"]')
            const rows = [...(collection?.querySelectorAll('[data-route-product-row], [data-page-product-row]') ?? [])].map(row => {
              const rect = row?.getBoundingClientRect()
              return {
                kind: row?.hasAttribute('data-route-product-row') === true ? 'route' : 'page',
                id: row?.getAttribute('data-route-product-row') ?? row?.getAttribute('data-page-product-row'),
                title: row?.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row?.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                ariaLabel: row?.getAttribute('aria-label') ?? null,
                hostIcon: row?.querySelector('[data-material-icon]')?.getAttribute('data-material-icon') ?? null,
                machineId: row?.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                status: row?.querySelector('.cxc-status')?.getAttribute('aria-label') ?? null,
                chevron: row?.querySelector('.cxm-chevron') !== null,
                tags: row?.querySelectorAll('.cxm-kind-badge,.cxm-badge,.cxm-status').length ?? 0,
                horizontalOverflow: row instanceof HTMLElement ? row.scrollWidth > row.clientWidth + 1 : null,
                insidePanel: rect === undefined || panel === null ? null : (() => {
                  const panelRect = panel.getBoundingClientRect()
                  return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1
                })(),
              }
            })
            return {
              locale: document.documentElement.lang,
              pageRoute: document.querySelector('[data-manager-page-route]')?.getAttribute('data-manager-page-route') ?? null,
              compactIconLayout: (() => {
                const row = collection?.querySelector('[data-route-product-row], [data-page-product-row]')
                const seat = row?.querySelector('.cxc-icon-seat')
                const glyph = seat?.querySelector('[data-material-icon]')
                const seatRect = seat?.getBoundingClientRect()
                const glyphRect = glyph?.getBoundingClientRect()
                return {
                  density: collection?.getAttribute('data-density') ?? null,
                  seat: seatRect === undefined ? null : { width: Math.round(seatRect.width), height: Math.round(seatRect.height) },
                  glyph: glyphRect === undefined ? null : { width: Math.round(glyphRect.width), height: Math.round(glyphRect.height) },
                  iconButtons: collection?.querySelectorAll('.cxc-icon-seat button').length ?? 0,
                }
              })(),
              listRole: collection?.querySelector('.cxc-list')?.getAttribute('role') ?? null,
              rowCount: rows.length,
              rows,
              fallbackPlaceholderVisible: (panel?.textContent ?? '').includes('受控页面 mount'),
              contentHorizontalOverflow: panel instanceof HTMLElement ? panel.scrollWidth > panel.clientWidth + 1 : null,
              search: (() => {
                const input = document.querySelector('input[type="search"]')
                return input === null ? null : {
                  ariaLabel: input.getAttribute('aria-label'),
                  placeholder: input.getAttribute('placeholder'),
                }
              })(),
            }
          })(),
          routePageDetail: (() => {
            const cards = [...document.querySelectorAll('.cxm-route-card')]
            if (cards.length === 0) return null
            const icons = cards.map(card => {
              const icon = card.querySelector('.cxm-route-card-icon')
              const rect = icon?.getBoundingClientRect()
              const glyph = icon?.querySelector('svg')?.getBoundingClientRect()
              return {
                token: icon?.getAttribute('data-material-icon') ?? null,
                seat: rect === undefined ? null : { width: Math.round(rect.width), height: Math.round(rect.height) },
                glyph: glyph === undefined ? null : { width: Math.round(glyph.width), height: Math.round(glyph.height) },
                isButton: icon?.matches('button') ?? false,
                nestedButtons: icon?.querySelectorAll('button').length ?? 0,
              }
            })
            return { icons, nestedButtons: cards.reduce((count, card) => count + card.querySelectorAll('.cxm-route-card-icon button').length, 0) }
          })(),
          marketplaceCatalog: document.querySelector('[aria-label="插件商店列表"]') === null ? null : {
            locale: document.documentElement.lang,
            permanentTrustWarning: (document.querySelector('.cxm-content')?.textContent ?? '').includes('商店收录、schema 校验和页面展示都不代表'),
            sourceConfigured: marketplaceSourceConfigured,
            certifiedOnly: document.querySelector('[data-marketplace-certified-only]')?.getAttribute('aria-pressed') ?? null,
            fixedChrome: (() => {
              const content = document.querySelector('.cxm-content')
              const discovery = document.querySelector('[data-marketplace-discovery-page]')
              const tools = discovery?.querySelector('.cxm-marketplace-discovery-tools')
              const toolbar = tools?.querySelector('.cxm-toolbar')
              const search = toolbar?.querySelector('.cxc-search')
              const filters = tools?.querySelector('.cxm-marketplace-filter-row')
              const results = discovery?.querySelector('[data-marketplace-results-scroll]')
              const list = results?.querySelector('.cxc-list')
              const sourceMenu = toolbar?.querySelector('[data-marketplace-source-menu]')
              return {
                discoveryMode: content?.getAttribute('data-marketplace-discovery') ?? null,
                contentOverflowY: content === null ? null : getComputedStyle(content).overflowY,
                resultsOverflowY: results === null || results === undefined ? null : getComputedStyle(results).overflowY,
                listOverflowY: list === null || list === undefined ? null : getComputedStyle(list).overflowY,
                searchBeforeSourceMenu: search !== null && search !== undefined && sourceMenu !== null && sourceMenu !== undefined
                  ? Boolean(search.compareDocumentPosition(sourceMenu) & Node.DOCUMENT_POSITION_FOLLOWING)
                  : false,
                filtersBelowSearch: search !== null && search !== undefined && filters !== null && filters !== undefined
                  ? filters.getBoundingClientRect().top >= search.getBoundingClientRect().bottom - 1
                  : false,
                documentationButtons: [...(discovery?.querySelectorAll('a,button') ?? [])]
                  .filter(item => item.textContent?.includes('文档')).length,
                sourceManagementRight: sourceMenu !== null && sourceMenu !== undefined,
              }
            })(),
            primaryDeveloperInternals: [...document.querySelectorAll('[aria-label="插件商店列表"] .cxc-card')]
              .flatMap(card => ['schemaVersion', 'integrity', 'ranking', 'outlet', 'mount', 'verificationPolicy']
                .filter(token => (card.textContent ?? '').includes(token))),
            rows: [...document.querySelectorAll('[aria-label="插件商店列表"] [data-marketplace-plugin]')].map(row => {
              const primary = row.querySelector('.cxc-primary')
              const style = primary === null ? null : getComputedStyle(primary)
              return {
                id: row.getAttribute('data-marketplace-plugin'),
                role: row.getAttribute('role'),
                primaryButton: primary?.matches('button') ?? false,
                padding: style === null ? null : [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
                name: row.querySelector('.cxc-title')?.textContent?.trim() ?? null,
                description: row.querySelector('.cxc-description')?.textContent?.trim() ?? null,
                machineId: row.querySelector('.cxc-machine-id')?.textContent?.trim() ?? null,
                official: row.getAttribute('data-marketplace-official'),
                certified: row.getAttribute('data-marketplace-certified'),
                rankingTier: row.getAttribute('data-marketplace-ranking-tier'),
                rankingOfficialPriority: row.getAttribute('data-marketplace-ranking-official-priority'),
                rankingExplanation: row.getAttribute('data-marketplace-ranking-explanation'),
                badges: [...row.querySelectorAll('[data-trust-dimension]')].map(badge => ({
                  dimension: badge.getAttribute('data-trust-dimension'),
                  label: badge.textContent?.trim() ?? null,
                  ariaLabel: badge.getAttribute('aria-label'),
                  icon: badge.querySelector('[data-host-icon-key]')?.getAttribute('data-host-icon-key') ?? null,
                })),
                chevron: row.querySelector('.cxm-chevron') !== null,
              }
            }),
          },
          marketplaceTrustDetail: document.querySelector('[data-marketplace-trust-dimension]') === null ? null : {
            dimensions: [...document.querySelectorAll('[data-marketplace-trust-dimension]')].map(item => ({
              dimension: item.getAttribute('data-marketplace-trust-dimension'),
              text: item.textContent?.trim() ?? null,
              evidence: item.querySelector('a')?.href ?? null,
            })),
            boundary: document.querySelector('[data-marketplace-trust-boundary]')?.textContent?.trim() ?? null,
          },
        },
      }
    })()`
