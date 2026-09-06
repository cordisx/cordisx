import cordisxMarkDark from '../../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../assets/brand/cordisx-mark-light.svg'
import { type CordisXPermissionPolicy, type CordisXPlatformCapability } from '../../contracts.js'
import { type ManagerIconToken } from '.././icons.js'
import { managerCopy } from '.././ui-copy.js'
import {
  ExtensionPointDetailTab,
  LocalTabIcon,
  ManagerSettingsTabSnapshot,
  MarketplaceDetailTab,
  PluginDetailTab,
} from './model.js'

export const MANAGER_STYLE_ID = 'cordisx-manager-style'
export const MANAGER_SETTINGS_FALLBACK = 'host:marketplace'
export type LocalizedTab<T extends string> = {
  readonly id: T
  readonly copyKey: Parameters<typeof managerCopy>[1]
  readonly icon: LocalTabIcon
}
export const PLUGIN_DETAIL_TABS: readonly LocalizedTab<PluginDetailTab>[] = [
  { id: 'readme', copyKey: 'plugin-tab.readme', icon: 'document' },
  { id: 'config', copyKey: 'plugin-tab.configuration', icon: 'configuration' },
  { id: 'permissions', copyKey: 'plugin-tab.permissions', icon: 'permissions' },
  { id: 'runtime', copyKey: 'plugin-tab.runtime', icon: 'runtime' },
  { id: 'logs', copyKey: 'plugin-tab.logs', icon: 'diagnostics' },
  { id: 'extension-points', copyKey: 'plugin-tab.extension-points', icon: 'outlets' },
  { id: 'routes', copyKey: 'plugin-tab.routes', icon: 'routes' },
]
export const EXTENSION_POINT_DETAIL_TABS: readonly LocalizedTab<ExtensionPointDetailTab>[] = [
  { id: 'usage', copyKey: 'extension-tab.usage', icon: 'plugins' },
  { id: 'information', copyKey: 'extension-tab.information', icon: 'point-info' },
  { id: 'diagnostics', copyKey: 'extension-tab.diagnostics', icon: 'diagnostics' },
]
export const MARKETPLACE_DETAIL_TABS: readonly LocalizedTab<MarketplaceDetailTab>[] = [
  { id: 'overview', copyKey: 'marketplace-tab.overview', icon: 'overview' },
  { id: 'authors-source', copyKey: 'marketplace-tab.authors-source', icon: 'authors-source' },
]
/** Compatibility export only. This Manager has no global Settings product page. */
export const CORDISX_BUILTIN_MANAGER_SETTINGS_TABS: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])
export const CORDISX_MARK_DARK_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
export const CORDISX_MARK_LIGHT_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`
export const ABOUT_ACTIONS = [
  {
    label: '反馈问题',
    description: '报告缺陷、提交改进建议或补充可复现信息。',
    href: 'https://github.com/cordisx/cordisx/issues/new',
  },
  {
    label: '参与建设',
    description: '查看源码、开发约定和当前可参与的项目。',
    href: 'https://github.com/cordisx/cordisx',
  },
  {
    label: '查看文档',
    description: '了解 CordisX 的使用方式、插件协议与开发指南。',
    href: 'https://cordisx.github.io/docs/',
  },
  {
    label: '项目主页',
    description: '访问 CordisX 组织主页与公开项目入口。',
    href: 'https://cordisx.github.io/',
  },
] as const

export const PRODUCT_DOCUMENTATION = Object.freeze({
  marketplace: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/dynamic-plugin-lifecycle.md',
  runtime: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/dynamic-plugin-lifecycle.md',
  launcher: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/distribution-and-cli.md',
  permissions: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/platform-capabilities.md',
})

export interface CapabilityPresentation {
  readonly name: string
  readonly icon: ManagerIconToken
}

export const CAPABILITY_PRESENTATIONS: Readonly<Partial<Record<CordisXPlatformCapability, CapabilityPresentation>>> = {
  'models.read': {
    name: '读取可用模型',
    icon: 'models-read',
  },
  'tasks.catalog.read': {
    name: '查看任务列表',
    icon: 'tasks-catalog-read',
  },
  'tasks.content.read': {
    name: '查看任务内容',
    icon: 'tasks-content-read',
  },
  'tasks.create': {
    name: '创建任务',
    icon: 'tasks-create',
  },
  'tasks.control': {
    name: '管理任务',
    icon: 'tasks-control',
  },
  'turns.submit': {
    name: '提交消息',
    icon: 'turns-submit',
  },
  'turns.control': {
    name: '控制对话轮次',
    icon: 'turns-control',
  },
  'agent.events.read': {
    name: '读取 Agent 事件',
    icon: 'capability-fallback',
  },
  'agent.history.read': {
    name: '读取 Agent 历史',
    icon: 'capability-fallback',
  },
  'agent.messages.append': {
    name: '追加 Agent 消息',
    icon: 'capability-fallback',
  },
  'agent.steps.reject': {
    name: '拒绝 Agent 步骤',
    icon: 'capability-fallback',
  },
  'agent.messages.transform': {
    name: '转换 Agent 消息',
    icon: 'capability-fallback',
  },
  'agent.prompt.section': {
    name: '扩展系统提示词',
    icon: 'capability-fallback',
  },
  'agent.prompt.context': {
    name: '追加模型上下文',
    icon: 'capability-fallback',
  },
}

export const POLICY_LABELS: Readonly<Record<CordisXPermissionPolicy, string>> = {
  ask: '每次询问',
  allow: '始终允许',
  deny: '始终拒绝',
}
