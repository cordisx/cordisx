import { recordChannelDispatchFailure } from './channel-dispatch-diagnostic.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelTaskPolicyChange } from './channel-task-policy-change.js'
import { channelPermissionOperation } from './channel-permission-cli.js'
import { channelBindingLabels } from './channel-binding-labels.js'
import { ChannelQuestions } from './channel-questions.js'
import { createChannelMemory } from './channel-memory-composition.js'
import { createChannelFeedback } from './channel-feedback-composition.js'
import { channelCardAction } from './channel-card-actions.js'
import { bindingIdentity, eventThread, identity, sameConversation, thread } from './channel-conversation-refs.js'
import type { ChannelEventRef, ChannelThreadRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { CALLER, type ChannelConversationConsumerInput, isThread } from './channel-conversation-consumer-contract.js'
export type { ChannelConversationConsumerInput } from './channel-conversation-consumer-contract.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { type ChannelCommandAddressing, ChannelCommandUsers } from './channel-command-users.js'
import { ChannelSessionCommands } from './channel-session-commands.js'
import { channelCommandHelp } from '../channel-command-registry.js'
import { CHANNEL_MODEL_COMMANDS } from './channel-model-commands.js'
import { ChannelNativeApprovals } from './channel-native-approvals.js'
import { channelExecutionDispatch } from './channel-execution-dispatch.js'
import { ChannelCreationDefaults } from './channel-creation-defaults.js'
import { channelMessageContext } from './channel-message-context.js'
import { ChannelAgentAccess } from './channel-agent-access.js'
import { channelJobBlocks, reconcileChannelJob, steerChannelQueued } from './channel-conversation-steer.js'
import { ChannelTaskSettings } from './channel-task-settings.js'
import { ChannelContinuationManager } from './channel-continuation-manager.js'
import {
  channelContinuationArguments,
  channelDispatchHandoff,
  claimChannelDispatch,
} from './channel-conversation-dispatch.js'
import { ensureChannelLogicalPersona } from './channel-logical-persona.js'
import {
  callChannelLogicalHistory,
  channelLogicalHistoryAvailable,
  createChannelLogicalHistory,
} from './channel-logical-history.js'
import {
  channelBindingNavigation,
  channelManagementReadback,
  channelPolicyReadback,
  channelPolicySet,
  channelStatusReadback,
} from './channel-management-readback.js'
import {
  type ProfileLogicalConversationOwner,
  profileLogicalConversationOwner,
} from './profile-logical-conversation-owner.js'
import { attachCreatedChannelBinding, channelBindingAction } from './channel-binding-action.js'
import { channelLogicalCommand } from './channel-logical-command.js'
import { logicalContinuationManagement } from './logical-continuation-management.js'
import { assertChannelLogicalHandoff, confirmChannelLogicalHandoff } from './channel-logical-handoff.js'
import { mayFinishChannelJob } from './channel-live-takeover.js'
import {
  channelAutoReplyTarget,
  channelCommandReplyTarget,
  channelReplyDefaults,
  type ChannelReplyMode,
  channelReplyMode,
  channelReplyTarget,
} from './channel-reply-routing.js'
import {
  CHANNEL_COMMANDS,
  channelCommandDenied,
  channelCommandScope,
  channelExact,
  channelGlobalCommandAllowed,
  channelPolicyAllows,
  channelRecord,
  channelText,
  channelWakePrefix,
} from './channel-conversation-policy.js'
import type * as Conversation from './channel-conversation-store.js'
import { ChannelConversationStore } from './channel-conversation-store.js'

export class ChannelConversationConsumer {
  private readonly lifetime = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private pumping: Promise<void> | undefined
  private readonly sessionClaims = new Set<string>()
  private readonly logicalOwner: ProfileLogicalConversationOwner
  private readonly sourceFence: ProfileLogicalConversationOwner['fence']
  private readonly commandUsers = new ChannelCommandUsers()
  private extraNative: (() => ChannelNativeSessions | undefined) | undefined
  private readonly sessionCommands: ChannelSessionCommands
  private readonly approvals: ChannelNativeApprovals
  readonly agentAccess = new ChannelAgentAccess(() => this.store.snapshot(), () => this.extraNative?.())
  readonly taskSettings: ChannelTaskSettings
  private readonly creationDefaults: ChannelCreationDefaults
  readonly questions: ChannelQuestions
  readonly continuation: ChannelContinuationManager
  private readonly logicalHistory?: ReturnType<typeof createChannelLogicalHistory>
  readonly memory
  readonly memoryAuthority
  readonly personas
  readonly feedback: ReturnType<typeof createChannelFeedback>
  private jobOffset = 0
  private constructor(
    private readonly store: ChannelConversationStore,
    private readonly input: ChannelConversationConsumerInput & { readonly file: string },
  ) {
    this.logicalOwner = profileLogicalConversationOwner(store)
    this.sourceFence = this.logicalOwner.fence
    if (input.appId && (input.logicalRuntime || input.logicalRecoveryRequired)) {
      this.logicalHistory = createChannelLogicalHistory({
        store,
        native: () => this.extraNative?.(),
        appId: input.appId,
        profileId: input.profileId,
      })
    }
    ;[this.memory, this.memoryAuthority, this.personas] = createChannelMemory(input.file)
    this.feedback = createChannelFeedback(store, input, this.lifetime.signal)
    this.creationDefaults = new ChannelCreationDefaults(this.store)
    this.questions = new ChannelQuestions(this.store, this.input.access, () => {
      void this.pump()
    })
    this.continuation = new ChannelContinuationManager(this.store, () => this.extraNative?.(), this.sessionClaims)
    this.taskSettings = new ChannelTaskSettings({
      store: this.store,
      native: () => this.extraNative?.(),
      access: this.input.access,
      agent: this.agentAccess,
      notify: (event, text, id) => this.commandReply(id, event, text),
    })
    this.sessionCommands = new ChannelSessionCommands({
      bindings: () => this.bindings(),
      native: () => this.extraNative?.(),
      allowed: (event, command) => channelPolicyAllows(this.store.snapshot().policy, 'command', event, command),
      unbind: id => this.bindingAction('unbind', id),
      tasks: this.taskSettings,
      denied: (event, command) => channelCommandDenied(this.store.snapshot().policy, event, command),
    })
    this.approvals = new ChannelNativeApprovals({
      bindings: () => this.bindings(),
      routineAllowed: (command, threadId, turnId) => this.agentAccess.routine(command, threadId, turnId),
      allowed: (event, command) => channelPolicyAllows(this.store.snapshot().policy, 'command', event, command),
      sendCard: (event, card) =>
        this.input.access()?.sendCard?.(event, card) ?? Promise.reject(new Error('CHANNEL_CARD_UNAVAILABLE')),
      updateCard: (event, messageId, card) =>
        this.input.access()?.updateCard?.(event, messageId, card)
          ?? Promise.reject(new Error('CHANNEL_CARD_UNAVAILABLE')),
      notify: (event, text, operation) => this.commandReply(operation, event, text),
      ...(this.input.report === undefined ? {} : { report: this.input.report }),
    })
    this.timer = setInterval(() => {
      void this.pump()
    }, 2_000)
    this.timer.unref()
  }
  static async open(input: ChannelConversationConsumerInput & { readonly file: string }) {
    return new ChannelConversationConsumer(await ChannelConversationStore.open(input.file), input)
  }
  permissionOperation(operation: string, value: unknown, metadata: unknown) {
    return channelPermissionOperation({
      operation,
      value,
      metadata,
      store: this.store,
      agent: this.agentAccess,
      users: this.commandUsers,
      access: this.input.access,
      signal: this.lifetime.signal,
    })
  }
  assertProgressNotice(token: unknown, source: ChannelEventRef | undefined, sessionId: string | undefined) {
    this.feedback.assertProgress(token, source, sessionId)
  }
  trackProgressDelivery(
    id: string,
    source: ChannelEventRef | undefined,
    session: string | undefined,
    turn: string | undefined,
  ) {
    this.feedback.trackDelivery(id, source, session, turn)
  }
  profileLogicalOwner() {
    return this.logicalOwner
  }
  logicalHistoryCall(params: unknown) {
    return callChannelLogicalHistory(this.logicalHistory, params)
  }
  enterNativeSourceOperation(method: string, params: Readonly<Record<string, unknown>>) {
    return this.sourceFence.enterNative(method, params)
  }
  isNativeSourceMigrating(threadId: string) {
    return this.sourceFence.isMigrating(threadId)
      || ChannelConversationStore.logicalSessionFenced(this.store.snapshot(), threadId)
  }
  assertNativeHandoff(method: string, params: Readonly<Record<string, unknown>>) {
    assertChannelLogicalHandoff(this.store.snapshot(), method, params, this.extraNative?.()?.logicalHandoffPermits)
  }
  bindings(): readonly Conversation.ChannelChatBinding[] {
    return Object.values(this.store.snapshot().bindings)
  }
  commandAllowed(event: ChannelEventRef, command: string): boolean {
    return channelPolicyAllows(this.store.snapshot().policy, 'command', event, command)
  }
  setNativeExtras(native: () => ChannelNativeSessions | undefined) {
    if (this.personas) native()?.setPersonaRegistry?.(this.personas)
    this.extraNative = native
    this.continuation.attachContext()
    this.approvals.attach(native())
  }
  async cardAction(
    ref: import('@cordisx/channel-runtime').ChannelTenantRef,
    action: import('@larksuiteoapi/node-sdk').CardActionEvent,
  ) {
    if (await this.questions.action(ref, action)) return
    return channelCardAction(
      {
        bindings: () => this.bindings(),
        tasks: this.taskSettings,
        approvals: this.approvals,
        reply: (id, event, text) => this.commandReply(id, event, text),
      },
      ref,
      action,
    )
  }
  async executionOperation(operation: string, args: Record<string, unknown>) {
    return channelExecutionDispatch(this.continuation, this.creationDefaults, this.extraNative?.(), operation, args)
  }
  managementReadback() {
    return channelManagementReadback(this.store.snapshot())
  }
  logicalProfilePreference(operation: string, value: unknown) {
    return logicalContinuationManagement(
      {
        owner: this.logicalOwner,
        ...(this.input.appId ? { appId: this.input.appId } : {}),
        profileId: this.input.profileId,
        available: !!(this.input.logicalRuntime || this.input.logicalRecoveryRequired),
        recoveryRequired: !!this.input.logicalRecoveryRequired,
      },
      operation,
      value,
    )
  }
  async bindingNavigation(id: string) {
    return channelBindingNavigation(() => this.bindings(), this.extraNative?.(), this.lifetime.signal, id)
  }
  async bindingLabels(ids?: readonly string[]) {
    return channelBindingLabels(this.bindings(), this.input.access(), this.extraNative?.(), ids)
  }
  policy() {
    return channelPolicyReadback(this.store.snapshot())
  }
  async policySet(value: unknown, expectedRevision: number) {
    const result = await channelPolicySet(this.store, value, expectedRevision)
    void this.pump()
    return result
  }
  async bindingAction(action: 'archive' | 'restore' | 'unbind', id: string): Promise<boolean> {
    return channelBindingAction(this.store, action, id, sessionId => this.sourceFence.isMigrating(sessionId))
  }
  async bind(value: unknown, sessionId: string): Promise<Conversation.ChannelChatBinding> {
    const args = channelRecord(value)
    channelExact(args, ['channel', 'mode', 'autoReply', 'replyMode', 'replyFallbackMode'])
    const channel = thread(args.channel)
    const mode = args.mode ?? 'listen'
    if (
      !['listen', 'deliver'].includes(String(mode))
      || args.autoReply !== undefined && typeof args.autoReply !== 'boolean'
      || !isThread(sessionId)
    ) throw new Error('INVALID_REQUEST')
    const replyOptions = {
      ...(args.replyMode == null ? {} : { replyMode: channelReplyMode(args.replyMode, true) }),
      ...(args.replyFallbackMode == null
        ? {}
        : { replyFallbackMode: channelReplyMode(args.replyFallbackMode) as ChannelReplyMode }),
    }
    const access = this.input.access()
    if (
      !access?.accounts().some(account =>
        sameConversation({
          ...account.ref,
          conversationId: channel.conversationId,
          kind: channel.kind,
          threadId: channel.threadId,
          semantics: channel.semantics,
        }, channel) && account.state === 'ready'
      )
    ) {
      throw new Error('CONNECTION_NOT_READY')
    }
    if (!await this.input.native()?.exists(sessionId)) throw new Error('SESSION_UNAVAILABLE')
    if (this.lifetime.signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
    return this.store.mutate(state => {
      if (this.sourceFence.isMigrating(sessionId)) throw new Error('CONTINUATION_PENDING')
      if (ChannelConversationStore.logicalSessionFenced(state, sessionId)) throw new Error('CONTINUATION_PENDING')
      const id = Object.values(state.bindings).find(binding =>
        binding.sessionId === sessionId
        && sameConversation(binding.channel, channel)
      )?.id ?? bindingIdentity(this.input.profileId, channel, sessionId)
      const prior = state.bindings[id]
      if (prior?.state === 'active') {
        const updated = {
          ...prior,
          ...replyOptions,
          mode: mode as 'listen' | 'deliver',
          autoReply: args.autoReply === true,
        }
        if (args.replyMode === null) delete updated.replyMode
        if (args.replyFallbackMode === null) delete updated.replyFallbackMode
        state.bindings[id] = updated
        return updated
      }
      const binding: Conversation.ChannelChatBinding = {
        id,
        channel,
        sessionId,
        hostId: 'local',
        profileId: this.input.profileId,
        createdAt: new Date().toISOString(),
        fromSequence: state.nextSequence,
        mode: mode as 'listen' | 'deliver',
        autoReply: args.autoReply === true,
        ...replyOptions,
        state: 'active',
      }
      state.bindings[id] = binding
      return binding
    })
  }
  async unbind(value: unknown, sessionId: string): Promise<number> {
    const args = channelRecord(value)
    channelExact(args, ['bindingId', 'channel'])
    const selected = args.channel === undefined ? undefined : thread(args.channel)
    return this.store.mutate(state => {
      let count = 0
      for (const [id, binding] of Object.entries(state.bindings)) {
        if (
          binding.sessionId !== sessionId || args.bindingId !== undefined && id !== args.bindingId
          || selected !== undefined && !sameConversation(binding.channel, selected)
        ) continue
        delete state.bindings[id]
        count += 1
        for (const job of Object.values(state.jobs)) {
          if (job.bindingId === id && job.state === 'queued') job.state = 'cancelled'
        }
      }
      return count
    })
  }
  status(sessionId?: string) {
    return channelStatusReadback(this.store.snapshot(), sessionId)
  }
  /** Select the final-response route for this exact incoming turn; this operation never sends a message. */
  async selectReplyMode(value: unknown, sessionId: string, turnId?: string) {
    const args = channelRecord(value)
    channelExact(args, ['operationId', 'mode'])
    const operationId = channelText(args.operationId, 128)
    const mode = channelReplyMode(args.mode) as ChannelReplyMode
    // Wait for the reserved dispatch if a native tool arrives before start() returns; never retry it.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = this.store.snapshot().jobs[operationId]
      if (!job || job.state !== 'dispatching' || this.lifetime.signal.aborted) break
      if (job.sessionId !== undefined && job.sessionId !== sessionId) throw new Error('REPLY_OPERATION_NOT_FOUND')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (this.lifetime.signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
    return this.store.mutate(state => {
      const job = state.jobs[operationId]
      if (!job || job.sessionId !== sessionId || turnId !== undefined && job.turnId !== turnId) {
        throw new Error('REPLY_OPERATION_NOT_FOUND')
      }
      if (job.state !== 'running' || job.replyTarget !== undefined) throw new Error('REPLY_ALREADY_RESERVED')
      const record = state.inputs[job.recordId]
      if (!record) throw new Error('REPLY_OPERATION_NOT_FOUND')
      if (mode !== 'none') channelReplyTarget(record.input.source.event, mode)
      job.replyMode = mode
      return { operationId, mode, sendsMessage: false }
    })
  }
  history(value: unknown, sessionId: string) {
    const args = channelRecord(value)
    channelExact(args, ['afterSequence', 'limit'])
    const afterSequence = args.afterSequence ?? 0, limit = args.limit ?? 50
    if (!isThread(sessionId)) throw new Error('INVALID_REQUEST')
    if (
      !Number.isSafeInteger(afterSequence) || Number(afterSequence) < 0 || !Number.isInteger(limit)
      || Number(limit) < 1 || Number(limit) > 100
    ) throw new Error('INVALID_CURSOR')
    const state = this.store.snapshot()
    const bindings = Object.values(state.bindings).filter(binding =>
      binding.sessionId === sessionId && binding.state === 'active'
    )
    const messages = Object.values(state.inputs).filter(record =>
      record.accepted && record.sequence > Number(afterSequence)
      && bindings.some(binding =>
        record.sequence >= binding.fromSequence && sameConversation(binding.channel, record.input.source.event)
      )
    )
      .sort((left, right) => left.sequence - right.sequence).slice(0, Number(limit))
    return {
      status: 'ok',
      afterSequence: messages.at(-1)?.sequence ?? Number(afterSequence),
      messages: messages.map(record => {
        const name = record.addressing?.senderName ?? this.input.access()?.senderName?.(record.input.source.event)
        return name
          ? { ...record, addressing: { mentions: record.addressing?.mentions ?? [], senderName: name } }
          : record
      }),
    }
  }
  async receive(
    recordId: string,
    message: ChannelUserInput,
    mentionedBot = false,
    persisted = true,
    addressing?: ChannelCommandAddressing,
  ): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const fresh = await this.store.mutate(state => {
      const prior = state.inputs[recordId]
      if (prior) {
        state.inputs[recordId] = {
          ...prior,
          mentionedBot: prior.mentionedBot || mentionedBot,
          persisted: prior.persisted || persisted,
          ...(addressing === undefined ? {} : { addressing: structuredClone(addressing) }),
        }
        return
      }
      state.inputs[recordId] = {
        recordId,
        input: structuredClone(message),
        mentionedBot,
        sequence: state.nextSequence++,
        persisted,
        ...(addressing === undefined ? {} : { addressing: structuredClone(addressing) }),
        accepted: false,
        routed: false,
      }
      return true
    })
    if (fresh) this.feedback.inputReceived(recordId, message.source.event)
    void this.pump()
  }
  private async catchup(): Promise<void> {
    const access = this.input.access()
    if (!access) return
    const accounts = access.accounts()
    if (!accounts.length) return
    const cursor = this.store.snapshot().inputCursor
    const read = await access.runtime.inputsSince(
      CALLER,
      accounts.map(account => ({ account: account.ref })),
      cursor,
      100,
    )
    if (this.lifetime.signal.aborted) return
    for (const message of read.messages) await this.receive(message.recordId, message.input)
    if (read.cursor !== cursor) {
      await this.store.mutate(state => {
        state.inputCursor = read.cursor
      })
    }
  }
  async pump(): Promise<void> {
    if (this.lifetime.signal.aborted || this.pumping) return this.pumping
    if (this.input.logicalRecoveryRequired && !this.store.hasCommitBarrier()) return
    this.pumping = (async () => {
      this.approvals.attach(this.extraNative?.())
      this.feedback.sync()
      await this.approvals.expire()
      void this.taskSettings.pump().catch(() => this.input.report?.('CHANNEL_TASK_SETTINGS_UNAVAILABLE'))
      await this.catchup()
      for (
        const record of Object.values(this.store.snapshot().inputs).filter(record => record.persisted && !record.routed)
          .slice(0, 100)
      ) {
        await this.route(record)
      }
      const jobs = Object.values(this.store.snapshot().jobs).filter(job =>
        ['queued', 'running', 'replying', 'reconciliation-required'].includes(job.state)
      )
      const offset = jobs.length ? this.jobOffset % jobs.length : 0
      const selected = [...jobs.slice(offset), ...jobs.slice(0, offset)].slice(0, 8)
      this.jobOffset = offset + selected.length
      await Promise.all(selected.map(async job => {
        try {
          await this.advance(job)
          this.feedback.jobUpdated(job.recordId)
          await this.feedback.completed(job.recordId).catch(() =>
            this.input.report?.('CHANNEL_FEEDBACK_COMPLETION_UNKNOWN')
          )
        } catch (error) {
          await recordChannelDispatchFailure(this.store, job.id, error, this.input.report)
        }
      }))
      await this.continuation.pumpIdle(this.lifetime.signal)
      await this.feedback.catchup()
      await this.continuation.pumpLive()
    })().catch(error =>
      this.input.report?.(
        error instanceof Error && /^[A-Z_]+$/u.test(error.message)
          ? error.message
          : 'CHANNEL_CONSUMER_FAILED',
      )
    ).finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  }
  private async route(record: Conversation.ChannelConversationInput): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const state = this.store.snapshot(), event = record.input.source.event, policy = state.policy
    const text = record.input.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    const prefix = channelWakePrefix(policy, event, text)
    const received = event.kind === 'direct' || policy.groupReception === 'all' || record.mentionedBot
    if (received) {
      await this.store.mutate(state => {
        state.inputs[record.recordId]!.accepted = true
      })
    }
    const addressed = event.kind === 'direct' || record.mentionedBot || prefix !== undefined
    const command = /^\/([a-z-]+)(?:\s+(.*))?$/u.exec(prefix === undefined ? text : text.slice(prefix.length).trim())
    if (
      received && addressed && policy.enabled && command
    ) {
      // Consume a command before performing its effects. Replay never repeats a command reply.
      await this.store.mutate(state => {
        state.inputs[record.recordId]!.routed = true
      })
      try {
        if ((CHANNEL_COMMANDS as readonly string[]).includes(command[1]!)) {
          await this.command(record, command[1]!, command[2] ?? '')
        } else {await this.commandReply(
            record.recordId + ':unknown-command',
            event,
            `未找到指令 /${command[1]}。用 /help 查看可用指令。`,
          )}
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : 'COMMAND_FAILED'
        await this.commandReply(
          record.recordId + ':command-error',
          event,
          `/${command[1]} 未完成：${code}。\n${channelCommandHelp(command[1])}`,
        )
      }
      return
    } else if (received && addressed && policy.enabled && channelDispatchAllowed(state, event)) {
      this.feedback.accepted(record.recordId)
      // Acknowledge receipt before a busy conversation is ready to create a job.
      void this.feedback.received(record.recordId).catch(() => this.input.report?.('CHANNEL_FEEDBACK_UNAVAILABLE'))
      const waiting = await this.store.mutate(state => {
        const bindings = Object.values(state.bindings).filter(binding =>
          binding.state === 'active'
          && binding.mode === 'deliver' && record.sequence >= binding.fromSequence
          && sameConversation(binding.channel, event)
        )
        for (const binding of bindings) {
          const id = `channel:${identity([record.recordId, binding.sessionId])}`
          state.jobs[id] ??= {
            id,
            recordId: record.recordId,
            bindingId: binding.id,
            sessionId: binding.sessionId,
            autoCreate: false,
            state: 'queued',
          }
        }
        if (
          !bindings.length && policy.autoCreate
          && !Object.values(state.bindings).some(binding => sameConversation(binding.channel, event))
        ) {
          if (
            Object.values(state.jobs).some(job =>
              job.autoCreate && state.inputs[job.recordId]
              && sameConversation(state.inputs[job.recordId]!.input.source.event, event)
              && !['failed', 'cancelled', 'completed'].includes(job.state)
            )
          ) return true
          const id = `channel:${identity([record.recordId, 'create'])}`
          state.jobs[id] ??= { id, recordId: record.recordId, autoCreate: true, state: 'queued' }
        }
        return false
      })
      if (waiting) return
      void this.feedback.routed(record.recordId).catch(() => this.input.report?.('CHANNEL_FEEDBACK_UNAVAILABLE'))
    }
    await this.store.mutate(state => {
      state.inputs[record.recordId]!.routed = true
    })
    await this.feedback.routed(record.recordId)
  }
  private async command(
    record: Conversation.ChannelConversationInput,
    command: string,
    argument: string,
  ): Promise<void> {
    const event = record.input.source.event
    if (
      ![
        'choose',
        'permissions',
        'work-mode',
        ...CHANNEL_MODEL_COMMANDS,
      ].includes(command)
      && !channelPolicyAllows(this.store.snapshot().policy, 'command', event, command)
    ) {
      await this.commandReply(
        record.recordId + ':command-denied',
        event,
        `当前用户没有执行 /${command} 的权限。可在 CordisX 的用户组与指令规则中配置。`,
      )
      return
    }
    const handled = await this.sessionCommands.handle(event, command, argument)
    if (handled !== undefined) {
      await this.commandReply(record.recordId + ':command', event, handled)
      return
    }
    if (command === 'continue-provider') {
      const desktopGrant = this.input.logicalRecoveryRequired && this.store.hasCommitBarrier()
        && argument.trim().startsWith('authorize-desktop ')
      const message = await channelLogicalCommand({
        store: this.store,
        native: this.input.logicalRuntime || desktopGrant ? this.extraNative?.() : undefined,
        fence: this.sourceFence,
        claims: this.sessionClaims,
        ...((this.input.logicalRuntime || desktopGrant) && this.input.appId ? { appId: this.input.appId } : {}),
        ...(desktopGrant ? { desktopGrants: this.logicalOwner.desktopChannelGrants } : {}),
        profileId: this.input.profileId,
        event,
        recordId: record.recordId,
        argument,
      })
      await this.commandReply(record.recordId + ':command', event, message)
      return
    }
    if (command === 'approvals' || command === 'approve' || command === 'deny') {
      const [id, mode, extra] = argument.trim().split(/\s+/u)
      if (
        command === 'approvals' && argument.trim() || command === 'deny' && mode || extra
        || mode && !['once', 'session'].includes(mode)
      ) throw new Error('INVALID_COMMAND_ARGUMENTS')
      const result = command === 'approvals'
        ? this.approvals.list(event)
        : await this.approvals.answer(
          event,
          id || undefined,
          command === 'deny' ? 'decline' : mode === 'session' ? 'acceptForSession' : 'accept',
        )
      await this.commandReply(record.recordId + ':command', event, result)
      return
    }
    if (command === 'bind') {
      if (argument === 'new') {
        const id = `channel:${identity([record.recordId, 'explicit-create'])}`
        await this.store.mutate(state => {
          state.jobs[id] ??= {
            id,
            recordId: record.recordId,
            autoCreate: true,
            creationReason: 'bind-command',
            state: 'queued',
          }
        })
        await this.commandReply(record.recordId + ':command', event, '已提交创建并绑定；完成后可用 /bind-status 查看。')
        return
      }
      if (!isThread(argument)) {
        await this.commandReply(record.recordId + ':command', event, 'Usage: /bind <Codex chat ID>')
        return
      }
      await this.bind({ channel: eventThread(event), mode: 'deliver', autoReply: true }, argument)
    } else if (command === 'unbind') {
      if (argument && !isThread(argument)) {
        await this.commandReply(record.recordId + ':command', event, 'Usage: /unbind [Codex chat ID]')
        return
      }
      for (
        const binding of this.bindings().filter(binding =>
          sameConversation(binding.channel, event)
          && (!argument || binding.sessionId === argument)
        )
      ) await this.bindingAction('unbind', binding.id)
    } else if (['messages-on', 'messages-off', 'allow-user', 'deny-user', 'reset-user', 'wake'].includes(command)) {
      const parts = argument.trim().split(/\s+/u).filter(Boolean)
      const global = parts.includes('--global')
      if (global && !channelGlobalCommandAllowed(this.store.snapshot().policy, event, command)) {
        await this.commandReply(record.recordId + ':command-denied', event, '当前用户没有修改全局策略的权限。')
        return
      }
      let userArgument = parts.filter(part => part !== '--global').join(' ')
      if (
        ['messages-on', 'messages-off'].includes(command) && userArgument
        || command.includes('user') && !userArgument
        || command === 'wake' && !userArgument
      ) {
        await this.commandReply(record.recordId + ':command', event, `Invalid /${command} arguments`)
        return
      }
      if (command.includes('user')) {
        const access = this.input.access()
        const resolved = await this.commandUsers.resolve({
          event,
          command,
          argument: userArgument,
          global,
          ...(access?.generation === undefined ? {} : { generation: access.generation }),
          ...(record.addressing === undefined ? {} : { addressing: record.addressing }),
          ...(access?.users === undefined ? {} : { directory: () => access.users!(event) }),
        })
        if ('message' in resolved) {
          await this.commandReply(record.recordId + ':command', event, resolved.message)
          return
        }
        if (access?.generation !== this.input.access()?.generation) {
          await this.commandReply(record.recordId + ':command', event, '连接已变化，请重新指定目标用户。')
          return
        }
        userArgument = resolved.userId
      }
      const scope = channelCommandScope(event, global)
      if (this.lifetime.signal.aborted) return
      const applied = await this.store.mutate(state => {
        // Name lookup is asynchronous. A policy change during lookup must still control this effect.
        if (
          !state.policy.enabled || !channelPolicyAllows(state.policy, 'command', event, command)
          || global && !channelGlobalCommandAllowed(state.policy, event, command)
        ) return false
        channelTaskPolicyChange(state, scope, command, userArgument)
        return true
      })
      if (!applied) return
    }
    const bindings = this.bindings().filter(binding => sameConversation(binding.channel, event))
    await this.commandReply(
      record.recordId + ':command',
      event,
      command.endsWith('status')
        ? JSON.stringify({
          bindings: bindings.map(binding => ({
            sessionId: binding.sessionId,
            state: binding.state,
            mode: binding.mode,
          })),
          enabled: this.store.snapshot().policy.enabled,
          messagesAllowed: channelDispatchAllowed(this.store.snapshot(), event),
        })
        : `/${command}: completed`,
    )
  }
  private async advance(job: Conversation.ChannelConversationJob): Promise<void> {
    const state = this.store.snapshot(), record = state.inputs[job.recordId], native = this.input.native()
    if (!record || !native || this.lifetime.signal.aborted) return
    const event = record.input.source.event
    if (job.state === 'reconciliation-required') {
      return await reconcileChannelJob(this.store, native, job, record, this.input.profileId)
    }
    if (job.state === 'queued') {
      if (!state.policy.enabled || !channelDispatchAllowed(state, event)) return
      if (job.sessionId && ChannelConversationStore.logicalSourceFenced(state, job.sessionId)) return
      if (job.bindingId && state.bindings[job.bindingId]?.state !== 'active') {
        await this.store.mutate(state => {
          state.jobs[job.id]!.state = 'cancelled'
        })
        return
      }
      if (
        job.sessionId
        && Object.values(state.jobs).some(other =>
          other.id !== job.id && other.sessionId === job.sessionId
          && channelJobBlocks(state, other)
        )
      ) {
        await steerChannelQueued(
          {
            store: this.store,
            access: this.input.access,
            signal: this.lifetime.signal,
            claims: this.sessionClaims,
            ready: sessionId => this.taskSettings.ready(sessionId),
          },
          job,
          record,
          native,
        )
        return
      }
      if (job.sessionId && (!this.taskSettings.ready(job.sessionId) || this.sessionClaims.has(job.sessionId))) return
      if (
        job.sessionId && ['dispatching', 'unknown'].includes(state.continuations[job.sessionId]?.intent?.state ?? '')
      ) return
      if (job.sessionId) this.sessionClaims.add(job.sessionId)
      let continuation: Awaited<ReturnType<ChannelContinuationManager['reserve']>>
      try {
        continuation = job.sessionId
          ? await this.continuation.reserve(job.sessionId, 'auto')
          : undefined
        const dispatching = await this.store.mutate(state => claimChannelDispatch(state, job, event, continuation))
        if (!dispatching) return
        if (this.lifetime.signal.aborted) {
          await this.store.mutate(state => {
            if (continuation) {
              this.continuation.failDispatch(state, continuation, job.id)
            } else state.jobs[job.id]!.state = 'queued'
          })
          return
        }
        const captured = this.store.snapshot()
        const defaults = captured.jobs[job.id]!.replyDefaults!
        const message: ChannelUserInput = job.creationReason === 'bind-command'
          ? {
            ...record.input,
            content: [{
              type: 'text' as const,
              text:
                'The user requested creating and binding this Codex chat through /bind new. The Host has processed the command. Wait for subsequent channel messages; do not execute /bind again or send an unsolicited greeting.',
            }],
          }
          : record.input
        const context = await this.input.access()?.messageContext?.(message, record.addressing)
          .catch(() => undefined) ?? channelMessageContext(message, record.addressing)
        const logicalHistory = !continuation && channelLogicalHistoryAvailable(captured, event, job.sessionId)
        if (!await ensureChannelLogicalPersona(this.personas, this.store, job.id, event, this.input)) return
        const handoff = await channelDispatchHandoff(this.store, job.id, event)
        if (handoff === false) return
        const result = await native.start(
          job.id,
          message,
          continuation ? undefined : job.sessionId,
          this.lifetime.signal,
          {
            ...defaults,
            enabled: captured.jobs[job.id]!.finalDeliveryEnabled === true,
          },
          context,
          job.autoCreate ? await this.taskSettings.defaults(event) : undefined,
          job.autoCreate ? this.creationDefaults.read().settings : undefined,
          ...channelContinuationArguments(continuation, this.continuation, logicalHistory, handoff),
        )
        const sourceCurrent = !continuation
          || result.state === 'running' && await this.continuation.sourceCurrent(continuation)
        await this.store.mutate(state => {
          const input = state.inputs[job.recordId]
          if (input && context.sender.name && !input.addressing?.senderName) {
            state.inputs[job.recordId] = {
              ...input,
              addressing: { mentions: input.addressing?.mentions ?? [], senderName: context.sender.name },
            }
          }
          const current = state.jobs[job.id]!
          if (
            continuation
            && !this.continuation.finishDispatch(
              state,
              continuation,
              job.id,
              sourceCurrent ? result : { ...result, state: 'reconciliation-required' },
            )
          ) return
          if (result.state === 'running' && result.sessionId && result.turnId) {
            confirmChannelLogicalHandoff(state, job.id, result.sessionId, result.turnId)
          }
          current.state = result.state === 'busy' ? 'queued' : result.state
          if (result.sessionId) current.sessionId = result.sessionId
          if (result.turnId) current.turnId = result.turnId
          if (result.code) current.code = result.code
          if (job.autoCreate && result.sessionId) {
            attachCreatedChannelBinding(state, current, record, result.sessionId, this.input.profileId)
          }
        })
      } catch (error) {
        if (continuation) {
          await this.store.mutate(state => {
            this.continuation.failDispatch(state, continuation!, job.id)
          })
        }
        throw error
      } finally {
        if (job.sessionId) this.sessionClaims.delete(job.sessionId)
      }
      return
    }
    if (!job.sessionId || !job.turnId || !mayFinishChannelJob(state, job)) return
    const binding = job.bindingId === undefined ? undefined : state.bindings[job.bindingId]
    const defaults = job.replyDefaults ?? channelReplyDefaults(state.policy, event, binding)
    const mode = job.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode)
    const includeFinal = job.finalDeliveryEnabled === true && state.policy.enabled && state.policy.autoReply
      && binding?.state === 'active' && binding.autoReply && mode !== 'none'
      && channelDispatchAllowed(state, event) && channelPolicyAllows(state.policy, 'send', event)
    const completion = await native.completion(job.sessionId, job.turnId, includeFinal)
    if (completion.state === 'running') return
    if (completion.state === 'failed') {
      await this.store.mutate(state => {
        if (!mayFinishChannelJob(state, job)) return
        state.jobs[job.id]!.state = 'failed'
        state.jobs[job.id]!.code = completion.code ?? 'NATIVE_TURN_FAILED'
      })
      return
    }
    if (this.lifetime.signal.aborted) return
    if (!includeFinal) {
      await this.store.mutate(state => {
        if (!mayFinishChannelJob(state, job)) return
        state.jobs[job.id]!.state = 'completed'
      })
      return
    }
    const access = this.input.access()
    const deliveryId = `delivery:${identity([job.id, event])}`
    const existingTarget = access?.runtime.deliverySnapshot(deliveryId, CALLER)?.target
    const target = await this.store.mutate(state => {
      if (!mayFinishChannelJob(state, job)) return undefined
      const current = state.jobs[job.id]!
      const binding = current.bindingId === undefined ? undefined : state.bindings[current.bindingId]
      const defaults = current.replyDefaults ?? channelReplyDefaults(state.policy, event, binding)
      const mode = current.replyMode ?? (defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode)
      if (
        current.finalDeliveryEnabled !== true || !state.policy.enabled || !state.policy.autoReply
        || !channelDispatchAllowed(state, event)
        || binding?.state !== 'active' || !binding.autoReply || !completion.text || mode === 'none'
      ) {
        current.state = 'completed'
        return undefined
      }
      try {
        const replyTarget = existingTarget ?? channelAutoReplyTarget(event, defaults, current.replyMode)
        if (!replyTarget) throw new Error('INVALID_REPLY_MODE')
        current.replyTarget ??= replyTarget
      } catch (error) {
        current.state = 'failed'
        current.code = error instanceof Error && error.message === 'REPLY_MESSAGE_REQUIRED'
          ? error.message
          : 'INVALID_REPLY_MODE'
        return undefined
      }
      current.state = 'replying'
      return current.replyTarget
    })
    if (target && completion.text) {
      const receipt = await this.reply(job.id, event, completion.text, target)
      await this.store.mutate(state => {
        const current = state.jobs[job.id]!
        current.state = receipt === 'sent' || receipt === 'denied'
          ? 'completed'
          : receipt === 'dead-letter' || receipt === 'cancelled'
          ? 'failed'
          : 'replying'
        if (current.state === 'failed') current.code = 'CHANNEL_DELIVERY_FAILED'
      })
    }
  }
  private async reply(
    operation: string,
    event: ChannelEventRef,
    text: string,
    reservedTarget?: ChannelThreadRef,
  ): Promise<string> {
    const access = this.input.access()
    if (!access || this.lifetime.signal.aborted || !channelPolicyAllows(this.store.snapshot().policy, 'send', event)) {
      return 'denied'
    }
    const deliveryId = `delivery:${identity([operation, event])}`
    const defaults = channelReplyDefaults(this.store.snapshot().policy, event)
    const mode = defaults.mode === 'agent' ? defaults.fallbackMode : defaults.mode
    if (!reservedTarget && mode === 'none') return 'denied'
    const target = reservedTarget ?? access.runtime.deliverySnapshot(deliveryId, CALLER)?.target
      ?? channelAutoReplyTarget(event, defaults)
    if (!target) return 'denied'
    await access.runtime.notifyOnce({ target, kind: 'reply', text }, CALLER, deliveryId)
    if (this.lifetime.signal.aborted) return 'queued'
    await access.drain(event)
    return access.runtime.deliverySnapshot(deliveryId, CALLER)?.state ?? 'unavailable'
  }
  private async commandReply(operation: string, event: ChannelEventRef, text: string): Promise<string> {
    try {
      return await this.reply(
        operation,
        event,
        text,
        channelCommandReplyTarget(event, this.input.access()?.replyCapabilities?.(event)),
      )
    } catch {
      // A second error reply could duplicate an outbound effect whose result is unknown.
      this.input.report?.('CHANNEL_COMMAND_REPLY_RESULT_UNKNOWN')
      return 'unknown'
    }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.feedback.dispose()
    clearInterval(this.timer)
    await this.pumping
    this.commandUsers.dispose()
    this.sessionCommands.dispose()
    this.approvals.dispose()
    this.continuation.dispose()
    this.logicalOwner.desktopChannelGrants.clear()
    await this.store.close()
  }
  sendAllowed(event: ChannelEventRef): boolean {
    return channelPolicyAllows(this.store.snapshot().policy, 'send', event)
  }
}
