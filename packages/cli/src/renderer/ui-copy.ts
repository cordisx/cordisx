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
  | 'marketplace.description'
  | 'marketplace.source-label'
  | 'marketplace.add'
  | 'marketplace.empty'
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
  | 'form.switch-on'
  | 'form.switch-off'
  | 'form.section-general'
  | 'form.empty-no-schema'
  | 'form.empty-no-fields'
  | 'form.restore-default'
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
  'form.switch-on': { en: 'On', 'zh-CN': '已开启' },
  'form.switch-off': { en: 'Off', 'zh-CN': '已关闭' },
  'form.section-general': { en: 'General', 'zh-CN': '常规' },
  'form.empty-no-schema': { en: 'This plugin does not provide editable settings.', 'zh-CN': '此插件未提供可编辑设置。' },
  'form.empty-no-fields': { en: 'This plugin has no editable settings.', 'zh-CN': '此插件没有可编辑设置。' },
  'form.restore-default': { en: 'Restore default', 'zh-CN': '恢复默认值' },
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
