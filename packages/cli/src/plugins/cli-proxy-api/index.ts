import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineReactPage } from 'cordisx/react'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMetadataV3,
  type CordisXPluginManifestV1,
  type CordisXPluginPresentation,
  type CordisXRouteDefinitionV2,
} from '../../contracts.js'
import { createProviderFleetPage } from './view.js'

export const name = 'cli-proxy-api'
export const inject = ['i18n', 'slots', 'pages', 'routes', 'platform']

const capabilities = [
  'models.read', 'tasks.catalog.read', 'tasks.content.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control',
] as const

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'cli-proxy-api',
  name: 'CLIProxy Providers',
  capabilities: capabilities.map(capability => ({
    name: capability,
    required: false,
    reason: {
      namespace: 'cli-proxy-api',
      key: `permission.${capability}`,
      fallback: `Use ${capability} for explicitly configured external providers`,
    },
    scope: {},
  })),
} satisfies CordisXPluginManifestV1

interface Messages {
  'plugin.name': undefined
  'plugin.description': undefined
  'navigation.title': undefined
  'navigation.description': undefined
  'route.title': undefined
  'route.description': undefined
  'page.title': undefined
  'page.description': undefined
  'page.subtitle': undefined
  'field.provider': undefined
  'field.model': undefined
  'field.cwd': undefined
  'field.initial-message': undefined
  'field.search': undefined
  'action.refresh': undefined
  'action.create': undefined
  'action.load-more': undefined
  'action.continue': undefined
  'action.fork': undefined
  'action.archive': undefined
  'action.restore': undefined
  'action.delete': undefined
  'action.send': undefined
  'action.steer': undefined
  'action.interrupt': undefined
  'state.loading': undefined
  'state.empty': undefined
  'state.no-models': undefined
  'state.select-session': undefined
  'state.error': { readonly message: string }
  'session.provider': { readonly provider: string }
  'session.model': { readonly model: string }
  'permission.models.read': undefined
  'permission.tasks.catalog.read': undefined
  'permission.tasks.content.read': undefined
  'permission.tasks.create': undefined
  'permission.tasks.control': undefined
  'permission.turns.submit': undefined
  'permission.turns.control': undefined
}

export interface Config {
  readonly providerIds: readonly string[]
  readonly defaultCwd: string
}

export const Config = Schema.object({
  providerIds: Schema.array(
    Schema.string().required().pattern(/^[a-z0-9][a-z0-9._-]{0,95}$/),
  ).default([]).max(64)
    .extra('extra', { label: { 'zh-CN': 'Provider 过滤范围', en: 'Provider filter' } })
    .extra('description', {
      'zh-CN': '选择要显示的 Provider；留空表示全部。',
      en: 'Choose the providers to show; leave empty for all.',
    }),
  defaultCwd: Schema.string().default('').max(4096).pattern(/^[^\u0000]*$/)
    .extra('extra', { label: { 'zh-CN': '默认工作目录', en: 'Default working directory' } })
    .extra('description', {
      'zh-CN': '新会话的默认工作目录。',
      en: 'Default working directory for new sessions.',
    }),
})

export const configApplies = 'plugin-restart'

function configuredProviderIds(config: Config): readonly string[] | undefined {
  const providerIds = [...new Set(config.providerIds)]
  return providerIds.length === 0 ? undefined : providerIds
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return { namespace: 'cli-proxy-api', key, ...(args[0] === undefined ? {} : { params: args[0] }) }
}

export const presentation = {
  name: message('plugin.name'),
  description: message('plugin.description'),
} satisfies CordisXPluginPresentation

const providerSessionsPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'providers.sessions',
  title: message('page.title'),
  description: message('page.description'),
  icon: 'host:layers',
} satisfies CordisXPageMetadataV3

const providerSessionsRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'providers.sessions',
  path: '/main/providers/sessions',
  outlet: 'main',
  page: 'providers.sessions',
  title: message('route.title'),
  description: message('route.description'),
} satisfies CordisXRouteDefinitionV2<'main'>

export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.i18n.define<Messages>({
    namespace: 'cli-proxy-api', locale: 'en', default: true, messages: {
      'plugin.name': 'CLIProxy Providers',
      'plugin.description': 'Manage configured CLIProxy providers, models, and sessions.',
      'navigation.title': 'Providers', 'navigation.description': 'Manage provider models and sessions',
      'route.title': 'Open Provider sessions',
      'route.description': 'Enter the external Provider sessions fleet from CordisX navigation or the Manager route catalog.',
      'page.title': 'Provider sessions',
      'page.description': 'Create, search, resume, and manage sessions for configured Providers in the main workspace.',
      'page.subtitle': 'Choose a model and manage its sessions.',
      'field.provider': 'Provider', 'field.model': 'Model', 'field.cwd': 'Working directory', 'field.search': 'Search sessions',
      'field.initial-message': 'Initial message (recommended for persistence)',
      'action.refresh': 'Refresh', 'action.create': 'New session', 'action.load-more': 'Load more', 'action.continue': 'Continue',
      'action.fork': 'Fork', 'action.archive': 'Archive', 'action.restore': 'Restore', 'action.delete': 'Delete', 'action.send': 'Send message',
      'action.steer': 'Steer active turn', 'action.interrupt': 'Interrupt',
      'state.loading': 'Loading providers…', 'state.empty': 'No matching sessions.', 'state.no-models': 'No provider models are available.',
      'state.select-session': 'Select a provider session to inspect its content.', 'state.error': 'Provider request failed: {message}',
      'session.provider': 'Provider {provider}', 'session.model': 'Model {model}',
      'permission.models.read': 'List models from configured external providers', 'permission.tasks.catalog.read': 'List and search external provider sessions',
      'permission.tasks.content.read': 'Read selected external provider session content', 'permission.tasks.create': 'Create a session for the selected provider model',
      'permission.tasks.control': 'Continue, fork, archive, restore, or delete selected sessions', 'permission.turns.submit': 'Send messages to selected sessions',
      'permission.turns.control': 'Steer or interrupt selected turns',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'cli-proxy-api', locale: 'zh-CN', messages: {
      'plugin.name': 'CLIProxy 提供方',
      'plugin.description': '管理已配置的 CLIProxy 提供方、模型和会话。',
      'navigation.title': 'Providers', 'navigation.description': '管理 Provider 模型和会话',
      'route.title': '打开 Provider 会话',
      'route.description': '从 CordisX 导航或 Manager 路由目录进入外部 Provider 会话 Fleet。',
      'page.title': 'Provider 会话',
      'page.description': '在主工作区为已配置的 Provider 创建、搜索、续聊和管理会话。',
      'page.subtitle': '选择模型并管理会话。',
      'field.provider': 'Provider', 'field.model': '模型', 'field.cwd': '工作目录', 'field.search': '搜索会话',
      'field.initial-message': '首条消息（建议填写以立即持久化）',
      'action.refresh': '刷新', 'action.create': '新建会话', 'action.load-more': '加载更多', 'action.continue': '继续',
      'action.fork': '分叉', 'action.archive': '归档', 'action.restore': '恢复', 'action.delete': '删除', 'action.send': '发送消息',
      'action.steer': '引导进行中的 turn', 'action.interrupt': '中断',
      'state.loading': '正在加载 Provider…', 'state.empty': '没有匹配的会话。', 'state.no-models': '没有可用的 Provider 模型。',
      'state.select-session': '选择一个 Provider 会话以查看内容。', 'state.error': 'Provider 请求失败：{message}',
      'session.provider': 'Provider {provider}', 'session.model': '模型 {model}',
      'permission.models.read': '读取已配置外部 Provider 的模型', 'permission.tasks.catalog.read': '列出并搜索外部 Provider 会话',
      'permission.tasks.content.read': '读取所选外部 Provider 会话内容', 'permission.tasks.create': '用所选 Provider 模型创建会话',
      'permission.tasks.control': '继续、分叉、归档、恢复或删除所选会话', 'permission.turns.submit': '向所选会话发送消息',
      'permission.turns.control': '引导或中断所选 turn',
    },
  })
  ctx.pages.register<Messages>(providerSessionsPage, defineReactPage<Messages>(createProviderFleetPage(ctx, config)))
  ctx.routes.register(providerSessionsRoute)
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'providers', order: -100 }, {
    label: message('navigation.title'), description: message('navigation.description'), icon: 'host:layers', route: { id: 'providers.sessions' },
  })
}
