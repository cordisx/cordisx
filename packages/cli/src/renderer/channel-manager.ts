import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import type { CordisXPageMountContext } from '../contracts.js'
import { createHostCollection, HOST_COLLECTION_STYLES, type HostCollectionItem } from './host-collection.js'
import { HostThemeProjection } from './host-theme.js'
import { createHostSurfaceIcon } from './icons.js'
import { managerCopy } from './ui-copy.js'

export type ChannelProductStatus = 'implemented' | 'verified' | 'experimental' | 'unavailable' | 'planned'

export interface ChannelManagerConnectionProjection {
  readonly ref: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
  readonly adapterKind: string
  readonly enabled: boolean
  readonly transportMode: string
  readonly secretState: 'missing' | 'ready' | 'unavailable'
}

export interface ChannelManagerRouteProjection {
  readonly id: string
  readonly connection: ChannelManagerConnectionProjection['ref']
  readonly enabled: boolean
  readonly workspaceAlias: string
  readonly provider: string
  readonly model: string
  readonly profile: string
  readonly notifications: readonly string[]
}

export interface ChannelManagerAccountProjection extends ChannelManagerConnectionProjection {
  readonly implementationStatus: ChannelProductStatus
  readonly connectionState: 'disabled' | 'starting' | 'ready' | 'retrying' | 'unavailable' | 'stopped'
  readonly generation: number
  readonly inbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
  readonly outbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
}

export interface ChannelManagerBindingProjection {
  readonly bindingId: string
  readonly channel: ChannelManagerConnectionProjection['ref'] & {
    readonly conversationId: string
    readonly threadId: string
  }
  readonly session: { readonly providerId: string; readonly remoteSessionId: string }
  readonly routeId: string
  readonly state: 'active' | 'archived' | 'unavailable'
}

export interface ChannelManagerDiagnosticProjection {
  readonly id: string
  readonly status: ChannelProductStatus
  readonly message: string
}

/** Renderer-safe Host projection. It deliberately has no secretRef or credential value field. */
export interface ChannelManagerProjectionV1 {
  readonly contract: 'cordisx.channel-manager-projection/v1'
  readonly schemaVersion: 1
  readonly status: ChannelProductStatus
  readonly service: {
    readonly configurationKind: 'host'
    readonly configApplies: 'service-restart'
    readonly revision: number
    readonly lastGoodRevision: number
    readonly writable: boolean
  }
  readonly connections: readonly ChannelManagerConnectionProjection[]
  readonly routes: readonly ChannelManagerRouteProjection[]
  readonly accounts: readonly ChannelManagerAccountProjection[]
  readonly bindings: readonly ChannelManagerBindingProjection[]
  readonly diagnostics: readonly ChannelManagerDiagnosticProjection[]
}

const EMPTY_PROJECTION: ChannelManagerProjectionV1 = Object.freeze({
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'unavailable',
  service: Object.freeze({
    configurationKind: 'host',
    configApplies: 'service-restart',
    revision: 0,
    lastGoodRevision: 0,
    writable: false,
  }),
  connections: Object.freeze([]),
  routes: Object.freeze([]),
  accounts: Object.freeze([]),
  bindings: Object.freeze([]),
  diagnostics: Object.freeze([
    Object.freeze({
      id: 'channel-runtime',
      status: 'unavailable',
      message: 'No launcher-owned Channel service is active for this profile.',
    }),
    Object.freeze({
      id: 'real-adapters',
      status: 'unavailable',
      message: 'Feishu and WeCom adapters require a developer account, Host credential handle, and an official transport.',
    }),
  ]),
})

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const projections = new WeakMap<object, ChannelManagerProjectionV1>()

function projectionFor(service: object): ChannelManagerProjectionV1 {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  if (original !== undefined) {
    const projection = projections.get(original)
    if (projection !== undefined) return projection
  }
  let candidate: object | null = service
  while (candidate !== null) {
    const projection = projections.get(candidate)
    if (projection !== undefined) return projection
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Channel Manager is detached from its Host projection')
}

const CHANNEL_MANAGER_STYLES = String.raw`
  .cxc-channel-manager { display: grid; gap: 18px; min-width: 0; color: var(--cx-text); }
  .cxc-channel-intro { display: grid; gap: 4px; }
  .cxc-channel-intro h2, .cxc-channel-section h3 { margin: 0; color: var(--cx-text); }
  .cxc-channel-intro h2 { font-size: 16px; }
  .cxc-channel-intro p, .cxc-channel-section p { margin: 0; color: var(--cx-muted); font-size: 11px; line-height: 1.5; }
  .cxc-channel-summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); }
  .cxc-channel-state { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 650; }
  .cxc-channel-state::before { width: 8px; height: 8px; border-radius: 50%; background: var(--cx-muted); content: ''; }
  .cxc-channel-state[data-status="verified"]::before, .cxc-channel-state[data-status="implemented"]::before { background: var(--cx-success, #4ade80); }
  .cxc-channel-state[data-status="experimental"]::before { background: var(--cx-warning, #fbbf24); }
  .cxc-channel-state[data-status="unavailable"]::before { background: var(--cx-danger, #fb7185); }
  .cxc-channel-meta { color: var(--cx-muted); font: 10px/1.35 ui-monospace, monospace; }
  .cxc-channel-section { display: grid; gap: 7px; min-width: 0; }
  .cxc-channel-section-head { display: grid; gap: 2px; }
  .cxc-channel-section h3 { font-size: 12px; }
  .cxc-channel-manager .cordisx-host-icon, .cxc-channel-manager .cordisx-host-icon svg { width: 22px; height: 22px; }
`

function compositeRef(ref: ChannelManagerConnectionProjection['ref']): string {
  return `${ref.adapterId}/${ref.accountId}/${ref.tenantId}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not renderer-safe`)
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as number
}

function array(value: unknown, label: string, maximum = 256): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} is invalid`)
  return value
}

function oneOf<T extends string>(value: unknown, accepted: readonly T[], label: string): T {
  if (typeof value !== 'string' || !accepted.includes(value as T)) throw new TypeError(`${label} is invalid`)
  return value as T
}

function ref(value: unknown, label: string): ChannelManagerConnectionProjection['ref'] {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId'], label)
  return {
    adapterId: boundedText(item.adapterId, `${label}.adapterId`),
    accountId: boundedText(item.accountId, `${label}.accountId`),
    tenantId: boundedText(item.tenantId, `${label}.tenantId`),
  }
}

function connection(value: unknown, label: string): ChannelManagerConnectionProjection {
  const item = object(value, label)
  exactKeys(item, ['ref', 'adapterKind', 'enabled', 'transportMode', 'secretState'], label)
  if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
  return {
    ref: ref(item.ref, `${label}.ref`),
    adapterKind: boundedText(item.adapterKind, `${label}.adapterKind`),
    enabled: item.enabled,
    transportMode: boundedText(item.transportMode, `${label}.transportMode`),
    secretState: oneOf(item.secretState, ['missing', 'ready', 'unavailable'], `${label}.secretState`),
  }
}

function normalizeProjection(value: unknown): ChannelManagerProjectionV1 {
  const projection = object(value, 'Channel Manager projection')
  exactKeys(projection, ['contract', 'schemaVersion', 'status', 'service', 'connections', 'routes', 'accounts', 'bindings', 'diagnostics'], 'Channel Manager projection')
  if (projection.contract !== 'cordisx.channel-manager-projection/v1' || projection.schemaVersion !== 1) {
    throw new TypeError('Channel Manager projection contract is unsupported')
  }
  const service = object(projection.service, 'Channel Manager projection.service')
  exactKeys(service, ['configurationKind', 'configApplies', 'revision', 'lastGoodRevision', 'writable'], 'Channel Manager projection.service')
  if (service.configurationKind !== 'host' || service.configApplies !== 'service-restart' || typeof service.writable !== 'boolean') {
    throw new TypeError('Channel Manager service projection is invalid')
  }
  const connections = array(projection.connections, 'Channel Manager projection.connections').map((item, index) => (
    connection(item, `Channel Manager projection.connections[${index}]`)
  ))
  const routes = array(projection.routes, 'Channel Manager projection.routes').map((value, index): ChannelManagerRouteProjection => {
    const item = object(value, `Channel Manager projection.routes[${index}]`)
    const label = `Channel Manager projection.routes[${index}]`
    exactKeys(item, ['id', 'connection', 'enabled', 'workspaceAlias', 'provider', 'model', 'profile', 'notifications'], label)
    if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
    return {
      id: boundedText(item.id, `${label}.id`),
      connection: ref(item.connection, `${label}.connection`),
      enabled: item.enabled,
      workspaceAlias: boundedText(item.workspaceAlias, `${label}.workspaceAlias`),
      provider: boundedText(item.provider, `${label}.provider`),
      model: boundedText(item.model, `${label}.model`),
      profile: boundedText(item.profile, `${label}.profile`),
      notifications: array(item.notifications, `${label}.notifications`, 32).map((entry, notificationIndex) => (
        boundedText(entry, `${label}.notifications[${notificationIndex}]`)
      )),
    }
  })
  const accounts = array(projection.accounts, 'Channel Manager projection.accounts').map((value, index): ChannelManagerAccountProjection => {
    const item = object(value, `Channel Manager projection.accounts[${index}]`)
    const label = `Channel Manager projection.accounts[${index}]`
    exactKeys(item, [
      'ref', 'adapterKind', 'enabled', 'transportMode', 'secretState', 'implementationStatus', 'connectionState',
      'generation', 'inbound', 'outbound',
    ], label)
    const base = connection(Object.fromEntries(
      ['ref', 'adapterKind', 'enabled', 'transportMode', 'secretState'].map(key => [key, item[key]]),
    ), label)
    const counts = (raw: unknown, countLabel: string) => {
      const count = object(raw, countLabel)
      exactKeys(count, ['pending', 'retrying', 'deadLetter'], countLabel)
      return {
        pending: boundedInteger(count.pending, `${countLabel}.pending`),
        retrying: boundedInteger(count.retrying, `${countLabel}.retrying`),
        deadLetter: boundedInteger(count.deadLetter, `${countLabel}.deadLetter`),
      }
    }
    return {
      ...base,
      implementationStatus: oneOf(item.implementationStatus, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], `${label}.implementationStatus`),
      connectionState: oneOf(item.connectionState, ['disabled', 'starting', 'ready', 'retrying', 'unavailable', 'stopped'], `${label}.connectionState`),
      generation: boundedInteger(item.generation, `${label}.generation`),
      inbound: counts(item.inbound, `${label}.inbound`),
      outbound: counts(item.outbound, `${label}.outbound`),
    }
  })
  const bindings = array(projection.bindings, 'Channel Manager projection.bindings').map((value, index): ChannelManagerBindingProjection => {
    const item = object(value, `Channel Manager projection.bindings[${index}]`)
    const label = `Channel Manager projection.bindings[${index}]`
    exactKeys(item, ['bindingId', 'channel', 'session', 'routeId', 'state'], label)
    const channel = object(item.channel, `${label}.channel`)
    exactKeys(channel, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId'], `${label}.channel`)
    const session = object(item.session, `${label}.session`)
    exactKeys(session, ['providerId', 'remoteSessionId'], `${label}.session`)
    return {
      bindingId: boundedText(item.bindingId, `${label}.bindingId`),
      channel: {
        ...ref({ adapterId: channel.adapterId, accountId: channel.accountId, tenantId: channel.tenantId }, `${label}.channel`),
        conversationId: boundedText(channel.conversationId, `${label}.channel.conversationId`),
        threadId: boundedText(channel.threadId, `${label}.channel.threadId`),
      },
      session: {
        providerId: boundedText(session.providerId, `${label}.session.providerId`),
        remoteSessionId: boundedText(session.remoteSessionId, `${label}.session.remoteSessionId`),
      },
      routeId: boundedText(item.routeId, `${label}.routeId`),
      state: oneOf(item.state, ['active', 'archived', 'unavailable'], `${label}.state`),
    }
  })
  const diagnostics = array(projection.diagnostics, 'Channel Manager projection.diagnostics', 128).map((value, index): ChannelManagerDiagnosticProjection => {
    const item = object(value, `Channel Manager projection.diagnostics[${index}]`)
    const label = `Channel Manager projection.diagnostics[${index}]`
    exactKeys(item, ['id', 'status', 'message'], label)
    return {
      id: boundedText(item.id, `${label}.id`),
      status: oneOf(item.status, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], `${label}.status`),
      message: boundedText(item.message, `${label}.message`, 4096),
    }
  })
  return {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: oneOf(projection.status, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], 'Channel Manager projection.status'),
    service: {
      configurationKind: 'host',
      configApplies: 'service-restart',
      revision: boundedInteger(service.revision, 'Channel Manager projection.service.revision'),
      lastGoodRevision: boundedInteger(service.lastGoodRevision, 'Channel Manager projection.service.lastGoodRevision'),
      writable: service.writable,
    },
    connections,
    routes,
    accounts,
    bindings,
    diagnostics,
  }
}

function cloneProjection(projection: ChannelManagerProjectionV1): ChannelManagerProjectionV1 {
  return normalizeProjection(JSON.parse(JSON.stringify(projection)) as unknown)
}

function selector(value: string): string {
  return value === 'default' ? 'default' : value
}

function statusTone(status: ChannelProductStatus | ChannelManagerAccountProjection['connectionState']) {
  if (status === 'implemented' || status === 'verified' || status === 'ready') return 'success' as const
  if (status === 'experimental' || status === 'starting' || status === 'retrying') return 'progress' as const
  if (status === 'unavailable') return 'danger' as const
  if (status === 'planned') return 'warning' as const
  return 'neutral' as const
}

function section(document: Document, title: string, description: string): { readonly root: HTMLElement; readonly body: HTMLElement } {
  const root = document.createElement('section')
  root.className = 'cxc-channel-section'
  const head = document.createElement('div')
  head.className = 'cxc-channel-section-head'
  const heading = document.createElement('h3')
  heading.textContent = title
  const copy = document.createElement('p')
  copy.textContent = description
  const body = document.createElement('div')
  head.append(heading, copy)
  root.append(head, body)
  return { root, body }
}

function accountItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  const configured = new Map(projection.connections.map(item => [compositeRef(item.ref), item]))
  const live = new Map(projection.accounts.map(item => [compositeRef(item.ref), item]))
  return [...new Set([...configured.keys(), ...live.keys()])].sort().map(id => {
    const account = live.get(id)
    const connection = account ?? configured.get(id)!
    const state = account?.connectionState ?? (connection.enabled ? 'unavailable' : 'disabled')
    const description = `${connection.adapterKind} · ${connection.transportMode} · credential ${connection.secretState}`
    return {
      id,
      title: connection.ref.accountId,
      description,
      machineId: id,
      searchText: [connection.ref.adapterId, connection.ref.tenantId, state],
      icon: () => createHostSurfaceIcon(document, state === 'ready' ? 'host:success' : 'host:layers'),
      status: {
        label: state,
        tone: statusTone(state),
        detail: account === undefined
          ? `${state}; no launcher runtime snapshot`
          : `${state}; generation ${account.generation}; inbound ${account.inbound.pending}; outbound ${account.outbound.pending}`,
      },
    }
  })
}

function routeItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  return projection.routes.map(route => ({
    id: route.id,
    title: route.id,
    description: `${selector(route.provider)} · ${selector(route.model)} · ${route.workspaceAlias}`,
    machineId: `${compositeRef(route.connection)} → ${route.profile}`,
    searchText: [...route.notifications, route.enabled ? 'enabled' : 'disabled'],
    icon: () => createHostSurfaceIcon(document, 'host:open'),
    status: {
      label: route.enabled ? 'enabled' : 'disabled',
      tone: route.enabled ? 'success' : 'neutral',
      detail: `${route.notifications.length} notification event types`,
    },
  }))
}

function bindingItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  return projection.bindings.map(binding => ({
    id: binding.bindingId,
    title: binding.channel.conversationId,
    description: `${binding.session.providerId} · ${binding.session.remoteSessionId}`,
    machineId: `${compositeRef(binding.channel)}/${binding.channel.threadId}`,
    searchText: [binding.routeId, binding.state, binding.session.providerId, binding.session.remoteSessionId],
    icon: () => createHostSurfaceIcon(document, 'host:layers'),
    status: {
      label: binding.state,
      tone: binding.state === 'active' ? 'success' : binding.state === 'unavailable' ? 'danger' : 'neutral',
      detail: `route ${binding.routeId}`,
    },
  }))
}

function diagnosticItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  return projection.diagnostics.map(diagnostic => ({
    id: diagnostic.id,
    title: diagnostic.id,
    description: diagnostic.message,
    icon: () => createHostSurfaceIcon(document, diagnostic.status === 'unavailable' ? 'host:warning' : 'host:info'),
    status: { label: diagnostic.status, tone: statusTone(diagnostic.status), detail: diagnostic.message },
  }))
}

export interface CordisXChannelManager {
  snapshot(): ChannelManagerProjectionV1
  mount(context: CordisXPageMountContext): Disposable<void>
}

/** Host-owned Channel settings renderer. Plugins can request the seat but never receive its DOM internals. */
export class CordisXChannelManagerService extends Service implements CordisXChannelManager {
  constructor(ctx: Context, projection: ChannelManagerProjectionV1 = EMPTY_PROJECTION) {
    super(ctx, 'channelManager')
    projections.set(this, normalizeProjection(projection))
  }

  snapshot(): ChannelManagerProjectionV1 {
    return cloneProjection(projectionFor(this))
  }

  mount(context: CordisXPageMountContext): Disposable<void> {
    const { document } = context
    const projection = projectionFor(this)
    const locale = document.documentElement.lang || 'en'
    const theme = new HostThemeProjection(document)
    const root = document.createElement('div')
    root.className = 'cxc-channel-manager'
    root.dataset.channelManager = 'mounted'
    root.dataset.channelStatus = projection.status
    const detachTheme = theme.attach(root)
    const style = document.createElement('style')
    style.dataset.channelManagerStyles = 'true'
    style.textContent = `${HOST_COLLECTION_STYLES}\n${CHANNEL_MANAGER_STYLES}`

    const intro = document.createElement('header')
    intro.className = 'cxc-channel-intro'
    const title = document.createElement('h2')
    title.textContent = managerCopy(locale, 'channel.title')
    const description = document.createElement('p')
    description.textContent = managerCopy(locale, 'channel.description')
    intro.append(title, description)

    const summary = document.createElement('div')
    summary.className = 'cxc-channel-summary'
    summary.setAttribute('role', 'status')
    const state = document.createElement('span')
    state.className = 'cxc-channel-state'
    state.dataset.status = projection.status
    state.textContent = managerCopy(locale, projection.status === 'unavailable' ? 'status.unavailable' : 'channel.status.available')
    const meta = document.createElement('code')
    meta.className = 'cxc-channel-meta'
    meta.textContent = `service config · service restart · r${projection.service.revision} / last-good ${projection.service.lastGoodRevision}`
    summary.append(state, meta)

    const accounts = section(document, managerCopy(locale, 'channel.accounts'), managerCopy(locale, 'channel.accounts.description'))
    const accountCollection = createHostCollection(document, {
      id: 'channel-accounts',
      label: managerCopy(locale, 'channel.accounts'),
      items: accountItems(document, projection),
      emptyLabel: managerCopy(locale, 'channel.accounts.empty'),
      noMatchesLabel: managerCopy(locale, 'channel.search.empty'),
    })
    accounts.body.append(accountCollection.element)

    const routes = section(document, managerCopy(locale, 'channel.routes'), managerCopy(locale, 'channel.routes.description'))
    const routeCollection = createHostCollection(document, {
      id: 'channel-routes',
      label: managerCopy(locale, 'channel.routes'),
      items: routeItems(document, projection),
      emptyLabel: managerCopy(locale, 'channel.routes.empty'),
      noMatchesLabel: managerCopy(locale, 'channel.search.empty'),
    })
    routes.body.append(routeCollection.element)

    const bindings = section(document, managerCopy(locale, 'channel.bindings'), managerCopy(locale, 'channel.bindings.description'))
    const bindingCollection = createHostCollection(document, {
      id: 'channel-bindings',
      label: managerCopy(locale, 'channel.bindings'),
      items: bindingItems(document, projection),
      emptyLabel: managerCopy(locale, 'channel.bindings.empty'),
      noMatchesLabel: managerCopy(locale, 'channel.search.empty'),
    })
    bindings.body.append(bindingCollection.element)

    const diagnostics = section(document, managerCopy(locale, 'channel.diagnostics'), managerCopy(locale, 'channel.diagnostics.description'))
    const diagnosticCollection = createHostCollection(document, {
      id: 'channel-diagnostics',
      label: managerCopy(locale, 'channel.diagnostics'),
      items: diagnosticItems(document, projection),
      search: { enabled: false, reason: 'Diagnostics are a fixed, small Host status catalog.' },
      emptyLabel: managerCopy(locale, 'channel.diagnostics.empty'),
    })
    diagnostics.body.append(diagnosticCollection.element)

    root.append(style, intro, summary, accounts.root, routes.root, bindings.root, diagnostics.root)
    context.container.append(root)
    const abort = () => root.dataset.channelManagerAborted = 'true'
    context.signal.addEventListener('abort', abort, { once: true })
    return () => {
      context.signal.removeEventListener('abort', abort)
      diagnosticCollection.dispose()
      bindingCollection.dispose()
      routeCollection.dispose()
      accountCollection.dispose()
      detachTheme()
      theme.dispose()
      root.remove()
    }
  }
}
