import { readChannelCompletion } from './channel-legacy-completion.js'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { createHash, randomBytes } from 'node:crypto'
import { channelAttachmentTicket } from './channel-inbound-resources.js'
import type { AgentBridge } from './agent-bridge.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { codexThreadMetadata, codexTurn } from './agent-bridge-codex-history.js'
import { channelContinuationHistory } from './channel-continuation-history.js'
import { ChannelLogicalHandoffPermits } from './channel-logical-handoff-permits.js'
import { channelNativeIdle } from './channel-native-idle.js'
import type { ChannelReplyDefaults } from './channel-reply-routing.js'
import {
  channelCliPreparationInstructions,
  channelCliSendInstructions,
  type ChannelNativeCliContext,
} from './channel-cli-context.js'
import { channelNativeLivePrompt, channelNativeMessagePrompt } from './channel-native-message-prompt.js'
import { ChannelChatOrganization, channelChatTitle } from './channel-chat-organization.js'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'
import { configuredChannelApprovalOperation } from './channel-cli-approval.js'
import type { ChannelMessageContext } from './channel-message-context.js'
import {
  type ChatExecutionSettings,
  mergeChatExecutionSettings,
  nativeExecutionTurn,
} from '../chat-execution-settings.js'
import { isDeepStrictEqual } from 'node:util'
import {
  continuationCheckpointInstructions,
  type ContinuationPolicy,
  ContinuationUsage,
} from './channel-continuation.js'
import {
  type ContinuationConfiguration,
  continuationConfiguration,
  continuationStartMatches,
} from './channel-continuation-config.js'
import { ChannelLiveTurnControl } from './channel-live-turn-control.js'
import { logicalHistoryContentVersion } from './logical-continuation-snapshot.js'
import { logicalNativeHistoryPage } from './logical-continuation-native-page.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'
import { createLogicalNativeDestination } from './logical-continuation-native-create.js'
import type { LogicalContinuationEvidence, LogicalContinuationRequest } from './logical-continuation-control.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { channelLogicalJointSourceRoot, channelLogicalSourceSnapshot } from './channel-logical-source-snapshot.js'
import { logicalPresentation, placeLogicalDestination } from './logical-continuation-presentation.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export interface ChannelNativeTurnResult {
  readonly state: 'running' | 'busy' | 'failed' | 'reconciliation-required'
  readonly sessionId?: string
  readonly turnId?: string
  readonly code?: string
}
export type ChannelNativeReconciliationResult = Omit<ChannelNativeTurnResult, 'state'> & {
  readonly state: 'running' | 'reconciliation-required'
}

/** Uses the launch's authenticated native backend and existing provider/credential preparation. */
export class ChannelNativeSessions {
  readonly logicalHandoffPermits = new ChannelLogicalHandoffPermits()
  private personaRegistry?: import('./channel-memory-personas.js').ChannelMemoryPersonas
  private readonly personaEpochs = new Map<string, string>()
  setPersonaRegistry(registry: import('./channel-memory-personas.js').ChannelMemoryPersonas): void {
    this.personaRegistry = registry
  }
  resetPersonaContext(threadId: string): void {
    this.personaEpochs.delete(threadId)
  }
  private readonly organization: ChannelChatOrganization
  private readonly continuationUsage = new ContinuationUsage()
  private readonly contextRedactions = new Map<string, Set<string>>()
  private readonly logicalContextRedactions = new Map<string, readonly string[]>()
  private readonly activeLogicalTurns = new Map<string, string>()
  private readonly completedLogicalTurns = new Map<string, string>()
  private readonly logicalTurnWaiters = new Map<string, Set<() => void>>()
  private readonly sources = new Map<
    string,
    {
      source: ChannelEventRef
      token: string
      threadId?: string
      turnId?: string
      confirmedTurn?: string
      nativeOperationId?: string
      preparing?: boolean
      preparationExpiresAt?: number
    }
  >()
  constructor(
    private readonly input: {
      readonly bridge: () => AgentBridge | undefined
      readonly nativeRequest: (
        method: NativeBridgeMethod,
        params: Readonly<Record<string, unknown>>,
      ) => Promise<unknown>
      readonly cwd: string
      readonly nativeVersion?: string
      readonly logicalHandoffWriteGuardReady?: () => boolean
      readonly logicalMigrationLease?: (
        source: string,
      ) => ReturnType<typeof import('./channel-logical-native-lease.js').acquireChannelLogicalNativeLease>
      readonly logicalOwnerIdentity?: () => Promise<string | undefined>
      readonly providerId?: string
      readonly model?: string
      readonly cli?: ChannelNativeCliContext
      readonly execution?: ChatExecutionPreferences
      readonly configuration?: import('./codex-chat-configuration.js').CodexChatConfiguration
      readonly contextObserver?: import('./native-context-observer.js').NativeContextObserver
      readonly confirmedWorkMode?: (threadId: string) => 'default' | 'plan' | undefined
      readonly models?: (operation: string, input: unknown, beforeEffect?: () => Promise<boolean>) => Promise<unknown>
      readonly sourceConfiguration?: (
        threadId: string,
      ) => Promise<import('./native-source-configuration.js').NativeSourceConfiguration | undefined>
      readonly name?: (event: import('@cordisx/channel-runtime').ChannelEventRef) => Promise<string | undefined>
      readonly sectionName?: () => string | undefined
      readonly report?: (code: string) => void
      readonly subscribeApprovals?: (listener: (event: Record<string, unknown>) => void) => () => void
      readonly subscribeContinuationEvents?: (listener: (method: string, params: unknown) => void) => () => void
      readonly respondApproval?: (input: Record<string, unknown>) => Promise<unknown>
    },
  ) {
    this.organization = new ChannelChatOrganization(input)
    input.subscribeContinuationEvents?.((method, params) => {
      this.continuationUsage.notification(method, params)
      if (method === 'cordisx/connection/closed') {
        this.activeLogicalTurns.clear()
        this.completedLogicalTurns.clear()
        this.sources.clear()
        this.logicalContextRedactions.clear()
        for (const threadId of this.logicalTurnWaiters.keys()) this.signalLogicalTurn(threadId)
        return
      }
      const notification = object(params), notificationTurn = object(notification.turn).id
      if (
        method === 'turn/started' && typeof notification.threadId === 'string' && typeof notificationTurn === 'string'
      ) {
        this.activeLogicalTurns.set(notification.threadId, notificationTurn)
        if (this.activeLogicalTurns.size > 512) {
          this.activeLogicalTurns.delete(this.activeLogicalTurns.keys().next().value!)
        }
        const candidates = [...this.sources.values()].filter(entry =>
          entry.threadId === notification.threadId && entry.turnId === undefined
        )
        if (candidates.length === 1) candidates[0]!.turnId = notificationTurn
      }
      if (method === 'thread/closed' && typeof notification.threadId === 'string') {
        this.activeLogicalTurns.delete(notification.threadId)
      }
      if (method === 'turn/completed') {
        const value = object(params), turnId = object(value.turn).id
        if (typeof value.threadId === 'string' && this.activeLogicalTurns.get(value.threadId) === turnId) {
          this.activeLogicalTurns.delete(value.threadId)
        }
        if (typeof value.threadId === 'string' && typeof turnId === 'string') {
          this.completedLogicalTurns.set(value.threadId, turnId)
          if (this.completedLogicalTurns.size > 512) {
            this.completedLogicalTurns.delete(this.completedLogicalTurns.keys().next().value!)
          }
          this.signalLogicalTurn(value.threadId)
        }
        for (const [id, source] of this.sources) {
          if (
            typeof turnId === 'string' && source.threadId === value.threadId
            && source.confirmedTurn === turnId
          ) this.sources.delete(id)
        }
      }
    })
  }
  continuationEligible(threadId: string, policy: ContinuationPolicy) {
    return this.continuationUsage.eligible(threadId, policy)
  }
  supportsLogicalFork() {
    return this.input.nativeVersion === 'codex-cli 0.171.0-alpha.13'
  }
  supportsLogicalHandoff() {
    return this.input.logicalHandoffWriteGuardReady?.() === true
  }
  get logicalMigrationLease() {
    return this.input.logicalMigrationLease
  }
  async logicalOwnerIdentity() {
    return await this.input.logicalOwnerIdentity?.()
  }
  /** Do not infer provenance from a missing field or from Host-only relations. */
  async logicalJointSourceRoot(source: LogicalSessionRef) {
    return channelLogicalJointSourceRoot(this.input, source)
  }
  async continuationConfiguration(
    threadId: string,
    allowActive = false,
  ): Promise<ContinuationConfiguration | undefined> {
    if (!allowActive && !await this.idle(threadId)) return undefined
    await this.input.execution?.settled()
    const live = await this.input.sourceConfiguration?.(threadId).catch(() => undefined)
    const record = this.input.execution?.read('local', threadId)
    if (!record || record.application !== 'applied' || !this.input.execution?.observationConfirmed(threadId)) {
      return undefined
    }
    const confirmedMode = this.input.confirmedWorkMode?.(threadId)
    if (this.input.confirmedWorkMode && confirmedMode === undefined) return undefined
    return continuationConfiguration(record.effective, live, confirmedMode)
  }
  async continuationTurnActive(threadId: string, turnId: string): Promise<boolean> {
    const thread = await codexThreadMetadata(this.input, threadId)
    if (thread?.id !== threadId || object(thread.status).type !== 'active') return false
    const turn = await codexTurn(this.input, threadId, turnId)
    return turn?.id === turnId && ['inProgress', 'running'].includes(String(turn.status))
  }
  async logicalTurnActive(threadId: string, turnId: string): Promise<boolean> {
    if (this.activeLogicalTurns.get(threadId) !== turnId) return false
    const thread = await codexThreadMetadata(this.input, threadId)
    return this.activeLogicalTurns.get(threadId) === turnId && thread?.id === threadId
      && object(thread.status).type === 'active'
  }
  /** Caller must also hold the owner-side source fence while this runs and until commit. */
  async logicalSourceVersion(source: LogicalSessionRef): Promise<string | undefined> {
    const snapshot = await channelLogicalSourceSnapshot(this.input, source, threadId => this.idle(threadId))
    if (!snapshot) return undefined
    this.logicalContextRedactions.set(source.sessionId, snapshot.tokens)
    if (this.logicalContextRedactions.size > 128) {
      this.logicalContextRedactions.delete(this.logicalContextRedactions.keys().next().value!)
    }
    return snapshot.version
  }
  logicalContextTokens(sessionId: string) {
    return this.logicalContextRedactions.get(sessionId)
  }
  async createLogicalDestination(
    request: LogicalContinuationRequest,
    evidence: LogicalContinuationEvidence,
    fence?: ChannelNativeSourceFence,
    available?: (threadId: string) => boolean,
    nativeRequest?: typeof this.input.nativeRequest,
  ) {
    const native = nativeRequest ? { ...this.input, nativeRequest } : this.input
    const source = await logicalPresentation(native, request.source.sessionId).catch(() => undefined)
    if (!source) return { state: 'rejected' as const, code: 'SOURCE_PRESENTATION_UNAVAILABLE' }
    const result = await createLogicalNativeDestination(
      native,
      request,
      evidence,
      fence ? (threadId, params) => fence.allowFork(threadId, params) : undefined,
      source.projectId,
    )
    if (result.state !== 'created' || !result.confirmed) return result
    if (!fence || !available) return { ...result, confirmed: false }
    const destination = result.destination.sessionId, releaseTarget = fence.beginMigration(destination)
    if (!releaseTarget) return { ...result, confirmed: false }
    let retained = false
    try {
      if (!available(destination)) return { ...result, confirmed: false }
      // Naming is a durable native mutation; preserve project and explicit section order as well.
      if (
        !await placeLogicalDestination(native, fence, request.source.sessionId, destination, source, available, [
          evidence.sourceConfiguration.providerId,
          request.target.providerId,
        ])
      ) {
        return { ...result, confirmed: false }
      }
      if (!available(destination)) return { ...result, confirmed: false }
      const resumed = object(
        await native.nativeRequest(
          'thread/resume',
          fence.allowOwned('thread/resume', destination, { threadId: destination }),
        ),
      )
      if (
        object(resumed.thread).id !== result.destination.sessionId
        || !continuationStartMatches(resumed, { ...evidence.sourceConfiguration, ...request.target })
      ) {
        return { ...result, confirmed: false }
      }
      if (request.mode === 'fork') {
        if (
          await logicalHistoryContentVersion(native, request.source)
            !== await logicalHistoryContentVersion(native, result.destination)
        ) return { ...result, confirmed: false }
      }
      // Creation defaults are not sticky. Preserve the source execution choices on the first and later turns.
      const execution = this.input.execution
      if (!execution || !available(destination)) return { ...result, confirmed: false }
      const current = execution.read('local', result.destination.sessionId)
      if (current?.override) return { ...result, confirmed: false }
      const saved = await execution.set(
        'local',
        result.destination.sessionId,
        evidence.sourceConfiguration.execution,
        current?.revision ?? 0,
      )
      if (!isDeepStrictEqual(saved.override, evidence.sourceConfiguration.execution) || !available(destination)) {
        return { ...result, confirmed: false }
      }
      retained = true
      return { ...result, confirmed: true, releaseTarget }
    } catch {
      return { ...result, confirmed: false }
    } finally {
      if (!retained) releaseTarget()
    }
  }
  logicalHistoryPage(source: LogicalSessionRef, cursor?: string) {
    return logicalNativeHistoryPage(this.input, source, cursor)
  }
  async continuationHistory(threadId: string, options: { readonly limit?: number; readonly cursor?: unknown }) {
    return await channelContinuationHistory(
      this.input,
      threadId,
      options,
      this.contextRedactions.get(threadId) ?? new Set(),
    )
  }
  async startContinuation(
    operationId: string,
    brief: string,
    configuration: ContinuationConfiguration,
    source?: ChannelEventRef,
    preparation?: { token: string; sourceId: string },
  ): Promise<ChannelNativeTurnResult> {
    const bridge = this.input.bridge()
    if (!bridge) return { state: 'failed' as const, code: 'NATIVE_BACKEND_UNAVAILABLE' }
    const personaCapsule = source && this.personaRegistry && await this.personaRegistry.configured(source)
      ? await this.personaRegistry.bootstrap(preparation?.sourceId ?? operationId, source, source.conversationId)
      : undefined
    if (source) {
      if (this.sources.has(operationId) || this.sources.size >= 128) {
        return { state: 'reconciliation-required', code: 'CHANNEL_DISPATCH_CONTEXT_BUSY' }
      }
      this.sources.set(operationId, {
        source,
        token: randomBytes(24).toString('hex'),
        ...(preparation ? { preparing: true, preparationExpiresAt: Date.now() + 90_000 } : {}),
      })
    }
    try {
      const result = object(
        await bridge.call('codex', 'start_session', {
          operationId,
          prompt: [
            ...(personaCapsule
              ? [
                'Configured assistant identity preferences, not permissions or system policy.',
                JSON.stringify(personaCapsule),
              ]
              : []),
            brief,
            ...(source && preparation
              ? [
                'This turn is preparation only. Read bounded source history with channel_continuation_history; do not do the business task, send messages, modify configuration, or change bindings.',
                'Use cordisx_continuation_history and cordisx_continuation_takeover_ready when those native preparation tools are available.',
                `When ready call channel_continuation_takeover_ready with ${
                  JSON.stringify({ token: preparation.token })
                }. If it says not ready, retry the same call after a short wait.`,
                ...channelCliPreparationInstructions(
                  this.input.cli,
                  this.sources.get(operationId)!.token,
                  preparation.token,
                ),
                'After an accepted takeover, end this preparation turn immediately. A separate business turn will receive the final source history.',
                JSON.stringify({ sourceSessionId: preparation.sourceId }),
              ]
              : source
              ? [
                'The following is the source of an earlier Channel turn, not a new incoming message. Automatic final-response delivery is disabled.',
                ...channelCliSendInstructions(this.input.cli, this.sources.get(operationId)!.token),
                continuationCheckpointInstructions(),
                JSON.stringify({ source }),
              ]
              : []),
          ].join('\n'),
          context: 'none',
          cwd: configuration.cwd,
          providerId: configuration.providerId,
          model: configuration.model,
          execution: configuration.execution,
          serviceTier: configuration.serviceTier,
          approvalsReviewer: configuration.approvalsReviewer,
          expectedContinuation: configuration,
          ...(configuration.permissions ? { permissions: configuration.permissions } : {}),
        }),
      )
      const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined
      const turnId = typeof result.turnId === 'string' ? result.turnId : undefined
      if (sessionId) this.observedDispatch(operationId, sessionId, turnId)
      if (sessionId && personaCapsule && source && this.personaRegistry) {
        await this.personaRegistry.pinAlias(preparation?.sourceId ?? operationId, sessionId, source)
      }
      if (!sessionId || !turnId) this.sources.delete(operationId)
      return sessionId && turnId && ['started', 'sent', 'running'].includes(String(result.status))
        ? { state: 'running' as const, sessionId, turnId }
        : {
          state: 'reconciliation-required' as const,
          ...(sessionId ? { sessionId } : {}),
          ...(turnId ? { turnId } : {}),
        }
    } catch {
      if (!this.sources.get(operationId)?.turnId) this.sources.delete(operationId)
      return { state: 'reconciliation-required' as const }
    }
  }
  executionPreferences() {
    return this.input.execution
  }
  contextObservations() {
    return this.input.contextObserver?.observations
  }
  async modelOperation(operation: string, input: unknown, beforeEffect?: () => Promise<boolean>) {
    const result = await this.input.models?.(operation, input, beforeEffect)
      ?? { status: 'unavailable', code: 'MODEL_CATALOG_UNAVAILABLE' }
    if (operation !== 'list' || !this.input.configuration) return result
    const listed = object(result)
    if (!Array.isArray(listed.providers)) return result
    const native = await this.input.configuration.catalog()
    return {
      ...listed,
      providers: listed.providers.map(object).map(provider => {
        const metadata = native.find(row => row.providerId === provider.providerId)
        if (!metadata || !Array.isArray(provider.models)) return provider
        // Enrich admitted models only; the native Fast catalog does not grant another provider/model.
        const models: Record<string, unknown>[] = provider.models.map(object).map(model => {
          const capabilities = metadata.models.find(row => row.id === model.id)
          return {
            ...model,
            ...(capabilities?.supportsFastMode === undefined
              ? {}
              : { supportsFastMode: capabilities.supportsFastMode }),
          }
        })
        const defaultModelId = provider.defaultModelId
          ?? (models.some(model => model.id === metadata.defaultModelId) ? metadata.defaultModelId : undefined)
        return { ...provider, models, ...(defaultModelId === undefined ? {} : { defaultModelId }) }
      }),
    }
  }
  async idle(threadId: string) {
    return (await channelNativeIdle(this.input, threadId)) !== undefined
  }
  async taskSelection(threadId: string): Promise<import('./channel-task-config.js').ChannelTaskPatch> {
    const metadata = await codexThreadMetadata(this.input, threadId)
    if (metadata?.id !== threadId) throw new Error('SESSION_NOT_FOUND')
    const live = await this.input.sourceConfiguration?.(threadId).catch(() => undefined)
    const record = this.input.execution?.read('local', threadId)
    const provider = live?.providerId ?? metadata.modelProvider
    const effective = record?.effective
    const model = live?.model ?? metadata.model
      ?? (effective?.modelProvider === undefined || effective.modelProvider === provider ? effective?.model : undefined)
    const coherentEffective = effective !== undefined && effective.modelProvider === provider
      && effective.model === model
    const effort = live?.reasoningEffort ?? metadata.reasoningEffort
      ?? (coherentEffective ? effective?.reasoningEffort : undefined)
    const configuration = this.input.configuration
      ? object(await this.input.configuration.call('project', { sessionId: threadId }))
      : {}
    if (this.input.configuration && configuration.status !== 'ok') {
      throw new Error(String(configuration.code ?? 'CHAT_CONFIGURATION_UNAVAILABLE'))
    }
    const configured = object(configuration.effective)
    const tier = live?.serviceTier !== undefined
      ? live.serviceTier
      : metadata.serviceTier !== undefined
      ? metadata.serviceTier
      : coherentEffective
      ? effective?.serviceTier
      : undefined
    return {
      ...(typeof provider === 'string' ? { providerId: provider } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
      ...(typeof configured.fast === 'boolean'
        ? { fast: configured.fast }
        : tier === 'priority'
        ? { fast: true }
        : tier === null || tier === 'default'
        ? { fast: false }
        : {}),
      ...(typeof configured.projectId === 'string' ? { projectId: configured.projectId } : {}),
    }
  }
  async creationSelection(): Promise<import('./channel-task-config.js').ChannelTaskPatch> {
    const defaults = (await this.input.execution?.creationDefaults())?.settings ?? {}
    const selection = {
      ...(defaults.providerId ? { providerId: defaults.providerId } : {}),
      ...(defaults.model && (!this.input.providerId || this.input.providerId === defaults.providerId)
        ? { model: defaults.model }
        : {}),
      ...(this.input.providerId ? { providerId: this.input.providerId } : {}),
      ...(this.input.model ? { model: this.input.model } : {}),
      ...(defaults.fast === undefined ? {} : { fast: defaults.fast }),
    }
    if (!selection.providerId || !selection.model) {
      const providers = object(await this.modelOperation('list', {})).providers
      const rows = Array.isArray(providers) ? providers.map(object) : []
      const provider = rows.find(row => row.providerId === (selection.providerId ?? 'openai'))
      if (provider) {
        selection.providerId ??= String(provider.providerId)
        if (!selection.model && typeof provider.defaultModelId === 'string') selection.model = provider.defaultModelId
      }
    }
    return selection
  }
  projects(caller?: string) {
    return this.input.configuration?.projects(caller) ?? Promise.reject(new Error('PROJECT_AUTHORITY_UNAVAILABLE'))
  }
  async validateTaskConfiguration(settings: import('./channel-task-config.js').ChannelTaskPatch, caller?: string) {
    if (settings.fast !== undefined && !this.input.configuration) throw new Error('CHAT_CONFIGURATION_UNAVAILABLE')
    if (settings.projectId) {
      if (!this.input.configuration) throw new Error('PROJECT_AUTHORITY_UNAVAILABLE')
      await this.input.configuration.validateProject(settings.projectId, caller)
    }
  }
  async configurationRevision(threadId: string) {
    if (!this.input.configuration) throw new Error('CHAT_CONFIGURATION_UNAVAILABLE')
    const current = object(await this.input.configuration.call('fast', { sessionId: threadId }))
    if (current.status !== 'ok') throw new Error(String(current.code ?? 'CHAT_CONFIGURATION_UNAVAILABLE'))
    return Number(current.revision)
  }
  async applyTaskSelection(
    threadId: string,
    settings: import('./channel-task-config.js').ChannelTaskPatch,
    beforeEffect?: (applied?: import('./channel-task-config.js').ChannelTaskPatch) => Promise<boolean>,
  ) {
    if (!await this.idle(threadId)) return { status: 'rejected', reason: 'thread-not-idle' }
    const current = await this.taskSelection(threadId)
    const applied: import('./channel-task-config.js').ChannelTaskPatch = {}
    const revalidate = () => beforeEffect?.(applied) ?? Promise.resolve(true)
    let effected = false
    const configuration = this.input.configuration
    const applyConfiguration = async (operation: 'fast-set' | 'project-set', patch: Record<string, unknown>) => {
      if (!configuration) throw new Error('CHAT_CONFIGURATION_UNAVAILABLE')
      const read = object(
        await configuration.call(operation === 'fast-set' ? 'fast' : 'project', { sessionId: threadId }),
      )
      if (read.status !== 'ok') return read
      const result = object(
        await configuration.applyChannel(operation, {
          sessionId: threadId,
          expectedRevision: read.revision,
          ...patch,
        }, revalidate),
      )
      if (result.status !== 'applied') return result
      Object.assign(applied, patch)
      effected = true
      return undefined
    }
    // Clear Fast before a provider change so its old persisted tier cannot reject the resume.
    if (settings.fast === false && current.fast !== false) {
      const rejected = await applyConfiguration('fast-set', { fast: false })
      if (rejected) return rejected
    }
    if (settings.providerId !== current.providerId || settings.model !== current.model) {
      const result = object(
        await this.modelOperation('select', {
          threadId,
          providerId: settings.providerId,
          model: settings.model,
        }, revalidate),
      )
      if (result.status !== 'selected') return effected ? { status: 'reconciliation-required' } : result
      Object.assign(applied, { providerId: settings.providerId, model: settings.model })
      const selected = await this.taskSelection(threadId)
      if (selected.providerId !== settings.providerId || selected.model !== settings.model) {
        return { status: 'reconciliation-required' }
      }
      // Native provider selection can reset effort/tier. Fence later effects against that exact readback.
      if (selected.effort !== (applied.effort ?? current.effort)) Object.assign(applied, { effort: selected.effort })
      if (selected.fast !== (applied.fast ?? current.fast)) Object.assign(applied, { fast: selected.fast })
      effected = true
    }
    for (const [field, operation] of [['fast', 'fast-set'], ['projectId', 'project-set']] as const) {
      if (settings[field] === undefined || settings[field] === (applied[field] ?? current[field])) continue
      const rejected = await applyConfiguration(operation, { [field]: settings[field] })
      if (rejected) return effected ? { status: 'reconciliation-required' } : rejected
    }
    const observedEffort = Object.hasOwn(applied, 'effort') ? applied.effort : current.effort
    const effortChanged = settings.effort !== undefined && settings.effort !== observedEffort
    if (effortChanged) {
      if (!await revalidate()) return { status: 'reconciliation-required' }
      const preferences = this.input.execution
      if (!preferences) throw new Error('EXECUTION_SETTINGS_UNAVAILABLE')
      const record = preferences.read('local', threadId)
      const override = { ...record?.override }
      if (settings.effort === 'inherit') delete override.effort
      else override.effort = settings.effort
      await preferences.set('local', threadId, override, record?.revision ?? 0)
    }
    return {
      status: 'selected',
      application: !effortChanged || settings.effort === 'inherit' ? 'applied' : 'saved',
    }
  }
  approvalEvents(listener: (event: Record<string, unknown>) => void) {
    return this.input.subscribeApprovals?.(listener) ?? (() => {})
  }
  answerApproval(input: Record<string, unknown>) {
    return this.input.respondApproval?.(input) ?? Promise.resolve({ status: 'unavailable' })
  }
  cliApprovalOperation(command: unknown) {
    return configuredChannelApprovalOperation(command, this.input.cli)
  }
  observedDispatch(operationId: string, threadId: string, turnId?: string): void {
    const entry = this.sources.get(operationId)
      ?? [...this.sources.values()].find(candidate => candidate.nativeOperationId === operationId)
    if (!entry) return
    entry.threadId = threadId
    const tokens = this.contextRedactions.get(threadId) ?? new Set<string>()
    tokens.add(entry.token)
    if (tokens.size > 128) tokens.delete(tokens.values().next().value!)
    this.contextRedactions.set(threadId, tokens)
    if (this.contextRedactions.size > 512) this.contextRedactions.delete(this.contextRedactions.keys().next().value!)
    if (turnId) {
      entry.turnId = turnId
      entry.confirmedTurn = turnId
      if (this.completedLogicalTurns.get(threadId) === turnId) {
        for (const [id, candidate] of this.sources) if (candidate === entry) this.sources.delete(id)
      }
      this.signalLogicalTurn(threadId)
    }
  }
  isPreparing(threadId: string): boolean {
    return [...this.sources.values()].some(entry => entry.preparing && entry.threadId === threadId)
  }
  isPreparationOperation(operationId: string): boolean {
    return this.sources.get(operationId)?.preparing === true
  }
  hasPreparation(): boolean {
    return [...this.sources.values()].some(entry => entry.preparing && (entry.preparationExpiresAt ?? 0) > Date.now())
  }
  async stopPreparation(operationId: string): Promise<boolean> {
    const entry = this.sources.get(operationId)
    if (!entry?.preparing || !entry.threadId || !entry.turnId) return false
    const state = await this.liveTurnControl().turnState(entry.threadId, entry.turnId)
    if (state === 'completed' || state === 'failed') {
      this.sources.delete(operationId)
      return true
    }
    if (state !== 'active') return false
    const result = await this.liveTurnControl().interruptExact(entry.threadId, entry.turnId)
    if (result === 'interrupted' || result === 'already-completed') {
      this.sources.delete(operationId)
      return true
    }
    return false
  }
  liveTurnControl(): ChannelLiveTurnControl {
    return new ChannelLiveTurnControl(this.input)
  }

  /** Restore and confirm the source settings before starting the separate business turn. */
  async startLiveBusiness(input: {
    operationId: string
    target: string
    source: ChannelEventRef
    sourceId: string
    configuration: ContinuationConfiguration
    delta: string
  }): Promise<ChannelNativeTurnResult> {
    const preferences = this.input.execution, config = input.configuration
    if (!preferences || !await this.idle(input.target) || preferences.read('local', input.target)?.override) {
      return { state: 'reconciliation-required', code: 'CONTINUATION_SETTINGS_UNAVAILABLE' }
    }
    const turnSettings = nativeExecutionTurn(config.execution, { ...config, model: config.model }, {})
    if (config.permissions) delete turnSettings.sandboxPolicy
    const settings = {
      ...turnSettings,
      model: config.model,
      cwd: config.cwd,
      serviceTier: config.serviceTier,
      approvalsReviewer: config.approvalsReviewer,
      ...(config.permissions ? { permissions: config.permissions } : {}),
    }
    try {
      await this.input.nativeRequest('thread/settings/update', { threadId: input.target, ...settings })
      let confirmed = false
      for (let attempt = 0; attempt < 50; attempt++) {
        await preferences.settled()
        if (preferences.read('local', input.target)?.override) break
        if (isDeepStrictEqual(await this.continuationConfiguration(input.target), config)) {
          confirmed = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!confirmed || this.sources.has(input.operationId) || this.sources.size >= 128) {
        return { state: 'reconciliation-required', code: 'CONTINUATION_SETTINGS_UNAVAILABLE' }
      }
      const token = randomBytes(24).toString('hex')
      this.sources.set(input.operationId, { source: input.source, token, threadId: input.target })
      const liveCapsule =
        this.personaRegistry && await this.personaRegistry.taskConfigured(input.sourceId, input.source)
          ? await this.personaRegistry.bootstrap(input.sourceId, input.source, input.source.conversationId)
          : undefined
      if (liveCapsule && this.personaRegistry) await this.personaRegistry.inheritTask(input.sourceId, input.target)
      const prompt = channelNativeLivePrompt(input, liveCapsule, this.input.cli, token)
      const result = object(
        await this.input.nativeRequest('turn/start', {
          ...settings,
          threadId: input.target,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        }),
      )
      const turnId = object(result.turn).id
      if (typeof turnId !== 'string' || !turnId) return { state: 'reconciliation-required' }
      this.observedDispatch(input.operationId, input.target, turnId)
      return { state: 'running', sessionId: input.target, turnId }
    } catch {
      return { state: 'reconciliation-required', code: 'CONTINUATION_BUSINESS_UNCERTAIN' }
    }
  }
  sourceFor(threadId: string, turnId?: string): ChannelEventRef | undefined {
    const entries = [...this.sources.values()].filter(entry =>
      entry.threadId === threadId && (!turnId || !entry.turnId || entry.turnId === turnId)
    )
    return entries.length === 1 ? entries[0]!.source : undefined
  }
  /** History access requires the turn id acknowledged for this exact Channel operation. */
  async sourceForLogicalTurn(threadId: string, turnId: string): Promise<ChannelEventRef | undefined> {
    const matching = () =>
      [...this.sources.values()].filter(entry => entry.threadId === threadId && entry.confirmedTurn === turnId)
    let entries = matching()
    if (
      !entries.length && this.activeLogicalTurns.get(threadId) === turnId
      && [...this.sources.values()].some(entry => entry.threadId === threadId && !entry.confirmedTurn)
    ) {
      await new Promise<void>(resolve => {
        const waiters = this.logicalTurnWaiters.get(threadId) ?? new Set<() => void>()
        const finish = () => {
          clearTimeout(timer)
          waiters.delete(finish)
          if (!waiters.size) this.logicalTurnWaiters.delete(threadId)
          resolve()
        }
        const timer = setTimeout(finish, 2_000)
        waiters.add(finish)
        this.logicalTurnWaiters.set(threadId, waiters)
      })
      entries = matching()
    }
    return entries.length === 1 ? entries[0]!.source : undefined
  }
  private signalLogicalTurn(threadId: string) {
    const waiters = this.logicalTurnWaiters.get(threadId)
    this.logicalTurnWaiters.delete(threadId)
    waiters?.forEach(resolve => resolve())
  }
  contextFor(token: string) {
    return [...this.sources.values()].find(entry => entry.token === token)
  }
  async label(sessionId: string) {
    const metadata = await codexThreadMetadata(this.input, sessionId)
    return typeof metadata?.name === 'string' ? metadata.name : 'Codex 对话'
  }
  async exists(sessionId: string): Promise<boolean> {
    try {
      return (await codexThreadMetadata(this.input, sessionId))?.id === sessionId
    } catch {
      return false
    }
  }
  async start(
    operationId: string,
    message: ChannelUserInput,
    sessionId?: string,
    signal?: AbortSignal,
    reply?: ChannelReplyDefaults & { readonly enabled: boolean },
    context?: ChannelMessageContext,
    settings?: import('./channel-task-config.js').ChannelTaskPatch,
    creationOverrides?: ChatExecutionSettings,
    ...continuationOptions: [
      continuation?: {
        readonly operationId: string
        readonly brief: string
        readonly configuration: ContinuationConfiguration
      },
      logicalHistory?: boolean,
      logicalHandoff?: string,
    ]
  ): Promise<ChannelNativeTurnResult> {
    const [continuation, logicalHistory = false, logicalHandoff] = continuationOptions
    if (signal?.aborted) return { state: 'failed', code: 'CANCELLED' }
    const bridge = this.input.bridge()
    if (!bridge) return { state: 'failed', code: 'NATIVE_BACKEND_UNAVAILABLE' }
    if (sessionId !== undefined) {
      const metadata = await codexThreadMetadata(this.input, sessionId)
      if (metadata?.status && object(metadata.status).type === 'active') return { state: 'busy' }
    }
    const event = message.source.event
    const personaTask = sessionId ?? `dispatch-${createHash('sha256').update(operationId).digest('hex')}`
    const capsule = this.personaRegistry && await this.personaRegistry.taskConfigured(personaTask, event)
      ? await this.personaRegistry.bootstrap(personaTask, event, event.conversationId)
      : undefined
    const capsuleVersion = capsule
      ? `${capsule.personaId}:${capsule.revision}:${capsule.bindingRevision}:${JSON.stringify(capsule.style)}`
      : ''
    const includeCapsule = capsule && this.personaEpochs.get(personaTask) !== capsuleVersion
    if (this.sources.has(operationId) || this.sources.size >= 128) {
      return { state: 'reconciliation-required', code: 'CHANNEL_DISPATCH_CONTEXT_BUSY' }
    }
    this.sources.set(operationId, {
      source: event,
      token: randomBytes(24).toString('hex'),
      ...(sessionId ? { threadId: sessionId } : {}),
      ...(continuation ? { nativeOperationId: continuation.operationId } : {}),
    })
    const contextToken = this.sources.get(operationId)!.token
    const handoffMarker = logicalHandoff && sessionId
      ? this.logicalHandoffPermits.issue(operationId, sessionId)
      : undefined
    if (logicalHandoff && !handoffMarker) {
      this.sources.delete(operationId)
      return { state: 'reconciliation-required', code: 'HANDOFF_ASSOCIATION_UNAVAILABLE' }
    }
    const title = channelChatTitle(event)
    const prompt = channelNativeMessagePrompt({
      operationId,
      message,
      context,
      reply,
      contextToken,
      handoffMarker,
      logicalHandoff,
      logicalHistory,
      cli: this.input.cli,
      capsule: includeCapsule ? capsule : undefined,
      brief: continuation?.brief,
    })
    try {
      const baseSelection = await this.creationSelection()
      const providerId = continuation?.configuration.providerId ?? settings?.providerId ?? baseSelection.providerId
      let model = continuation?.configuration.model ?? settings?.model
        ?? (settings?.providerId && settings.providerId !== baseSelection.providerId ? undefined : baseSelection.model)
      if (providerId && !model) {
        const catalog = object(await this.modelOperation('list', {})).providers
        const provider = Array.isArray(catalog)
          ? catalog.map(object).find(row => row.providerId === providerId)
          : undefined
        if (typeof provider?.defaultModelId === 'string') model = provider.defaultModelId
      }
      const execution = sessionId === undefined && !continuation
        ? mergeChatExecutionSettings(
          mergeChatExecutionSettings((await this.input.execution?.defaults())?.settings ?? {}, creationOverrides ?? {}),
          settings?.effort === undefined ? {} : { effort: settings.effort },
        )
        : undefined
      let fast = settings?.fast ?? baseSelection.fast
      if (sessionId === undefined && !continuation && fast === true) {
        const providers = object(await this.modelOperation('list', {})).providers
        const selected = Array.isArray(providers)
          ? providers.map(object).find(row => row.providerId === providerId)
          : undefined
        const supported = Array.isArray(selected?.models)
          && selected.models.map(object).some(row => row.id === model && row.supportsFastMode === true)
        if (!supported) {
          if (settings?.fast === true) throw new Error('FAST_NOT_SUPPORTED')
          fast = false
        }
      }
      if (sessionId === undefined && !continuation) {
        await this.validateTaskConfiguration({ ...settings, ...(fast === undefined ? {} : { fast }) })
      }
      if (signal?.aborted) {
        this.sources.delete(operationId)
        return { state: 'failed', code: 'CANCELLED' }
      }
      const result = object(
        await bridge.call('codex', sessionId === undefined ? 'start_session' : 'send_message', {
          operationId: continuation?.operationId ?? operationId,
          prompt,
          channelAttachmentTicket: await channelAttachmentTicket(message),
          ...(sessionId === undefined
            ? {
              cwd: continuation?.configuration.cwd ?? this.input.cwd,
              title,
              ...(providerId
                ? {
                  providerId: providerId,
                }
                : {}),

              ...(model
                ? { model: model }
                : {}),
              ...(settings?.projectId && !continuation ? { projectId: settings.projectId } : {}),
              ...(fast === undefined || continuation ? {} : { serviceTier: fast ? 'priority' : null }),
              ...(continuation
                ? {
                  execution: continuation.configuration.execution,
                  serviceTier: continuation.configuration.serviceTier,
                  approvalsReviewer: continuation.configuration.approvalsReviewer,
                  expectedContinuation: continuation.configuration,
                  ...(continuation.configuration.permissions
                    ? { permissions: continuation.configuration.permissions }
                    : {}),
                }
                : execution === undefined || !Object.keys(execution).length
                ? {}
                : { execution }),
            }
            : { sessionId }),
        }, signal),
      )
      const createdSession = typeof result.sessionId === 'string' ? result.sessionId : sessionId
      if (
        sessionId === undefined && createdSession && !['started', 'sent', 'running'].includes(String(result.status))
      ) {
        void this.organization.created(
          createdSession,
          title,
          this.input.sectionName ? this.input.sectionName() : '外部连接',
        )
          .catch(() => this.input.report?.('CHANNEL_CHAT_ORGANIZATION_UNAVAILABLE'))
      }
      const turnId = typeof result.turnId === 'string' ? result.turnId : undefined
      if (createdSession && turnId && ['started', 'sent', 'running'].includes(String(result.status))) {
        if (capsule && this.personaRegistry) {
          await this.personaRegistry.pinAlias(personaTask, createdSession, event)
          this.personaEpochs.set(createdSession, capsuleVersion)
        }
        this.observedDispatch(operationId, createdSession, turnId)
        if (sessionId === undefined) {
          void this.organization.created(
            createdSession,
            title,
            this.input.sectionName ? this.input.sectionName() : '外部连接',
          )
            .catch(() => this.input.report?.('CHANNEL_CHAT_ORGANIZATION_UNAVAILABLE'))
          void this.input.name?.(event).then(name =>
            this.organization.refineTitle(createdSession, channelChatTitle(event, name))
          )
            .catch(() => undefined)
        }
        return { state: 'running', sessionId: createdSession, turnId }
      }
      if (result.reason === 'session-busy') {
        this.sources.delete(operationId)
        return { state: 'busy' }
      }
      if (!createdSession) this.sources.delete(operationId)
      if (signal?.aborted && !createdSession) return { state: 'failed', code: 'CANCELLED' }
      return {
        state: createdSession ? 'reconciliation-required' : 'failed',
        ...(createdSession === undefined ? {} : { sessionId: createdSession }),
        ...(turnId === undefined ? {} : { turnId }),
        code: 'NATIVE_DISPATCH_REJECTED',
      }
    } catch {
      return {
        state: 'reconciliation-required',
        ...(sessionId === undefined ? {} : { sessionId }),
        code: 'NATIVE_EFFECT_UNCERTAIN',
      }
    } finally {
      this.logicalHandoffPermits.release(operationId)
    }
  }
  async reconcile(operationId: string): Promise<ChannelNativeReconciliationResult> {
    const bridge = this.input.bridge()
    if (!bridge) return { state: 'reconciliation-required', code: 'NATIVE_BACKEND_UNAVAILABLE' }
    try {
      const result = object(await bridge.call('codex', 'check_operation', { operationId }))
      if (typeof result.sessionId === 'string' && typeof result.turnId === 'string') {
        this.observedDispatch(operationId, result.sessionId, result.turnId)
        return { state: 'running', sessionId: result.sessionId, turnId: result.turnId }
      }
      return {
        state: 'reconciliation-required',
        code: result.reason === 'operation-not-found'
          ? 'NATIVE_OPERATION_UNAVAILABLE_AFTER_RESTART'
          : 'NATIVE_EFFECT_UNCERTAIN',
      }
    } catch {
      return { state: 'reconciliation-required', code: 'NATIVE_EFFECT_UNCERTAIN' }
    }
  }
  async completion(sessionId: string, turnId: string, includeFinal = false): Promise<{
    readonly state: 'running' | 'completed' | 'failed'
    readonly text?: string
    readonly code?: string
  }> {
    const turn = await codexTurn(this.input, sessionId, turnId)
    if (!turn || ['inProgress', 'running'].includes(String(turn.status))) return { state: 'running' }
    for (const [id, entry] of this.sources) {
      if (entry.threadId === sessionId && entry.turnId === turnId) this.sources.delete(id)
    }
    if (turn.status !== 'completed') return { state: 'failed', code: 'NATIVE_TURN_FAILED' }
    if (!includeFinal) return { state: 'completed' }
    return readChannelCompletion(this.input.nativeRequest, sessionId, turnId)
  }
}
