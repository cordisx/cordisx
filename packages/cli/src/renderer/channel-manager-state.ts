import type { RegisteredServiceCapabilityOwner } from '../service-capability-ownership.js'
import type { ChannelManagerRuntimeProjection } from '../launcher/channel-manager-api.js'
import type { ChannelManagerServiceConfigApi, ChannelManagerServiceInput } from './channel-manager.js'
import type { ChannelCredentialWorkflow } from './channel-credential-workflow.js'
import type { ChannelPolicyWorkflow } from './channel-policy-workflow.js'
import type { ChannelExecutionWorkflow } from './channel-execution-workflow.js'
import type { ChannelConversationWorkflow } from './channel-conversation-workflow.js'
import type { ChannelSettingsWorkflow } from './channel-settings-workflow.js'
import type { PermissionBroker } from './platform.js'
import type { PublicChannelManagerController } from './channel-manager-public.js'
import {
  type ChannelManagerConnectionProjection,
  type ChannelManagerProjectionV1,
  normalizeProjection,
  withRuntimeProjection,
} from './channel-manager-projection.js'

export interface ChannelManagerState {
  projection: ChannelManagerProjectionV1
  readonly credentialRequest?: ChannelManagerServiceInput['credentialRequest']
  readonly broker?: PermissionBroker
  credentials?: ChannelCredentialWorkflow
  policy?: ChannelPolicyWorkflow
  execution?: ChannelExecutionWorkflow
  conversations?: ChannelConversationWorkflow
  settings: ChannelSettingsWorkflow
  readonly lifetime: AbortController
  readonly serviceConfig?: ChannelManagerServiceConfigApi
  readonly createCredentialedConnection?: ChannelManagerServiceInput['createCredentialedConnection']
  readonly actions?: ChannelManagerServiceInput['actions']
  readonly localConnections: ChannelManagerConnectionProjection[]
  readonly listeners: Set<() => void>
  runtimeProjection?: ChannelManagerRuntimeProjection
  cachedProjection: ChannelManagerProjectionV1 | undefined
  publicController?: PublicChannelManagerController
  refreshSequence: number
  disposed: boolean
  readonly isCurrent: () => boolean
}
interface OwnedServiceFacade {
  readonly owner: RegisteredServiceCapabilityOwner
  readonly lifetime: AbortSignal
}
const projections = new WeakMap<object, ChannelManagerState>()
const ownedFacades = new WeakMap<object, OwnedServiceFacade>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

export function registerChannelManagerState(service: object, state: ChannelManagerState): void {
  projections.set(service, state)
}
export function registerChannelServiceFacade(
  service: object,
  owner: RegisteredServiceCapabilityOwner,
  lifetime: AbortSignal,
): void {
  ownedFacades.set(service, { owner, lifetime })
}
export function originalService(service: object): object {
  const seen = new Set<object>()
  let current = service
  while (!seen.has(current)) {
    seen.add(current)
    const original = (current as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
    if (original === undefined || original === current) return current
    current = original
  }
  throw new Error('Invalid Cordis service trace')
}
export function serviceOwnerFor(service: object): OwnedServiceFacade | undefined {
  let current: object | null = originalService(service)
  while (current !== null) {
    const owner = ownedFacades.get(current)
    if (owner !== undefined) return owner
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}
export function stateFor(service: object): ChannelManagerState {
  let candidate: object | null = originalService(service)
  while (candidate !== null) {
    const state = projections.get(candidate)
    if (state !== undefined) return state
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Channel Manager is detached from its Host projection')
}
export function projectionFor(service: object): ChannelManagerProjectionV1 {
  const state = stateFor(service)
  const projection = state.localConnections.length === 0 ? state.projection : normalizeProjection({
    ...state.projection,
    connections: [...state.projection.connections, ...state.localConnections],
  })
  return withRuntimeProjection(projection, state.runtimeProjection)
}
