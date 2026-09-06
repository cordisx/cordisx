import {
  type CordisXIconToken,
  type CordisXPermissionPolicy,
  type CordisXPluginConsolePageV1,
} from '../../contracts.js'
import type { ExtensionPointPluginUsageSnapshot, ExtensionPointSnapshot } from '.././extension-points.js'
import {
  createHostCollection,
  type HostCollectionItem,
  type HostCollectionStatus,
  type HostCollectionView,
} from '.././host-collection.js'
import { HostFormAdapter } from '.././host-form.js'
import { resolveHostTheme } from '.././host-theme.js'
import { createHostSurfaceIcon, createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { highlightSafeMarkdownCodeBlocks, renderSafeMarkdown } from '.././markdown.js'
import type { NavigationPageSnapshot, RouteSnapshot } from '.././navigation.js'
import { type TDesignSelectElement } from '.././tdesign-form.js'
import { HostTooltipController } from '.././tooltips.js'
import { managerCopy } from '.././ui-copy.js'
import {
  capabilityAvailabilityLabel,
  capabilityPresentation,
  createCapabilityIcon,
  createPermissionPolicySelect,
} from './authorization.js'
import {
  pluginConsoleEntryCopyText,
  PluginConsoleLunaEntryProjection,
  projectPluginConsoleEntryForLuna,
  summarizePluginConsole,
} from './console-projection.js'
import { create } from './dom.js'
import type { ManagerConsoleState } from './interaction-state.js'
import {
  LocalTabIcon,
  ManagerModel,
  ManagerPermissionSnapshot,
  ManagerPluginSnapshot,
  ManagerRouteState,
  ManagerSnapshot,
  PluginDetailTab,
} from './model.js'
import { LocalizedTab, PLUGIN_DETAIL_TABS } from './presentation.js'
import { activateManagerListRow, createLocalTabs, createTabPanel, statusLabel } from './widgets.js'

export interface PluginDetailDependencies {
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  content: HTMLDivElement
  document: Document
  routeState: ManagerRouteState
  localizeTabs: <T extends string>(
    items: readonly LocalizedTab<T>[],
  ) => readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[]
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  renderPluginConfiguration: (plugin: ManagerPluginSnapshot, panel: HTMLElement) => void
  operationError: string | undefined
  forms: HostFormAdapter
  commitPermissionPolicy: (
    pluginId: string,
    permission: ManagerPermissionSnapshot,
    policy: CordisXPermissionPolicy,
    control: TDesignSelectElement<CordisXPermissionPolicy>,
  ) => Promise<void>
  model: ManagerModel
  dismissedConsoleWarnings: Map<string, number>
  managerIconAction: (
    icon: ManagerIconToken,
    label: string,
    options?: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    },
  ) => HTMLButtonElement
  renderContent: () => void
  busyPluginId: string | undefined
  authorizeAndRestore: (plugin: ManagerPluginSnapshot) => Promise<void>
  consoleScrollStates: Map<string, { follow: boolean; scrollTop: number }>
  tooltips: HostTooltipController
  copyConsoleText: (value: string) => Promise<void>
  exportPluginConsole: (pluginId: string, page: CordisXPluginConsolePageV1) => void
  mountLunaConsole: (
    container: HTMLElement,
    projections: readonly PluginConsoleLunaEntryProjection[],
    pluginId: string,
    latest: HTMLButtonElement,
  ) => void
  pluginExtensionPointQueries: Map<string, string>
  extensionPointRowStatus: (
    snapshot: ManagerSnapshot,
    point: ExtensionPointSnapshot,
    usage?: ExtensionPointPluginUsageSnapshot,
  ) =>
    | Readonly<{ state: 'pending' | 'unavailable' | 'error'; text: string; icon: 'host:warning' | 'host:error' }>
    | undefined
  mountHostCollection: (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ) => HostCollectionView
  pluginRouteQueries: Map<string, string>
  qualifiedNavigationId: (owner: string, id: string) => string
  routeCollectionItem: (snapshot: ManagerSnapshot, route: RouteSnapshot, onOpen: () => void) => HostCollectionItem
  pageCollectionItem: (
    snapshot: ManagerSnapshot,
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
    onOpen: () => void,
  ) => HostCollectionItem
  consoleState: Pick<
    ManagerConsoleState,
    | 'consolePaused'
    | 'consolePausedPage'
    | 'consoleQuery'
    | 'consoleMethod'
    | 'consoleKind'
    | 'consoleSource'
    | 'selectedConsoleEntry'
  >
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createPluginDetail(dependencies: PluginDetailDependencies) {
  const renderPluginDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const plugin = snapshot.plugins.find(item => item.id === id)
    dependencies.setHeading(dependencies.copy('plugins.heading'), snapshot)
    if (plugin === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '插件已不在当前 bundle 中'))
      return
    }
    const activeFacet = dependencies.routeState.kind === 'plugin' ? dependencies.routeState.facet : 'readme'
    dependencies.content.append(
      createLocalTabs(
        dependencies.document,
        dependencies.localizeTabs(PLUGIN_DETAIL_TABS),
        activeFacet,
        'data-plugin-detail-tab',
        (tab) => {
          void dependencies.navigateRoute({ kind: 'plugin', pluginId: id, facet: tab as PluginDetailTab })
        },
      ),
    )

    if (activeFacet === 'readme') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.readme'))
      if (plugin.readme?.trim() === '') {
        panel.append(create(dependencies.document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else if (plugin.readme === undefined) {
        panel.append(create(dependencies.document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else {
        const readme = renderSafeMarkdown(dependencies.document, plugin.readme)
        panel.append(readme)
        // Safe Markdown creates text-only DOM synchronously. Shiki merely
        // projects its fenced-code text into Host-owned token spans afterward.
        void highlightSafeMarkdownCodeBlocks(readme, resolveHostTheme(dependencies.document).theme).catch(() =>
          undefined
        )
      }
      dependencies.content.append(panel)
      return
    }

    if (activeFacet === 'config') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.configuration'))
      dependencies.renderPluginConfiguration(plugin, panel)
      dependencies.content.append(panel)
      return
    }

    if (activeFacet === 'permissions') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.permissions'))
      const permissions = snapshot.permissions.filter(item =>
        item.identity.source === plugin.source && item.identity.id === plugin.id
      )
      if (permissions.length === 0) {
        panel.append(create(dependencies.document, 'div', 'cxm-empty', '该插件没有申请任何权限。'))
      }
      const permissionList = create(dependencies.document, 'div')
      permissionList.classList.add('cxm-flat-list', 'cxm-settings-group')
      permissionList.setAttribute('role', 'list')
      permissionList.dataset.managerGroup = 'capability-declarations'
      for (const permission of permissions) {
        const presentation = capabilityPresentation(permission.capability)
        const item = create(dependencies.document, 'div', 'cxm-flat-item cxm-permission-item')
        item.setAttribute('role', 'listitem')
        item.setAttribute('aria-label', presentation.name)
        item.dataset.permissionItem = permission.capability
        const open = create(dependencies.document, 'button', 'cxm-permission-open')
        open.type = 'button'
        open.dataset.permissionOpen = permission.capability
        const copy = create(dependencies.document, 'span', 'cxm-permission-copy')
        const title = create(dependencies.document, 'span', 'cxm-permission-title')
        title.append(create(dependencies.document, 'span', 'cxm-permission-name', presentation.name))
        if (permission.required) title.append(create(dependencies.document, 'span', 'cxm-required-badge', '必需'))
        copy.append(title, create(dependencies.document, 'span', 'cxm-permission-reason', permission.reasonText))
        open.append(createCapabilityIcon(dependencies.document, permission.capability), copy)
        activateManagerListRow(open, () => {
          dependencies.operationError = undefined
          void dependencies.navigateRoute({
            kind: 'permission',
            pluginId: plugin.id,
            capability: permission.capability,
            fingerprint: permission.fingerprint,
          })
        })
        const control = create(dependencies.document, 'div', 'cxm-permission-control')
        control.append(
          createPermissionPolicySelect(dependencies.forms, permission, async (policy, select) => {
            await dependencies.commitPermissionPolicy(plugin.id, permission, policy, select)
          }),
        )
        item.append(open, control)
        permissionList.append(item)
      }
      if (permissions.length > 0) panel.append(permissionList)
      if (dependencies.operationError !== undefined) {
        panel.append(create(dependencies.document, 'div', 'cxm-error', dependencies.operationError))
      }
      dependencies.content.append(panel)
      return
    }

    const pluginRegistrations = snapshot.registrations.filter(item => item.owner === plugin.id)
    const pluginCommands = snapshot.commands.filter(item => item.owner === plugin.id)
    const pluginRoutes = snapshot.navigation.routes.filter(item => item.owner === plugin.id)
    const pluginPages = snapshot.navigation.pages.filter(item => item.owner === plugin.id)
    const appendRuntimeDiagnostics = (target: HTMLElement): void => {
      const runtimeDiagnostics = create(dependencies.document, 'details', 'cxm-diagnostics')
      runtimeDiagnostics.dataset.runtimeDiagnostics = 'platform'
      runtimeDiagnostics.append(
        create(dependencies.document, 'summary', undefined, dependencies.copy('runtime.diagnostics')),
      )
      const diagnosticsBody = create(dependencies.document, 'div', 'cxm-diagnostics-body')
      let hasDiagnostics = false
      if (plugin.error !== undefined) {
        diagnosticsBody.append(create(dependencies.document, 'div', 'cxm-error', plugin.error))
        hasDiagnostics = true
      }
      if (plugin.blockedReason !== undefined) {
        diagnosticsBody.append(create(dependencies.document, 'div', 'cxm-error', plugin.blockedReason))
        hasDiagnostics = true
      }
      if (dependencies.operationError !== undefined) {
        diagnosticsBody.append(create(dependencies.document, 'div', 'cxm-error', dependencies.operationError))
        hasDiagnostics = true
      }
      if (plugin.configuration !== undefined && !plugin.configuration.writable) {
        const configSchema = plugin.configuration.schemaKind === 'schemastery'
          ? 'Schemastery'
          : plugin.configuration.schemaKind === 'standard'
          ? 'Standard Schema'
          : dependencies.copy('runtime.not-declared')
        const configurationDiagnostics = create(
          dependencies.document,
          'div',
          'cxm-copy',
          `${dependencies.copy('runtime.configuration')}: ${configSchema} · ${plugin.configuration.applies} · ${
            dependencies.copy('runtime.revision')
          } ${plugin.configuration.revision} · ${
            dependencies.copy('runtime.last-good')
          } ${plugin.configuration.lastGoodRevision} · ${dependencies.copy('runtime.writer')} ${
            plugin.configuration.writable
              ? dependencies.copy('runtime.available')
              : dependencies.copy('runtime.unavailable')
          }`,
        )
        configurationDiagnostics.dataset.configDiagnostics = plugin.id
        diagnosticsBody.append(configurationDiagnostics)
        hasDiagnostics = true
      }
      for (
        const provider of (snapshot.capabilityProviders ?? []).filter(item =>
          item.kind !== 'current-connection' && item.status !== 'supported'
        )
      ) {
        diagnosticsBody.append(
          create(
            dependencies.document,
            'div',
            'cxm-copy',
            `${provider.providerNameText} · ${
              capabilityAvailabilityLabel(provider.status, snapshot.localization.locale)
            } · ${provider.reasonText}`,
          ),
        )
        hasDiagnostics = true
      }
      const adapter = snapshot.platform
      for (const diagnostic of adapter.diagnostics) {
        diagnosticsBody.append(
          create(dependencies.document, 'div', 'cxm-error', `${diagnostic.code} · ${diagnostic.message}`),
        )
        hasDiagnostics = true
      }
      const unattributed = dependencies.model.pluginConsole?.(plugin.id)?.unattributedEntries ?? 0
      if (unattributed > 0 && dependencies.dismissedConsoleWarnings.get(plugin.id) !== unattributed) {
        const warning = create(dependencies.document, 'div', 'cxm-notice cxm-console-warning')
        warning.dataset.tone = 'warning'
        warning.append(
          create(
            dependencies.document,
            'span',
            undefined,
            dependencies.copy('console.ownership-warning').replace('{count}', String(unattributed)),
          ),
        )
        const dismissWarning = dependencies.managerIconAction(
          'close',
          dependencies.copy('console.dismiss-ownership-warning'),
        )
        dismissWarning.addEventListener('click', () => {
          dependencies.dismissedConsoleWarnings.set(plugin.id, unattributed)
          dependencies.renderContent()
        })
        warning.append(dismissWarning)
        diagnosticsBody.append(warning)
        hasDiagnostics = true
      }
      if (!hasDiagnostics) return
      runtimeDiagnostics.append(diagnosticsBody)
      target.append(runtimeDiagnostics)
    }
    if (activeFacet === 'runtime') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.runtime'))
      const blocked = plugin.status === 'blocked' || plugin.status === 'failed'
      const permissionBlocked = plugin.status === 'permission-blocked'
      const restorable = blocked || permissionBlocked
      const overview = create(dependencies.document, 'section', 'cxm-runtime-overview')
      const status = create(dependencies.document, 'section', 'cxm-runtime-status')
      status.dataset.pluginRuntimeStatus = plugin.id
      const icon = create(dependencies.document, 'span', 'cxm-runtime-status-icon')
      icon.append(createManagerIcon(dependencies.document, plugin.status === 'active' ? 'runtime' : 'diagnostics'))
      const statusCopy = create(dependencies.document, 'span', 'cxm-runtime-status-copy')
      const hasDetail = plugin.error !== undefined || plugin.blockedReason !== undefined
      statusCopy.append(
        create(
          dependencies.document,
          'span',
          'cxm-runtime-status-label',
          statusLabel(plugin.status, snapshot.localization.locale),
        ),
        create(
          dependencies.document,
          'span',
          'cxm-runtime-status-meta',
          hasDetail ? dependencies.copy('runtime.status-details') : dependencies.copy('runtime.healthy'),
        ),
      )
      status.append(icon, statusCopy)
      if (plugin.status !== 'configured-disabled') {
        const action = dependencies.managerIconAction(
          restorable ? 'enable-plugin' : 'disable-plugin',
          restorable ? dependencies.copy('runtime.reauthorize') : dependencies.copy('runtime.block-plugin'),
          { disabled: dependencies.busyPluginId !== undefined },
        )
        action.dataset.pluginRuntimeAction = plugin.id
        action.addEventListener('click', async () => {
          dependencies.busyPluginId = plugin.id
          dependencies.renderContent()
          try {
            if (restorable) await dependencies.authorizeAndRestore(plugin)
            else await dependencies.model.setPluginBlocked(plugin.id, true)
          } catch (error) {
            dependencies.operationError = error instanceof Error ? error.message : String(error)
          } finally {
            dependencies.busyPluginId = undefined
            dependencies.renderContent()
          }
        })
        status.append(action)
      }
      const facts = create(dependencies.document, 'div', 'cxm-runtime-status-facts')
      for (
        const [label, value] of [
          [
            dependencies.copy('runtime.active-contributions'),
            pluginRegistrations.filter(item => item.visible && item.valid).length,
          ],
          [dependencies.copy('runtime.commands'), pluginCommands.length],
        ] as const
      ) {
        const fact = create(dependencies.document, 'span', 'cxm-runtime-status-fact')
        fact.append(
          create(dependencies.document, 'strong', undefined, String(value)),
          create(dependencies.document, 'span', undefined, label),
        )
        facts.append(fact)
      }
      overview.append(status, facts)
      const consolePage = dependencies.model.pluginConsole?.(plugin.id) ?? {
        contract: 'cordisx.plugin-console-page/v1' as const,
        schemaVersion: 1 as const,
        plugin: { source: plugin.source, pluginId: plugin.id },
        generation: 'manager-unavailable',
        generatedAt: Date.now(),
        partialObservability: true,
        entries: [],
      }
      const consoleSummary = summarizePluginConsole(consolePage)
      const consoleOverview = create(dependencies.document, 'section', 'cxm-runtime-console-summary')
      consoleOverview.dataset.runtimeConsoleSummary = plugin.id
      consoleOverview.setAttribute('aria-label', dependencies.copy('console.performance'))
      for (
        const [label, value] of [
          [dependencies.copy('console.requests'), consoleSummary.requests],
          [dependencies.copy('console.successes'), consoleSummary.successes],
          [dependencies.copy('console.failures'), consoleSummary.failures],
          [dependencies.copy('console.denied'), consoleSummary.denials],
        ] as const
      ) {
        const metric = create(dependencies.document, 'div', 'cxm-runtime-console-metric')
        metric.append(
          create(dependencies.document, 'strong', undefined, String(value)),
          create(dependencies.document, 'span', undefined, label),
        )
        consoleOverview.append(metric)
      }
      const performance = create(dependencies.document, 'details', 'cxm-runtime-console-performance')
      performance.append(
        create(
          dependencies.document,
          'summary',
          undefined,
          `${dependencies.copy('console.performance')} ${
            consoleSummary.averageDurationMs === undefined ? '—' : `${consoleSummary.averageDurationMs.toFixed(1)}ms`
          }`,
        ),
      )
      performance.append(
        create(
          dependencies.document,
          'div',
          'cxm-runtime-console-performance-body',
          consoleSummary.consumption.length === 0
            ? dependencies.copy('console.no-host-api-metrics')
            : consoleSummary.consumption.join('   '),
        ),
      )
      consoleOverview.append(performance)
      overview.append(consoleOverview)
      panel.append(overview)
      if (dependencies.operationError !== undefined) {
        const notice = create(dependencies.document, 'div', 'cxm-notice', dependencies.copy('runtime.status-attention'))
        notice.dataset.tone = 'warning'
        panel.append(notice)
      }
      dependencies.content.append(panel)
      return
    }
    if (activeFacet === 'logs') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.logs'))
      panel.classList.add('cxm-console-panel')
      const livePage = dependencies.model.pluginConsole?.(plugin.id) ?? {
        contract: 'cordisx.plugin-console-page/v1',
        schemaVersion: 1,
        plugin: { source: plugin.source, pluginId: plugin.id },
        generation: 'manager-unavailable',
        generatedAt: Date.now(),
        partialObservability: true,
        entries: [],
      }
      if (
        dependencies.consoleState.consolePaused
        && (dependencies.consoleState.consolePausedPage === undefined
          || dependencies.consoleState.consolePausedPage.plugin.pluginId !== plugin.id)
      ) {
        dependencies.consoleState.consolePausedPage = livePage
      }
      const page = dependencies.consoleState.consolePaused
        ? dependencies.consoleState.consolePausedPage ?? livePage
        : livePage
      const sources = [...new Set(page.entries.map(entry => entry.source))].sort()
      const normalizedQuery = dependencies.consoleState.consoleQuery.trim().toLocaleLowerCase()
      const filtered = page.entries.filter(entry => (
        (dependencies.consoleState.consoleMethod === 'all' || entry.method === dependencies.consoleState.consoleMethod)
        && (dependencies.consoleState.consoleKind === 'all'
          || dependencies.consoleState.consoleKind === 'host-api'
            && (entry.kind === 'invocation' || entry.kind === 'permission')
          || entry.kind === dependencies.consoleState.consoleKind)
        && (dependencies.consoleState.consoleSource === 'all'
          || entry.source === dependencies.consoleState.consoleSource)
        && (normalizedQuery === ''
          || `${entry.message} ${entry.source} ${entry.correlationId ?? ''} ${
            entry.args.map(argument => argument.preview).join(' ')
          }`.toLocaleLowerCase().includes(normalizedQuery))
      ))
      const projections = filtered.map(projectPluginConsoleEntryForLuna)
      const controls = create(dependencies.document, 'div', 'cxm-console-controls')
      const search = create(dependencies.document, 'input')
      search.type = 'search'
      search.placeholder = dependencies.copy('console.search-placeholder')
      search.value = dependencies.consoleState.consoleQuery
      search.dataset.consoleSearch = plugin.id
      search.addEventListener('input', () => {
        dependencies.consoleState.consoleQuery = search.value
        dependencies.renderContent()
      })
      const select = (
        label: string,
        value: string,
        values: readonly string[],
        change: (value: string) => void,
      ): TDesignSelectElement<string> =>
        dependencies.forms.select(
          label,
          values.map(item => ({ value: item, label: item === 'all' ? dependencies.copy('console.all') : item })),
          value,
          next => {
            if (next === undefined) return
            change(next)
            dependencies.renderContent()
          },
        )
      controls.append(
        search,
        select(dependencies.copy('console.level'), dependencies.consoleState.consoleMethod, [
          'all',
          'debug',
          'log',
          'info',
          'warn',
          'error',
        ], value => {
          dependencies.consoleState.consoleMethod = value
        }),
        select(dependencies.copy('console.kind'), dependencies.consoleState.consoleKind, [
          'all',
          'host-api',
          'console',
          'lifecycle',
          'diagnostic',
        ], value => {
          dependencies.consoleState.consoleKind = value
        }),
        select(
          dependencies.copy('console.source'),
          dependencies.consoleState.consoleSource,
          ['all', ...sources],
          value => {
            dependencies.consoleState.consoleSource = value
          },
        ),
      )
      const scrollState = dependencies.consoleScrollStates.get(plugin.id) ?? { follow: true, scrollTop: 0 }
      dependencies.consoleScrollStates.set(plugin.id, scrollState)
      const actionToolbar = create(dependencies.document, 'div', 'cxm-console-action-toolbar')
      actionToolbar.setAttribute('role', 'toolbar')
      actionToolbar.setAttribute('aria-label', dependencies.copy('console.toolbar'))
      const iconAction = (
        action: string,
        icon: ManagerIconToken,
        label: string,
        options: { readonly pressed?: boolean; readonly disabled?: boolean; readonly description?: string } = {},
        invoke: () => void,
      ): HTMLButtonElement => {
        const button = create(dependencies.document, 'button', 'cxm-manager-icon-action')
        button.type = 'button'
        button.dataset.consoleAction = action
        button.dataset.cordisxNoDrag = 'true'
        button.setAttribute('aria-label', label)
        if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
        if (options.description !== undefined) button.setAttribute('aria-description', options.description)
        button.disabled = options.disabled === true
        button.append(createManagerIcon(dependencies.document, icon))
        button.addEventListener('click', invoke)
        button.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          button.click()
        })
        dependencies.tooltips.attach(
          button,
          () => options.description === undefined ? label : `${label} · ${options.description}`,
          'top',
          80,
        )
        return button
      }
      const pauseLabel = dependencies.consoleState.consolePaused
        ? dependencies.copy('console.resume')
        : dependencies.copy('console.pause')
      const pause = iconAction(
        'pause',
        dependencies.consoleState.consolePaused ? 'console-resume' : 'console-pause',
        pauseLabel,
        {
          pressed: dependencies.consoleState.consolePaused,
        },
        () => {
          dependencies.consoleState.consolePaused = !dependencies.consoleState.consolePaused
          dependencies.consoleState.consolePausedPage = dependencies.consoleState.consolePaused
            ? dependencies.model.pluginConsole?.(plugin.id) ?? livePage
            : undefined
          dependencies.renderContent()
        },
      )
      const followLabel = scrollState.follow
        ? dependencies.copy('console.stop-following')
        : dependencies.copy('console.follow')
      const autoScroll = iconAction('follow', 'console-follow', followLabel, { pressed: scrollState.follow }, () => {
        scrollState.follow = !scrollState.follow
        dependencies.renderContent()
      })
      const clear = iconAction('clear', 'console-clear', dependencies.copy('console.clear'), {
        disabled: page.entries.length === 0,
        description: dependencies.copy('console.irreversible'),
      }, () => {
        dependencies.model.clearPluginConsole?.(plugin.id)
        dependencies.consoleState.selectedConsoleEntry = undefined
        dependencies.consoleState.consolePausedPage = undefined
        dependencies.renderContent()
      })
      const selected = page.entries.find(entry => entry.entryId === dependencies.consoleState.selectedConsoleEntry)
      const copyButton = iconAction(
        'copy',
        'console-copy',
        dependencies.copy('console.copy'),
        { disabled: selected === undefined },
        () => {
          if (selected !== undefined) {
            void dependencies.copyConsoleText(pluginConsoleEntryCopyText(selected)).catch(() => undefined)
          }
        },
      )
      const exportButton = iconAction('export', 'console-export', dependencies.copy('console.export'), {
        disabled: page.entries.length === 0,
      }, () => {
        dependencies.exportPluginConsole(plugin.id, page)
      })
      actionToolbar.append(pause, autoScroll, clear, copyButton, exportButton)
      controls.append(actionToolbar)
      panel.append(controls)

      const workspace = create(dependencies.document, 'div', 'cxm-console-workspace')
      const body = create(dependencies.document, 'div', 'cxm-console-body')
      const frame = create(dependencies.document, 'div', 'cxm-console-frame')
      frame.dataset.pluginConsole = plugin.id
      if (projections.length === 0) {
        frame.append(
          create(
            dependencies.document,
            'div',
            'cxm-console-empty',
            page.entries.length === 0 ? dependencies.copy('console.empty') : dependencies.copy('console.no-matches'),
          ),
        )
      } else {
        frame.classList.add('cxm-console-luna')
      }
      const latest = dependencies.managerIconAction('console-follow', dependencies.copy('console.back-to-latest'), {
        className: 'cxm-console-latest',
      })
      latest.hidden = true
      body.append(frame, latest)
      if (selected !== undefined) {
        workspace.dataset.inspector = 'true'
        const inspector = create(dependencies.document, 'aside', 'cxm-console-inspector')
        inspector.dataset.consoleDetail = selected.entryId
        const inspectorHead = create(dependencies.document, 'div', 'cxm-console-inspector-head')
        inspectorHead.append(
          create(dependencies.document, 'span', undefined, dependencies.copy('console.entry-details')),
        )
        const closeInspector = dependencies.managerIconAction('close', dependencies.copy('console.close-details'))
        closeInspector.addEventListener('click', () => {
          dependencies.consoleState.selectedConsoleEntry = undefined
          dependencies.renderContent()
        })
        inspectorHead.append(closeInspector)
        const grid = create(dependencies.document, 'dl', 'cxm-console-inspector-grid')
        const metadata: readonly (readonly [string, string | number | undefined])[] = [
          [dependencies.copy('console.field.timestamp'), new Date(selected.time).toISOString()],
          [dependencies.copy('console.field.plugin'), `${selected.plugin.pluginId} · ${selected.plugin.source}`],
          [dependencies.copy('console.field.generation'), selected.generation],
          [dependencies.copy('console.field.source'), selected.source],
          [dependencies.copy('console.field.kind'), selected.kind],
          [dependencies.copy('console.field.coverage'), selected.coverage],
          [dependencies.copy('console.field.correlation'), selected.correlationId],
          [dependencies.copy('console.field.phase'), selected.phase],
          [dependencies.copy('console.field.status'), selected.status],
          [
            dependencies.copy('console.field.duration'),
            selected.durationMs === undefined ? undefined : `${selected.durationMs.toFixed(1)}ms`,
          ],
          [dependencies.copy('console.field.session'), selected.sessionId],
          [
            dependencies.copy('console.field.trigger'),
            selected.trigger === undefined
              ? undefined
              : `${selected.trigger.kind}${
                selected.trigger.registrationId === undefined ? '' : ` · ${selected.trigger.registrationId}`
              }`,
          ],
          [
            dependencies.copy('console.field.owner'),
            selected.effectiveOwner === undefined
              ? undefined
              : `${selected.effectiveOwner.pluginId} · ${selected.effectiveOwner.source}`,
          ],
          [
            dependencies.copy('console.field.request-metrics'),
            selected.request === undefined ? undefined : JSON.stringify(selected.request),
          ],
          [
            dependencies.copy('console.field.result-metrics'),
            selected.result === undefined ? undefined : JSON.stringify(selected.result),
          ],
        ]
        for (const [label, value] of metadata) {
          if (value === undefined) continue
          grid.append(
            create(dependencies.document, 'dt', undefined, label),
            create(dependencies.document, 'dd', undefined, String(value)),
          )
        }
        inspector.append(inspectorHead, grid)
        workspace.append(body, inspector)
      } else workspace.append(body)
      panel.append(workspace)
      if (projections.length > 0) dependencies.mountLunaConsole(frame, projections, plugin.id, latest)
      // The console page only carries actionable diagnostics. Runtime status
      // and API summaries stay on the dedicated Runtime status tab.
      appendRuntimeDiagnostics(panel)
      dependencies.content.append(panel)
      return
    }

    if (activeFacet === 'extension-points') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.extension-points'))
      const points = (snapshot.extensionPoints?.points ?? []).filter(point =>
        point.plugins.some(usage => (
          usage.identity.source === plugin.source && usage.identity.id === plugin.id
        ))
      )
      const query = dependencies.pluginExtensionPointQueries.get(plugin.id) ?? ''
      const items: HostCollectionItem[] = points.map(point => {
        const usage = point.plugins.find(item =>
          item.identity.source === plugin.source && item.identity.id === plugin.id
        )
        const rowStatus = dependencies.extensionPointRowStatus(snapshot, point, usage)
        const status: HostCollectionStatus | undefined = rowStatus === undefined
          ? undefined
          : {
            label: rowStatus.text,
            tone: rowStatus.state === 'pending' ? 'warning' : 'danger',
            detail: rowStatus.text,
          }
        return {
          id: point.id,
          title: point.titleProjection.text,
          description: point.descriptionProjection.text,
          machineId: point.id,
          searchText: [
            ...(usage?.registrations.flatMap(
              item => [item.titleText, item.descriptionText ?? '', item.id, item.qualifiedId],
            ) ?? []),
            ...(usage?.routes.flatMap(item => [item.qualifiedId, item.definition.path, item.definition.outlet]) ?? []),
          ],
          icon: () => createHostSurfaceIcon(dependencies.document, point.icon),
          ...(status === undefined ? {} : { status }),
          onOpen: () => {
            dependencies.operationError = undefined
            void dependencies.navigateRoute({
              kind: 'extension-point',
              pointId: point.id,
              facet: rowStatus === undefined ? 'usage' : 'diagnostics',
            })
          },
        }
      })
      dependencies.mountHostCollection(panel, {
        id: `plugin-extension-points-${plugin.id}`,
        label: `${plugin.name}扩展点列表`,
        density: 'compact',
        items,
        search: {
          label: `搜索${plugin.name}的扩展点与贡献`,
          placeholder: '搜索扩展点、介绍、贡献名称或 id…',
          query,
          onQueryChange: value => {
            dependencies.pluginExtensionPointQueries.set(plugin.id, value)
          },
        },
        emptyLabel: '当前插件没有使用任何扩展点',
        noMatchesLabel: '没有匹配的扩展点或贡献',
      })
      dependencies.content.append(panel)
      return
    }

    const panel = createTabPanel(dependencies.document, dependencies.copy('plugin-tab.routes'))
    const query = dependencies.pluginRouteQueries.get(plugin.id) ?? ''
    const routesForPage = (page: NavigationPageSnapshot): readonly RouteSnapshot[] =>
      pluginRoutes.filter(route => (
        dependencies.qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
      ))
    const items: HostCollectionItem[] = [
      ...pluginRoutes.map(route =>
        dependencies.routeCollectionItem(snapshot, route, () => {
          void dependencies.navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        })
      ),
      ...pluginPages.map(page =>
        dependencies.pageCollectionItem(snapshot, page, routesForPage(page), () => {
          void dependencies.navigateRoute({ kind: 'page', qualifiedId: page.qualifiedId })
        })
      ),
    ]
    dependencies.mountHostCollection(panel, {
      id: `plugin-routes-${plugin.id}`,
      label: `${plugin.name}路由与页面列表`,
      items,
      search: {
        label: `搜索${plugin.name}的路由与页面`,
        placeholder: '搜索标题、说明、位置、页面或 id…',
        query,
        onQueryChange: value => {
          dependencies.pluginRouteQueries.set(plugin.id, value)
        },
      },
      emptyLabel: '当前插件没有注册路由或页面',
      noMatchesLabel: '没有匹配的路由或页面',
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const id = open.dataset.collectionOpen
        if (id?.startsWith('route:')) open.dataset.routeProductRow = id.slice('route:'.length)
        if (id?.startsWith('page:')) open.dataset.pageProductRow = id.slice('page:'.length)
      }
    })
    dependencies.content.append(panel)
  }
  return { renderPluginDetail }
}
