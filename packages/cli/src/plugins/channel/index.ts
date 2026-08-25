import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMetadataV3,
  type CordisXPageMountContext,
  type CordisXRouteDefinitionV2,
} from '../../contracts.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  type CordisXCapabilityDeclarationV2,
  type CordisXPluginManifestV4,
} from '../../permission-contracts.js'
import type { CordisXChannelManager } from '../../renderer/channel-manager.js'

export const name = 'channel'
export const inject = ['i18n', 'slots', 'pages', 'routes', 'channelManager']

const capabilityNames = [
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
  'agent.events.read',
  'channel.accounts.read',
  'channel.accounts.connect',
  'channel.events.receive',
  'channel.events.subscribe',
  'channel.messages.send',
  'channel.bindings.read',
  'channel.bindings.write',
  'channel.attachments.read',
] as const

const simulatorAccount = { adapterId: 'simulator', accountId: 'local' } as const
const simulatorTenant = { ...simulatorAccount, tenantId: 'test' } as const
const simulatorConversation = { ...simulatorTenant, conversationId: 'direct-alice', kind: 'direct' as const }

function capabilityScope(name: typeof capabilityNames[number]): CordisXCapabilityDeclarationV2['scope'] {
  if (name === 'tasks.create') return { providers: ['codex'], cwdRoots: ['/'] }
  if (name === 'tasks.content.read' || name === 'tasks.control' || name === 'turns.submit' || name === 'turns.control') {
    return { sessions: [{ providerId: 'codex', remoteSessionId: 'sim-session-1' }] }
  }
  if (name === 'agent.events.read') return { sessionIds: ['channel-simulator'] }
  if (name === 'channel.accounts.connect') return { channelAccounts: [simulatorAccount] }
  if (name === 'channel.events.receive' || name === 'channel.events.subscribe') return { channelTenants: [simulatorTenant] }
  if (name === 'channel.messages.send' || name === 'channel.bindings.write' || name === 'channel.attachments.read') {
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
    retention: name === 'channel.bindings.read' || name === 'channel.bindings.write' ? 'profile' : 'runtime',
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
  'page.title': undefined
  'page.description': undefined
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

type ChannelManagerContext = Context & { readonly channelManager: CordisXChannelManager }

function mountChannelManager(ctx: ChannelManagerContext, context: CordisXPageMountContext) {
  return ctx.channelManager.mount(context)
}

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
      'page.title': 'Channels',
      'page.description': 'Manage configured channel accounts, connections, and sessions.',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'channel',
    locale: 'zh-CN',
    messages: {
      'route.title': '渠道配置',
      'route.description': '打开由启动器持有的渠道账号、路由、任务绑定与诊断。',
      'page.title': '渠道',
      'page.description': '管理已配置的渠道账号、连接和会话。',
    },
  })
  ctx.pages.register<Messages>(settingsPage, context => mountChannelManager(channelContext, context))
  ctx.routes.register(settingsRoute)
  ctx.slots.register({
    name: 'manager.settings.navigation-items',
    id: 'channels',
    group: 'after-settings',
    order: 180,
  }, {
    route: { id: 'settings' },
  })
}
