import type { NativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import type { TerminalProviderRequest, TerminalProviderResult } from '../launcher/terminal-provider.js'
import type { ModelExportRequest } from './model-export-parse.js'
import type { CliModelExportResult } from '../launcher/model-catalog/cli-export.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { RendererConfigOperation, RendererConfigResult } from '../launcher/renderer-config-management.js'
import type { ManagerServiceAuthOperation } from '../launcher/manager-service-auth.js'
import type { ManagerChannelCredentialOperation } from '../launcher/manager-channel-credentials.js'
import { applyManagementPermissionReview } from '../launcher/permission-review-management.js'
import { openPluginManagementService } from '../management/service.js'
import {
  type PluginManagementBridgeHandler,
  type PluginManagementRpcServer,
  startPluginManagementRpcServer,
} from '../launcher/management-rpc.js'
import { processStartIdentity } from './supervisor-state.js'
import { createManagerRendererGatewayAuthenticator } from './manager-renderer-gateway.js'
import { createManagerRendererManagementChannel } from './manager-renderer-management.js'
import { dispatchManagerRendererOperation } from './manager-renderer-rpc.js'
import { type ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ManagerRendererWriteLifetimes } from './manager-renderer-write-lifetimes.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { fenceManagerConsumers } from './manager-consumer-fence.js'
import { fenceAdapterOrigin, type ManagerOriginFence } from './manager-origin-fence.js'
import { coordinateManagerChannelCredentials } from './manager-channel-credential-fence.js'
import { coordinateManagerPermissionReview } from './manager-permission-review-fence.js'
import { createManagerRendererServiceConfigChannel } from './manager-renderer-service-config.js'
import { createManagerRendererChannelControl } from './manager-renderer-channel-control.js'
import { createManagerRendererChannelCredentials } from './manager-renderer-channel-credentials.js'
import { createManagerRendererMarketplaceChannel } from './manager-renderer-marketplace.js'
import { createManagerRendererDesktopPackageConfig } from './manager-renderer-desktop-package-config.js'
import type { DesktopOwnerRendererLifecycle } from './desktop-owner-renderer-lifecycle.js'
import type { DesktopPackageConfigWriteGate } from './desktop-package-config-write.js'
import { coordinateManagerManagedServiceMutations } from './manager-managed-service-mutation.js'
import type { ManagerManagedServiceUIGate } from './manager-managed-service-ui-gate.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { createServiceRendererPermissionChannel } from './service-renderer-permission-channel.js'
import { createServiceRendererLifecycleReview } from './service-renderer-lifecycle-review.js'
import type { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import type { ServiceRendererPermissionConsumerFence } from './service-renderer-permission-handoff.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { createConfiguredChannelOwner } from './configured-channel-owner.js'
import type {
  ManagedServiceClientIdentity,
  ManagedServiceClientReservation,
} from '../launcher/managed-service-client-reservation.js'
import type { OwnerAdapterSessions } from './owner-adapter-sessions.js'
import { dispatchOwnerAdapterRpcOperation } from './owner-adapter-rpc.js'
import { PermissionDecisionJournal } from './permission-decision-journal.js'
import { createServiceRendererPermissionHistory } from './service-renderer-permission-history.js'
import { createServiceRendererPermissionOnce } from './service-renderer-permission-once.js'

export interface ProductionPluginManagementComposition {
  readonly handler: PluginManagementBridgeHandler
  /** Owner-only Manager portion of a wider profile mutation barrier. */
  readonly fenceManagers?: () => Promise<{ isCurrent(): boolean; release(): boolean; fence(): void }>
  readonly fenceAdapterPermissionOrigin?: (rendererId: string) => Promise<ManagerOriginFence>
  readonly lifecycleParticipants?: {
    hasLive(): boolean
    admitted(peer: ManagerRendererCommandPeer): boolean
    reserveWrites(): Promise<{ isCurrent(): boolean; release(): boolean; fence(): void }>
    matchesDesktop?(participants: ServiceRendererParticipants, lifecycle: DesktopOwnerRendererLifecycle): boolean
  }
  close(): Promise<void>
}
export async function openProductionPluginManagementComposition(input: {
  readonly mode?: 'service'
  readonly configPath: string
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly managerConsoleOrigins?: readonly string[]
  readonly token: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly modelExport?: (request: ModelExportRequest) => Promise<CliModelExportResult>
  readonly terminalProvider?: (request: TerminalProviderRequest) => Promise<TerminalProviderResult>
  /** Owner-only reservation of affected clients during a managed-service logout. */
  readonly reserveServiceClients?: (
    identity: ManagedServiceClientIdentity,
  ) => ManagedServiceClientReservation | undefined
  readonly reserveManagedAccountUI?: (
    current: () => boolean,
  ) => Promise<Awaited<ReturnType<ManagerManagedServiceUIGate['reserve']>>>
  readonly channel?: (operation: string, input: unknown) => Promise<unknown>
  readonly codex?: (operation: string, input: unknown, metadata?: unknown) => Promise<unknown>
  readonly rendererConfiguration?: (operation: RendererConfigOperation) => Promise<RendererConfigResult>
  readonly managerServiceAuth?: (operation: ManagerServiceAuthOperation) => Promise<unknown>
  readonly managerChannelCredentials?: (operation: ManagerChannelCredentialOperation) => Promise<unknown>
  /** Owner-only adapter sessions; never available through a renderer binding. */
  readonly ownerAdapterSessions?: OwnerAdapterSessions
  /** Owner-created participant; never supplied by the browser or plugin. */
  readonly rendererParticipant?: ConstructorParameters<typeof ManagerRendererSessions>[0]['participant']
  /** Must be the registry that issued rendererParticipant, never page supplied. */
  readonly rendererParticipants?: ServiceRendererParticipants
  readonly rendererLifecycle?: ServiceRendererLifecycle
  /** Private owner/sidecar bootstrap; it must not be exposed as a browser binding. */
  readonly rendererBootstrap?: ManagerRendererChannel
  /** Owner-issued per-renderer durable document bridge. */
  readonly rendererDocuments?: ManagerRendererChannel
  readonly rendererModels?: ManagerRendererChannel
  readonly rendererManagementAuthority?: Pick<ServiceRendererBootstrap, 'managementRequest' | 'allowsManagementWrite'>
  /** Owner resource retirement must finish before a renderer revocation is acknowledged. */
  readonly rendererRetirement?: (rendererId: string) => Promise<boolean>
  readonly rendererWriteLifetimes?: ManagerRendererWriteLifetimes
  readonly rendererReadLifetimes?: ManagerRendererReadLifetimes
  /** Owner-issued, per-renderer managed-service UI bridge. */
  readonly rendererManagedServiceUI?: ManagerRendererChannel
  readonly rendererModelServices?: ManagerRendererChannel
  readonly rendererNativeCatalog?: ManagerRendererChannel
  /** Optional owner-created read-only Channel bridge; never enabled implicitly. */
  readonly rendererReadonlyChannel?: ManagerRendererChannel
  /** The Desktop owner supplies the same private participant and lifecycle registry. */
  readonly rendererDesktopLifecycle?: {
    readonly participant: NonNullable<ConstructorParameters<typeof ManagerRendererSessions>[0]['participant']>
    readonly participants: ServiceRendererParticipants
    readonly lifecycle: DesktopOwnerRendererLifecycle
  }
  readonly rendererDesktopPackageConfig?: {
    readonly participant: NonNullable<ConstructorParameters<typeof ManagerRendererSessions>[0]['participant']>
    readonly participants: ServiceRendererParticipants
    readonly lifecycle: DesktopOwnerRendererLifecycle
    readonly bootstrap: ServiceRendererBootstrap
    readonly writes: DesktopPackageConfigWriteGate
  }
  readonly rendererConfiguredChannelService?: {
    readonly bootstrap: ServiceRendererBootstrap
    readonly plugin: CordisXConfigPlugin
    readonly service: LocalChannelService
    readonly authority: NonNullable<ReturnType<typeof createConfiguredChannelOwner>>
  }
  /** Owner-only opt-in; requires a fence for policy consumers outside the Manager cohort. */
  readonly rendererPermissionPolicy?: {
    readonly bootstrap: ServiceRendererBootstrap
    readonly proof: ManagerPermissionProofAuthority
    readonly reserveAdditionalPeers?: () => Promise<import('./manager-origin-fence.js').ManagerOriginAdditionalFence>
    readonly onFailure?: (phase: string, error: unknown) => void
    readonly reserveOtherConsumers: (
      origin: ManagerOriginFence,
      evidence: import('./service-renderer-permission-access.js').ServiceRendererPermissionEvidence,
    ) => Promise<ServiceRendererPermissionConsumerFence>
  }
  readonly processStartedAt?: string
}): Promise<ProductionPluginManagementComposition> {
  if (input.ownerAdapterSessions && input.mode !== 'service') throw new Error('adapter-owner-scope-invalid')
  if (
    input.reserveManagedAccountUI && (input.mode !== 'service' || !input.rendererManagedServiceUI
      || !input.rendererParticipants || !input.rendererLifecycle || !input.reserveServiceClients)
  ) throw new Error('manager-consumer-fence-scope-invalid')
  if (input.rendererParticipants && input.rendererParticipant !== input.rendererParticipants.participant) {
    throw new Error('manager-consumer-fence-scope-invalid')
  }
  if (
    input.rendererDocuments && (input.mode !== 'service' || !input.rendererParticipants || !input.rendererBootstrap)
  ) {
    throw new Error('manager-consumer-fence-scope-invalid')
  }
  if (
    input.rendererModels && (input.mode !== 'service' || !input.rendererDocuments || !input.rendererParticipants
      || !input.rendererBootstrap || !input.rendererPermissionPolicy)
  ) throw new Error('manager-consumer-fence-scope-invalid')
  if (input.rendererLifecycle && !input.rendererParticipants?.isBoundTo(input.rendererLifecycle)) {
    throw new Error('manager-consumer-fence-scope-invalid')
  }
  if (
    input.rendererDesktopLifecycle && (input.mode === 'service' || input.rendererParticipants || input.rendererLifecycle
      || input.rendererParticipant !== input.rendererDesktopLifecycle.participant
      || !input.rendererDesktopLifecycle.participants.isBoundTo(input.rendererDesktopLifecycle.lifecycle))
  ) throw new Error('manager-consumer-fence-scope-invalid')
  if (
    input.rendererConfiguredChannelService && (
      input.mode !== 'service' || !input.rendererParticipants || !input.rendererLifecycle
      || !input.rendererReadonlyChannel
    )
  ) throw new Error('manager-consumer-fence-scope-invalid')
  if (
    input.rendererPermissionPolicy && (
      input.mode !== 'service' || !input.rendererParticipants || !input.rendererLifecycle
      || !input.rendererBootstrap
      || input.rendererPermissionPolicy.bootstrap !== input.rendererManagementAuthority
        && input.rendererPermissionPolicy.bootstrap !== input.rendererConfiguredChannelService?.bootstrap
      || !input.rendererPermissionPolicy.bootstrap.usesPermissionProof(input.rendererPermissionPolicy.proof)
    )
  ) throw new Error('manager-consumer-fence-scope-invalid')
  if (
    input.rendererDesktopPackageConfig && (input.mode === 'service'
      || input.rendererParticipant !== input.rendererDesktopPackageConfig.participant
      || !input.rendererDesktopPackageConfig.participants.isBoundTo(input.rendererDesktopPackageConfig.lifecycle)
      || input.rendererDesktopLifecycle && (
          input.rendererDesktopLifecycle.participant !== input.rendererDesktopPackageConfig.participant
          || input.rendererDesktopLifecycle.participants !== input.rendererDesktopPackageConfig.participants
          || input.rendererDesktopLifecycle.lifecycle !== input.rendererDesktopPackageConfig.lifecycle
        ))
  ) throw new Error('manager-consumer-fence-scope-invalid')
  const service = await openPluginManagementService({
    configPath: input.configPath,
    homeDir: input.homeDir,
    appId: input.appId,
    profileId: input.profileId,
    lifecycle: {
      coordinator: input.coordinator,
      runtimeGeneration: input.runtimeGeneration,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    },
  })
  let closed = false
  const rendererMarketplace = input.rendererParticipants === undefined
    ? undefined
    : createManagerRendererMarketplaceChannel({
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      service,
      isCurrent: context => !closed && input.rendererParticipants!.peer(context.rendererId) !== undefined,
    })
  let rendererSessions!: ManagerRendererSessions
  const rendererDesktopPackageConfig = input.rendererDesktopPackageConfig === undefined
    ? undefined
    : createManagerRendererDesktopPackageConfig({
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      ...input.rendererDesktopPackageConfig,
      sessions: () => rendererSessions,
    })
  const rendererManagedServiceUI = input.rendererManagedServiceUI === undefined
    ? undefined
    : coordinateManagerManagedServiceMutations({
      channel: input.rendererManagedServiceUI,
      sessions: () => rendererSessions,
      ...(input.mode === 'service' && input.rendererParticipants && input.rendererLifecycle
        ? { participants: input.rendererParticipants, lifecycle: input.rendererLifecycle }
        : {}),
      ...(input.mode === 'service' && input.reserveServiceClients
        ? { reserveServiceClients: input.reserveServiceClients }
        : {}),
      ...(input.mode === 'service' && input.reserveManagedAccountUI
        ? { reserveAccountUI: input.reserveManagedAccountUI }
        : {}),
    })
  const rendererServiceConfig = input.rendererConfiguredChannelService
    ? createManagerRendererServiceConfigChannel({
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      configPath: input.configPath,
      ...input.rendererConfiguredChannelService,
      participants: input.rendererParticipants!,
      lifecycle: input.rendererLifecycle!,
      sessions: () => rendererSessions,
    })
    : undefined
  const rendererChannelActions = input.rendererConfiguredChannelService && input.rendererReadonlyChannel
    ? createManagerRendererChannelControl({
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      configPath: input.configPath,
      readOnly: input.rendererReadonlyChannel,
      allowReconnect: true,
      ...input.rendererConfiguredChannelService,
      participants: input.rendererParticipants!,
      lifecycle: input.rendererLifecycle!,
      sessions: () => rendererSessions,
    })
    : input.rendererReadonlyChannel
  const credentialHandler = input.managerChannelCredentials
  const rendererCredentials = input.rendererConfiguredChannelService && credentialHandler
    ? createManagerRendererChannelCredentials({
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      configPath: input.configPath,
      ...input.rendererConfiguredChannelService,
      participants: input.rendererParticipants!,
      lifecycle: input.rendererLifecycle!,
      sessions: () => rendererSessions,
      handle: credentialHandler,
    })
    : undefined
  const decisionJournal = input.rendererPermissionPolicy === undefined
    ? undefined
    : new PermissionDecisionJournal({ homeDir: input.homeDir, profileId: input.profileId })
  const rendererPermission = input.rendererPermissionPolicy === undefined
    ? undefined
    : createServiceRendererPermissionChannel({
      profileId: input.profileId,
      configPath: input.configPath,
      ...input.rendererPermissionPolicy,
      decisionJournal: decisionJournal!,
      participants: input.rendererParticipants!,
      lifecycle: input.rendererLifecycle!,
      sessions: () => rendererSessions,
    })
  const rendererPermissionHistory = input.rendererPermissionPolicy === undefined || decisionJournal === undefined
    ? undefined
    : createServiceRendererPermissionHistory({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      bootstrap: input.rendererPermissionPolicy.bootstrap,
      journal: decisionJournal,
    })
  const rendererPermissionOnce = input.rendererPermissionPolicy === undefined || decisionJournal === undefined
    ? undefined
    : createServiceRendererPermissionOnce({
      homeDir: input.homeDir,
      profileId: input.profileId,
      bootstrap: input.rendererPermissionPolicy.bootstrap,
      proof: input.rendererPermissionPolicy.proof,
      journal: decisionJournal,
    })
  const rendererLifecycleReview = input.mode !== 'service' || input.rendererPermissionPolicy === undefined
      || decisionJournal === undefined
    ? undefined
    : createServiceRendererLifecycleReview({
      homeDir: input.homeDir,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      coordinator: input.coordinator,
      journal: decisionJournal,
      proof: input.rendererPermissionPolicy.proof,
      bootstrap: input.rendererPermissionPolicy.bootstrap,
      service,
    })
  rendererSessions = new ManagerRendererSessions({
    profileId: input.profileId,
    ownerGeneration: input.runtimeGeneration,
    ownerCurrent: () => !closed,
    authenticateGateway: createManagerRendererGatewayAuthenticator({
      homeDir: input.homeDir,
      profileId: input.profileId,
      ownerAppId: input.appId,
      ownerGeneration: input.runtimeGeneration,
    }),
    ...(input.rendererRetirement === undefined && rendererCredentials === undefined ? {} : {
      waitForRetirement: async (rendererId: string) => {
        const results = await Promise.all([
          input.rendererRetirement?.(rendererId) ?? Promise.resolve(true),
          rendererCredentials?.waitForRetirement(rendererId) ?? Promise.resolve(true),
        ])
        return results.every(Boolean)
      },
    }),
    ...(input.rendererWriteLifetimes === undefined ? {} : { writeLifetimes: input.rendererWriteLifetimes }),
    ...(input.rendererReadLifetimes === undefined ? {} : { readLifetimes: input.rendererReadLifetimes }),
    channels: new Map([
      [
        'plugin-management',
        createManagerRendererManagementChannel(
          service,
          input.rendererManagementAuthority,
          rendererLifecycleReview,
        ),
      ],
      ...(input.rendererBootstrap === undefined
        ? []
        : [['manager-bootstrap', input.rendererBootstrap] as const]),
      ...(input.rendererDocuments === undefined ? [] : [['owner-document', input.rendererDocuments] as const]),
      ...(input.rendererModels === undefined ? [] : [['platform-models', input.rendererModels] as const]),
      ...(rendererManagedServiceUI === undefined
        ? []
        : [['managed-service-ui', rendererManagedServiceUI] as const]),
      ...(input.rendererModelServices === undefined
        ? []
        : [['model-services', input.rendererModelServices] as const]),
      ...(input.rendererNativeCatalog === undefined
        ? []
        : [['native-catalog', input.rendererNativeCatalog] as const]),
      ...(rendererDesktopPackageConfig === undefined
        ? []
        : [['desktop-package-config', rendererDesktopPackageConfig] as const]),
      ...(rendererChannelActions === undefined
        ? []
        : [['channel-actions', rendererChannelActions] as const]),
      ...(rendererServiceConfig === undefined ? [] : [['service-config', rendererServiceConfig] as const]),
      ...(rendererCredentials === undefined ? [] : [['channel-credentials', rendererCredentials.channel] as const]),
      ...(rendererPermission === undefined ? [] : [['permission-policy', rendererPermission] as const]),
      ...(rendererPermissionOnce === undefined ? [] : [['permission-once', rendererPermissionOnce] as const]),
      ...(rendererPermissionHistory === undefined ? [] : [['permission-history', rendererPermissionHistory] as const]),
      ...(rendererMarketplace === undefined ? [] : [['marketplace', rendererMarketplace] as const]),
    ]),
    ...(input.rendererParticipant === undefined ? {} : { participant: input.rendererParticipant }),
  })
  const managerChannelCredentials = input.managerChannelCredentials === undefined
    ? undefined
    : input.mode === 'service'
    ? coordinateManagerChannelCredentials({
      sessions: rendererSessions,
      ...(input.rendererParticipants === undefined ? {} : { participants: input.rendererParticipants }),
      ...(input.rendererLifecycle === undefined ? {} : { lifecycle: input.rendererLifecycle }),
      handle: input.managerChannelCredentials,
    })
    : input.managerChannelCredentials
  const permissionReview = input.mode === 'service'
    ? coordinateManagerPermissionReview({
      sessions: rendererSessions,
      ...(input.rendererParticipants === undefined ? {} : { participants: input.rendererParticipants }),
      ...(input.rendererLifecycle === undefined ? {} : { lifecycle: input.rendererLifecycle }),
      coordinator: input.coordinator,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
    })
    : async (operation: Parameters<typeof applyManagementPermissionReview>[0]['operation']) =>
      await applyManagementPermissionReview({
        coordinator: input.coordinator,
        profileId: input.profileId,
        generation: input.runtimeGeneration,
        operation,
      })
  let server: PluginManagementRpcServer
  try {
    const processStartedAt = input.processStartedAt ?? await processStartIdentity(process.pid)
    if (processStartedAt === undefined) throw new Error('cannot identify the CordisX management owner process')
    server = await startPluginManagementRpcServer({
      homeDir: input.homeDir,
      appId: input.appId,
      profileId: input.profileId,
      configPath: input.configPath,
      generation: input.runtimeGeneration,
      ...(input.managerConsoleOrigins === undefined ? {} : { managerConsoleOrigins: input.managerConsoleOrigins }),
      processStartedAt,
      ...(input.mode === 'service' ? { sandboxMailbox: true } : {}),
      service,
      managerRenderer: async operation => await dispatchManagerRendererOperation(rendererSessions, operation),
      ...(input.ownerAdapterSessions === undefined ? {} : {
        ownerAdapter: async operation => await dispatchOwnerAdapterRpcOperation(input.ownerAdapterSessions!, operation),
      }),
      permissionReview,
      ...(input.modelExport === undefined ? {} : { modelExport: input.modelExport }),
      ...(input.terminalProvider === undefined ? {} : { terminalProvider: input.terminalProvider }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.codex === undefined ? {} : { codex: input.codex }),
      ...(input.rendererConfiguration === undefined ? {} : { rendererConfiguration: input.rendererConfiguration }),
      ...(input.managerServiceAuth === undefined ? {} : { managerServiceAuth: input.managerServiceAuth }),
      ...(managerChannelCredentials === undefined
        ? {}
        : { managerChannelCredentials }),
    })
  } catch (error) {
    rendererSessions.dispose()
    input.rendererPermissionPolicy?.proof.close()
    service.close()
    throw error
  }
  return {
    handler: {
      token: input.token,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      service,
      ...(input.modelExport === undefined ? {} : { modelExport: input.modelExport }),
    },
    ...(input.rendererPermissionPolicy?.reserveAdditionalPeers === undefined ? {} : {
      fenceAdapterPermissionOrigin: async (rendererId: string) => {
        if (closed) throw new Error('adapter-permission-fence-unavailable')
        return await fenceAdapterOrigin({
          sessions: rendererSessions,
          participants: input.rendererParticipants!,
          lifecycle: input.rendererLifecycle!,
          originRendererId: rendererId,
          reserveAdditionalPeers: input.rendererPermissionPolicy!.reserveAdditionalPeers!,
        })
      },
    }),
    ...(input.rendererParticipants === undefined && input.rendererDesktopLifecycle === undefined ? {} : {
      lifecycleParticipants: {
        hasLive: () => !closed && rendererSessions.hasLiveRenderers(),
        admitted: (peer: ManagerRendererCommandPeer) => !closed && rendererSessions.hasAdmittedPeer(peer),
        matchesDesktop: (participants: ServiceRendererParticipants, lifecycle: DesktopOwnerRendererLifecycle) =>
          !closed && input.rendererDesktopLifecycle?.participants === participants
          && input.rendererDesktopLifecycle.lifecycle === lifecycle,
        reserveWrites: async () => {
          if (closed) throw new Error('manager-lifecycle-fence-unavailable')
          return await rendererSessions.suspendMutationsForLifecycle()
        },
      },
    }),
    ...(input.rendererParticipants === undefined ? {} : {
      fenceManagers: async () => {
        if (closed) throw new Error('manager-consumer-fence-unavailable')
        return await fenceManagerConsumers({
          sessions: rendererSessions,
          participants: input.rendererParticipants!,
          ...(input.rendererLifecycle ? { lifecycle: input.rendererLifecycle } : {}),
        })
      },
    }),
    async close(): Promise<void> {
      if (closed) return
      closed = true
      rendererSessions.dispose()
      input.rendererPermissionPolicy?.proof.close()
      try {
        await server.close()
      } finally {
        service.close()
      }
    },
  }
}

/** Resolve the live composition at request time, including late bootstrap completion. */
export function nativeCatalogExport(current: () => NativeSubmissionComposition | undefined) {
  return async (request: ModelExportRequest): Promise<CliModelExportResult> => {
    const composition = current()
    if (!composition?.modelExport) throw new Error('Model export catalog unavailable in this runtime')
    return composition.modelExport(request)
  }
}

export function nativeTerminalProvider(current: () => NativeSubmissionComposition | undefined) {
  return async (request: TerminalProviderRequest): Promise<TerminalProviderResult> => {
    const composition = current()
    if (!composition?.terminalProvider) throw new Error('Terminal provider unavailable in this runtime')
    return composition.terminalProvider(request)
  }
}

/** Late native bootstrap and replacement are resolved for every command, never cached as availability. */
export function nativeCodexOperations(current: () => NativeSubmissionComposition | undefined) {
  return async (operation: string, input: unknown, metadata?: unknown): Promise<unknown> =>
    await current()?.codex?.(operation, input, metadata)
      ?? { status: 'unavailable', code: 'CODEX_RUNTIME_UNAVAILABLE' }
}
