import type { Context, Disposable } from '@deepseek-ai/cordis'
import { defineReactPage } from 'cordisx/react'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  type CordisXLocalizedText,
  type CordisXManagerContentNavigationDeclarationV1,
  type CordisXMessageParams,
  type CordisXPageMetadataV3,
  type CordisXRouteDefinitionV2,
} from '../../contracts.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  type CordisXCapabilityDeclarationV2,
  type CordisXPluginManifestV4,
} from '../../permission-contracts.js'
import type { CordisXChannelManager } from '../../renderer/channel-manager.js'
import { createChannelPage } from './view.js'

export const name = 'channel'
export const inject = ['i18n', 'slots', 'pages', 'routes', 'managerContent', 'channelManager']

const capabilityNames = [
  'channel.accounts.read',
  'channel.accounts.connect',
  'channel.events.receive',
  'channel.events.subscribe',
  'channel.messages.send',
  'channel.attachments.read',
] as const

const simulatorAccount = { adapterId: 'simulator', accountId: 'local' } as const
const simulatorTenant = { ...simulatorAccount, tenantId: 'test' } as const
const simulatorConversation = { ...simulatorTenant, conversationId: 'direct-alice', kind: 'direct' as const }

function capabilityScope(name: typeof capabilityNames[number]): CordisXCapabilityDeclarationV2['scope'] {
  if (name === 'channel.accounts.connect') return { channelAccounts: [simulatorAccount] }
  if (name === 'channel.events.receive' || name === 'channel.events.subscribe') return { channelTenants: [simulatorTenant] }
  if (name === 'channel.messages.send' || name === 'channel.attachments.read') {
    return { channelConversations: [simulatorConversation] }
  }
  return {}
}

const capabilities: readonly CordisXCapabilityDeclarationV2[] = capabilityNames.map(name => ({
  name,
  required: false,
  scope: capabilityScope(name),
  security: {
    dataUse: name.startsWith('channel.') ? 'profile-persistent' : 'ephemeral',
    retention: 'runtime',
    externalTransfer: name === 'channel.messages.send' || name === 'channel.accounts.connect',
  },
}))

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  schemaVersion: 4,
  id: 'channel',
  name: 'Channels',
  capabilities,
  services: [{
    id: 'runtime',
    kind: 'channel-adapter',
    entry: './service.mjs',
    configuration: {
      kind: 'host',
      schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json',
      configApplies: 'restart',
    },
  }],
} as const satisfies CordisXPluginManifestV4

interface Messages {
  'route.title': undefined
  'route.description': undefined
  'route.create.title': undefined
  'route.create.description': undefined
  'route.configuration.title': undefined
  'route.configuration.description': undefined
  'route.logs.title': undefined
  'route.logs.description': undefined
  'route.runtime.title': undefined
  'route.runtime.description': undefined
  'route.sessions.title': undefined
  'route.sessions.description': undefined
  'page.title': undefined
  'page.description': undefined
  'page.create.title': undefined
  'page.create.description': undefined
  'page.configuration.title': undefined
  'page.configuration.description': undefined
  'page.logs.title': undefined
  'page.logs.description': undefined
  'page.runtime.title': undefined
  'page.runtime.description': undefined
  'page.sessions.title': undefined
  'page.sessions.description': undefined
  'page.record.fallback': undefined
  'page.record.title': { name: string }
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return { namespace: 'channel', key, ...(args[0] === undefined ? {} : { params: args[0] }) }
}

const settingsPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'settings',
  title: message('page.title'),
  description: message('page.description'),
  icon: 'host:layers',
  chrome: 'standard',
} satisfies CordisXPageMetadataV3

const settingsRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'settings',
  path: '/manager/extensions/channels',
  outlet: 'manager.content',
  page: 'settings',
  title: message('route.title'),
  description: message('route.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>

const createPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'create',
  title: message('page.create.title'), description: message('page.create.description'), icon: 'host:layers', chrome: 'standard',
} satisfies CordisXPageMetadataV3
const configurationPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'configuration',
  title: message('page.configuration.title'), description: message('page.configuration.description'), icon: 'host:settings', chrome: 'standard',
} satisfies CordisXPageMetadataV3
const logsPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'logs',
  title: message('page.logs.title'), description: message('page.logs.description'), icon: 'host:history', chrome: 'standard',
} satisfies CordisXPageMetadataV3
const runtimePage = {
  $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'runtime',
  title: message('page.runtime.title'), description: message('page.runtime.description'), icon: 'host:open', chrome: 'standard',
} satisfies CordisXPageMetadataV3
const sessionsPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'sessions',
  title: message('page.sessions.title'), description: message('page.sessions.description'), icon: 'host:layers', chrome: 'standard',
} satisfies CordisXPageMetadataV3

const createRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'create', path: '/manager/extensions/channels/create', outlet: 'manager.content', page: 'create',
  title: message('route.create.title'), description: message('route.create.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>
const configurationRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'configuration', path: '/manager/extensions/channels/:accountId', outlet: 'manager.content', page: 'configuration',
  title: message('route.configuration.title'), description: message('route.configuration.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>
const logsRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'logs', path: '/manager/extensions/channels/:accountId/logs', outlet: 'manager.content', page: 'logs',
  title: message('route.logs.title'), description: message('route.logs.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>
const runtimeRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'runtime', path: '/manager/extensions/channels/:accountId/runtime', outlet: 'manager.content', page: 'runtime',
  title: message('route.runtime.title'), description: message('route.runtime.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>
const sessionsRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'sessions', path: '/manager/extensions/channels/:accountId/sessions', outlet: 'manager.content', page: 'sessions',
  title: message('route.sessions.title'), description: message('route.sessions.description'),
} satisfies CordisXRouteDefinitionV2<'manager.content'>

function channelRef(item: { readonly ref: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string } }): string {
  return `${item.ref.adapterId}/${item.ref.accountId}/${item.ref.tenantId}`
}

function declarationId(prefix: string, accountId: string): string {
  const normalized = accountId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'account'
  let hash = 0
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${prefix}-${normalized}-${hash.toString(36)}`
}

type ChannelManagerContext = Context & { readonly channelManager: CordisXChannelManager }

/** Structured Channel Settings contribution; every rendered node remains Host-owned. */
export function apply(ctx: Context): void {
  const channelContext = ctx as ChannelManagerContext
  ctx.i18n.define<Messages>({
    namespace: 'channel',
    locale: 'en',
    default: true,
    messages: {
      'route.title': 'Channel settings',
      'route.description': 'Open launcher-owned Channel accounts, routes, task bindings, and diagnostics.',
      'route.create.title': 'Channel candidate', 'route.create.description': 'Open the local candidate creation flow.',
      'route.configuration.title': 'Channel account', 'route.configuration.description': 'Open a safe account configuration projection.',
      'route.logs.title': 'Channel account logs', 'route.logs.description': 'Open the account log projection.',
      'route.runtime.title': 'Channel runtime', 'route.runtime.description': 'Review the current connection and queue state.',
      'route.sessions.title': 'Channel account sessions', 'route.sessions.description': 'Open account routes and session bindings.',
      'page.title': 'Channels',
      'page.description': 'Manage configured channel accounts, connections, and sessions.',
      'page.create.title': 'Create channel', 'page.create.description': 'Create a local candidate without exposing credentials.',
      'page.configuration.title': 'Configuration', 'page.configuration.description': 'Review safe account configuration.',
      'page.logs.title': 'Logs', 'page.logs.description': 'Inspect available channel logs.',
      'page.runtime.title': 'Runtime status', 'page.runtime.description': 'Review current channel activity and connection state.',
      'page.sessions.title': 'Connections & sessions', 'page.sessions.description': 'Review routes and session bindings.',
      'page.record.fallback': 'Channel',
      'page.record.title': '{name}',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'channel',
    locale: 'zh-CN',
    messages: {
      'route.title': '渠道配置',
      'route.description': '打开由启动器持有的渠道账号、路由、任务绑定与诊断。',
      'route.create.title': '渠道候选', 'route.create.description': '打开本地候选创建流程。',
      'route.configuration.title': '渠道账号', 'route.configuration.description': '打开安全的账号配置投影。',
      'route.logs.title': '渠道账号日志', 'route.logs.description': '打开账号日志投影。',
      'route.runtime.title': '渠道运行状态', 'route.runtime.description': '查看当前连接与队列状态。',
      'route.sessions.title': '渠道账号会话', 'route.sessions.description': '打开账号路由和会话绑定。',
      'page.title': '渠道',
      'page.description': '管理已配置的渠道账号、连接和会话。',
      'page.create.title': '新建渠道', 'page.create.description': '创建本地候选，不展示凭据。',
      'page.configuration.title': '配置', 'page.configuration.description': '查看安全的账号配置。',
      'page.logs.title': '日志', 'page.logs.description': '查看可用的渠道日志。',
      'page.runtime.title': '运行状态', 'page.runtime.description': '查看当前渠道活动与连接状态。',
      'page.sessions.title': '连接与会话管理', 'page.sessions.description': '查看路由与会话绑定。',
      'page.record.fallback': '渠道',
      'page.record.title': '{name}',
    },
  })
  const mountPage = defineReactPage<Messages>(createChannelPage(channelContext.channelManager))
  ctx.pages.register<Messages>(settingsPage, mountPage)
  ctx.pages.register<Messages>(createPage, mountPage)
  ctx.pages.register<Messages>(configurationPage, mountPage)
  ctx.pages.register<Messages>(logsPage, mountPage)
  ctx.pages.register<Messages>(runtimePage, mountPage)
  ctx.pages.register<Messages>(sessionsPage, mountPage)
  ctx.routes.register(settingsRoute)
  ctx.routes.register(createRoute)
  ctx.routes.register(configurationRoute)
  ctx.routes.register(logsRoute)
  ctx.routes.register(runtimeRoute)
  ctx.routes.register(sessionsRoute)
  ctx.effect(() => {
    let disposeProjection: Disposable<void | Promise<void>> = () => {}
    const refreshNavigation = (): void => {
      const declarations: CordisXManagerContentNavigationDeclarationV1[] = [{
        $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1, schemaVersion: 1,
        id: 'root', route: { id: 'settings' }, header: { title: { kind: 'route' } },
      }, {
        $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1, schemaVersion: 1,
        id: 'create', route: { id: 'create' }, parentRoute: { id: 'settings' }, header: { title: { kind: 'route' } },
      }]
      const snapshot = channelContext.channelManager.snapshot()
      const records = [...snapshot.connections, ...snapshot.accounts]
      const unique = new Map(records.map(record => [channelRef(record), record]))
      const recordTitles = [...unique].map(([id, record]) => ({
        id,
        title: message('page.record.title', { name: record.displayName ?? record.ref.accountId }),
      }))
      for (const [accountId] of unique) {
        const tabs = [
          { id: 'configuration', route: { id: 'configuration', params: { accountId } } },
          { id: 'runtime', route: { id: 'runtime', params: { accountId } } },
          { id: 'logs', route: { id: 'logs', params: { accountId } } },
          { id: 'sessions', route: { id: 'sessions', params: { accountId } } },
        ] as const
        for (const tab of tabs) {
          declarations.push({
            $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1, schemaVersion: 1,
            id: declarationId(tab.id, accountId), route: tab.route, parentRoute: { id: 'settings' },
            header: { title: { kind: 'record', recordIdParam: 'accountId', fallback: message('page.record.fallback') } }, tabs,
          })
        }
      }
      disposeProjection = ctx.managerContent.replaceProjection({ declarations, recordTitles })
    }
    refreshNavigation()
    const unsubscribe = channelContext.channelManager.subscribe(refreshNavigation)
    return () => {
      unsubscribe()
      void disposeProjection()
    }
  }, 'channel: manager content navigation projection')
  ctx.slots.register({
    name: 'manager.settings.navigation-items',
    id: 'channels',
    group: 'after-settings',
    order: 180,
  }, {
    route: { id: 'settings' },
  })
}
