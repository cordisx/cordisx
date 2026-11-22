import { ChannelQuestions } from './channel-questions.js'
import { ChannelFeedback } from './channel-feedback.js'
import { channelCardAction } from './channel-card-actions.js'
import { bindingIdentity, eventThread, identity, sameConversation, thread } from './channel-conversation-refs.js'
import type { ChannelEventRef, ChannelThreadRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { CALLER, type ChannelConversationConsumerInput, isThread } from './channel-conversation-consumer-contract.js'
export type { ChannelConversationConsumerInput } from './channel-conversation-consumer-contract.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { type ChannelCommandAddressing, ChannelCommandUsers } from './channel-command-users.js'
import { ChannelSessionCommands } from './channel-session-commands.js'
import { channelCommandHelp } from '../channel-command-registry.js'
import { ChannelNativeApprovals } from './channel-native-approvals.js'
import { chatExecutionOperation } from './chat-execution-operation.js'
import { ChannelCreationDefaults } from './channel-creation-defaults.js'
import { channelMessageContext } from './channel-message-context.js'
import { ChannelAgentAccess } from './channel-agent-access.js'
import { ChannelTaskSettings } from './channel-task-settings.js'
import { ChannelContinuationManager } from './channel-continuation-manager.js'
import { mayFinishChannelJob } from './channel-live-takeover.js'
import {
  channelCommandReplyTarget,
  channelReplyDefaults,
  type ChannelReplyMode,
  channelReplyMode,
  channelReplyTarget,
} from './channel-reply-routing.js'
import {
  CHANNEL_COMMANDS,
  channelCommandDenied,
  channelExact,
  channelPolicyAllows,
  channelRecord,
  channelSameScope,
  channelText,
  channelWakePrefix,
  parseChannelConversationPolicy,
} from './channel-conversation-policy.js'
import {
  type ChannelChatBinding,
  type ChannelConversationInput,
  type ChannelConversationJob,
  ChannelConversationStore,
} from './channel-conversation-store.js'

/** The Host consumes sourced Channel inputs; transport core never learns about Codex tasks or policies. */
export class ChannelConversationConsumer {
  private readonly feedback: ChannelFeedback
  private readonly lifetime = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private pumping: Promise<void> | undefined
  private readonly sessionClaims = new Set<string>()
  private readonly commandUsers = new ChannelCommandUsers()
  private extraNative: (() => ChannelNativeSessions | undefined) | undefined
  private readonly sessionCommands: ChannelSessionCommands
  private readonly approvals: ChannelNativeApprovals
  readonly agentAccess = new ChannelAgentAccess(() => this.store.snapshot(), () => this.extraNative?.())
  readonly taskSettings: ChannelTaskSettings
  private readonly creationDefaults: ChannelCreationDefaults
  readonly questions: ChannelQuestions
  readonly continuation: ChannelContinuationManager
  private jobOffset = 0
  private constructor(
    private readonly store: ChannelConversationStore,
    private readonly input: ChannelConversationConsumerInput,
  ) {
    this.feedback = new ChannelFeedback({
      store: this.store,
      access: this.input.access,
      turnState: async (sessionId: string, turnId: string) =>
        this.extraNative?.()?.liveTurnControl().turnState(sessionId, turnId) ?? 'unknown',
      allows: channelPolicyAllows,
      replyDefaults: channelReplyDefaults,
      replyTarget: channelReplyTarget,
      signal: this.lifetime.signal,
      report: this.input.report,
    })
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
  bindings(): readonly ChannelChatBinding[] {
    return Object.values(this.store.snapshot().bindings)
  }
  commandAllowed(event: ChannelEventRef, command: string): boolean {
    return channelPolicyAllows(this.store.snapshot().policy, 'command', event, command)
  }
  setNativeExtras(native: () => ChannelNativeSessions | undefined) {
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
    if (operation.startsWith('continuation-defaults') || operation.startsWith('continuation-live-policy')) {
      return this.continuation.defaultsOperation(operation, args)
    }
    if (operation.startsWith('channel-execution-defaults')) return this.creationDefaults.operation(operation, args)
    return chatExecutionOperation(this.extraNative?.(), operation, args)
  }
  managementReadback() {
    const state = this.store.snapshot()
    return {
      revision: state.revision,
      bindings: Object.values(state.bindings),
      senders: Object.values(state.inputs).flatMap(record =>
        record.addressing?.senderName
          ? [{ event: record.input.source.event, name: record.addressing.senderName }]
          : []
      ),
      deliveries: Object.values(state.jobs).flatMap(job =>
        job.deliveryId && job.sessionId && state.inputs[job.recordId]
          ? [{
            deliveryId: job.deliveryId,
            sessionId: job.sessionId,
            event: state.inputs[job.recordId]!.input.source.event,
          }]
          : []
      ),
    }
  }
  async bindingNavigation(id: string) {
    const binding = this.bindings().find(binding => binding.id === id)
    const native = this.extraNative?.()
    if (!binding || !native || this.lifetime.signal.aborted || !await native.exists(binding.sessionId)) return undefined
    if (this.lifetime.signal.aborted || this.bindings().find(item => item.id === id)?.sessionId !== binding.sessionId) {
      return undefined
    }
    return binding.sessionId
  }
  async bindingLabels(ids?: readonly string[]) {
    const native = this.extraNative?.()
    return Promise.all(
      this.bindings().filter(binding => ids === undefined || ids.includes(binding.id)).map(async binding => {
        const event: ChannelEventRef = { ...binding.channel, eventId: 'display' }
        const conversationName = await this.input.access()?.name?.(event).catch(() => undefined)
        return {
          bindingId: binding.id,
          sessionName: await native?.label(binding.sessionId).catch(() => undefined) ?? 'Codex 对话',
          conversationName: conversationName ?? (binding.channel.kind === 'direct' ? '私聊' : '群聊'),
        }
      }),
    )
  }
  policy() {
    const state = this.store.snapshot()
    return { revision: state.policyRevision, policy: state.policy }
  }
  async policySet(value: unknown, expectedRevision: number) {
    const policy = parseChannelConversationPolicy(value)
    await this.store.mutate(state => {
      if (state.policyRevision !== expectedRevision) throw new Error('REVISION_CONFLICT')
      state.policy = policy
      state.policyRevision += 1
    })
    void this.pump()
    return this.policy()
  }
  async bindingAction(action: 'archive' | 'restore' | 'unbind', id: string): Promise<boolean> {
    return this.store.mutate(state => {
      const binding = state.bindings[id]
      if (!binding) return false
      if (action === 'unbind') delete state.bindings[id]
      else binding.state = action === 'archive' ? 'archived' : 'active'
      for (const job of Object.values(state.jobs)) {
        if (job.bindingId === id && job.state === 'queued' && action !== 'restore') {
          job.state = 'cancelled'
        }
      }
      return true
    })
  }
  async bind(value: unknown, sessionId: string): Promise<ChannelChatBinding> {
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
      const binding: ChannelChatBinding = {
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
    const state = this.store.snapshot()
    return {
      status: 'ok',
      revision: state.revision,
      enabled: state.policy.enabled,
      bindings: Object.values(state.bindings).filter(binding =>
        sessionId === undefined || binding.sessionId === sessionId
      ),
      jobs: Object.values(state.jobs).filter(job => sessionId === undefined || job.sessionId === sessionId)
        .map(({ id, state, sessionId, turnId, code, replyDefaults, replyMode }) => ({
          id,
          state,
          sessionId,
          turnId,
          code,
          replyDefaults,
          replyMode,
        })),
    }
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
    await this.store.mutate(state => {
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
    })
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
    this.pumping = (async () => {
      this.approvals.attach(this.extraNative?.())
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
        } catch {
          await this.store.mutate(state => {
            const current = state.jobs[job.id]
            if (current?.state === 'dispatching') {
              current.state = 'reconciliation-required'
              current.code = 'NATIVE_EFFECT_UNCERTAIN'
            } else if (current?.state === 'running') current.code = 'NATIVE_READBACK_UNAVAILABLE'
          })
        }
      }))
      await this.continuation.pumpIdle(this.lifetime.signal)
      for (
        const record of Object.values(this.store.snapshot().inputs).filter(record =>
          record.feedback?.reaction && !record.feedback.completionAttempted
        ).slice(0, 100)
      ) {
        await this.feedback.completed(record.recordId).catch(() =>
          this.input.report?.('CHANNEL_FEEDBACK_COMPLETION_UNKNOWN')
        )
      }
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
  private async route(record: ChannelConversationInput): Promise<void> {
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
    } else if (received && addressed && policy.enabled && channelPolicyAllows(policy, 'dispatch', event)) {
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
    }
    await this.store.mutate(state => {
      state.inputs[record.recordId]!.routed = true
    })
    await this.feedback.routed(record.recordId)
  }
  private async command(record: ChannelConversationInput, command: string, argument: string): Promise<void> {
    const event = record.input.source.event
    if (
      ![
        'choose',
        'permissions',
        'work-mode',
        'models',
        'model',
        'provider',
        'task-settings',
        'task-requests',
        'task-approve',
        'task-deny',
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
      const scope = global ? {} : {
        adapterId: event.adapterId,
        accountId: event.accountId,
        tenantId: event.tenantId,
        conversationId: event.conversationId,
      }
      if (this.lifetime.signal.aborted) return
      const applied = await this.store.mutate(state => {
        // Name lookup is asynchronous. A policy change during lookup must still control this effect.
        if (!state.policy.enabled || !channelPolicyAllows(state.policy, 'command', event, command)) return false
        const id = `command:${identity([scope, command.includes('user') ? userArgument : 'messages'])}`
        const rules = state.policy.rules.filter(rule => rule.id !== id)
        if (command === 'messages-off' || command === 'allow-user' || command === 'deny-user') {
          rules.push({
            id,
            ...scope,
            action: 'dispatch',
            effect: command === 'allow-user' ? 'allow' : 'deny',
            ...(command.includes('user') ? { userIds: [channelText(userArgument)] } : {}),
          })
        }
        const wakePrefixes = command === 'wake'
          ? [
            ...state.policy.wakePrefixes.filter(item => !channelSameScope(item, scope)),
            ...(userArgument === '--clear' ? [] : [{ ...scope, prefixes: [channelText(userArgument)] }]),
          ]
          : state.policy.wakePrefixes
        state.policy = parseChannelConversationPolicy({ ...state.policy, rules, wakePrefixes })
        state.policyRevision += 1
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
          messagesAllowed: channelPolicyAllows(this.store.snapshot().policy, 'dispatch', event),
        })
        : `/${command}: completed`,
    )
  }
  private async advance(job: ChannelConversationJob): Promise<void> {
    const state = this.store.snapshot(), record = state.inputs[job.recordId], native = this.input.native()
    if (!record || !native || this.lifetime.signal.aborted) return
    const event = record.input.source.event
    if (job.state === 'reconciliation-required') {
      if (
        job.code === 'CONTINUATION_EFFECT_UNCERTAIN' || job.code === 'CONTINUATION_BUSINESS_TURN_PENDING'
        || job.sessionId && state.continuations[job.sessionId]?.intent?.state === 'unknown'
      ) return
      if (job.turnId && job.sessionId) {
        await this.store.mutate(state => {
          state.jobs[job.id]!.state = 'running'
        })
      } else if (job.code !== 'NATIVE_OPERATION_UNAVAILABLE_AFTER_RESTART') {
        const recovered = await native.reconcile(job.id)
        await this.store.mutate(state => {
          const current = state.jobs[job.id]!
          current.state = recovered.state
          if (recovered.sessionId) current.sessionId = recovered.sessionId
          if (recovered.turnId) current.turnId = recovered.turnId
          if (recovered.code) current.code = recovered.code
          if (job.autoCreate && recovered.sessionId) {
            this.attachCreatedBinding(state, current, record, recovered.sessionId)
          }
        })
      }
      return
    }
    if (job.state === 'queued') {
      if (!state.policy.enabled || !channelPolicyAllows(state.policy, 'dispatch', event)) return
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
          && ['dispatching', 'running', 'replying', 'reconciliation-required'].includes(other.state)
        )
      ) return
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
        await this.store.mutate(state => {
          const current = state.jobs[job.id]!
          current.state = 'dispatching'
          const binding = current.bindingId === undefined ? undefined : state.bindings[current.bindingId]
          current.finalDeliveryEnabled = state.policy.autoReply && (binding?.autoReply ?? current.autoCreate)
          current.replyDefaults ??= channelReplyDefaults(
            state.policy,
            event,
            current.bindingId === undefined
              ? undefined
              : state.bindings[current.bindingId],
          )
        })
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
          ...(continuation
            ? [{
              operationId: continuation.operationId,
              brief: this.continuation.brief(continuation),
              configuration: continuation.configuration,
            }]
            : []),
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
          current.state = result.state === 'busy' ? 'queued' : result.state
          if (result.sessionId) current.sessionId = result.sessionId
          if (result.turnId) current.turnId = result.turnId
          if (result.code) current.code = result.code
          if (job.autoCreate && result.sessionId) {
            this.attachCreatedBinding(state, current, record, result.sessionId)
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
      && channelPolicyAllows(state.policy, 'dispatch', event) && channelPolicyAllows(state.policy, 'send', event)
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
        || !channelPolicyAllows(state.policy, 'dispatch', event)
        || binding?.state !== 'active' || !binding.autoReply || !completion.text || mode === 'none'
      ) {
        current.state = 'completed'
        return undefined
      }
      try {
        current.replyTarget ??= existingTarget ?? channelReplyTarget(event, mode)
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
  private attachCreatedBinding(
    state: import('./channel-conversation-store.js').ChannelConversationState,
    job: ChannelConversationJob,
    record: ChannelConversationInput,
    sessionId: string,
  ): void {
    // A removed binding must not be resurrected by later native reconciliation.
    if (job.bindingId !== undefined) return
    const channel = eventThread(record.input.source.event)
    const id = Object.values(state.bindings).find(binding =>
      binding.sessionId === sessionId
      && sameConversation(binding.channel, channel)
    )?.id ?? bindingIdentity(this.input.profileId, channel, sessionId)
    job.bindingId = id
    state.bindings[id] ??= {
      id,
      channel,
      sessionId,
      hostId: 'local',
      profileId: this.input.profileId,
      createdAt: new Date().toISOString(),
      fromSequence: record.sequence,
      mode: 'deliver',
      // Automatically created bindings inherit the profile's opt-in; this flag cannot enable it alone.
      autoReply: true,
      state: 'active',
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
      ?? channelReplyTarget(event, mode as Exclude<ChannelReplyMode, 'none'>)
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
    this.feedback.dispose()
    this.lifetime.abort()
    clearInterval(this.timer)
    await this.pumping
    this.commandUsers.dispose()
    this.sessionCommands.dispose()
    this.approvals.dispose()
    this.continuation.dispose()
    await this.store.close()
  }
  sendAllowed(event: ChannelEventRef): boolean {
    return channelPolicyAllows(this.store.snapshot().policy, 'send', event)
  }
}
