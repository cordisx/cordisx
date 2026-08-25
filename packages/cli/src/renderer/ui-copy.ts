/**
 * Host-owned product copy for the Manager's primary states and actions.
 *
 * Keep machine identifiers and raw provider errors out of this catalog: those
 * belong in diagnostics, where callers render them as secondary detail.
 */
export type CordisXProductLocale = 'en' | 'zh-CN'

type CopyKey =
  | 'channel.title'
  | 'channel.description'
  | 'channel.status.available'
  | 'channel.accounts'
  | 'channel.accounts.description'
  | 'channel.accounts.empty'
  | 'channel.routes'
  | 'channel.routes.description'
  | 'channel.routes.empty'
  | 'channel.bindings'
  | 'channel.bindings.description'
  | 'channel.bindings.empty'
  | 'channel.diagnostics'
  | 'channel.diagnostics.description'
  | 'channel.diagnostics.empty'
  | 'channel.search.empty'
  | 'channel.search.label'
  | 'channel.search.placeholder'
  | 'channel.search.clear'
  | 'channel.open'
  | 'channel.back'
  | 'channel.create'
  | 'channel.create.icon-label'
  | 'channel.create.description'
  | 'channel.create.local-only'
  | 'channel.create.name'
  | 'channel.create.platform'
  | 'channel.create.unavailable'
  | 'channel.create.save'
  | 'channel.create.simulator'
  | 'channel.create.feishu'
  | 'channel.create.app-id'
  | 'channel.create.tenant'
  | 'channel.create.provider'
  | 'channel.create.model'
  | 'channel.create.profile'
  | 'channel.create.workspace'
  | 'channel.create.notifications'
  | 'channel.configuration'
  | 'channel.configuration.description'
  | 'channel.configuration.unavailable'
  | 'channel.logs'
  | 'channel.logs.unavailable'
  | 'channel.logs.native-semantics'
  | 'channel.logs.search'
  | 'channel.logs.all'
  | 'channel.logs.success'
  | 'channel.logs.failure'
  | 'channel.logs.export'
  | 'channel.logs.page'
  | 'channel.sessions'
  | 'channel.sessions.unavailable'
  | 'channel.field.platform'
  | 'channel.field.transport'
  | 'channel.field.enabled'
  | 'channel.field.status'
  | 'channel.field.credentials'
  | 'channel.status.inbound'
  | 'channel.status.outbound'
  | 'channel.status.generation'
  | 'channel.reconnect'
  | 'channel.enable'
  | 'channel.disable'
  | 'channel.reconnecting'
  | 'channel.reconnected'
  | 'channel.runtime.unavailable'
  | 'channel.binding.archive'
  | 'channel.binding.restore'
  | 'channel.binding.unbind'
  | 'channel.binding-operations.unavailable'
  | 'channel.credentials.help'
  | 'channel.real-readiness'
  | 'channel.real-readiness.description'
  | 'channel.real-readiness.app'
  | 'channel.real-readiness.events'
  | 'channel.real-readiness.credentials'
  | 'channel.real-readiness.adapter'
  | 'channel.real-readiness.events-label'
  | 'channel.real-readiness.adapter-label'
  | 'marketplace.description'
  | 'marketplace.source-label'
  | 'marketplace.add'
  | 'marketplace.no-plugins'
  | 'marketplace.loaded'
  | 'marketplace.loading'
  | 'marketplace.failed'
  | 'marketplace.error-details'
  | 'marketplace.move-up'
  | 'marketplace.move-down'
  | 'marketplace.remove'
  | 'marketplace.restore-official'
  | 'marketplace.reload'
  | 'marketplace.invalid-url'
  | 'marketplace.duplicate-source'
  | 'manager.nav.plugins'
  | 'manager.nav.extension-points'
  | 'manager.nav.routes'
  | 'manager.nav.marketplace'
  | 'manager.nav.about'
  | 'manager.trigger.manage'
  | 'manager.close'
  | 'manager.dialog'
  | 'manager.navigation'
  | 'manager.back'
  | 'plugins.install'
  | 'plugins.install-checking'
  | 'plugins.enable'
  | 'plugins.disable'
  | 'plugins.favorite'
  | 'plugins.unfavorite'
  | 'plugins.reload'
  | 'plugins.open'
  | 'plugins.heading'
  | 'plugin.status.active'
  | 'plugin.status.blocked'
  | 'plugin.status.permission-blocked'
  | 'plugin.status.failed'
  | 'plugin.status.installing'
  | 'plugin.status.updating'
  | 'plugin.status.enabling'
  | 'plugin.status.disabling'
  | 'plugin.status.reloading'
  | 'plugin.status.uninstalling'
  | 'plugin.status.rolling-back'
  | 'plugin.status.rollback-failed'
  | 'plugin.status.configured-disabled'
  | 'runtime.lifecycle-summary'
  | 'runtime.services'
  | 'runtime.none'
  | 'runtime.active-contributions'
  | 'runtime.commands'
  | 'runtime.processing'
  | 'runtime.healthy'
  | 'runtime.status-attention'
  | 'runtime.status-details-in-logs'
  | 'runtime.configured-disabled'
  | 'runtime.reauthorize'
  | 'runtime.restore-plugin'
  | 'runtime.block-plugin'
  | 'runtime.locale-catalogs-empty'
  | 'runtime.commands-empty'
  | 'runtime.diagnostics'
  | 'runtime.section.localization'
  | 'runtime.section.details'
  | 'runtime.configuration'
  | 'runtime.not-declared'
  | 'runtime.revision'
  | 'runtime.last-good'
  | 'runtime.writer'
  | 'runtime.available'
  | 'runtime.unavailable'
  | 'runtime.availability-supported'
  | 'runtime.availability-degraded'
  | 'runtime.host'
  | 'runtime.adapter'
  | 'runtime.secondary-connection'
  | 'runtime.raw-bridge'
  | 'runtime.yes'
  | 'runtime.no'
  | 'runtime.permission-boundary'
  | 'runtime.permission-documentation'
  | 'console.requests'
  | 'console.successes'
  | 'console.failures'
  | 'console.denied'
  | 'console.performance'
  | 'console.no-host-api-metrics'
  | 'console.search-placeholder'
  | 'console.all'
  | 'console.level'
  | 'console.kind'
  | 'console.source'
  | 'console.toolbar'
  | 'console.pause'
  | 'console.resume'
  | 'console.follow'
  | 'console.stop-following'
  | 'console.clear'
  | 'console.irreversible'
  | 'console.copy'
  | 'console.export'
  | 'console.ownership-warning'
  | 'console.dismiss-ownership-warning'
  | 'console.empty'
  | 'console.no-matches'
  | 'console.back-to-latest'
  | 'console.entry-details'
  | 'console.close-details'
  | 'console.field.plugin'
  | 'console.field.generation'
  | 'console.field.source'
  | 'console.field.kind'
  | 'console.field.coverage'
  | 'console.field.correlation'
  | 'console.field.phase'
  | 'console.field.status'
  | 'console.field.duration'
  | 'console.field.session'
  | 'console.field.trigger'
  | 'console.field.owner'
  | 'console.field.request-metrics'
  | 'console.field.result-metrics'
  | 'plugins.share'
  | 'plugins.share-unavailable'
  | 'plugins.open-source'
  | 'plugins.open-source-unavailable'
  | 'plugins.diagnostics'
  | 'plugins.uninstall'
  | 'plugins.uninstall-unavailable'
  | 'plugins.local-description'
  | 'plugins.collection-label'
  | 'plugins.search-label'
  | 'plugins.search-placeholder'
  | 'plugins.search-clear'
  | 'plugins.empty'
  | 'plugins.no-matches'
  | 'plugins.more-actions'
  | 'plugins.operation-busy'
  | 'plugins.enable-unavailable'
  | 'plugins.disable-unavailable'
  | 'plugins.reload-unavailable'
  | 'plugins.demo.slot-showcase-description'
  | 'plugins.demo.hello-toolbar-description'
  | 'plugins.demo.form-schema-gallery-description'
  | 'plugin-tab.readme'
  | 'plugin-tab.configuration'
  | 'plugin-tab.permissions'
  | 'plugin-tab.runtime'
  | 'plugin-tab.logs'
  | 'plugin-tab.extension-points'
  | 'plugin-tab.routes'
  | 'extension-tab.usage'
  | 'extension-tab.information'
  | 'extension-tab.diagnostics'
  | 'extension.heading'
  | 'extension.collection-label'
  | 'extension.search-label'
  | 'extension.search-placeholder'
  | 'extension.empty'
  | 'extension.no-matches'
  | 'marketplace-tab.overview'
  | 'marketplace-tab.authors-source'
  | 'routes.heading'
  | 'routes.collection-label'
  | 'routes.search-label'
  | 'routes.search-placeholder'
  | 'routes.empty'
  | 'routes.no-matches'
  | 'routes.open-route'
  | 'routes.open-page'
  | 'marketplace.heading'
  | 'marketplace.filter-all'
  | 'marketplace.filter-certified'
  | 'marketplace.filter-certified-only'
  | 'marketplace.filter-official'
  | 'marketplace.filter-official-only'
  | 'marketplace.official'
  | 'marketplace.certified'
  | 'marketplace.open'
  | 'marketplace.collection-label'
  | 'marketplace.search-label'
  | 'marketplace.search-placeholder'
  | 'marketplace.search-clear'
  | 'marketplace.empty-no-sources'
  | 'marketplace.empty'
  | 'marketplace.no-matches'
  | 'marketplace.source-menu-label'
  | 'marketplace.source-menu-description'
  | 'marketplace.source-menu.create'
  | 'marketplace.source-menu.clipboard'
  | 'marketplace.source-menu.manage'
  | 'marketplace.source.clipboard-prompt'
  | 'marketplace.source.clipboard-unavailable'
  | 'marketplace.source.imported'
  | 'marketplace.source.index-heading'
  | 'marketplace.source.add'
  | 'marketplace.source.disabled'
  | 'marketplace.source.failed'
  | 'marketplace.source.updating'
  | 'marketplace.source.cached'
  | 'marketplace.source.no-description'
  | 'marketplace.source.open'
  | 'marketplace.source.enable'
  | 'marketplace.source.disable'
  | 'marketplace.source.edit'
  | 'marketplace.source.move-up'
  | 'marketplace.source.move-down'
  | 'marketplace.source.remove'
  | 'marketplace.source.official-remove-unavailable'
  | 'marketplace.source.disabled-notice'
  | 'marketplace.source.enabled-notice'
  | 'marketplace.source.moved-notice'
  | 'marketplace.source.removed-notice'
  | 'marketplace.source.collection-label'
  | 'marketplace.source.search-label'
  | 'marketplace.source.search-placeholder'
  | 'marketplace.source.search-clear'
  | 'marketplace.source.empty'
  | 'marketplace.source.no-matches'
  | 'marketplace.source.more-actions'
  | 'marketplace.source.create-heading'
  | 'marketplace.source.edit-heading'
  | 'marketplace.source.url-section'
  | 'marketplace.source.url-help'
  | 'marketplace.source.readonly-url-help'
  | 'marketplace.source.url-label'
  | 'marketplace.source.local-section'
  | 'marketplace.source.local-help'
  | 'marketplace.source.name-label'
  | 'marketplace.source.name-help'
  | 'marketplace.source.description-label'
  | 'marketplace.source.description-help'
  | 'marketplace.source.note-label'
  | 'marketplace.source.note-help'
  | 'marketplace.source.create'
  | 'marketplace.source.save'
  | 'marketplace.source.url-required'
  | 'marketplace.source.url-invalid'
  | 'marketplace.source.duplicate'
  | 'marketplace.source.added'
  | 'marketplace.source.saved'
  | 'marketplace.source.operation-failed'
  | 'runtime.empty'
  | 'runtime.restore'
  | 'launcher.description'
  | 'action.view-config-docs'
  | 'action.view-runtime-docs'
  | 'status.unavailable'
  | 'status.file-not-found'
  | 'status.no-data'
  | 'status.restart-required'
  | 'permission.required-denial'
  | 'permission.request-unavailable'
  | 'permission.review'
  | 'permission.cancel'
  | 'permission.deny'
  | 'permission.allow-once'
  | 'permission.allow-always'
  | 'form.saving'
  | 'form.dirty-prefix'
  | 'form.apply-live'
  | 'form.apply-plugin-restart'
  | 'form.apply-service-restart'
  | 'form.apply-app-restart'
  | 'form.required'
  | 'form.choice-invalid'
  | 'form.number-invalid'
  | 'form.natural-invalid'
  | 'form.json-invalid'
  | 'form.sensitive-unavailable'
  | 'form.unsupported'
  | 'form.select-placeholder'
  | 'form.text-placeholder'
  | 'form.switch-on'
  | 'form.switch-off'
  | 'form.section-general'
  | 'form.empty-no-schema'
  | 'form.empty-no-fields'
  | 'form.restore-default'
  | 'form.field-actions'
  | 'form.use-default'
  | 'form.use-default-unavailable'
  | 'form.rollback-field'
  | 'form.copy-path'
  | 'form.path-copied'
  | 'form.path-copy-unavailable'
  | 'form.undo-changes'
  | 'form.save-configuration'
  | 'form.configuration-saved'
  | 'form.readonly-note'
  | 'form.conflict-retained'

const COPY: Readonly<Record<CopyKey, Readonly<Record<CordisXProductLocale, string>>>> = Object.freeze({
  'channel.title': { en: 'Channels', 'zh-CN': '渠道' },
  'channel.description': { en: 'Manage launcher-owned connections, routes, and task bindings.', 'zh-CN': '管理由启动器持有的连接、路由与任务绑定。' },
  'channel.status.available': { en: 'Available', 'zh-CN': '可用' },
  'channel.accounts': { en: 'Accounts', 'zh-CN': '账号' },
  'channel.accounts.description': { en: 'Connection state and credential readiness.', 'zh-CN': '查看连接状态与凭据就绪情况。' },
  'channel.accounts.empty': { en: 'No channel accounts yet.', 'zh-CN': '暂无渠道账号。' },
  'channel.routes': { en: 'Routes', 'zh-CN': '路由' },
  'channel.routes.description': { en: 'Map channel messages to CordisX task defaults.', 'zh-CN': '将渠道消息映射到 CordisX 任务默认项。' },
  'channel.routes.empty': { en: 'No channel routes yet.', 'zh-CN': '暂无渠道路由。' },
  'channel.bindings': { en: 'Task bindings', 'zh-CN': '任务绑定' },
  'channel.bindings.description': { en: 'Persistent channel-thread to provider-session identities.', 'zh-CN': '持久化渠道话题与 Provider 会话的组合身份。' },
  'channel.bindings.empty': { en: 'No task bindings yet.', 'zh-CN': '暂无任务绑定。' },
  'channel.diagnostics': { en: 'Diagnostics', 'zh-CN': '诊断' },
  'channel.diagnostics.description': { en: 'Implementation and external dependency status.', 'zh-CN': '查看实现状态与外部依赖。' },
  'channel.diagnostics.empty': { en: 'No diagnostics.', 'zh-CN': '暂无诊断。' },
  'channel.search.empty': { en: 'No matching items.', 'zh-CN': '没有匹配项。' },
  'channel.search.label': { en: 'Search configured channels', 'zh-CN': '搜索已配置频道' },
  'channel.search.placeholder': { en: 'Search configured channels', 'zh-CN': '搜索已配置频道' },
  'channel.search.clear': { en: 'Clear channel search', 'zh-CN': '清除频道搜索' },
  'channel.open': { en: 'Open channel details', 'zh-CN': '打开频道详情' },
  'channel.back': { en: 'Back to channels', 'zh-CN': '返回频道列表' },
  'channel.create': { en: 'New channel', 'zh-CN': '新建频道' },
  'channel.create.icon-label': { en: 'Create channel configuration', 'zh-CN': '创建频道配置' },
  'channel.create.description': { en: 'Add a local simulator to this CordisX test configuration.', 'zh-CN': '向当前 CordisX 测试配置添加本地模拟频道。' },
  'channel.create.local-only': { en: 'The Host writes this simulator to the active test configuration and restarts only its local service. It has no credential and makes no external change.', 'zh-CN': '宿主会把这个模拟频道写入当前测试配置，并只重启本地服务；不含凭据，也不会产生外部变更。' },
  'channel.create.name': { en: 'Channel name', 'zh-CN': '频道名称' },
  'channel.create.platform': { en: 'Platform', 'zh-CN': '平台' },
  'channel.create.unavailable': { en: 'The local Channel configuration is unavailable.', 'zh-CN': '本地频道配置当前不可用。' },
  'channel.create.save': { en: 'Add local simulator', 'zh-CN': '添加本地模拟频道' },
  'channel.create.simulator': { en: 'Local simulator', 'zh-CN': '本地模拟器' },
  'channel.create.feishu': { en: 'Feishu', 'zh-CN': '飞书' },
  'channel.create.app-id': { en: 'App ID', 'zh-CN': '应用 ID' },
  'channel.create.tenant': { en: 'Tenant', 'zh-CN': '租户' },
  'channel.create.provider': { en: 'Provider', 'zh-CN': 'Provider' },
  'channel.create.model': { en: 'Model', 'zh-CN': '模型' },
  'channel.create.profile': { en: 'Profile', 'zh-CN': '配置档' },
  'channel.create.workspace': { en: 'Workspace', 'zh-CN': '工作区' },
  'channel.create.notifications': { en: 'Completion notifications', 'zh-CN': '完成通知' },
  'channel.configuration': { en: 'Configuration', 'zh-CN': '配置' },
  'channel.configuration.description': { en: 'Host-rendered, read-only connection information.', 'zh-CN': '由宿主渲染的只读连接信息。' },
  'channel.configuration.unavailable': { en: 'No configurable items yet.', 'zh-CN': '暂无可配置项。' },
  'channel.logs': { en: 'Logs', 'zh-CN': '日志' },
  'channel.logs.unavailable': { en: 'No logs yet.', 'zh-CN': '暂无日志。' },
  'channel.logs.native-semantics': { en: 'When available, logs preserve native console argument arrays and structured event records. This page does not synthesize log entries.', 'zh-CN': '日志可用后将保留原生 console 参数数组和结构化事件记录；当前页面不会伪造日志。' },
  'channel.logs.search': { en: 'Search activity', 'zh-CN': '搜索活动记录' },
  'channel.logs.all': { en: 'All results', 'zh-CN': '全部结果' },
  'channel.logs.success': { en: 'Successful', 'zh-CN': '成功' },
  'channel.logs.failure': { en: 'Needs attention', 'zh-CN': '需要处理' },
  'channel.logs.export': { en: 'Export JSON', 'zh-CN': '导出 JSON' },
  'channel.logs.page': { en: 'Page', 'zh-CN': '第' },
  'channel.sessions': { en: 'Connections & sessions', 'zh-CN': '连接与会话管理' },
  'channel.sessions.unavailable': { en: 'No connected sessions yet.', 'zh-CN': '暂无连接或会话。' },
  'channel.field.platform': { en: 'Platform', 'zh-CN': '平台' },
  'channel.field.transport': { en: 'Transport', 'zh-CN': '传输方式' },
  'channel.field.enabled': { en: 'Enabled', 'zh-CN': '已启用' },
  'channel.field.status': { en: 'Connection status', 'zh-CN': '连接状态' },
  'channel.field.credentials': { en: 'Credentials', 'zh-CN': '凭据' },
  'channel.status.inbound': { en: 'Inbound pending', 'zh-CN': '待处理入站' },
  'channel.status.outbound': { en: 'Outbound pending', 'zh-CN': '待处理出站' },
  'channel.status.generation': { en: 'Service generation', 'zh-CN': '服务代次' },
  'channel.reconnect': { en: 'Reconnect', 'zh-CN': '重新连接' },
  'channel.enable': { en: 'Enable', 'zh-CN': '启用' },
  'channel.disable': { en: 'Disable', 'zh-CN': '停用' },
  'channel.reconnecting': { en: 'Reconnecting…', 'zh-CN': '正在重新连接…' },
  'channel.reconnected': { en: 'Reconnected', 'zh-CN': '已重新连接' },
  'channel.runtime.unavailable': { en: 'Runtime status is currently unavailable.', 'zh-CN': '运行状态当前不可用。' },
  'channel.binding.archive': { en: 'Archive binding', 'zh-CN': '归档绑定' },
  'channel.binding.restore': { en: 'Restore binding', 'zh-CN': '恢复绑定' },
  'channel.binding.unbind': { en: 'Unbind', 'zh-CN': '解除绑定' },
  'channel.binding-operations.unavailable': { en: 'Binding operations are currently unavailable.', 'zh-CN': '绑定操作当前不可用。' },
  'channel.credentials.help': { en: 'Only readiness is projected; credential references and values are never rendered.', 'zh-CN': '仅展示就绪状态；不会渲染凭据引用或值。' },
  'channel.real-readiness': { en: 'Real connection readiness', 'zh-CN': '真实连接就绪状态' },
  'channel.real-readiness.description': { en: 'Known test-target information is not evidence of a connected channel.', 'zh-CN': '已知测试目标不代表频道已连接。' },
  'channel.real-readiness.app': { en: 'Feishu test application: enabled candidate cli_aaba90fcc4389cb3; not connected.', 'zh-CN': '飞书测试应用：已启用候选 cli_aaba90fcc4389cb3；尚未连接。' },
  'channel.real-readiness.events': { en: 'Events and callbacks: not configured.', 'zh-CN': '事件与回调：未配置。' },
  'channel.real-readiness.credentials': { en: 'Credential reference: not configured.', 'zh-CN': '凭据引用：未配置。' },
  'channel.real-readiness.adapter': { en: 'Official adapter and launcher transport: unavailable.', 'zh-CN': '官方 adapter 与启动器 transport：不可用。' },
  'channel.real-readiness.events-label': { en: 'Events & callbacks', 'zh-CN': '事件与回调' },
  'channel.real-readiness.adapter-label': { en: 'Adapter & transport', 'zh-CN': 'Adapter 与传输' },
  'marketplace.description': { en: 'Manage plugin marketplace sources.', 'zh-CN': '管理插件商店来源。' },
  'marketplace.source-label': { en: 'Marketplace JSON URL', 'zh-CN': '插件商店 JSON 地址' },
  'marketplace.add': { en: 'Add marketplace', 'zh-CN': '添加商店' },
  'marketplace.empty': { en: 'No marketplaces yet.', 'zh-CN': '暂无插件商店。' },
  'marketplace.loaded': { en: 'Loaded', 'zh-CN': '已加载' },
  'marketplace.loading': { en: 'Loading…', 'zh-CN': '加载中…' },
  'marketplace.failed': { en: 'Failed to load', 'zh-CN': '加载失败' },
  'marketplace.error-details': { en: 'View error details', 'zh-CN': '查看错误详情' },
  'marketplace.move-up': { en: 'Move up', 'zh-CN': '上移' },
  'marketplace.move-down': { en: 'Move down', 'zh-CN': '下移' },
  'marketplace.remove': { en: 'Remove', 'zh-CN': '移除' },
  'marketplace.restore-official': { en: 'Restore official marketplace', 'zh-CN': '恢复官方商店' },
  'marketplace.reload': { en: 'Reload', 'zh-CN': '重新加载' },
  'marketplace.invalid-url': { en: 'Enter an HTTPS URL', 'zh-CN': '请输入 HTTPS 地址' },
  'marketplace.duplicate-source': { en: 'This marketplace is already configured', 'zh-CN': '这个商店地址已经配置' },
  'manager.nav.plugins': { en: 'Plugins', 'zh-CN': '插件' },
  'manager.nav.extension-points': { en: 'Extension points', 'zh-CN': '扩展点' },
  'manager.nav.routes': { en: 'Routes', 'zh-CN': '路由' },
  'manager.nav.marketplace': { en: 'Marketplace', 'zh-CN': '插件商店' },
  'manager.nav.about': { en: 'About CordisX', 'zh-CN': '关于 CordisX' },
  'manager.trigger.manage': { en: 'Manage CordisX plugins', 'zh-CN': '管理 CordisX 插件' },
  'manager.close': { en: 'Close CordisX Manager', 'zh-CN': '关闭 CordisX 管理器' },
  'manager.dialog': { en: 'CordisX Plugin Manager', 'zh-CN': 'CordisX 插件管理器' },
  'manager.navigation': { en: 'CordisX Manager pages', 'zh-CN': 'CordisX 管理器页面' },
  'manager.back': { en: 'Back', 'zh-CN': '返回' },
  'plugins.install': { en: 'Import local plugin', 'zh-CN': '导入本地插件' },
  'plugins.install-checking': { en: 'Checking local package', 'zh-CN': '检查本地包中' },
  'plugins.enable': { en: 'Enable plugin', 'zh-CN': '启用插件' },
  'plugins.disable': { en: 'Disable plugin', 'zh-CN': '禁用插件' },
  'plugins.favorite': { en: 'Favorite plugin', 'zh-CN': '收藏插件' },
  'plugins.unfavorite': { en: 'Remove from favorites', 'zh-CN': '取消收藏' },
  'plugins.reload': { en: 'Reload plugin', 'zh-CN': '重载插件' },
  'plugins.open': { en: 'Open plugin details', 'zh-CN': '打开插件详情' },
  'plugins.heading': { en: 'Plugin details', 'zh-CN': '插件详情' },
  'plugin.status.active': { en: 'Active', 'zh-CN': '运行中' },
  'plugin.status.blocked': { en: 'Blocked', 'zh-CN': '已屏蔽' },
  'plugin.status.permission-blocked': { en: 'Permission blocked', 'zh-CN': '权限阻止' },
  'plugin.status.failed': { en: 'Failed to start', 'zh-CN': '启动失败' },
  'plugin.status.installing': { en: 'Installing', 'zh-CN': '安装中' },
  'plugin.status.updating': { en: 'Updating', 'zh-CN': '更新中' },
  'plugin.status.enabling': { en: 'Enabling', 'zh-CN': '启用中' },
  'plugin.status.disabling': { en: 'Disabling', 'zh-CN': '禁用中' },
  'plugin.status.reloading': { en: 'Reloading', 'zh-CN': '重载中' },
  'plugin.status.uninstalling': { en: 'Uninstalling', 'zh-CN': '卸载中' },
  'plugin.status.rolling-back': { en: 'Restoring', 'zh-CN': '正在恢复' },
  'plugin.status.rollback-failed': { en: 'Restore failed', 'zh-CN': '恢复失败' },
  'plugin.status.configured-disabled': { en: 'Disabled by configuration', 'zh-CN': '配置禁用' },
  'runtime.lifecycle-summary': { en: 'Runtime details', 'zh-CN': '运行详情' },
  'runtime.services': { en: 'Services', 'zh-CN': '服务' },
  'runtime.none': { en: 'None', 'zh-CN': '无' },
  'runtime.active-contributions': { en: 'Active contributions', 'zh-CN': '活跃贡献' },
  'runtime.commands': { en: 'Commands', 'zh-CN': '命令' },
  'runtime.processing': { en: 'Working…', 'zh-CN': '处理中…' },
  'runtime.healthy': { en: 'Healthy', 'zh-CN': '运行正常' },
  'runtime.status-attention': { en: 'Needs attention', 'zh-CN': '需要处理' },
  'runtime.status-details-in-logs': { en: 'Details are available in Logs & diagnostics.', 'zh-CN': '详细信息请在日志与诊断中查看。' },
  'runtime.configured-disabled': { en: 'Disabled by configuration', 'zh-CN': '配置中已禁用' },
  'runtime.reauthorize': { en: 'Reauthorize', 'zh-CN': '重新授权' },
  'runtime.restore-plugin': { en: 'Restore plugin', 'zh-CN': '恢复插件' },
  'runtime.block-plugin': { en: 'Block plugin', 'zh-CN': '屏蔽插件' },
  'runtime.locale-catalogs-empty': { en: 'No active locale catalogs', 'zh-CN': '当前插件没有活跃 locale dictionary' },
  'runtime.commands-empty': { en: 'No commands registered', 'zh-CN': '当前插件没有 command 注册' },
  'runtime.diagnostics': { en: 'Diagnostics', 'zh-CN': '诊断' },
  'runtime.section.localization': { en: 'Localization', 'zh-CN': '本地化' },
  'runtime.section.details': { en: 'Runtime details', 'zh-CN': '运行时详情' },
  'runtime.configuration': { en: 'Configuration', 'zh-CN': '配置' },
  'runtime.not-declared': { en: 'Not declared', 'zh-CN': '未声明' },
  'runtime.revision': { en: 'revision', 'zh-CN': '版本' },
  'runtime.last-good': { en: 'last good', 'zh-CN': '最后可用' },
  'runtime.writer': { en: 'writer', 'zh-CN': '写入器' },
  'runtime.available': { en: 'available', 'zh-CN': '可用' },
  'runtime.unavailable': { en: 'unavailable', 'zh-CN': '不可用' },
  'runtime.availability-supported': { en: 'Available', 'zh-CN': '可用' },
  'runtime.availability-degraded': { en: 'Partially available', 'zh-CN': '部分可用' },
  'runtime.host': { en: 'Host', 'zh-CN': '宿主' },
  'runtime.adapter': { en: 'adapter', 'zh-CN': '适配器' },
  'runtime.secondary-connection': { en: 'secondary connection', 'zh-CN': '二次连接' },
  'runtime.raw-bridge': { en: 'raw bridge', 'zh-CN': '原始 bridge 暴露' },
  'runtime.yes': { en: 'yes', 'zh-CN': '是' },
  'runtime.no': { en: 'no', 'zh-CN': '否' },
  'runtime.permission-boundary': { en: 'Permissions apply only to Host API calls.', 'zh-CN': '当前权限仅适用于 Host API 调用。' },
  'runtime.permission-documentation': { en: 'View permission documentation', 'zh-CN': '查看权限说明' },
  'console.requests': { en: 'Requests', 'zh-CN': '调用' },
  'console.successes': { en: 'Succeeded', 'zh-CN': '成功' },
  'console.failures': { en: 'Failed', 'zh-CN': '失败' },
  'console.denied': { en: 'Denied', 'zh-CN': '拒绝' },
  'console.performance': { en: 'Performance & usage · Average duration', 'zh-CN': '性能与消费 · 平均耗时' },
  'console.no-host-api-metrics': { en: 'No Host API metrics.', 'zh-CN': '当前没有 Host API 调用计量。' },
  'console.search-placeholder': { en: 'Search messages, sources, or correlation ID', 'zh-CN': '搜索消息、来源或 correlation id' },
  'console.all': { en: 'All', 'zh-CN': '全部' },
  'console.level': { en: 'Log level', 'zh-CN': '日志级别' },
  'console.kind': { en: 'API / type', 'zh-CN': 'API / 类型' },
  'console.source': { en: 'Log source', 'zh-CN': '日志来源' },
  'console.toolbar': { en: 'Console display controls', 'zh-CN': 'Console 显示控制' },
  'console.pause': { en: 'Pause capture', 'zh-CN': '暂停采集' },
  'console.resume': { en: 'Resume capture', 'zh-CN': '继续采集' },
  'console.follow': { en: 'Follow latest', 'zh-CN': '跟随最新' },
  'console.stop-following': { en: 'Stop following', 'zh-CN': '停止跟随' },
  'console.clear': { en: 'Clear logs', 'zh-CN': '清空日志' },
  'console.irreversible': { en: 'Cannot be undone', 'zh-CN': '不可撤销' },
  'console.copy': { en: 'Copy selected', 'zh-CN': '复制所选' },
  'console.export': { en: 'Export plugin logs', 'zh-CN': '导出插件日志' },
  'console.ownership-warning': { en: 'Detected {count} runtime errors with conflicting sources. Reload the plugin, then try again.', 'zh-CN': '检测到 {count} 条来源冲突的运行时错误。请重载插件后复现。' },
  'console.dismiss-ownership-warning': { en: 'Dismiss attribution warning', 'zh-CN': '关闭归属异常提示' },
  'console.empty': { en: 'Waiting for plugin logs or CordisX API calls…', 'zh-CN': '等待插件日志或 CordisX API 调用…' },
  'console.no-matches': { en: 'No logs match the current filters', 'zh-CN': '没有匹配当前筛选的日志' },
  'console.back-to-latest': { en: 'Back to latest', 'zh-CN': '回到最新' },
  'console.entry-details': { en: 'Entry details', 'zh-CN': '日志详情' },
  'console.close-details': { en: 'Close log details', 'zh-CN': '关闭日志详情' },
  'console.field.plugin': { en: 'Plugin', 'zh-CN': '插件' },
  'console.field.generation': { en: 'Generation', 'zh-CN': 'Generation' },
  'console.field.source': { en: 'Capability / source', 'zh-CN': '能力 / 来源' },
  'console.field.kind': { en: 'Type', 'zh-CN': '类型' },
  'console.field.coverage': { en: 'Coverage', 'zh-CN': '采集' },
  'console.field.correlation': { en: 'Correlation', 'zh-CN': 'Correlation' },
  'console.field.phase': { en: 'Phase', 'zh-CN': '阶段' },
  'console.field.status': { en: 'Status', 'zh-CN': '状态' },
  'console.field.duration': { en: 'Duration', 'zh-CN': '耗时' },
  'console.field.session': { en: 'Session', 'zh-CN': '会话' },
  'console.field.trigger': { en: 'Trigger', 'zh-CN': '触发' },
  'console.field.owner': { en: 'Effective owner', 'zh-CN': '有效 owner' },
  'console.field.request-metrics': { en: 'Request metrics', 'zh-CN': '请求计量' },
  'console.field.result-metrics': { en: 'Result metrics', 'zh-CN': '结果计量' },
  'plugins.share': { en: 'Share public source', 'zh-CN': '分享公开来源' },
  'plugins.share-unavailable': { en: 'Share public source (unavailable)', 'zh-CN': '分享公开来源（不可用）' },
  'plugins.open-source': { en: 'Open public source', 'zh-CN': '打开公开来源' },
  'plugins.open-source-unavailable': { en: 'Open public source (unavailable)', 'zh-CN': '打开公开来源（不可用）' },
  'plugins.diagnostics': { en: 'View diagnostics', 'zh-CN': '查看运行诊断' },
  'plugins.uninstall': { en: 'Uninstall', 'zh-CN': '卸载' },
  'plugins.uninstall-unavailable': { en: 'Uninstall (unavailable)', 'zh-CN': '卸载（不可用）' },
  'plugins.local-description': { en: 'Local CordisX plugin', 'zh-CN': '本地 CordisX 插件' },
  'plugins.collection-label': { en: 'Current bundle plugins', 'zh-CN': '当前 bundle 插件' },
  'plugins.search-label': { en: 'Search plugins', 'zh-CN': '搜索 CordisX 插件' },
  'plugins.search-placeholder': { en: 'Search plugins or extension points', 'zh-CN': '搜索插件或扩展点' },
  'plugins.search-clear': { en: 'Clear plugin search', 'zh-CN': '清除插件搜索' },
  'plugins.empty': { en: 'No plugins available', 'zh-CN': '暂无可用插件' },
  'plugins.no-matches': { en: 'No matching plugins', 'zh-CN': '没有匹配的插件' },
  'plugins.more-actions': { en: 'More plugin actions', 'zh-CN': '更多插件操作' },
  'plugins.operation-busy': { en: 'Another plugin action is in progress', 'zh-CN': '当前有插件操作正在执行' },
  'plugins.enable-unavailable': { en: 'This plugin cannot be enabled now', 'zh-CN': '插件当前不能启用' },
  'plugins.disable-unavailable': { en: 'This plugin cannot be disabled now', 'zh-CN': '插件当前不能禁用' },
  'plugins.reload-unavailable': { en: 'This plugin cannot be reloaded now', 'zh-CN': '插件当前不能重载' },
  'plugins.demo.slot-showcase-description': { en: 'Explore plugins, navigation, pages, and status.', 'zh-CN': '查看插件、导航、页面与状态。' },
  'plugins.demo.hello-toolbar-description': { en: 'Add a quick greeting to the workspace toolbar.', 'zh-CN': '在工作区工具栏添加快捷问候。' },
  'plugins.demo.form-schema-gallery-description': { en: 'Explore editable workspace settings.', 'zh-CN': '查看可编辑的工作区设置。' },
  'plugin-tab.readme': { en: 'README', 'zh-CN': 'README' },
  'plugin-tab.configuration': { en: 'Configuration', 'zh-CN': '配置管理' },
  'plugin-tab.permissions': { en: 'Permissions', 'zh-CN': '权限' },
  'plugin-tab.runtime': { en: 'Runtime status', 'zh-CN': '运行状态' },
  'plugin-tab.logs': { en: 'Logs & diagnostics', 'zh-CN': '日志与诊断' },
  'plugin-tab.extension-points': { en: 'Extension points', 'zh-CN': '扩展点位' },
  'plugin-tab.routes': { en: 'Routes', 'zh-CN': '路由' },
  'extension-tab.usage': { en: 'Usage', 'zh-CN': '使用情况' },
  'extension-tab.information': { en: 'Information', 'zh-CN': '点位信息' },
  'extension-tab.diagnostics': { en: 'Diagnostics', 'zh-CN': '诊断' },
  'extension.heading': { en: 'Extension points', 'zh-CN': '扩展点位' },
  'extension.collection-label': { en: 'Extension points', 'zh-CN': '扩展点列表' },
  'extension.search-label': { en: 'Search extension points', 'zh-CN': '搜索 CordisX 扩展点' },
  'extension.search-placeholder': { en: 'Search names, descriptions, IDs, or plugins', 'zh-CN': '搜索名称、介绍、点位 id 或插件…' },
  'extension.empty': { en: 'No extension points available', 'zh-CN': '当前宿主没有声明扩展点；请查看运行诊断。' },
  'extension.no-matches': { en: 'No matching extension points', 'zh-CN': '没有匹配的扩展点' },
  'marketplace-tab.overview': { en: 'Overview', 'zh-CN': '概览' },
  'marketplace-tab.authors-source': { en: 'Authors and source', 'zh-CN': '作者与来源' },
  'routes.heading': { en: 'Routes', 'zh-CN': '路由' },
  'routes.collection-label': { en: 'Routes and pages', 'zh-CN': '路由和页面列表' },
  'routes.search-label': { en: 'Search routes and pages', 'zh-CN': '搜索 CordisX 路由和页面' },
  'routes.search-placeholder': { en: 'Search titles, descriptions, locations, pages, or plugins', 'zh-CN': '搜索标题、说明、位置、页面或插件…' },
  'routes.empty': { en: 'No routes or pages available', 'zh-CN': '当前没有路由或页面' },
  'routes.no-matches': { en: 'No matching routes or pages', 'zh-CN': '没有匹配的路由或页面' },
  'routes.open-route': { en: 'Open route details', 'zh-CN': '打开路由详情' },
  'routes.open-page': { en: 'Open page details', 'zh-CN': '打开页面详情' },
  'marketplace.heading': { en: 'Discover plugins', 'zh-CN': '发现插件' },
  'marketplace.filter-all': { en: 'Show all plugins', 'zh-CN': '显示全部插件' },
  'marketplace.filter-certified': { en: 'Show certified plugins only', 'zh-CN': '仅显示已认证插件' },
  'marketplace.filter-certified-only': { en: 'Certified only', 'zh-CN': '仅看已认证' },
  'marketplace.filter-official': { en: 'Show official plugins only', 'zh-CN': '仅显示官方插件' },
  'marketplace.filter-official-only': { en: 'Official only', 'zh-CN': '仅看官方' },
  'marketplace.official': { en: 'Official', 'zh-CN': '官方' },
  'marketplace.certified': { en: 'Certified', 'zh-CN': '已认证' },
  'marketplace.open': { en: 'Open plugin details', 'zh-CN': '打开插件详情' },
  'marketplace.collection-label': { en: 'Marketplace plugins', 'zh-CN': '插件商店列表' },
  'marketplace.search-label': { en: 'Search marketplace plugins', 'zh-CN': '搜索插件商店' },
  'marketplace.search-placeholder': { en: 'Search plugins, authors, or keywords', 'zh-CN': '搜索插件、作者或关键词' },
  'marketplace.search-clear': { en: 'Clear marketplace search', 'zh-CN': '清除商店搜索' },
  'marketplace.empty-no-sources': { en: 'No sources yet', 'zh-CN': '暂无商店来源' },
  'marketplace.no-plugins': { en: 'No plugins available', 'zh-CN': '暂无可用插件' },
  'marketplace.no-matches': { en: 'No matching plugins', 'zh-CN': '没有匹配的插件' },
  'marketplace.source-menu-label': { en: 'Manage marketplace sources', 'zh-CN': '管理商店来源' },
  'marketplace.source-menu-description': { en: 'Add, import, or manage sources', 'zh-CN': '添加、导入或管理来源' },
  'marketplace.source-menu.create': { en: 'Add source', 'zh-CN': '新增来源' },
  'marketplace.source-menu.clipboard': { en: 'Import from clipboard', 'zh-CN': '从剪贴板导入' },
  'marketplace.source-menu.manage': { en: 'Manage sources', 'zh-CN': '管理来源' },
  'marketplace.source.clipboard-prompt': { en: 'Paste an HTTPS URL or source file', 'zh-CN': '粘贴 HTTPS 地址或来源文件' },
  'marketplace.source.clipboard-unavailable': { en: 'Clipboard unavailable', 'zh-CN': '剪贴板不可用' },
  'marketplace.source.imported': { en: 'Source imported', 'zh-CN': '已导入来源' },
  'marketplace.source.index-heading': { en: 'Marketplace sources', 'zh-CN': '商店来源' },
  'marketplace.source.add': { en: 'Add source', 'zh-CN': '新增来源' },
  'marketplace.source.disabled': { en: 'Disabled', 'zh-CN': '已停用' },
  'marketplace.source.failed': { en: 'Failed to update', 'zh-CN': '更新失败' },
  'marketplace.source.updating': { en: 'Updating', 'zh-CN': '正在更新' },
  'marketplace.source.cached': { en: 'Using cached data', 'zh-CN': '使用缓存' },
  'marketplace.source.no-description': { en: 'No description', 'zh-CN': '暂无说明' },
  'marketplace.source.open': { en: 'Open source details', 'zh-CN': '打开来源详情' },
  'marketplace.source.enable': { en: 'Enable source', 'zh-CN': '启用来源' },
  'marketplace.source.disable': { en: 'Disable source', 'zh-CN': '停用来源' },
  'marketplace.source.edit': { en: 'Edit display details', 'zh-CN': '编辑显示信息' },
  'marketplace.source.move-up': { en: 'Move up', 'zh-CN': '上移' },
  'marketplace.source.move-down': { en: 'Move down', 'zh-CN': '下移' },
  'marketplace.source.remove': { en: 'Remove source', 'zh-CN': '移除来源' },
  'marketplace.source.official-remove-unavailable': { en: 'The official source cannot be removed', 'zh-CN': '官方来源不能删除' },
  'marketplace.source.disabled-notice': { en: 'Source disabled', 'zh-CN': '已停用来源' },
  'marketplace.source.enabled-notice': { en: 'Source enabled', 'zh-CN': '已启用来源' },
  'marketplace.source.moved-notice': { en: 'Source order updated', 'zh-CN': '已调整来源顺序' },
  'marketplace.source.removed-notice': { en: 'Source removed', 'zh-CN': '已移除来源' },
  'marketplace.source.collection-label': { en: 'Marketplace sources', 'zh-CN': '插件商店来源' },
  'marketplace.source.search-label': { en: 'Search sources', 'zh-CN': '搜索商店来源' },
  'marketplace.source.search-placeholder': { en: 'Search sources', 'zh-CN': '搜索来源' },
  'marketplace.source.search-clear': { en: 'Clear source search', 'zh-CN': '清除来源搜索' },
  'marketplace.source.empty': { en: 'No sources yet', 'zh-CN': '暂无商店来源' },
  'marketplace.source.no-matches': { en: 'No matching sources', 'zh-CN': '没有匹配的来源' },
  'marketplace.source.more-actions': { en: 'More source actions', 'zh-CN': '更多来源操作' },
  'marketplace.source.create-heading': { en: 'Add source', 'zh-CN': '添加来源' },
  'marketplace.source.edit-heading': { en: 'Source details', 'zh-CN': '来源详情' },
  'marketplace.source.url-section': { en: 'Source URL', 'zh-CN': '来源地址' },
  'marketplace.source.url-help': { en: 'Enter an HTTPS URL', 'zh-CN': '请输入 HTTPS 地址' },
  'marketplace.source.readonly-url-help': { en: 'This URL cannot be changed', 'zh-CN': '此地址不可修改' },
  'marketplace.source.url-label': { en: 'Marketplace URL', 'zh-CN': '商店地址' },
  'marketplace.source.local-section': { en: 'Display details', 'zh-CN': '显示信息' },
  'marketplace.source.local-help': { en: 'Shown only in this Manager', 'zh-CN': '仅在此管理器中显示' },
  'marketplace.source.name-label': { en: 'Name', 'zh-CN': '名称' },
  'marketplace.source.name-help': { en: 'Leave blank to use the source name', 'zh-CN': '留空时使用来源名称' },
  'marketplace.source.description-label': { en: 'Description', 'zh-CN': '说明' },
  'marketplace.source.description-help': { en: 'Describe this source', 'zh-CN': '说明此来源的内容' },
  'marketplace.source.note-label': { en: 'Note', 'zh-CN': '备注' },
  'marketplace.source.note-help': { en: 'For your reference', 'zh-CN': '仅供参考' },
  'marketplace.source.create': { en: 'Add source', 'zh-CN': '添加来源' },
  'marketplace.source.save': { en: 'Save details', 'zh-CN': '保存信息' },
  'marketplace.source.url-required': { en: 'Enter a marketplace URL', 'zh-CN': '请输入商店地址' },
  'marketplace.source.url-invalid': { en: 'Enter an HTTPS URL', 'zh-CN': '请输入有效的 HTTPS 地址' },
  'marketplace.source.duplicate': { en: 'This source is already configured', 'zh-CN': '这个来源已经配置' },
  'marketplace.source.added': { en: 'Source added', 'zh-CN': '已添加来源' },
  'marketplace.source.saved': { en: 'Details saved', 'zh-CN': '已保存信息' },
  'marketplace.source.operation-failed': { en: 'Could not update source', 'zh-CN': '无法更新来源' },
  'runtime.empty': { en: 'No blocked plugins.', 'zh-CN': '暂无被屏蔽的插件。' },
  'runtime.restore': { en: 'Restore', 'zh-CN': '恢复' },
  'launcher.description': { en: 'Manage launcher settings in cordisx.config.json.', 'zh-CN': '启动器配置由 cordisx.config.json 管理。' },
  'action.view-config-docs': { en: 'View configuration docs', 'zh-CN': '查看配置文档' },
  'action.view-runtime-docs': { en: 'View runtime status docs', 'zh-CN': '查看运行状态说明' },
  'status.unavailable': { en: 'Currently unavailable', 'zh-CN': '当前不可用' },
  'status.file-not-found': { en: 'File not found', 'zh-CN': '文件不存在' },
  'status.no-data': { en: 'No data yet', 'zh-CN': '暂无数据' },
  'status.restart-required': { en: 'Restart required', 'zh-CN': '需要重启' },
  'permission.required-denial': { en: 'Required permission. Denying it stops this plugin.', 'zh-CN': '这是一项必需权限。拒绝后插件将停止运行。' },
  'permission.request-unavailable': { en: 'Permission service is currently unavailable.', 'zh-CN': '权限服务当前不可用。' },
  'permission.review': { en: 'Review permissions', 'zh-CN': '确认权限' },
  'permission.cancel': { en: 'Cancel', 'zh-CN': '取消' },
  'permission.deny': { en: 'Deny', 'zh-CN': '拒绝' },
  'permission.allow-once': { en: 'Allow this time', 'zh-CN': '仅此次允许' },
  'permission.allow-always': { en: 'Always allow', 'zh-CN': '始终允许' },
  'form.saving': { en: 'Saving…', 'zh-CN': '正在保存…' },
  'form.dirty-prefix': { en: 'Unsaved changes', 'zh-CN': '有未保存更改' },
  'form.apply-live': { en: 'Applies immediately after saving', 'zh-CN': '保存后立即生效' },
  'form.apply-plugin-restart': { en: 'Takes effect after restarting the plugin', 'zh-CN': '保存后重启插件生效' },
  'form.apply-service-restart': { en: 'Takes effect after restarting the service', 'zh-CN': '保存后重启相关服务生效' },
  'form.apply-app-restart': { en: 'Takes effect after restarting the app', 'zh-CN': '保存后重启 App 生效' },
  'form.required': { en: 'Required', 'zh-CN': '此项为必填项' },
  'form.choice-invalid': { en: 'Choose a value from the list', 'zh-CN': '请选择列表中的有效值' },
  'form.number-invalid': { en: 'Enter a valid number', 'zh-CN': '请输入有效数字' },
  'form.natural-invalid': { en: 'Enter a non-negative integer', 'zh-CN': '请输入非负整数' },
  'form.json-invalid': { en: 'Enter valid JSON', 'zh-CN': '请输入有效 JSON' },
  'form.sensitive-unavailable': { en: 'Managed by Host credentials; unavailable here.', 'zh-CN': '敏感字段由 Host 凭据边界管理；此处不可编辑。' },
  'form.unsupported': { en: 'This setting cannot be edited safely.', 'zh-CN': '此设置的结构当前无法安全编辑。' },
  'form.select-placeholder': { en: 'Choose', 'zh-CN': '选择' },
  'form.text-placeholder': { en: 'Enter a value', 'zh-CN': '请输入' },
  'form.switch-on': { en: 'On', 'zh-CN': '已开启' },
  'form.switch-off': { en: 'Off', 'zh-CN': '已关闭' },
  'form.section-general': { en: 'General', 'zh-CN': '常规' },
  'form.empty-no-schema': { en: 'This plugin does not provide editable settings.', 'zh-CN': '此插件未提供可编辑设置。' },
  'form.empty-no-fields': { en: 'This plugin has no editable settings.', 'zh-CN': '此插件没有可编辑设置。' },
  'form.restore-default': { en: 'Restore default', 'zh-CN': '恢复默认值' },
  'form.field-actions': { en: 'Field actions', 'zh-CN': '字段操作' },
  'form.use-default': { en: 'Use default value', 'zh-CN': '使用默认值' },
  'form.use-default-unavailable': { en: 'No default value is available', 'zh-CN': '此字段没有可用默认值' },
  'form.rollback-field': { en: 'Revert field change', 'zh-CN': '回滚此字段修改' },
  'form.copy-path': { en: 'Copy configuration path', 'zh-CN': '复制配置路径' },
  'form.path-copied': { en: 'Path copied', 'zh-CN': '已复制路径' },
  'form.path-copy-unavailable': { en: 'Clipboard unavailable', 'zh-CN': '剪贴板不可用' },
  'form.undo-changes': { en: 'Undo changes', 'zh-CN': '撤销更改' },
  'form.save-configuration': { en: 'Save configuration', 'zh-CN': '保存配置' },
  'form.configuration-saved': { en: 'Configuration saved', 'zh-CN': '配置已保存' },
  'form.readonly-note': { en: 'These settings are read-only. Connect CordisX to a writable configuration service to change them.', 'zh-CN': '这些设置当前为只读。将 CordisX 连接到可写配置服务后即可修改。' },
  'form.conflict-retained': { en: 'Configuration changed in another window or process. Your draft is retained; refresh and review before saving again.', 'zh-CN': '配置已在其他窗口或进程中更新。你的草稿仍保留；刷新后请重新核对再保存。' },
})

export function productLocale(locale: string): CordisXProductLocale {
  return new Intl.Locale(locale).language === 'zh' ? 'zh-CN' : 'en'
}

export function managerCopy(locale: string, key: CopyKey): string {
  return COPY[key][productLocale(locale)]
}

/** Exposed to the copy gate: every product-copy key must ship both baseline locales. */
export const MANAGER_PRODUCT_COPY = COPY
