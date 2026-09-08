import { ControlledAgentTurns } from './controlled-agent-turns.js'
import type { AgentLoopControlledTurnV1, AgentLoopControlV1 } from '@cordisx/protocol/agent-loop-control/v1'
import type { ChannelTaskDispatchResult } from '@cordisx/channel-runtime'
import { randomUUID } from 'node:crypto'
import type { CordisXExternalProviderAvailabilityStatus } from '../capability-availability-contracts.js'
import type {
  CordisXModelPage,
  CordisXModelsListInput,
  CordisXPlatformAdapterStatus,
  CordisXPlatformCapability,
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXSessionPage,
  CordisXSessionProjection,
  CordisXSessionSummary,
  CordisXTaskControlInput,
  CordisXTaskControlOutcome,
  CordisXTaskCreateInput,
  CordisXTaskReadInput,
  CordisXTasksListInput,
  CordisXTurnControlInput,
  CordisXTurnControlOutcome,
  CordisXTurnStart,
  CordisXTurnSubmitInput,
} from '../contracts.js'
import {
  AgentLoopAuthority,
  type AgentLoopAuthorityScope,
  type AgentLoopProviderFence,
  type AgentLoopTaskLocator,
} from '../launcher/agent-loop-authority.js'
import type { CordisXExactProviderAdapter, CordisXPlatformAdapter } from '../renderer/platform.js'
import { withExactProviderGeneration } from './fleet-exact-provider.js'
import { ProviderAdapterRegistry } from '../renderer/provider-registry.js'
import { LocalCodexProviderAdapter } from './local-codex-adapter.js'
import { type CodexAppServerOptions, type CodexAppServerRpc, startLocalCodexAppServer } from './codex-app-server.js'
import type {
  CodexProviderConfig,
  LocalCodexProviderConfig,
  ProviderConnection,
  ProviderLifecycleSignal,
} from './contracts.js'
import { type AgentLoopInFlight, runFleetAgentLoopTransaction } from './fleet-agent-loop-transaction.js'
import { CURRENT_CONNECTION_UNAVAILABLE, FLEET_CAPABILITIES } from './fleet-capabilities.js'
import {
  appendFleetLifecycle,
  type ChannelTaskLifecycleEvent,
  type ChannelTaskLifecycleRange,
  lifecycleKey,
} from './fleet-lifecycle.js'
import { type ProviderFleetPublication, publishProviderConnections } from './fleet-publication.js'
import { FleetTaskPagination } from './fleet-pagination.js'
import { copy, failure, registryFailure } from './fleet-results.js'
import { selectFleetProviders } from './fleet-provider-selection.js'
import { fleetReconfigurationTransaction } from './fleet-reconfiguration-transaction.js'
export type { ChannelTaskLifecycleEvent, ChannelTaskLifecycleRange } from './fleet-lifecycle.js'

export interface ProviderFleetOptions {
  readonly now?: () => number
  readonly startServer?: (config: CodexProviderConfig, options?: CodexAppServerOptions) => Promise<CodexAppServerRpc>
  readonly appServer?: CodexAppServerOptions
  readonly agentLoopAuthority?: AgentLoopAuthority
}

/** Host-owned multi-provider router. Renderer calls never receive adapters, raw cursors, or child handles. */
export class ProviderFleet implements CordisXPlatformAdapter {
  private registry = new ProviderAdapterRegistry<ProviderConnection>()
  private failures = new Map<string, CordisXPlatformDiagnostic>()
  private names = new Map<string, string>()
  private readonly pagination: FleetTaskPagination
  private readonly now: () => number
  private readonly startServer: NonNullable<ProviderFleetOptions['startServer']>
  private readonly appServer: CodexAppServerOptions | undefined
  private readonly agentLoopAuthority: AgentLoopAuthority | undefined
  private readonly lifecycle = new Map<string, ChannelTaskLifecycleEvent[]>()
  private readonly lifecycleListeners = new Set<(event: ChannelTaskLifecycleEvent) => void>()
  private readonly operationResults = new Map<string, ChannelTaskDispatchResult>()
  private readonly agentLoopInFlight = new Map<string, AgentLoopInFlight>()
  private lifecycleAuthorityQueue: Promise<void> = Promise.resolve()
  private lifecycleDisposers = new Map<string, () => void>()
  private readonly controlledTurns = new ControlledAgentTurns({
    resolve: (scope, binding) =>
      this.resolveAgentLoopBinding({
        scope,
        task: binding.task,
        binding: binding.binding,
        definition: binding.definition,
      }),
    submit: (scope, input) => this.submitControlledTurn(scope, input),
    stored: (scope, id) => this.agentLoopAuthority?.committedResult(scope, id),
    save: async (scope, id, state) => {
      if (this.agentLoopAuthority === undefined) throw new Error('authority unavailable')
      await this.agentLoopAuthority.setControlledTurnState(scope, id, state)
    },
    terminal: (locator, turn) => {
      const event = this.readLifecycle({ providerId: locator.providerId, remoteSessionId: locator.remoteSessionId }, -1)
        .events
        .find(event =>
          event.providerGeneration === locator.providerGeneration && event.turnId === turn
          && (event.type === 'turn.completed' || event.type === 'turn.failed')
        )
      return event === undefined
        ? undefined
        : {
          state: event.type === 'turn.completed' ? 'completed' as const : 'failed' as const,
          observedAt: Date.parse(event.observedAt),
        }
    },
    interrupt: async (locator, turn) => {
      const result = await this.withProvider(
        locator.providerId,
        adapter =>
          adapter.controlTurn({
            action: 'interrupt',
            session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
            turnId: turn,
          }),
        locator.providerGeneration,
      )
      return result.ok
    },
  })
  private closed = false

  private constructor(options: ProviderFleetOptions) {
    this.now = options.now ?? Date.now
    this.pagination = new FleetTaskPagination(
      this.now,
      () => this.registry,
      requested => this.providers(requested),
      (providerId, operation, generation) => this.withProvider(providerId, operation, generation),
    )
    this.startServer = options.startServer ?? (async (config, serverOptions) => {
      if (config.kind !== 'local-codex') throw new Error('External providers require a plugin-owned service adapter')
      return await startLocalCodexAppServer(config, serverOptions)
    })
    this.appServer = options.appServer
    this.agentLoopAuthority = options.agentLoopAuthority
  }

  static async create(
    configs: readonly CodexProviderConfig[],
    options: ProviderFleetOptions = {},
  ): Promise<ProviderFleet> {
    const fleet = new ProviderFleet(options)
    const start = fleet.startServer
    const sourceRegistry = fleet.registry
    await Promise.all(
      configs.filter((config): config is LocalCodexProviderConfig => (
        config.enabled && config.kind === 'local-codex'
      )).map(async config => {
        fleet.names.set(config.id, config.displayName)
        try {
          const server = await start(config, options.appServer)
          const adapter = new LocalCodexProviderAdapter(config, server)
          fleet.registry.register({
            providerId: config.id,
            generation: adapter.generation,
            adapter,
            dispose: async () => await adapter.close(),
          })
          const disposeLifecycle = adapter.subscribeLifecycle?.(event =>
            fleet.observeLifecycle(sourceRegistry, adapter.generation, event)
          )
          if (disposeLifecycle !== undefined) fleet.lifecycleDisposers.set(config.id, disposeLifecycle)
        } catch {
          fleet.failures.set(config.id, {
            code: 'adapter-unavailable',
            message: `${
              config.kind === 'local-codex' ? 'Local Codex' : 'External provider'
            } ${config.id} is unavailable`,
            retryable: true,
          })
        }
      }),
    )
    return fleet
  }

  status(): CordisXPlatformAdapterStatus {
    const active = this.registry.snapshots().filter(item => item.state === 'active')
    return {
      hostId: 'cordisx-provider-fleet',
      hostName: 'CordisX Provider Fleet',
      mode: active.length > 0 ? 'read-write' : 'unavailable',
      supportedCapabilities: active.length > 0 ? FLEET_CAPABILITIES : [],
      diagnostics: [CURRENT_CONNECTION_UNAVAILABLE, ...this.failures.values()],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  providerStatuses(): readonly CordisXExternalProviderAvailabilityStatus[] {
    const generations = new Map(
      this.registry.snapshots().filter(item => item.state === 'active').map(item => [item.providerId, item.generation]),
    )
    return [...this.names].map(([providerId, displayName]) => {
      const generation = generations.get(providerId)
      return {
        providerId,
        displayName,
        ...(generation === undefined ? {} : { generation }),
        state: generation === undefined ? 'unavailable' as const : 'ready' as const,
      }
    }).sort((left, right) => left.providerId.localeCompare(right.providerId))
  }

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    const providers = this.providers(input.providerIds)
    if (!providers.ok) return providers
    const pages = await Promise.all(
      providers.value.map(async providerId =>
        await this.withProvider(providerId, async adapter => await adapter.listModels())
      ),
    )
    const failed = pages.find(page => !page.ok)
    if (failed !== undefined && !failed.ok) return failed
    const models = pages.flatMap(page => page.ok ? page.value : []).sort((left, right) => {
      return `${left.label}\0${left.ref.providerId}\0${left.ref.modelId}`.localeCompare(
        `${right.label}\0${right.ref.providerId}\0${right.ref.modelId}`,
      )
    })
    return {
      ok: true,
      value: { contract: 'cordisx.platform-model-page/v1', schemaVersion: 1, providerIds: providers.value, models },
    }
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    return await this.pagination.listTasks(input)
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    return await this.withSession(input.session, async adapter => await adapter.readSession(input.session))
  }

  async createTask(
    input: Omit<CordisXTaskCreateInput, 'initialMessage'>,
  ): Promise<CordisXPlatformResult<CordisXSessionSummary>> {
    return await this.withProvider(input.model.providerId, async adapter => await adapter.createSession(input))
  }

  /** Host-private AgentLoop create primitive with already-resolved prompt data. */
  async createAgentLoopTask(input: {
    readonly model: CordisXTaskCreateInput['model']
    readonly cwd: string
    readonly developerInstructions?: string
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
    readonly approvalPolicy?: 'never' | 'on-request'
  }): Promise<CordisXPlatformResult<CordisXSessionSummary>> {
    return await this.withProvider(input.model.providerId, async adapter => await adapter.createSession(input))
  }

  async createAgentLoopV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly model: CordisXTaskCreateInput['model']
    readonly cwd: string
    readonly workspaceCategory?: 'game'
    readonly developerInstructions?: string
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh'
  }): Promise<unknown> {
    const generation = this.generationFor(input.model.providerId)
    if (generation === 'retired') return { status: 'unavailable', code: 'host-unavailable' }
    const provider = { providerId: input.model.providerId, providerGeneration: generation }
    return await this.durableAgentLoop(
      input.workspaceCategory === 'game'
        ? { ...input, command: { ...(input.command as Record<string, unknown>), hostWorkspaceCategory: 'game' } }
        : input,
      provider,
      async commandDigest => {
        const created = await this.withProvider(input.model.providerId, async adapter =>
          await adapter.createSession({
            model: input.model,
            cwd: input.workspaceCategory === 'game'
              ? await this.agentLoopAuthority!.gameWorkspace(input.scope, input.operationId)
              : input.cwd,
            ...(input.developerInstructions === undefined
              ? {}
              : { developerInstructions: input.developerInstructions }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            approvalPolicy: 'on-request',
          }), generation)
        if (!created.ok) return { status: 'unavailable', code: 'host-unavailable' }
        const locator: AgentLoopTaskLocator = {
          task: `cxloop-task:${randomUUID()}`,
          binding: { bindingId: `cxloop-binding:${randomUUID()}`, generation: 1 },
          providerId: created.value.ref.providerId,
          providerGeneration: generation,
          remoteSessionId: created.value.ref.remoteSessionId,
          definition: copy(input.definition),
          state: 'active',
        }
        await this.agentLoopAuthority!.rememberTask(input.scope, locator)
        return {
          status: 'accepted',
          locator,
          commandDigest,
          detailsUrl: { url: `codex:task/${encodeURIComponent(locator.remoteSessionId)}`, target: 'external' },
        }
      },
    )
  }

  async bindAgentLoopV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly task: string
    readonly definition: { readonly agentId: string; readonly revision: string }
  }): Promise<unknown> {
    const locator = this.agentLoopAuthority?.resolveTask(input.scope, input.task)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'task-unavailable' }
    if (
      locator.definition.agentId !== input.definition.agentId
      || locator.definition.revision !== input.definition.revision
    ) {
      return { status: 'conflict', code: 'binding-conflict' }
    }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    return await this.durableAgentLoop(input, locator, async () => {
      const read = await this.withProvider(
        locator.providerId,
        async adapter =>
          await adapter.readSession({ providerId: locator.providerId, remoteSessionId: locator.remoteSessionId }),
        locator.providerGeneration,
      )
      if (!read.ok) return { status: 'unavailable', code: 'task-unavailable' }
      const rebound: AgentLoopTaskLocator = {
        ...locator,
        binding: { bindingId: locator.binding.bindingId, generation: locator.binding.generation + 1 },
      }
      await this.agentLoopAuthority!.rememberTask(input.scope, rebound)
      return {
        status: 'accepted',
        locator: rebound,
        detailsUrl: { url: `codex:task/${encodeURIComponent(locator.remoteSessionId)}`, target: 'external' },
      }
    })
  }

  private resolveAgentLoopBinding(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly task: string
    readonly binding: { readonly bindingId: string; readonly generation: number }
    readonly definition: { readonly agentId: string; readonly revision: string }
  }): AgentLoopTaskLocator | undefined {
    return this.agentLoopAuthority?.resolveBinding(input.scope, input)
  }

  async sendAgentLoopV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly task: string
    readonly binding: { readonly bindingId: string; readonly generation: number }
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly message: string
  }): Promise<unknown> {
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    return await this.durableAgentLoop(input, locator, async commandDigest => {
      const sent = await this.withProvider(locator.providerId, async adapter =>
        await adapter.submitTurn({
          session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
          message: input.message,
          operationId: input.operationId,
          operationDigest: commandDigest,
        }), locator.providerGeneration)
      return !sent.ok
        ? { status: 'unavailable', code: 'host-unavailable' }
        : { status: 'accepted', locator, turn: sent.value.turnId, messageId: `cxloop-message:${input.operationId}` }
    })
  }

  async decideAgentLoopApprovalV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly task: string
    readonly binding: { readonly bindingId: string; readonly generation: number }
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly turn: string
    readonly approvalId: string
    readonly decision: 'approved' | 'denied' | 'cancelled'
  }): Promise<unknown> {
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    return await this.durableAgentLoop(input, locator, async commandDigest => {
      const resolved = await this.withProvider(locator.providerId, async adapter =>
        await adapter.decideApproval({
          session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
          turnId: input.turn,
          approvalId: input.approvalId,
          decision: input.decision,
          operationId: input.operationId,
          operationDigest: commandDigest,
        }), locator.providerGeneration)
      return !resolved.ok
        ? { status: 'unavailable', code: 'approval-unavailable' }
        : {
          status: 'accepted',
          locator,
          operationId: input.operationId,
          turn: input.turn,
          approvalId: input.approvalId,
          decision: input.decision,
        }
    }, {
      resourceKey: `approval\0${input.task}\0${input.turn}\0${input.approvalId}`,
      conflictCode: 'approval-conflict',
    })
  }

  async requestAgentLoopIntroductionV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly task: string
    readonly binding: { readonly bindingId: string; readonly generation: number }
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly participantId: string
    readonly memberId: string
    readonly runId: string
  }): Promise<unknown> {
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    return await this.durableAgentLoop(input, locator, async commandDigest => {
      const requested = await this.withProvider(
        locator.providerId,
        async adapter =>
          await adapter.requestMemberSelfIntroduction({
            session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
            operationId: input.operationId,
            operationDigest: commandDigest,
            participantId: input.participantId,
            memberId: input.memberId,
            runId: input.runId,
          }),
        locator.providerGeneration,
      )
      return !requested.ok
        ? { status: 'unavailable', code: 'introduction-unavailable' }
        : {
          status: 'accepted',
          locator,
          operationId: input.operationId,
          participantId: input.participantId,
          memberId: input.memberId,
          runId: input.runId,
          turn: requested.value.turnId,
          messageId: requested.value.messageId,
          introductionState: this.introductionTerminal(locator, requested.value.turnId) ?? 'pending',
        }
    }, {
      resourceKey: `introduction\0${input.task}\0${input.participantId}\0${input.memberId}\0${input.runId}`,
      conflictCode: 'introduction-conflict',
    })
  }

  async cancelAgentLoopIntroductionV4(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly command: unknown
    readonly operationId: string
    readonly requestOperationId: string
    readonly task: string
    readonly binding: { readonly bindingId: string; readonly generation: number }
    readonly definition: { readonly agentId: string; readonly revision: string }
    readonly participantId: string
    readonly memberId: string
    readonly runId: string
  }): Promise<unknown> {
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    try {
      await this.lifecycleAuthorityQueue
    } catch {
      return { status: 'unavailable', code: 'reconciliation-required' }
    }
    const request = this.agentLoopAuthority?.committedResult(input.scope, input.requestOperationId) as {
      status?: unknown
      turn?: unknown
      messageId?: unknown
      participantId?: unknown
      memberId?: unknown
      runId?: unknown
      introductionState?: unknown
      locator?: {
        task?: unknown
        providerId?: unknown
        providerGeneration?: unknown
        remoteSessionId?: unknown
        binding?: { bindingId?: unknown; generation?: unknown }
      }
    } | undefined
    if (request?.status !== 'accepted' || typeof request.turn !== 'string' || typeof request.messageId !== 'string') {
      return { status: 'unavailable', code: 'introduction-not-found' }
    }
    if (
      request.locator?.task !== locator.task
      || request.locator.providerId !== locator.providerId
      || request.locator.providerGeneration !== locator.providerGeneration
      || request.locator.remoteSessionId !== locator.remoteSessionId
      || request.locator.binding?.bindingId !== locator.binding.bindingId
      || request.locator.binding.generation !== locator.binding.generation
    ) {
      return { status: 'conflict', code: 'introduction-conflict' }
    }
    if (request.participantId !== input.participantId || request.memberId !== input.memberId) {
      return { status: 'conflict', code: 'member-conflict' }
    }
    if (request.runId !== input.runId) return { status: 'conflict', code: 'run-conflict' }
    if (request.introductionState === 'completed') return { status: 'conflict', code: 'introduction-completed' }
    if (request.introductionState === 'cancelled') return { status: 'conflict', code: 'introduction-cancelled' }
    if (request.introductionState !== 'pending') return { status: 'conflict', code: 'introduction-conflict' }
    return await this.durableAgentLoop(input, locator, async commandDigest => {
      const cancelled = await this.withProvider(
        locator.providerId,
        async adapter =>
          await adapter.cancelMemberSelfIntroduction({
            session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
            turnId: request.turn as string,
            operationId: input.operationId,
            operationDigest: commandDigest,
          }),
        locator.providerGeneration,
      )
      if (!cancelled.ok) return { status: 'unavailable', code: 'introduction-unavailable' }
      this.appendLifecycle({
        providerGeneration: locator.providerGeneration,
        session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
        turnId: cancelled.value.turnId,
        type: 'turn.cancelled',
        provenance: 'observed',
        observedAt: new Date(this.now()).toISOString(),
        cancellation: { operationId: input.operationId },
      })
      return {
        status: 'accepted',
        locator,
        operationId: input.operationId,
        requestOperationId: input.requestOperationId,
        participantId: request.participantId,
        memberId: request.memberId,
        runId: request.runId,
        turn: cancelled.value.turnId,
        messageId: request.messageId,
      }
    }, {
      resourceKey: `introduction-cancel\0${input.task}\0${input.requestOperationId}`,
      conflictCode: 'introduction-conflict',
    })
  }

  async readAgentLoopV4Lifecycle(
    input: {
      readonly scope: AgentLoopAuthorityScope
      readonly task: string
      readonly binding: { readonly bindingId: string; readonly generation: number }
      readonly definition: { readonly agentId: string; readonly revision: string }
      readonly afterSequence: number
    },
  ): Promise<unknown> {
    try {
      await this.lifecycleAuthorityQueue
    } catch {
      return { status: 'unavailable', code: 'reconciliation-required' }
    }
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    const session = { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId }
    const inFlightFence = [...this.agentLoopInFlight.values()]
      .filter(operation =>
        operation.task === input.task
        && operation.provider.providerId === locator.providerId
        && operation.provider.providerGeneration === locator.providerGeneration
        && operation.lifecycleFence !== undefined
      )
      .reduce<number | undefined>((minimum, operation) =>
        minimum === undefined
          ? operation.lifecycleFence
          : Math.min(minimum, operation.lifecycleFence!), undefined)
    const range = this.readLifecycle(session, input.afterSequence)
    const stableEvents = inFlightFence === undefined
      ? range.events
      : range.events.filter(event => event.sequence <= inFlightFence)
    const committed = this.agentLoopAuthority?.committedResults(input.scope) ?? []
    const accepted = (kind: string) =>
      committed.flatMap(entry => {
        if (entry.kind !== kind || entry.result === null || typeof entry.result !== 'object') return []
        const value = entry.result as Record<string, unknown>
        const locator = value.locator as { task?: unknown } | undefined
        return value.status === 'accepted' && locator?.task === input.task ? [value] : []
      })
    const approvals = accepted('approval-decision')
    const introductions = accepted('request-member-self-introduction')
    const cancellations = accepted('cancel-member-self-introduction')
    return {
      status: 'accepted',
      nextAfterSequence: stableEvents.at(-1)?.sequence ?? input.afterSequence,
      events: stableEvents.filter(event => event.providerGeneration === locator.providerGeneration).map(event => {
        const approvalId = event.approval?.approvalId
        const approval = event.type === 'approval.resolved' && approvalId !== undefined
          ? approvals.find(result => result.turn === event.turnId && result.approvalId === approvalId)
          : undefined
        const introduction =
          event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed'
            || event.type === 'turn.cancelled'
            ? introductions.find(result => result.turn === event.turnId)
            : undefined
        const cancellation =
          event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled'
            ? cancellations.find(result => result.turn === event.turnId)
            : undefined
        return {
          ...event,
          ...(typeof approval?.operationId === 'string' ? { causation: { operationId: approval.operationId } } : {}),
          ...(introduction === undefined ? {} : {
            introduction: {
              operationId: introduction.operationId,
              messageId: introduction.messageId,
              participantId: introduction.participantId,
              memberId: introduction.memberId,
              runId: introduction.runId,
            },
          }),
          ...(cancellation === undefined ? {} : { cancellation: { operationId: cancellation.operationId } }),
        }
      }),
    }
  }

  resolveAgentLoopV4Session(
    input: {
      readonly scope: AgentLoopAuthorityScope
      readonly task: string
      readonly binding: { readonly bindingId: string; readonly generation: number }
      readonly definition: { readonly agentId: string; readonly revision: string }
    },
  ): unknown {
    const locator = this.resolveAgentLoopBinding(input)
    if (locator === undefined || locator.state !== 'active') return { status: 'unavailable', code: 'binding-closed' }
    if (this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    return { status: 'resolved', sessionId: locator.remoteSessionId }
  }

  async controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    return await this.withSession(input.session, async adapter => await adapter.controlSession(input))
  }

  async submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    return await this.withSession(input.session, async adapter => await adapter.submitTurn(input))
  }

  /** Launcher-private Channel create primitive; no renderer bridge uses this path. */
  async dispatchCreate(input: {
    readonly operationId: string
    readonly model: { readonly providerId: string; readonly modelId: string }
    readonly cwd: string
    readonly message: string
  }): Promise<ChannelTaskDispatchResult> {
    const prior = this.operationResults.get(input.operationId)
    if (prior !== undefined) return structuredClone(prior)
    const observedAt = new Date(this.now()).toISOString()
    const created = await this.createTask({ model: input.model, cwd: input.cwd })
    if (!created.ok) {
      return this.remember({
        contract: 'cordisx.platform-task-dispatch-result/v1',
        schemaVersion: 1,
        operationId: input.operationId,
        operation: 'create',
        status: 'rejected',
        failure: { code: 'TASK_CREATE_REJECTED', retryable: created.error.retryable === true },
        observedAt,
      })
    }
    const session = created.value.ref
    const cursor = this.cursor(session)
    const turn = await this.submitTurn({ session, message: input.message })
    if (!turn.ok) {
      return this.remember({
        contract: 'cordisx.platform-task-dispatch-result/v1',
        schemaVersion: 1,
        operationId: input.operationId,
        operation: 'create',
        status: 'created-initial-turn-failed',
        session,
        lifecycle: { session, afterSequence: cursor },
        failure: { code: 'TURN_START_FAILED', retryable: turn.error.retryable === true },
        observedAt: new Date(this.now()).toISOString(),
      })
    }
    this.appendLifecycle({
      providerGeneration: this.generationFor(session.providerId),
      session,
      turnId: turn.value.turnId,
      operationId: input.operationId,
      type: 'turn.started',
      provenance: 'observed',
      observedAt: new Date(this.now()).toISOString(),
    })
    return this.remember({
      contract: 'cordisx.platform-task-dispatch-result/v1',
      schemaVersion: 1,
      operationId: input.operationId,
      operation: 'create',
      status: 'accepted',
      session,
      turn: { session, turnId: turn.value.turnId },
      lifecycle: { session, afterSequence: cursor },
      observedAt: new Date(this.now()).toISOString(),
    })
  }

  /** Launcher-private Channel follow-up primitive against a complete bound session. */
  async dispatchFollowup(
    input: {
      readonly operationId: string
      readonly session: CordisXTaskReadInput['session']
      readonly message: string
    },
  ): Promise<ChannelTaskDispatchResult> {
    const prior = this.operationResults.get(input.operationId)
    if (prior !== undefined) return structuredClone(prior)
    const observedAt = new Date(this.now()).toISOString()
    const cursor = this.cursor(input.session)
    const turn = await this.submitTurn({ session: input.session, message: input.message })
    if (!turn.ok) {
      return this.remember({
        contract: 'cordisx.platform-task-dispatch-result/v1',
        schemaVersion: 1,
        operationId: input.operationId,
        operation: 'followup',
        status: 'rejected',
        failure: { code: 'TURN_START_REJECTED', retryable: turn.error.retryable === true },
        observedAt,
      })
    }
    this.appendLifecycle({
      providerGeneration: this.generationFor(input.session.providerId),
      session: input.session,
      turnId: turn.value.turnId,
      operationId: input.operationId,
      type: 'turn.started',
      provenance: 'observed',
      observedAt: new Date(this.now()).toISOString(),
    })
    return this.remember({
      contract: 'cordisx.platform-task-dispatch-result/v1',
      schemaVersion: 1,
      operationId: input.operationId,
      operation: 'followup',
      status: 'accepted',
      session: input.session,
      turn: { session: input.session, turnId: turn.value.turnId },
      lifecycle: { session: input.session, afterSequence: cursor },
      observedAt: new Date(this.now()).toISOString(),
    })
  }

  readLifecycle(session: CordisXTaskReadInput['session'], afterSequence = 0): ChannelTaskLifecycleRange {
    const events = (this.lifecycle.get(lifecycleKey(session)) ?? []).filter(event => event.sequence > afterSequence)
    return {
      contract: 'cordisx.platform-task-lifecycle-range/v1',
      schemaVersion: 1,
      session,
      afterSequence,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
      events: structuredClone(events),
    }
  }

  subscribeLifecycle(listener: (event: ChannelTaskLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  private async submitControlledTurn(
    scope: AgentLoopAuthorityScope,
    input: Parameters<AgentLoopControlV1['submit']>[0],
  ): Promise<unknown> {
    const locator = this.resolveAgentLoopBinding({
      scope,
      task: input.binding.task,
      binding: input.binding.binding,
      definition: input.binding.definition,
    })
    if (locator === undefined || this.generationFor(locator.providerId) !== locator.providerGeneration) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    if (input.content.some(part => part.kind !== 'text')) return { status: 'unavailable', code: 'unsupported' }
    const message = input.content.map(part => part.kind === 'text' ? part.text : '').join('\n')
    if (!message.trim() || message.length > 65_536) return { status: 'unavailable', code: 'invalid-request' }
    return await this.durableAgentLoop(
      { scope, operationId: input.commandId, command: { type: 'controlled-submit', ...input } },
      locator,
      async commandDigest => {
        const sent = await this.withProvider(locator.providerId, adapter =>
          adapter.submitTurn({
            session: { providerId: locator.providerId, remoteSessionId: locator.remoteSessionId },
            message,
            operationId: input.commandId,
            operationDigest: commandDigest,
          }), locator.providerGeneration)
        return !sent.ok
          ? { status: 'unavailable', code: 'host-unavailable' }
          : {
            status: 'accepted',
            locator,
            turn: sent.value.turnId,
            deadline: input.deadline,
            controlledState: 'running',
          }
      },
    )
  }

  async controlAgentLoop(
    input: {
      readonly scope: AgentLoopAuthorityScope
      readonly action: 'submit' | 'cancel' | 'read' | 'dispose'
      readonly value?: unknown
    },
  ): Promise<unknown> {
    if (input.action === 'dispose') {
      await this.controlledTurns.dispose(input.scope)
      return { status: 'accepted', value: null }
    }
    if (input.action === 'submit') {
      return await this.controlledTurns.submit(input.scope, input.value as Parameters<AgentLoopControlV1['submit']>[0])
    }
    if (input.action === 'read') {
      return await this.controlledTurns.read(input.scope, input.value as AgentLoopControlledTurnV1)
    }
    const request = input.value as Parameters<AgentLoopControlV1['cancel']>[0]
    const target = request.target
    const locator = this.resolveAgentLoopBinding({
      scope: input.scope,
      task: target.binding.task,
      binding: target.binding.binding,
      definition: target.binding.definition,
    })
    if (locator === undefined) return { status: 'unavailable', code: 'turn-unavailable' }
    return await this.durableAgentLoop(
      { scope: input.scope, operationId: request.commandId, command: { type: 'controlled-cancel', ...request } },
      locator,
      async () => await this.controlledTurns.cancel(input.scope, target),
    )
  }

  async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    return await this.withSession(input.session, async adapter => await adapter.controlTurn(input))
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.controlledTurns.dispose()
    this.closed = true
    this.pagination.clear()
    for (const dispose of this.lifecycleDisposers.values()) dispose()
    this.lifecycleDisposers.clear()
    this.lifecycleListeners.clear()
    await this.registry.dispose()
  }

  async withExactProviderGeneration<Value>(
    providerId: string,
    operation: (adapter: CordisXExactProviderAdapter) => Promise<Value>,
  ): Promise<Value> {
    return await withExactProviderGeneration(this.registry, providerId, operation)
  }

  /** Publish already-prepared plugin adapters into this Fleet without creating another registry. */
  async publishConnections(
    entries: readonly { readonly connection: ProviderConnection; readonly displayName: string }[],
  ): Promise<ProviderFleetPublication> {
    if (this.closed) throw new Error('Provider Fleet is closed')
    return await publishProviderConnections({
      entries,
      registry: this.registry,
      names: this.names,
      lifecycleDisposers: this.lifecycleDisposers,
      observeLifecycle: (generation, event) => this.observeLifecycle(this.registry, generation, event),
    })
  }

  /**
   * Start a replacement generation before retiring the previous adapters.
   * The narrow service-config API calls `finalize` only after persistence
   * commits, or `rollback` when it cannot, so callers never observe a
   * half-published Provider Fleet.
   */
  async reconfigure(
    configs: readonly CodexProviderConfig[],
    prepare?: (replacement: ProviderFleet) => Promise<void>,
  ): Promise<{
    readonly generation: string
    rollback(): Promise<void>
    finalize(): Promise<void>
  }> {
    if (this.closed) throw new Error('Provider Fleet is closed')
    const replacement = await ProviderFleet.create(configs, {
      now: this.now,
      startServer: this.startServer,
      ...(this.appServer === undefined ? {} : { appServer: this.appServer }),
    })
    let replacementLifecycleDisposers: Map<string, () => void> | undefined
    try {
      await prepare?.(replacement)
      replacementLifecycleDisposers = this.subscribeRegistryLifecycle(replacement.registry)
    } catch (error) {
      for (const dispose of replacementLifecycleDisposers?.values() ?? []) dispose()
      await replacement.close().catch(() => undefined)
      throw error
    }
    const previous = {
      registry: this.registry,
      failures: this.failures,
      names: this.names,
      lifecycleDisposers: this.lifecycleDisposers,
      providers: this.registry.snapshots().filter(item => item.state === 'active')
        .map(item => ({ providerId: item.providerId, providerGeneration: item.generation })),
    }
    this.registry = replacement.registry
    this.failures = replacement.failures
    this.names = replacement.names
    for (const dispose of replacement.lifecycleDisposers.values()) dispose()
    replacement.lifecycleDisposers.clear()
    this.lifecycleDisposers = replacementLifecycleDisposers
    replacement.closed = true
    const generation = this.registry.snapshots().map(item => item.generation).sort().join(',')
      || `unavailable:${randomUUID()}`
    const replacementState = {
      registry: this.registry,
      failures: this.failures,
      names: this.names,
      lifecycleDisposers: this.lifecycleDisposers,
      providers: this.registry.snapshots().filter(item => item.state === 'active')
        .map(item => ({ providerId: item.providerId, providerGeneration: item.generation })),
    }
    return fleetReconfigurationTransaction({
      generation,
      previous,
      replacement: replacementState,
      restore: state => {
        this.registry = state.registry
        this.failures = state.failures
        this.names = state.names
        this.lifecycleDisposers = state.lifecycleDisposers
      },
      ...(this.agentLoopAuthority === undefined ? {} : {
        closeProviderGeneration: async provider => await this.agentLoopAuthority!.closeProviderGeneration(provider),
      }),
    })
  }

  private providers(requested?: readonly string[]): CordisXPlatformResult<readonly string[]> {
    return selectFleetProviders(this.registry.snapshots(), this.names, requested)
  }

  private async withProvider<Value>(
    providerId: string,
    operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
    generation?: string,
  ): Promise<CordisXPlatformResult<Value>> {
    try {
      const lease = this.registry.acquire(providerId, generation)
      try {
        return await operation(lease.adapter)
      } finally {
        lease.release()
      }
    } catch (error) {
      return registryFailure(error)
    }
  }

  private async withSession<Value>(
    session: CordisXTaskReadInput['session'],
    operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
  ): Promise<CordisXPlatformResult<Value>> {
    try {
      const lease = this.registry.acquireSession(session)
      try {
        return await operation(lease.adapter)
      } finally {
        lease.release()
      }
    } catch (error) {
      return registryFailure(error)
    }
  }

  private async durableAgentLoop(
    input: { readonly scope: AgentLoopAuthorityScope; readonly command: unknown; readonly operationId: string },
    provider: AgentLoopProviderFence,
    execute: (commandDigest: string) => Promise<unknown>,
    resource?: { readonly resourceKey: string; readonly conflictCode: 'approval-conflict' | 'introduction-conflict' },
  ): Promise<unknown> {
    return await runFleetAgentLoopTransaction(
      this.agentLoopAuthority,
      this.agentLoopInFlight,
      () => this.lifecycleAuthorityQueue,
      session => this.cursor(session),
      input,
      provider,
      execute,
      resource,
    )
  }

  private remember(result: ChannelTaskDispatchResult): ChannelTaskDispatchResult {
    this.operationResults.set(result.operationId, structuredClone(result))
    return result
  }

  private generationFor(providerId: string): string {
    return this.registry.snapshots().find(item => item.providerId === providerId && item.state === 'active')?.generation
      ?? 'retired'
  }

  private subscribeRegistryLifecycle(registry: ProviderAdapterRegistry<ProviderConnection>): Map<string, () => void> {
    const disposers = new Map<string, () => void>()
    try {
      for (const snapshot of registry.snapshots().filter(item => item.state === 'active')) {
        const lease = registry.acquire(snapshot.providerId, snapshot.generation)
        try {
          const dispose = lease.adapter.subscribeLifecycle?.(event =>
            this.observeLifecycle(registry, snapshot.generation, event)
          )
          if (dispose !== undefined) disposers.set(snapshot.providerId, dispose)
        } finally {
          lease.release()
        }
      }
    } catch (error) {
      for (const dispose of disposers.values()) dispose()
      throw error
    }
    return disposers
  }

  private cursor(session: CordisXTaskReadInput['session']): number {
    return (this.lifecycle.get(lifecycleKey(session)) ?? []).at(-1)?.sequence ?? 0
  }

  private introductionTerminal(locator: AgentLoopTaskLocator, turn: string): 'completed' | 'failed' | undefined {
    const terminal =
      (this.lifecycle.get(lifecycleKey({ providerId: locator.providerId, remoteSessionId: locator.remoteSessionId }))
        ?? [])
        .find(event =>
          event.providerGeneration === locator.providerGeneration && event.turnId === turn
          && (event.type === 'turn.completed' || event.type === 'turn.failed')
        )
    return terminal?.type === 'turn.completed' ? 'completed' : terminal?.type === 'turn.failed' ? 'failed' : undefined
  }

  private observeLifecycle(
    source: ProviderAdapterRegistry<ProviderConnection>,
    generation: string,
    event: ProviderLifecycleSignal,
  ): void {
    const provider = source.snapshots().find(snapshot =>
      snapshot.providerId === event.session.providerId
      && snapshot.generation === generation
    )
    if (
      provider === undefined || provider.inFlight === 0
        && (provider.state === 'draining' || source !== this.registry)
    ) return
    const appended = this.appendLifecycle({
      providerGeneration: generation,
      session: event.session,
      turnId: event.turnId,
      type: event.type,
      provenance: 'observed',
      observedAt: new Date(this.now()).toISOString(),
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.failure === undefined ? {} : { failure: event.failure }),
      ...(event.approval === undefined ? {} : { approval: event.approval }),
    })
    if (appended && (event.type === 'turn.completed' || event.type === 'turn.failed')) {
      this.lifecycleAuthorityQueue = this.lifecycleAuthorityQueue.then(async () =>
        await this.agentLoopAuthority?.observeIntroductionTerminal(
          { providerId: event.session.providerId, providerGeneration: generation },
          event.session.remoteSessionId,
          event.turnId,
          event.type === 'turn.completed' ? 'completed' : 'failed',
        )
      )
    }
  }

  private appendLifecycle(
    input: Omit<ChannelTaskLifecycleEvent, 'contract' | 'schemaVersion' | 'eventId' | 'sequence'>,
  ): boolean {
    return appendFleetLifecycle(this.lifecycle, this.lifecycleListeners, input)
  }
}
