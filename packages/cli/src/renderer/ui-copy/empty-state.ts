import type { ProductCopyCatalog } from './types.js'

export const EMPTY_STATE_COPY = {
  'empty.modelsLoading': { en: 'Loading model services…', 'zh-CN': '正在加载模型服务…' },
  'empty.modelsLoadingHelp': { en: 'Reading services and model lists.', 'zh-CN': '正在读取服务与模型列表。' },
  'empty.pluginManagementUnavailable': { en: 'Plugin management is unavailable', 'zh-CN': '插件管理当前不可用' },
  'empty.bundles': { en: 'No plugin bundles installed yet', 'zh-CN': '还没有安装插件包' },
  'empty.bundleMatches': { en: 'No matching plugin bundles', 'zh-CN': '没有匹配的插件包' },
  'empty.hiddenPlugins': { en: 'No hidden plugins', 'zh-CN': '没有已隐藏的插件' },
  'empty.clearSearch': { en: 'Clear search', 'zh-CN': '清除搜索' },
  'empty.clearFilters': { en: 'Clear search and filters', 'zh-CN': '清除搜索和筛选' },
  'empty.searchHelp': {
    en: 'Try a different search or clear the filters.',
    'zh-CN': '试试其他关键词，或清除搜索和筛选。',
  },
  'empty.models': { en: 'No model connections yet', 'zh-CN': '还没有模型连接' },
  'empty.modelsHelp': {
    en: 'Connect a model service to see its available models here.',
    'zh-CN': '连接模型服务后，就可以在这里查看可用模型。',
  },
  'empty.modelMatches': { en: 'No matching models', 'zh-CN': '没有匹配的模型' },
  'empty.modelsFailed': { en: 'Could not load model services', 'zh-CN': '无法加载模型服务' },
  'empty.modelsUnavailable': { en: 'Model connections are currently unavailable', 'zh-CN': '模型连接当前不可用' },
  'empty.retryHelp': { en: 'Try refreshing in a moment.', 'zh-CN': '请稍后刷新重试。' },
  'empty.plugins': { en: 'No plugins installed yet', 'zh-CN': '还没有安装插件' },
  'empty.pluginsHelp': { en: 'Find plugins in the Marketplace.', 'zh-CN': '前往插件商店，发现可用插件。' },
  'empty.browsePlugins': { en: 'Browse Marketplace', 'zh-CN': '浏览插件商店' },
  'empty.marketplace': { en: 'No plugins available yet', 'zh-CN': '暂无可用插件' },
  'empty.marketplaceHelp': {
    en: 'Check your Marketplace sources for available plugins.',
    'zh-CN': '检查插件商店来源，获取可用插件。',
  },
  'empty.marketplaceFailed': { en: 'Could not load Marketplace plugins', 'zh-CN': '无法加载商店插件' },
  'empty.extensionHelp': {
    en: 'Extension points appear when they are available.',
    'zh-CN': '可用的扩展点会显示在这里。',
  },
  'empty.routesHelp': { en: 'Registered routes and pages appear here.', 'zh-CN': '已注册的路由和页面会显示在这里。' },
  'empty.notifications': { en: 'No muted notifications', 'zh-CN': '没有屏蔽规则' },
  'empty.notificationsHelp': { en: 'You are receiving all notifications.', 'zh-CN': '当前会接收所有通知。' },
} satisfies ProductCopyCatalog<'empty'>
