import type {
  StartupActionAvailabilityV1,
  StartupCapabilityDeclarationV1,
  StartupProjectionV1,
} from '@cordisx/protocol/startup/v1'
import type { ManagedServiceProjectionV1 } from '@cordisx/protocol/managed-service-runtime/v1'

export interface StartupCapabilityEvidence {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly hostGeneration: string
  readonly declaration: StartupCapabilityDeclarationV1
  readonly serviceGeneration?: string
  readonly service?: ManagedServiceProjectionV1
  readonly adopted: boolean
  readonly preparing: boolean
  readonly prepared: boolean
  readonly failed: boolean
  readonly revoked: boolean
  readonly canAuthenticate: boolean
  readonly catalog: StartupProjectionV1['catalog']
  readonly published: boolean
  readonly milestones: ReadonlyMap<
    string,
    { readonly sequence: number; readonly state: 'pending' | 'satisfied' | 'failed' }
  >
}

export const unavailable = (
  reason: Extract<StartupActionAvailabilityV1, { available: false }>['reason'],
): StartupActionAvailabilityV1 => ({ available: false, reason })
const available: StartupActionAvailabilityV1 = Object.freeze({ available: true })

export function projectStartupCapability(
  evidence: StartupCapabilityEvidence,
  dependencyReady: boolean,
): StartupProjectionV1 {
  const { declaration, service } = evidence
  const provider = declaration.kind === 'provider'
  const authentication = service === undefined
    ? 'unknown'
    : service.authentication.state === 'not-required'
    ? 'not-required'
    : service.authentication.state === 'configured'
    ? 'authenticated'
    : 'missing'
  const authenticated = authentication === 'not-required' || authentication === 'authenticated'
  const milestones = declaration.milestones.map(milestoneId => ({
    milestoneId,
    state: evidence.milestones.get(milestoneId)?.state ?? 'pending' as const,
  }))
  const emptyCatalog = provider && evidence.catalog.state === 'known' && evidence.catalog.modelIds.length === 0
  const failure = evidence.failed || service?.state === 'failed' || evidence.catalog.state === 'failed'
    || milestones.some(item => item.state === 'failed')
  const revoked = evidence.revoked || service?.state === 'disposed'
  const missingMilestone = declaration.success.allOf.some(condition =>
    condition.kind === 'milestone' && evidence.milestones.get(condition.milestoneId)?.state !== 'satisfied'
  )
  const catalogKnown = !provider || evidence.catalog.state === 'known'
  const serviceReady = service?.state === 'ready' && service.health === 'ready'
  let execute: StartupActionAvailabilityV1 = available
  if (revoked) execute = unavailable('revoked')
  else if (emptyCatalog) execute = unavailable('catalog-empty')
  else if (failure) execute = unavailable('failed')
  else if (service !== undefined && !authenticated) execute = unavailable('authentication-required')
  else if (!evidence.adopted || !evidence.prepared || !serviceReady) {
    execute = unavailable(evidence.preparing ? 'preparing' : 'not-prepared')
  } else if (!dependencyReady) execute = unavailable('dependency-not-ready')
  else if (missingMilestone) execute = unavailable('milestone-pending')
  else if (!catalogKnown) execute = unavailable('catalog-pending')
  else if (provider && evidence.catalog.state === 'known' && evidence.catalog.modelIds.length === 0) {
    execute = unavailable('catalog-empty')
  } else if (provider && !evidence.published) execute = unavailable('provider-unpublished')
  const state = revoked ? 'revoked' : failure || emptyCatalog
    ? 'failed'
    : service !== undefined && !authenticated
    ? 'auth-required'
    : provider && serviceReady && !catalogKnown
    ? 'catalog-pending'
    : execute.available
    ? 'ready'
    : !evidence.preparing && service === undefined
    ? 'declared'
    : 'preparing'
  return {
    identity: {
      pluginId: evidence.pluginId,
      capabilityId: declaration.id,
      serviceId: declaration.serviceId,
      providerId: provider ? declaration.providerId : null,
    },
    generation: {
      host: evidence.hostGeneration,
      plugin: evidence.pluginGeneration,
      service: service?.binding.serviceGeneration ?? evidence.serviceGeneration ?? null,
    },
    state,
    service: service?.state ?? 'unknown',
    process: service === undefined ? 'unknown' : service.state === 'ready'
      ? 'running'
      : service.state === 'preparing'
      ? 'starting'
      : service.state === 'failed'
      ? 'failed'
      : service.state === 'disposed'
      ? 'stopped'
      : 'not-started',
    health: service?.health ?? 'unknown',
    authentication,
    catalog: evidence.catalog,
    provider: !provider ? 'not-applicable' : revoked ? 'revoked' : evidence.published ? 'published' : 'unpublished',
    milestones,
    actions: {
      execute,
      authenticate: revoked
        ? unavailable('revoked')
        : !evidence.canAuthenticate
        ? unavailable('unsupported')
        : available,
      retry: revoked ? unavailable('revoked') : service === undefined
        ? unavailable('binding-unavailable')
        : evidence.preparing
        ? unavailable('preparing')
        : available,
    },
  }
}
