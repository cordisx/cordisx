import type { ProductCopyCatalog } from './types.js'

export const MANAGER_NAVIGATION_COPY = {
  'manager.nav.plugins': { en: 'Plugins', 'zh-CN': '插件' },
  'manager.nav.plugin-bundles': { en: 'Plugin bundles', 'zh-CN': '插件包' },
  'manager.nav.extension-points': { en: 'Extension points', 'zh-CN': '扩展点' },
  'manager.nav.routes': { en: 'Routes', 'zh-CN': '路由' },
  'manager.nav.marketplace': { en: 'Marketplace', 'zh-CN': '插件商店' },
  'manager.nav.about': { en: 'About CordisX', 'zh-CN': '关于 CordisX' },
  'manager.trigger.manage': { en: 'Manage CordisX plugins', 'zh-CN': '管理 CordisX 插件' },
  'manager.close': { en: 'Close CordisX Manager', 'zh-CN': '关闭 CordisX 管理器' },
  'manager.dialog': { en: 'CordisX Plugin Manager', 'zh-CN': 'CordisX 插件管理器' },
  'manager.navigation': { en: 'CordisX Manager pages', 'zh-CN': 'CordisX 管理器页面' },
  'manager.back': { en: 'Back', 'zh-CN': '返回' },
  'manager.content.loading': { en: 'Loading page…', 'zh-CN': '正在加载页面…' },
  'manager.content.failed': { en: 'This page could not be loaded.', 'zh-CN': '无法加载此页面。' },
} satisfies ProductCopyCatalog<'manager'>

export const EXTENSION_TAB_COPY = {
  'extension-tab.usage': { en: 'Usage', 'zh-CN': '使用情况' },
  'extension-tab.information': { en: 'Information', 'zh-CN': '点位信息' },
  'extension-tab.diagnostics': { en: 'Diagnostics', 'zh-CN': '诊断' },
} satisfies ProductCopyCatalog<'extension-tab'>

export const EXTENSION_COPY = {
  'extension.collection-label': { en: 'Extension points', 'zh-CN': '扩展点列表' },
  'extension.search-label': { en: 'Search extension points', 'zh-CN': '搜索 CordisX 扩展点' },
  'extension.search-placeholder': {
    en: 'Search names, descriptions, IDs, or plugins',
    'zh-CN': '搜索名称、介绍、点位 id 或插件…',
  },
  'extension.empty': { en: 'No extension points available', 'zh-CN': '当前宿主没有声明扩展点；请查看运行诊断。' },
  'extension.no-matches': { en: 'No matching extension points', 'zh-CN': '没有匹配的扩展点' },
} satisfies ProductCopyCatalog<'extension'>

export const ROUTE_COPY = {
  'routes.heading': { en: 'Routes', 'zh-CN': '路由' },
  'routes.collection-label': { en: 'Routes and pages', 'zh-CN': '路由和页面列表' },
  'routes.search-label': { en: 'Search routes and pages', 'zh-CN': '搜索 CordisX 路由和页面' },
  'routes.search-placeholder': {
    en: 'Search titles, descriptions, locations, pages, or plugins',
    'zh-CN': '搜索标题、说明、位置、页面或插件…',
  },
  'routes.empty': { en: 'No routes or pages available', 'zh-CN': '当前没有路由或页面' },
  'routes.no-matches': { en: 'No matching routes or pages', 'zh-CN': '没有匹配的路由或页面' },
  'routes.open-route': { en: 'Open route details', 'zh-CN': '打开路由详情' },
  'routes.open-page': { en: 'Open page details', 'zh-CN': '打开页面详情' },
} satisfies ProductCopyCatalog<'routes'>

export const LAUNCHER_COPY = {
  'launcher.description': {
    en: 'Manage launcher settings in cordisx.config.json.',
    'zh-CN': '启动器配置由 cordisx.config.json 管理。',
  },
} satisfies ProductCopyCatalog<'launcher'>

export const ACTION_COPY = {
  'action.view-config-docs': { en: 'View configuration docs', 'zh-CN': '查看配置文档' },
  'action.view-runtime-docs': { en: 'View runtime status docs', 'zh-CN': '查看运行状态说明' },
} satisfies ProductCopyCatalog<'action'>

export const STATUS_COPY = {
  'status.unavailable': { en: 'Currently unavailable', 'zh-CN': '当前不可用' },
  'status.file-not-found': { en: 'File not found', 'zh-CN': '文件不存在' },
  'status.no-data': { en: 'No data yet', 'zh-CN': '暂无数据' },
  'status.restart-required': { en: 'Restart required', 'zh-CN': '需要重启' },
} satisfies ProductCopyCatalog<'status'>

export const PERMISSION_COPY = {
  'permission.required-denial': {
    en: 'Required permission. Denying it stops this plugin.',
    'zh-CN': '这是一项必需权限。拒绝后插件将停止运行。',
  },
  'permission.request-unavailable': {
    en: 'Permission service is currently unavailable.',
    'zh-CN': '权限服务当前不可用。',
  },
  'permission.review': { en: 'Review permissions', 'zh-CN': '确认权限' },
  'permission.cancel': { en: 'Cancel', 'zh-CN': '取消' },
  'permission.deny': { en: 'Deny', 'zh-CN': '拒绝' },
  'permission.allow-once': { en: 'Allow this time', 'zh-CN': '仅此次允许' },
  'permission.allow-always': { en: 'Always allow', 'zh-CN': '始终允许' },
} satisfies ProductCopyCatalog<'permission'>
