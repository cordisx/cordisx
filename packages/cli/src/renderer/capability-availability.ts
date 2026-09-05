import type {
  CordisXAgentEventStatus,
  CordisXAgentHistoryStatus,
  CordisXCapabilityScope,
  CordisXLocaleCatalog,
  CordisXLocalizedText,
  CordisXPlatformAdapterStatus,
  CordisXPlatformCapability,
} from '../contracts.js'
import type {
  CordisXCapabilityAvailabilityState,
  CordisXCapabilityProviderFamily,
  CordisXCapabilityProviderKind,
  CordisXCapabilityProviderReport,
  CordisXCapabilityProviderRoute,
  CordisXExternalProviderAvailabilityStatus,
} from '../capability-availability-contracts.js'

const AVAILABILITY_NAMESPACE = 'cordisx.manager.capability-availability'
const PLATFORM_CAPABILITIES: readonly CordisXPlatformCapability[] = Object.freeze([
  'models.read',
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
  'turns.introduce',
  'approvals.decide',
])
const AGENT_INPUT_CAPABILITIES: readonly CordisXPlatformCapability[] = Object.freeze([
  'agent.messages.append',
  'agent.steps.reject',
  'agent.messages.transform',
  'agent.prompt.section',
  'agent.prompt.context',
])

function message(
  key: string,
  fallback: string,
  params?: Readonly<Record<string, string | number>>,
): CordisXLocalizedText {
  return Object.freeze({
    namespace: AVAILABILITY_NAMESPACE,
    key,
    ...(params === undefined ? {} : { params: Object.freeze({ ...params }) }),
    fallback,
  })
}

function frozenScope(scope: CordisXCapabilityScope): CordisXCapabilityScope {
  return Object.freeze({
    ...(scope.providers === undefined ? {} : { providers: Object.freeze([...scope.providers]) }),
    ...(scope.cwdRoots === undefined ? {} : { cwdRoots: Object.freeze([...scope.cwdRoots]) }),
    ...(scope.sessions === undefined
      ? {}
      : { sessions: Object.freeze(scope.sessions.map(item => Object.freeze({ ...item }))) }),
    ...(scope.sessionIds === undefined ? {} : { sessionIds: Object.freeze([...scope.sessionIds]) }),
  })
}

function route(
  capability: CordisXPlatformCapability,
  status: CordisXCapabilityAvailabilityState,
  reason: CordisXLocalizedText,
  scope: CordisXCapabilityScope = {},
): CordisXCapabilityProviderRoute {
  return Object.freeze({ capability, status, reason, scope: frozenScope(scope) })
}

function report(input: CordisXCapabilityProviderReport): CordisXCapabilityProviderReport {
  return Object.freeze({
    ...input,
    routes: Object.freeze([...input.routes]),
  })
}

export function platformAdapterCapabilityProvider(
  status: CordisXPlatformAdapterStatus,
  input: {
    readonly providerId: string
    readonly kind: Extract<CordisXCapabilityProviderKind, 'current-connection'>
    readonly scope?: CordisXCapabilityScope
  },
): CordisXCapabilityProviderReport {
  const supported = new Set(status.supportedCapabilities)
  const providerStatus: CordisXCapabilityAvailabilityState = status.mode === 'unavailable' ? 'unavailable' : 'supported'
  const providerReason = status.mode === 'unavailable'
    ? message('provider.current-connection.unavailable', 'The Desktop current connection is unavailable.')
    : message(
      'provider.current-connection.supported',
      'The Desktop current connection can route supported capabilities.',
    )
  return report({
    providerId: input.providerId,
    providerName: message('provider.current-connection.name', 'Desktop current connection'),
    kind: input.kind,
    family: 'platform',
    status: providerStatus,
    reason: providerReason,
    routes: PLATFORM_CAPABILITIES.map(capability =>
      route(
        capability,
        supported.has(capability) ? 'supported' : 'unavailable',
        supported.has(capability)
          ? message('route.current-connection.supported', 'The current connection can route this capability.')
          : message('route.current-connection.unavailable', 'The current connection cannot route this capability.'),
        input.scope,
      )
    ),
  })
}

export function hostLocalCapabilityProviders(input: {
  readonly agentStatus: CordisXAgentEventStatus
  readonly historyStatus: CordisXAgentHistoryStatus
  readonly configurationWritable: boolean
  readonly packageLifecycleAvailable?: boolean
}): readonly CordisXCapabilityProviderReport[] {
  const agentAvailable = input.agentStatus.mode !== 'unavailable'
  const historyAvailable = input.historyStatus.mode === 'available'
  const agentReason = agentAvailable
    ? message('provider.agent-input.supported', 'The current Agent connection can route Agent input capabilities.')
    : message('provider.agent-input.unavailable', 'Agent input requires a current connection that is not available.')
  const historyReason = historyAvailable
    ? message('provider.agent-history.supported', 'Host Agent history is available.')
    : message('provider.agent-history.unavailable', 'Host Agent history is unavailable.')
  return Object.freeze([
    report({
      providerId: 'host-agent-events',
      providerName: message('provider.agent-events.name', 'Host Agent event ledger'),
      kind: 'host-local',
      family: 'agent-events',
      status: 'supported',
      reason: message('provider.agent-events.supported', 'The Host-local Agent event ledger is available.'),
      routes: [route(
        'agent.events.read',
        'supported',
        message('route.agent-events.supported', 'The Host-local ledger can serve Agent event queries.'),
      )],
    }),
    report({
      providerId: 'host-agent-history',
      providerName: message('provider.agent-history.name', 'Host Agent history'),
      kind: 'host-local',
      family: 'agent-history',
      status: historyAvailable ? 'supported' : 'unavailable',
      reason: historyReason,
      routes: [route('agent.history.read', historyAvailable ? 'supported' : 'unavailable', historyReason)],
    }),
    report({
      providerId: 'desktop-agent-input',
      providerName: message('provider.agent-input.name', 'Desktop Agent input'),
      kind: 'current-connection',
      family: 'agent-input',
      status: agentAvailable ? 'supported' : 'unavailable',
      reason: agentReason,
      routes: AGENT_INPUT_CAPABILITIES.map(capability =>
        route(
          capability,
          agentAvailable ? 'supported' : 'unavailable',
          agentReason,
        )
      ),
    }),
    report({
      providerId: 'host-configuration',
      providerName: message('provider.configuration.name', 'Host configuration'),
      kind: 'host-local',
      family: 'configuration',
      status: input.configurationWritable ? 'supported' : 'degraded',
      reason: input.configurationWritable
        ? message('provider.configuration.supported', 'Validated configuration and the Host writer are available.')
        : message(
          'provider.configuration.degraded',
          'Configuration descriptors are available, but the Host writer is unavailable.',
        ),
      routes: [],
    }),
    report({
      providerId: 'host-plugin-console',
      providerName: message('provider.console.name', 'Host plugin console'),
      kind: 'host-local',
      family: 'console',
      status: 'unavailable',
      reason: message(
        'provider.console.unavailable',
        'The Console protocol is defined, but this Host has not published a console service.',
      ),
      routes: [],
    }),
    report({
      providerId: 'host-package-lifecycle',
      providerName: message('provider.package-lifecycle.name', 'Host package lifecycle'),
      kind: 'host-local',
      family: 'package-lifecycle',
      status: input.packageLifecycleAvailable === true ? 'supported' : 'unavailable',
      reason: input.packageLifecycleAvailable === true
        ? message(
          'provider.package-lifecycle.supported',
          'The launcher package lifecycle and generation service is available.',
        )
        : message(
          'provider.package-lifecycle.unavailable',
          'Package lifecycle contracts are defined, but this Host has not published an activation service.',
        ),
      routes: [],
    }),
  ])
}

export function externalProviderCapabilityProviders(
  statuses: readonly CordisXExternalProviderAvailabilityStatus[],
): readonly CordisXCapabilityProviderReport[] {
  return Object.freeze(statuses.map(provider => {
    const available = provider.state === 'ready'
    const providerName = message('provider.external.name', '{name}', { name: provider.displayName })
    const providerReason = available
      ? message('provider.external.supported', 'External provider {name} is ready.', { name: provider.displayName })
      : message('provider.external.unavailable', 'External provider {name} is unavailable.', {
        name: provider.displayName,
      })
    return report({
      providerId: `external:${provider.providerId}`,
      providerName,
      kind: 'external-provider',
      family: 'platform',
      status: available ? 'supported' : 'unavailable',
      reason: providerReason,
      ...(provider.generation === undefined ? {} : { generation: provider.generation }),
      routes: PLATFORM_CAPABILITIES.map(capability =>
        route(
          capability,
          available ? 'supported' : 'unavailable',
          providerReason,
          { providers: [provider.providerId] },
        )
      ),
    })
  }))
}

export interface ResolvedCapabilityProvider {
  readonly providerId: string
  readonly providerName: CordisXLocalizedText
  readonly kind: CordisXCapabilityProviderKind
  readonly family: CordisXCapabilityProviderFamily
  readonly status: CordisXCapabilityAvailabilityState
  readonly reason: CordisXLocalizedText
  readonly generation?: string
  readonly scope: CordisXCapabilityScope
}

export interface ResolvedCapabilityAvailability {
  readonly capability: CordisXPlatformCapability
  readonly status: CordisXCapabilityAvailabilityState
  readonly reason: CordisXLocalizedText
  readonly providers: readonly ResolvedCapabilityProvider[]
}

function providerIds(scope: CordisXCapabilityScope): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...(scope.providers ?? []),
      ...(scope.sessions ?? []).map(item => item.providerId),
    ]),
  ].sort())
}

function routeProviderIds(scope: CordisXCapabilityScope): ReadonlySet<string> {
  return new Set(providerIds(scope))
}

function providerRouteMatches(route: CordisXCapabilityProviderRoute, providerId: string): boolean {
  const scoped = routeProviderIds(route.scope)
  return scoped.has(providerId)
}

function resolvedProvider(
  provider: CordisXCapabilityProviderReport,
  route: CordisXCapabilityProviderRoute,
): ResolvedCapabilityProvider {
  return Object.freeze({
    providerId: provider.providerId,
    providerName: provider.providerName,
    kind: provider.kind,
    family: provider.family,
    status: route.status,
    reason: route.reason,
    ...(provider.generation === undefined ? {} : { generation: provider.generation }),
    scope: route.scope,
  })
}

function unavailableProvider(providerId: string): ResolvedCapabilityProvider {
  return Object.freeze({
    providerId: `unroutable:${providerId}`,
    providerName: message('provider.external.name', '{name}', { name: providerId }),
    kind: 'external-provider',
    family: 'platform',
    status: 'unavailable',
    reason: message('route.provider-scope.unavailable', 'No Host provider can route provider {providerId}.', {
      providerId,
    }),
    scope: frozenScope({ providers: [providerId] }),
  })
}

export class CapabilityAvailabilityRegistry {
  private readonly providers: readonly CordisXCapabilityProviderReport[]

  constructor(providers: readonly CordisXCapabilityProviderReport[]) {
    const ids = new Set<string>()
    for (const provider of providers) {
      if (ids.has(provider.providerId)) throw new Error(`duplicate capability provider ${provider.providerId}`)
      ids.add(provider.providerId)
    }
    this.providers = Object.freeze([...providers])
  }

  providerSnapshot(): readonly CordisXCapabilityProviderReport[] {
    return this.providers
  }

  resolve(capability: CordisXPlatformCapability, scope: CordisXCapabilityScope): ResolvedCapabilityAvailability {
    const routes = this.providers.flatMap(provider =>
      provider.routes
        .filter(item => item.capability === capability)
        .map(item => ({ provider, route: item }))
    )
    const requestedProviders = providerIds(scope)
    if (requestedProviders.length === 0) {
      const projected = routes.map(item => resolvedProvider(item.provider, item.route))
      const routable = projected.filter(item => item.status !== 'unavailable')
      const status: CordisXCapabilityAvailabilityState = routable.some(item => item.status === 'supported')
        ? 'supported'
        : routable.length > 0
        ? 'degraded'
        : 'unavailable'
      return Object.freeze({
        capability,
        status,
        reason: this.summaryReason(status),
        providers: Object.freeze(projected),
      })
    }

    const projected: ResolvedCapabilityProvider[] = []
    const coverage: CordisXCapabilityAvailabilityState[] = []
    for (const providerId of requestedProviders) {
      const matching = routes.filter(item => providerRouteMatches(item.route, providerId))
      if (matching.length === 0) {
        projected.push(unavailableProvider(providerId))
        coverage.push('unavailable')
        continue
      }
      projected.push(...matching.map(item => resolvedProvider(item.provider, item.route)))
      coverage.push(
        matching.some(item => item.route.status === 'supported')
          ? 'supported'
          : matching.some(item => item.route.status === 'degraded')
          ? 'degraded'
          : 'unavailable',
      )
    }
    const status: CordisXCapabilityAvailabilityState = coverage.every(item => item === 'supported')
      ? 'supported'
      : coverage.some(item => item !== 'unavailable')
      ? 'degraded'
      : 'unavailable'
    return Object.freeze({
      capability,
      status,
      reason: this.summaryReason(status),
      providers: Object.freeze(projected),
    })
  }

  unavailableRequired(
    capabilities: readonly {
      readonly name: CordisXPlatformCapability
      readonly required: boolean
      readonly scope: CordisXCapabilityScope
    }[],
  ): readonly CordisXPlatformCapability[] {
    return Object.freeze(
      capabilities
        .filter(item => item.required && this.resolve(item.name, item.scope).status === 'unavailable')
        .map(item => item.name),
    )
  }

  private summaryReason(status: CordisXCapabilityAvailabilityState): CordisXLocalizedText {
    if (status === 'supported') {
      return message('availability.supported', 'At least one Host provider can route this capability.')
    }
    if (status === 'degraded') {
      return message('availability.degraded', 'Only part of the declared provider scope is currently routable.')
    }
    return message('availability.unavailable', 'No Host provider can route this capability for the declared scope.')
  }
}

const EN_MESSAGES = {
  'availability.supported': 'Available',
  'availability.degraded': 'Partially available for the declared scope',
  'availability.unavailable': 'No Host provider can route the declared scope',
  'provider.current-connection.name': 'Desktop current connection',
  'provider.current-connection.supported': 'The Desktop current connection can route supported capabilities.',
  'provider.current-connection.unavailable': 'The Desktop current connection is unavailable.',
  'route.current-connection.supported': 'The current connection can route this capability.',
  'route.current-connection.unavailable': 'The current connection cannot route this capability.',
  'provider.agent-events.name': 'Host Agent event ledger',
  'provider.agent-events.supported': 'The Host-local Agent event ledger is available.',
  'route.agent-events.supported': 'The Host-local ledger can serve Agent event queries.',
  'provider.agent-history.name': 'Host Agent history',
  'provider.agent-history.supported': 'Host Agent history is available.',
  'provider.agent-history.unavailable': 'Host Agent history is unavailable.',
  'provider.agent-input.name': 'Desktop Agent input',
  'provider.agent-input.supported': 'The current Agent connection can route Agent input capabilities.',
  'provider.agent-input.unavailable': 'Agent input requires a current connection that is not available.',
  'provider.configuration.name': 'Host configuration',
  'provider.configuration.supported': 'Validated configuration and the Host writer are available.',
  'provider.configuration.degraded': 'Configuration descriptors are available, but the Host writer is unavailable.',
  'provider.console.name': 'Host plugin console',
  'provider.console.unavailable': 'The Console protocol is defined, but this Host has not published a console service.',
  'provider.package-lifecycle.name': 'Host package lifecycle',
  'provider.package-lifecycle.supported': 'The launcher package lifecycle and generation service is available.',
  'provider.package-lifecycle.unavailable':
    'Package lifecycle contracts are defined, but this Host has not published an activation service.',
  'provider.external.name': '{name}',
  'provider.external.supported': 'External provider {name} is ready.',
  'provider.external.unavailable': 'External provider {name} is unavailable.',
  'route.provider-scope.unavailable': 'No Host provider can route provider {providerId}.',
}

const ZH_MESSAGES = {
  'availability.supported': '当前可用',
  'availability.degraded': '声明范围内部分可用',
  'availability.unavailable': '没有宿主提供方可路由声明范围',
  'provider.current-connection.name': 'Desktop 当前连接',
  'provider.current-connection.supported': 'Desktop 当前连接可路由其已支持的能力。',
  'provider.current-connection.unavailable': 'Desktop 当前连接暂不可用。',
  'route.current-connection.supported': '当前连接可路由此能力。',
  'route.current-connection.unavailable': '当前连接无法路由此能力。',
  'provider.agent-events.name': '宿主 Agent 事件账本',
  'provider.agent-events.supported': '宿主本地 Agent 事件账本当前可用。',
  'route.agent-events.supported': '宿主本地账本可处理 Agent 事件查询。',
  'provider.agent-history.name': '宿主 Agent 历史',
  'provider.agent-history.supported': '宿主 Agent 历史当前可用。',
  'provider.agent-history.unavailable': '宿主 Agent 历史暂不可用。',
  'provider.agent-input.name': 'Desktop Agent 输入',
  'provider.agent-input.supported': '当前 Agent 连接可路由 Agent 输入能力。',
  'provider.agent-input.unavailable': 'Agent 输入需要当前尚不可用的 Desktop 连接。',
  'provider.configuration.name': '宿主配置',
  'provider.configuration.supported': '校验后的配置与宿主写入器当前可用。',
  'provider.configuration.degraded': '配置描述可用，但宿主写入器暂不可用。',
  'provider.console.name': '宿主插件 Console',
  'provider.console.unavailable': 'Console 协议已定义，但当前宿主尚未发布 Console 服务。',
  'provider.package-lifecycle.name': '宿主包生命周期',
  'provider.package-lifecycle.supported': '启动器插件包生命周期与 generation 服务当前可用。',
  'provider.package-lifecycle.unavailable': '包生命周期契约已定义，但当前宿主尚未发布激活服务。',
  'provider.external.name': '{name}',
  'provider.external.supported': '外部 Provider {name} 当前可用。',
  'provider.external.unavailable': '外部 Provider {name} 暂不可用。',
  'route.provider-scope.unavailable': '没有宿主提供方可路由 provider {providerId}。',
}

export const CORDISX_CAPABILITY_AVAILABILITY_LOCALE_CATALOGS: readonly CordisXLocaleCatalog[] = Object.freeze([
  Object.freeze({
    namespace: AVAILABILITY_NAMESPACE,
    locale: 'en',
    default: true,
    messages: Object.freeze(EN_MESSAGES),
  }),
  Object.freeze({ namespace: AVAILABILITY_NAMESPACE, locale: 'zh-CN', messages: Object.freeze(ZH_MESSAGES) }),
])
