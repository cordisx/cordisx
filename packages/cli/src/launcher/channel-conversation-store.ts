import { parseChannelTaskRecords } from './channel-task-records.js'
import { type ChannelModelPriority, parseChannelModelPriority } from './channel-model-priority.js'
import { type ChannelFailureNoticeConfig, parseChannelFailureNoticeConfig } from './channel-failure-notice-config.js'
import {
  type ChannelGroupTaskAccess,
  type ChannelGroupUserTaskAccess,
  parseChannelGroupTaskAccess,
  parseChannelGroupUserTaskAccess,
} from './channel-group-access.js'
import {
  type LogicalContinuationState,
  parseLogicalContinuationState,
  recoverLogicalContinuations,
} from './logical-continuation-control.js'
import { type ChannelLivePolicyOverride, parseLivePolicy } from './channel-live-policy.js'
import {
  type ChannelContinuationDefaults,
  INITIAL_CONTINUATION_DEFAULTS,
  parseContinuationDefaults,
} from './channel-continuation-defaults.js'
import {
  type ContinuationCheckpoint,
  continuationCheckpoint,
  type ContinuationPolicy,
  continuationPolicy,
} from './channel-continuation.js'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type ChatExecutionDefaults, parseChatExecutionDefaults } from '../chat-execution-settings.js'
import type { ChannelThreadRef, ChannelUserInput } from '@cordisx/channel-runtime'
import type { ChannelCommandAddressing } from './channel-command-users.js'
import type { ChannelAutoReplyMode, ChannelReplyDefaults, ChannelReplyMode } from './channel-reply-routing.js'
import {
  CHANNEL_TASK_CONFIG_INITIAL,
  type ChannelTaskConfig,
  type ChannelTaskPatch,
  parseChannelTaskConfig,
} from './channel-task-config.js'

export interface ChannelTaskRequest {
  readonly id: string
  readonly token: string
  readonly source: import('@cordisx/channel-runtime').ChannelEventRef
  readonly threadId: string
  readonly patch: ChannelTaskPatch
  readonly selection: ChannelTaskPatch
  readonly baseSelection: ChannelTaskPatch
  readonly createdAt: number
  readonly expectedRevision: number
  readonly expiresAt: number
  state: 'pending' | 'queued' | 'applying' | 'submitted' | 'applied' | 'denied' | 'expired' | 'unknown'
  approvedBy?: import('@cordisx/channel-runtime').ChannelEventRef
  code?: string
  cardMessageId?: string
}
export interface ChannelTaskSetting {
  revision: number
  settings: ChannelTaskPatch
  pending?: ChannelTaskPatch
  pendingPatch?: ChannelTaskPatch
  baseSelection?: ChannelTaskPatch
  requested?: ChannelTaskPatch
  application: 'saved' | 'applying' | 'submitted' | 'applied' | 'unknown'
  code?: string
}
import {
  CHANNEL_CONVERSATION_POLICY_INITIAL,
  type ChannelConversationPolicy,
  parseChannelConversationPolicy,
} from './channel-conversation-policy.js'

export interface ChannelChatBinding {
  readonly id: string
  readonly channel: ChannelThreadRef
  readonly sessionId: string
  readonly hostId: 'local'
  readonly profileId: string
  readonly createdAt: string
  readonly fromSequence: number
  readonly mode: 'listen' | 'deliver'
  readonly autoReply: boolean
  readonly replyMode?: ChannelAutoReplyMode
  readonly replyFallbackMode?: ChannelReplyMode
  state: 'active' | 'archived'
}
export interface ChannelConversationInput {
  feedback?: {
    since: number
    reactionAttempted: boolean
    waitAttempted: boolean
    replyObserved: boolean
    receivedAttempted?: boolean
    receivedReaction?: import('./channel-feedback.js').ChannelReactionReceipt
    receivedRemovalAttempted?: boolean
    processingSharesReceived?: boolean
    reaction?: import('./channel-feedback.js').ChannelReactionReceipt
    completionAttempted?: boolean
    completion?: import('./channel-feedback.js').ChannelReactionReceipt
  }
  readonly recordId: string
  readonly input: ChannelUserInput
  readonly mentionedBot: boolean
  readonly sequence: number
  readonly persisted: boolean
  readonly addressing?: ChannelCommandAddressing
  accepted: boolean
  routed: boolean
}
export interface ChannelConversationJob {
  readonly id: string
  readonly recordId: string
  bindingId?: string
  readonly autoCreate: boolean
  readonly creationReason?: 'bind-command'
  state:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'replying'
    | 'completed'
    | 'failed'
    | 'reconciliation-required'
    | 'cancelled'
  sessionId?: string
  turnId?: string
  /** An input inserted into this existing turn; it must never emit a second final reply. */
  steeredInto?: string
  steerParent?: string
  steerRejectedTurn?: string
  steerReadbackAt?: number
  deliveryId?: string
  /** Captured before native dispatch; a later opt-in must not export an earlier local-only turn. */
  finalDeliveryEnabled?: boolean
  replyDefaults?: ChannelReplyDefaults
  replyMode?: ChannelReplyMode
  replyTarget?: ChannelThreadRef
  /** Target created for this job's latest live handoff; fences immediate repeated handoffs. */
  liveContinuationTarget?: string
  code?: string
  /** A generic error notice is reserved once for this input, never a raw provider error. */
  failureNotice?: 'pending' | 'attempted'
}
export interface ChannelConversationState {
  readonly contract: 'cordisx.channel-conversation-store/v1'
  schemaVersion: 1 | 2
  revision: number
  policyRevision: number
  policy: ChannelConversationPolicy
  groupTaskAccess?: readonly ChannelGroupTaskAccess[]
  groupUserTaskAccess?: readonly ChannelGroupUserTaskAccess[]
  nextSequence: number
  inputCursor: string
  bindings: Record<string, ChannelChatBinding>
  inputs: Record<string, ChannelConversationInput>
  jobs: Record<string, ChannelConversationJob>
  taskConfigRevision: number
  taskConfig: ChannelTaskConfig
  modelPriority: ChannelModelPriority
  failureNotices: ChannelFailureNoticeConfig
  taskSettings: Record<string, ChannelTaskSetting>
  taskRequests: Record<string, ChannelTaskRequest>
  creationDefaults: ChatExecutionDefaults
  questions: Record<string, import('./channel-questions.js').ChannelQuestionRecord>
  continuations: Record<string, ChannelContinuationRecord>
  continuationDefaults: ChannelContinuationDefaults
  liveTakeovers: Record<string, import('./channel-live-takeover.js').LiveTakeoverIntent>
  logicalContinuations?: LogicalContinuationState
}

export interface ChannelContinuationRecord {
  livePolicy?: ChannelLivePolicyOverride
  policy?: ContinuationPolicy
  checkpoint?: ContinuationCheckpoint
  intent?: {
    operationId: string
    checkpointRevision: number
    state: 'dispatching' | 'unknown' | 'completed'
    targetThreadId?: string
    targetTurnId?: string
  }
}

function initial(): ChannelConversationState {
  return {
    contract: 'cordisx.channel-conversation-store/v1',
    schemaVersion: 1,
    revision: 0,
    policyRevision: 0,
    policy: CHANNEL_CONVERSATION_POLICY_INITIAL,
    nextSequence: 1,
    inputCursor: 'channel-input:0:empty',
    bindings: {},
    inputs: {},
    jobs: {},
    taskConfigRevision: 0,
    taskConfig: CHANNEL_TASK_CONFIG_INITIAL,
    modelPriority: { revision: 0, candidates: [] },
    failureNotices: { revision: 0, enabled: true },
    taskSettings: {},
    taskRequests: {},
    creationDefaults: { revision: 0, settings: {} },
    questions: {},
    continuations: {},
    continuationDefaults: INITIAL_CONTINUATION_DEFAULTS,
    liveTakeovers: {},
  }
}

/** Host-owned bindings and dispatch receipts. This is not a Channel connection store or shared Codex DB. */
export class ChannelConversationStore {
  private tail: Promise<void> = Promise.resolve()
  private durabilityUncertain = false
  private closed = false
  private commitBarrier: ((state: ChannelConversationState) => Promise<void>) | undefined
  private barrierReady = false
  private constructor(private readonly file: string, private value: ChannelConversationState) {}
  static logicalSourceFenced(state: ChannelConversationState, sessionId: string): boolean {
    return Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
      intent.request.source.sessionId === sessionId && ['creating', 'unknown'].includes(intent.state)
    )
  }
  static logicalSessionFenced(state: ChannelConversationState, sessionId: string): boolean {
    return Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
      ['creating', 'unknown'].includes(intent.state)
      && (intent.request.source.sessionId === sessionId || intent.destination?.sessionId === sessionId)
    )
  }
  static async open(file: string): Promise<ChannelConversationStore> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    let value = initial()
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as ChannelConversationState
      if (
        parsed.contract !== value.contract || ![1, 2].includes(parsed.schemaVersion)
        || !Number.isSafeInteger(parsed.revision)
        || !Number.isSafeInteger(parsed.nextSequence) || typeof parsed.inputCursor !== 'string'
        || !parsed.bindings || !parsed.inputs || !parsed.jobs
      ) throw new Error('INVALID_CONVERSATION_STORE')
      if (parsed.schemaVersion === 2) {
        parsed.logicalContinuations = parseLogicalContinuationState(parsed.logicalContinuations)
      } else if (parsed.logicalContinuations !== undefined) throw new Error('INVALID_CONVERSATION_STORE')
      parsed.policy = parseChannelConversationPolicy(parsed.policy)
      parsed.groupTaskAccess = parseChannelGroupTaskAccess(parsed.groupTaskAccess)
      parsed.groupUserTaskAccess = parseChannelGroupUserTaskAccess(parsed.groupUserTaskAccess)
      parsed.taskConfig = parseChannelTaskConfig(parsed.taskConfig ?? CHANNEL_TASK_CONFIG_INITIAL)
      parsed.modelPriority = parseChannelModelPriority(parsed.modelPriority ?? { revision: 0, candidates: [] })
      parsed.failureNotices = parseChannelFailureNoticeConfig(parsed.failureNotices ?? { revision: 0, enabled: true })
      parsed.taskConfigRevision ??= 0
      parsed.taskSettings ??= {}
      parsed.taskRequests ??= {}
      parsed.creationDefaults = parseChatExecutionDefaults(parsed.creationDefaults) ?? { revision: 0, settings: {} }
      parsed.questions ??= {}
      parsed.continuations ??= {}
      parsed.liveTakeovers ??= {}
      if (!parsed.liveTakeovers || typeof parsed.liveTakeovers !== 'object' || Array.isArray(parsed.liveTakeovers)) {
        throw new Error('INVALID_LIVE_TAKEOVER_STORE')
      }
      for (const [source, intent] of Object.entries(parsed.liveTakeovers)) {
        if (
          !intent || typeof intent !== 'object' || source !== intent.source
          || ![intent.operationId, intent.source, intent.sourceTurn, intent.sourceJob, intent.fence].every(value =>
            typeof value === 'string' && value.length > 0
          )
          || !/^[a-f0-9]{64}$/u.test(intent.tokenHash)
          || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0
          || ![
            'preparing',
            'ready',
            'interrupting',
            'committed',
            'business-starting',
            'finished',
            'abandoned',
            'unknown',
          ].includes(intent.state)
          || ['ready', 'interrupting', 'committed', 'business-starting', 'finished'].includes(intent.state)
            && (!intent.target || !intent.targetTurn)
          || intent.catchup !== undefined && (typeof intent.catchup !== 'string' || intent.catchup.length > 16_000)
          || intent.historyRead !== undefined && typeof intent.historyRead !== 'boolean'
          || ['committed', 'business-starting', 'finished'].includes(intent.state) && intent.catchup === undefined
        ) {
          throw new Error('INVALID_LIVE_TAKEOVER_STORE')
        }
      }
      parsed.continuationDefaults = parseContinuationDefaults(
        parsed.continuationDefaults ?? INITIAL_CONTINUATION_DEFAULTS,
      )
      if (typeof parsed.continuations !== 'object' || Array.isArray(parsed.continuations)) {
        throw new Error('INVALID_CONTINUATION_STORE')
      }
      for (const [threadId, entry] of Object.entries(parsed.continuations)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_CONTINUATION_STORE')
        if (Object.keys(entry).some(key => !['policy', 'livePolicy', 'checkpoint', 'intent'].includes(key))) {
          throw new Error('INVALID_CONTINUATION_STORE')
        }
        if (entry.policy !== undefined) entry.policy = continuationPolicy(entry.policy)
        if (entry.livePolicy !== undefined) entry.livePolicy = parseLivePolicy(entry.livePolicy)
        if (entry.checkpoint !== undefined) {
          const { threadId: checkpointThread, revision, ...body } = entry.checkpoint
          if (checkpointThread !== threadId) throw new Error('INVALID_CONTINUATION_STORE')
          entry.checkpoint = continuationCheckpoint(body, threadId, revision)
        }
        if (
          entry.intent !== undefined && (!entry.intent || typeof entry.intent !== 'object' || (
            typeof entry.intent.operationId !== 'string' || !entry.intent.operationId
            || !Number.isSafeInteger(entry.intent.checkpointRevision) || entry.intent.checkpointRevision < 1
            || !['dispatching', 'unknown', 'completed'].includes(entry.intent.state)
            || entry.intent.targetThreadId !== undefined && typeof entry.intent.targetThreadId !== 'string'
            || entry.intent.targetTurnId !== undefined && typeof entry.intent.targetTurnId !== 'string'
            || entry.intent.state === 'completed' && !entry.intent.targetThreadId
          ))
        ) throw new Error('INVALID_CONTINUATION_STORE')
      }
      Object.assign(parsed, parseChannelTaskRecords(parsed.taskSettings, parsed.taskRequests))
      parsed.policyRevision ??= 0
      if (
        !Number.isSafeInteger(parsed.policyRevision) || parsed.policyRevision < 0
        || !Number.isSafeInteger(parsed.taskConfigRevision) || parsed.taskConfigRevision < 0
      ) {
        throw new Error('INVALID_CONVERSATION_STORE')
      }
      value = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const store = new ChannelConversationStore(file, value)
    // A process died after reserving a native effect. Never blindly recreate/resend it.
    await store.mutate(state => {
      if (state.logicalContinuations) recoverLogicalContinuations(state.logicalContinuations)
      for (const intent of Object.values(state.liveTakeovers)) {
        if (['preparing', 'ready'].includes(intent.state)) intent.state = 'abandoned'
        else if (intent.state === 'interrupting' || intent.state === 'business-starting') intent.state = 'unknown'
      }
      for (const entry of Object.values(state.continuations)) {
        if (entry.intent?.state === 'dispatching') entry.intent.state = 'unknown'
      }
      for (const [threadId, setting] of Object.entries(state.taskSettings)) {
        if (setting.application === 'applying') {
          setting.application = 'unknown'
          setting.code = 'NATIVE_EFFECT_UNCERTAIN'
          delete setting.pending
          delete setting.pendingPatch
          for (const request of Object.values(state.taskRequests)) {
            if (request.threadId === threadId && request.state === 'applying') {
              request.state = 'unknown'
              request.code = 'NATIVE_EFFECT_UNCERTAIN'
            }
          }
        }
      }
      for (const job of Object.values(state.jobs)) {
        if (job.state === 'dispatching') {
          job.state = 'reconciliation-required'
          job.code = 'NATIVE_EFFECT_UNCERTAIN'
          job.failureNotice ??= 'pending'
        }
      }
    })
    return store
  }
  snapshot(): ChannelConversationState {
    if (this.closed) throw new Error('CONVERSATION_STORE_CLOSED')
    if (this.durabilityUncertain) throw new Error('CONVERSATION_STORE_DURABILITY_UNCERTAIN')
    return structuredClone(this.value)
  }
  hasCommitBarrier(): boolean {
    return !this.closed && !this.durabilityUncertain && this.commitBarrier !== undefined && this.barrierReady
  }
  pauseCommitBarrier(): void {
    this.barrierReady = false
  }
  async resumeCommitBarrier(onReady?: () => void): Promise<void> {
    if (this.closed) throw new Error('CONVERSATION_STORE_CLOSED')
    const task = this.tail.then(async () => {
      if (!this.commitBarrier || this.durabilityUncertain) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
      await this.commitBarrier(structuredClone(this.value))
      onReady?.()
      this.barrierReady = true
    })
    this.tail = task.catch(() => undefined)
    await task
  }
  /** Install once under the same queue as commits, so no update can overtake recovery. */
  async bindCommitBarrier(
    barrier: (state: ChannelConversationState) => Promise<void>,
    onReady?: () => void,
  ): Promise<void> {
    if (this.closed) throw new Error('CONVERSATION_STORE_CLOSED')
    const task = this.tail.then(async () => {
      if (this.commitBarrier || this.durabilityUncertain) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
      try {
        await barrier(structuredClone(this.value))
      } catch (error) {
        this.durabilityUncertain = true
        throw error
      }
      this.commitBarrier = barrier
      onReady?.()
      this.barrierReady = true
    })
    this.tail = task.catch(() => undefined)
    await task
  }
  /** Hold the owner queue from authorization until a native write is handed off. */
  async holdCommittedSnapshot<T>(read: (state: ChannelConversationState) => T): Promise<{
    value: T
    release(): void
  }> {
    if (!this.hasCommitBarrier()) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
    let grant!: (value: { value: T; release(): void }) => void
    let deny!: (error: unknown) => void
    let unlock!: () => void
    const ready = new Promise<{ value: T; release(): void }>((resolve, reject) => {
      grant = resolve
      deny = reject
    })
    const held = new Promise<void>(resolve => {
      unlock = resolve
    })
    const task = this.tail.then(async () => {
      if (!this.hasCommitBarrier()) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
      const value = read(structuredClone(this.value))
      let released = false
      grant({
        value,
        release: () => {
          if (!released) {
            released = true
            unlock()
          }
        },
      })
      await held
    }).catch(deny)
    this.tail = task
    return await ready
  }
  async mutate<T>(update: (draft: ChannelConversationState) => T): Promise<T> {
    if (this.closed) throw new Error('CONVERSATION_STORE_CLOSED')
    if (this.commitBarrier && !this.barrierReady) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
    let result!: T
    const task = this.tail.then(async () => {
      if (this.durabilityUncertain) throw new Error('CONVERSATION_STORE_DURABILITY_UNCERTAIN')
      if (this.commitBarrier && !this.barrierReady) throw new Error('CONVERSATION_STORE_UNAVAILABLE')
      const value = structuredClone(this.value)
      result = update(value)
      if (JSON.stringify(value) === JSON.stringify(this.value)) return
      value.revision += 1
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(value) + '\n')
        await handle.sync()
        await handle.close()
        await rename(temporary, this.file)
        // After rename, an error syncing the directory is an uncertain durability outcome.
        // Keep the in-process fence aligned with the visible file; never retry from stale state.
        this.value = value
        try {
          const directory = await open(path.dirname(this.file), 'r')
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        } catch (error) {
          this.durabilityUncertain = true
          throw error
        }
        try {
          await this.commitBarrier?.(structuredClone(value))
        } catch (error) {
          this.durabilityUncertain = true
          throw error
        }
      } finally {
        await handle.close().catch(() => undefined)
        await rm(temporary, { force: true })
      }
    })
    this.tail = task.catch(() => undefined)
    await task
    return result
  }
  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }
}
