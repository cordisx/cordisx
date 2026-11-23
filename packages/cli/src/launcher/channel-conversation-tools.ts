import type {
  ChannelRuntime,
  ChannelSubscriptionFilter,
  ChannelTenantRef,
  ChannelThreadRef,
} from '@cordisx/channel-runtime'
import { createHash } from 'node:crypto'
import { richtextRequirements } from '@cordisx/channel-runtime'
import { CHANNEL_MESSAGE_OPERATION_COMMANDS, messageOperationCallerScope } from './channel-message-operations-rpc.js'
import { channelGroupAccessOperation } from './channel-group-access.js'
import { channelMemoryCommand } from './channel-memory-command.js'
import type { ChannelRemoteHistoryRequest } from './channel-remote-history.js'
import type { ChannelMessageReadResult } from './channel-message-read.js'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import type { ChannelDirectoryReadback } from './channel-live-directory.js'
import type { ChannelCommandUserReadback } from './channel-command-users.js'
import { type ChannelReplyCapabilities } from './channel-reply-routing.js'
import { channelOperationDuringPreparation } from './channel-preparation-guard.js'
import type { ChannelAdminPairing } from './channel-admin-pairing.js'
import { questionDeliveryId } from './channel-questions.js'
import { channelProgressTarget } from './channel-progress-reminders.js'
import { channelAdminPairingOperation } from './channel-admin-pairing-rpc.js'
import { type ChannelOutboundRpc, outboundCallerScope, parseOutboundTarget } from './channel-outbound-rpc.js'
import { channelForwardRpc } from './channel-forward-rpc.js'
import { authorizeChannelForward } from './channel-forward-permissions.js'

export interface ChannelConversationAccess {
  readonly forward?: ReturnType<typeof import('./channel-forward-service.js').createChannelForwardService>
  messageOperations?(operation: string, input: Record<string, unknown>, context: {
    source?: import('@cordisx/channel-runtime').ChannelEventRef | undefined
    callerScope: string
    authorize: (event: import('@cordisx/channel-runtime').ChannelEventRef, write: boolean) => void
  }): Promise<unknown>
  readonly outbound?: ChannelOutboundRpc
  feedbackReact?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    emoji: string,
  ): Promise<import('./channel-feedback.js').ChannelReactionReceipt>
  feedbackRemove?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    reactionId: string,
  ): Promise<import('./channel-feedback.js').ChannelReactionReceipt>
  feedbackWait?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    target: ChannelThreadRef,
    text: string,
    recordId: string,
  ): Promise<void>
  readonly generation: string
  readonly runtime: ChannelRuntime
  accounts(): readonly { ref: ChannelTenantRef; name?: string; state: string }[]
  conversations(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback>
  remoteHistory?(ref: ChannelTenantRef, request: ChannelRemoteHistoryRequest): Promise<unknown>
  readMessage?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    messageId: string,
  ): Promise<ChannelMessageReadResult>
  /** Display-only cache-first directory. Never use for permissions or command target resolution. */
  displayConversations?(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback>
  conversationDisplay?(
    ref: import('@cordisx/channel-runtime').ChannelConversationRef,
  ): import('./channel-conversation-directory.js').ChannelConversationIdentity
  /** Launcher-only identity/capability lookups; no new plugin or Agent authority. */
  users?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<ChannelCommandUserReadback>
  senderName?(event: import('@cordisx/channel-runtime').ChannelEventRef): string | undefined
  messageContext?(
    message: import('@cordisx/channel-runtime').ChannelUserInput,
    addressing?: import('./channel-command-users.js').ChannelCommandAddressing,
  ): Promise<import('./channel-message-context.js').ChannelMessageContext>
  replyCapabilities?(event: import('@cordisx/channel-runtime').ChannelEventRef): ChannelReplyCapabilities
  name?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<string | undefined>
  conversationIdentity?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
  ): Promise<import('./channel-conversation-directory.js').ChannelConversationIdentity>
  sendCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, card: object): Promise<string>
  updateCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, messageId: string, card: object): Promise<void>
  drain(ref: ChannelTenantRef): Promise<void>
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum = 512, multiline = false): string => {
  if (
    typeof value !== 'string' || !value.trim() || value.length > maximum
    || (multiline ? /\0/u : /[\0\r\n]/u).test(value)
  ) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const remoteHistoryTime = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, 12)
const sameAccount = (left: ChannelTenantRef, right: ChannelTenantRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId

/** Native tools and CLI reuse this launch's configured runtime, never a second SDK connection. */
export class ChannelConversationTools {
  private readonly lifetime = new AbortController()
  private pendingListeners = 0
  constructor(
    private readonly access: () => ChannelConversationAccess | undefined,
    private readonly consumer?: ChannelConversationConsumer,
    private readonly documents?: (input: unknown) => Promise<unknown>,
    private readonly execution?: (operation: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly pairing?: ChannelAdminPairing,
    private readonly logicalPreference?: (operation: string, value: unknown) => Promise<unknown>,
  ) {}

  /** Ordinary Codex callers bypass Channel business policy; bound callers never bypass it. */
  async executionGuard(operation: string, args: Record<string, unknown>, metadata?: unknown) {
    const caller = callerThreadId(metadata)
    const target = typeof args.sessionId === 'string' ? args.sessionId : caller
    if (operation.endsWith('-set') && target && this.consumer?.isNativeSourceMigrating(target)) {
      return { status: 'rejected', code: 'CONTINUATION_PENDING' }
    }
    const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
    if (
      meta['cordisx/channelContext'] !== undefined
      || caller && this.consumer?.taskSettings.isBound(caller)
      || this.consumer?.agentAccess.preparation(metadata)
    ) {
      if (['fast', 'fast-set', 'project', 'project-set', 'model-defaults', 'model-defaults-set'].includes(operation)) {
        const scoped = this.consumer?.agentAccess.caller(metadata)
        if (meta['cordisx/channelContext'] !== undefined && !scoped) {
          return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
        }
        const session = scoped?.threadId ?? caller
        const source = scoped?.source
          ?? (session ? this.consumer?.agentAccess.source(session, callerTurnId(metadata)) : undefined)
        if (!source || !session) return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
        const target = typeof args.sessionId === 'string' ? args.sessionId : session
        if (
          !operation.startsWith('model-defaults') && target !== session
          && !this.consumer?.taskSettings.boundTo(source, target)
        ) {
          return { status: 'rejected', code: 'CHANNEL_TARGET_NOT_BOUND' }
        }
        if (this.consumer?.agentAccess.preparation(metadata)) {
          return { status: 'rejected', code: 'PREPARATION_READ_ONLY' }
        }
        if (operation === 'model-defaults-set') {
          return { status: 'rejected', code: 'PROFILE_SETTINGS_REQUIRE_LOCAL_USER' }
        }
        if (operation.endsWith('-set')) {
          const allowed = operation === 'fast-set'
            ? ['sessionId', 'fast', 'expectedRevision']
            : ['sessionId', 'projectId', 'expectedRevision']
          if (Object.keys(args).some(key => !allowed.includes(key))) {
            return { status: 'rejected', code: 'INVALID_REQUEST' }
          }
          return this.consumer!.taskSettings.configurationRequest(operation, source, target, args)
        }
        return undefined
      }
      return this.call(operation, args, metadata)
    }
    return undefined
  }

  /** Management RPC only. Agent/native dispatch never calls this local-only entry. */
  async callLocal(operation: string, value: unknown, metadata?: unknown): Promise<unknown> {
    if (
      operation === 'memory-persona-profile' || operation === 'memory-persona-bind'
      || operation === 'memory-persona-context'
    ) {
      if (metadata !== undefined) return { status: 'rejected', code: 'LOCAL_USER_REQUIRED' }
      if (!this.consumer?.personas) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
      try {
        const input = object(value)
        const allowed = operation === 'memory-persona-profile'
          ? ['personaId', 'name', 'identity', 'style', 'expectedRevision']
          : operation === 'memory-persona-context'
          ? ['personaId', 'conversationId', 'style', 'expectedRevision']
          : ['account', 'personaId', 'expectedRevision']
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('PERSONA_INVALID_REQUEST')
        const result = operation === 'memory-persona-context'
          ? await this.consumer.personas.contextSettings(
            String(input.personaId),
            String(input.conversationId),
            input.style as never,
            input.expectedRevision as number,
          )
          : operation === 'memory-persona-profile'
          ? await this.consumer.personas.profile(
            String(input.personaId),
            String(input.name),
            String(input.identity),
            input.expectedRevision as number,
            input.style as never,
          )
          : await this.consumer.personas.bind(
            input.account as never,
            String(input.personaId),
            input.expectedRevision as number,
          )
        return { status: 'ok', result }
      } catch (error) {
        return { status: 'rejected', code: error instanceof Error ? error.message : 'PERSONA_INVALID_REQUEST' }
      }
    }
    if (operation === 'memory-authority-set') {
      if (metadata !== undefined) return { status: 'rejected', code: 'LOCAL_USER_REQUIRED' }
      if (!this.consumer?.memoryAuthority) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
      try {
        const input = object(value)
        if (Object.keys(input).some(key => !['account', 'scopes', 'expectedRevision'].includes(key))) {
          throw new Error('MEMORY_INVALID_REQUEST')
        }
        const revision = await this.consumer.memoryAuthority.configure(
          input.account as never,
          input.scopes as never,
          input.expectedRevision as number,
        )
        return { status: 'ok', revision }
      } catch (error) {
        return { status: 'rejected', code: error instanceof Error ? error.message : 'MEMORY_INVALID_REQUEST' }
      }
    }
    if (
      this.consumer?.agentAccess.hasPreparation() && !channelOperationDuringPreparation(operation)
      && (!this.consumer.agentAccess.caller(metadata) || this.consumer.agentAccess.preparation(metadata))
    ) {
      return { status: 'rejected', code: 'PREPARATION_READ_ONLY' }
    }
    if (
      [
        'logical-status',
        'logical-chain',
        'logical-abandon',
        'logical-mode-default',
        'logical-mode-default-set',
        'logical-mode-conversation',
        'logical-mode-conversation-set',
      ]
        .includes(operation)
    ) {
      if (metadata !== undefined) return { status: 'rejected', code: 'LOCAL_USER_REQUIRED' }
      if (!this.consumer && !this.logicalPreference) {
        return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
      }
      try {
        return this.consumer
          ? await this.consumer.logicalProfilePreference(operation, value)
          : await this.logicalPreference!(operation, value)
      } catch (error) {
        return {
          status: 'rejected',
          code: error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
            ? error.message
            : 'CHANNEL_OPERATION_FAILED',
        }
      }
    }
    if (['admin-pair-begin', 'admin-pair-status', 'admin-pair-confirm', 'admin-pair-cancel'].includes(operation)) {
      return channelAdminPairingOperation({
        operation,
        value,
        metadata,
        access: this.access(),
        consumer: this.consumer,
        pairing: this.pairing,
      })
    }
    if (['continuation-policy', 'continuation-policy-set', 'continuation-start'].includes(operation)) {
      try {
        if (metadata !== undefined) throw new Error('LOCAL_USER_REQUIRED')
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        const input = object(value)
        const sessionId = text(input.sessionId)
        if (operation === 'continuation-policy') {
          if (Object.keys(input).some(key => key !== 'sessionId')) throw new Error('INVALID_REQUEST')
          return { status: 'ok', ...this.consumer.continuation.read(sessionId) }
        }
        if (operation === 'continuation-policy-set') {
          if (Object.keys(input).some(key => !['sessionId', 'policy'].includes(key))) throw new Error('INVALID_REQUEST')
          return { status: 'ok', policy: await this.consumer.continuation.setPolicy(sessionId, input.policy) }
        }
        if (Object.keys(input).some(key => key !== 'sessionId')) throw new Error('INVALID_REQUEST')
        return await this.consumer.continuation.startManual(sessionId)
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
          ? error.message
          : 'CHANNEL_OPERATION_FAILED'
        return { status: 'rejected', code }
      }
    }
    if (
      operation.startsWith('continuation-checkpoint')
      || ['continuation-history', 'continuation-takeover-ready'].includes(operation)
    ) {
      if (!this.consumer?.agentAccess.caller(metadata)) {
        return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
      }
      return this.call(operation, value, metadata)
    }
    if (operation !== 'local-bindings') return this.call(operation, value, metadata)
    try {
      if (this.lifetime.signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
      if (metadata !== undefined) throw new Error('LOCAL_CLI_REQUIRED')
      const current = this.access()
      if (!current || !this.consumer) return { status: 'unavailable', code: 'CHANNEL_NOT_CONFIGURED' }
      const input = object(value)
      if (Object.keys(input).some(key => !['account', 'conversationId'].includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      let account: ChannelTenantRef | undefined
      if (input.account !== undefined) {
        const raw = object(input.account)
        if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
          throw new Error('INVALID_REQUEST')
        }
        account = { adapterId: text(raw.adapterId), accountId: text(raw.accountId), tenantId: text(raw.tenantId) }
      }
      const conversationId = input.conversationId === undefined ? undefined : text(input.conversationId)
      if (conversationId !== undefined && !account) {
        throw new Error('INVALID_REQUEST')
      }
      const snapshot = this.consumer.status()
      return {
        status: 'ok',
        generation: current.generation,
        revision: snapshot.revision,
        bindings: snapshot.bindings.filter(binding =>
          (!account || sameAccount(binding.channel, account))
          && (conversationId === undefined || binding.channel.conversationId === conversationId)
        ).map(binding => ({
          bindingId: binding.id,
          sessionId: binding.sessionId,
          state: binding.state,
          mode: binding.mode,
          channel: {
            adapterId: binding.channel.adapterId,
            accountId: binding.channel.accountId,
            tenantId: binding.channel.tenantId,
            conversationId: binding.channel.conversationId,
            kind: binding.channel.kind,
          },
        })),
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
        ? error.message
        : 'CHANNEL_OPERATION_FAILED'
      return { status: 'rejected', code }
    }
  }

  async call(operation: string, value: unknown, metadata?: unknown): Promise<unknown> {
    try {
      if (this.lifetime.signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
      if (
        this.consumer?.agentAccess.hasPreparation() && !channelOperationDuringPreparation(operation)
        && (!this.consumer.agentAccess.caller(metadata) || this.consumer.agentAccess.preparation(metadata))
      ) throw new Error('PREPARATION_READ_ONLY')
      if (operation === 'docs') {
        return this.documents
          ? await this.documents(value)
          : { status: 'unavailable', code: 'DOCUMENTS_UNAVAILABLE' }
      }
      const input = object(value)
      if (operation === 'memory') {
        if (!this.consumer?.memory) throw new Error('CHANNEL_CONSUMER_UNAVAILABLE')
        const caller = this.consumer.agentAccess.caller(metadata)
        const personas = this.consumer.personas
        const store = caller && personas && await personas.taskConfigured(caller.threadId, caller.source)
          ? await personas.memoryForTask(caller.threadId, caller.source)
          : this.consumer.memory
        return await channelMemoryCommand(
          store,
          this.consumer.agentAccess,
          input,
          metadata,
          this.consumer.memoryAuthority,
        )
      }
      if (
        this.consumer?.agentAccess.preparation(metadata)
        && !['continuation-history', 'continuation-takeover-ready'].includes(operation)
      ) {
        throw new Error('PREPARATION_READ_ONLY')
      }
      if (operation === 'task-model-select') return await this.consumer?.taskSettings.externalSelection(input, metadata)
      if (operation.startsWith('task-') || operation === 'model-list') {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        return await this.consumer.taskSettings.call(operation, input, metadata)
      }
      const scopedCaller = this.consumer?.agentAccess.caller(metadata)
      const nativeCaller = callerThreadId(metadata)
      const metadataObject = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}
      if (metadataObject['cordisx/channelContext'] !== undefined && !scopedCaller) {
        throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
      }
      const source = scopedCaller?.source
        ?? (nativeCaller ? this.consumer?.agentAccess.source(nativeCaller, callerTurnId(metadata)) : undefined)
      const callerSession = scopedCaller?.threadId ?? nativeCaller
      if (['forward', 'merge-forward', 'forward-receipt'].includes(operation)) {
        if (nativeCaller && this.consumer?.taskSettings.isBound(nativeCaller) && !source) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        const access = this.access()
        if (!access) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        return await channelForwardRpc({
          operation,
          value: input,
          access,
          scope: outboundCallerScope({
            session: callerSession,
            turnId: scopedCaller?.turnId ?? callerTurnId(metadata),
            source,
          }),
          ...(source ? { source } : {}),
          authorize: (event, action) => {
            if (source && this.consumer) {
              authorizeChannelForward(this.consumer.profileLogicalOwner().store.snapshot().policy, event, action)
            }
          },
        })
      }
      if (['user-access', 'user-access-set', 'group-block', 'group-block-set'].includes(operation)) {
        if (!this.consumer) throw new Error('CHANNEL_CONSUMER_UNAVAILABLE')
        return await this.consumer.permissionOperation(operation, input, metadata)
      }
      if (operation === 'group-access' || operation === 'group-access-set') {
        if (!this.consumer) throw new Error('CHANNEL_CONSUMER_UNAVAILABLE')
        return await channelGroupAccessOperation({
          operation,
          value: input,
          metadata,
          store: this.consumer.profileLogicalOwner().store,
          agent: this.consumer.agentAccess,
          access: this.access,
          signal: this.lifetime.signal,
        })
      }
      if (operation === 'reaction') {
        if (!source || !this.consumer || !this.consumer.commandAllowed(source, 'send')) {
          throw new Error('CHANNEL_PERMISSION_DENIED')
        }
        if (Object.keys(input).some(key => !['action', 'emojiType', 'reactionId'].includes(key))) {
          throw new Error('INVALID_REQUEST')
        }
        const access = this.access()
        if (!access?.feedbackReact || !access.feedbackRemove) {
          return { status: 'unavailable', code: 'CHANNEL_REACTION_UNAVAILABLE' }
        }
        if (input.action === 'remove') {
          return { status: 'ok', receipt: await access.feedbackRemove(source, text(input.reactionId, 512)) }
        }
        if (input.action !== 'add') throw new Error('INVALID_REQUEST')
        const emoji = text(input.emojiType, 64)
        if (!/^[A-Za-z0-9_]{1,64}$/u.test(emoji)) throw new Error('INVALID_EMOJI')
        return { status: 'ok', receipt: await access.feedbackReact(source, emoji) }
      }
      if (operation === 'continuation-takeover-ready') {
        const turnId = scopedCaller?.turnId ?? callerTurnId(metadata)
        if (
          !this.consumer || !callerSession || !turnId || !source || !this.consumer.agentAccess.preparation(metadata)
          || Object.keys(input).some(key => key !== 'token') || typeof input.token !== 'string'
        ) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        return await this.consumer.continuation.liveReady(callerSession, turnId, input.token)
      }
      if (['continuation-checkpoint', 'continuation-checkpoint-set', 'continuation-history'].includes(operation)) {
        if (!this.consumer || !callerSession || !source) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        const turnId = scopedCaller?.turnId ?? callerTurnId(metadata)
        if (!turnId || !await this.consumer.continuation.turnActive(callerSession, turnId)) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        if (operation === 'continuation-history') {
          if (
            Object.keys(input).some(key => !['limit', 'cursor'].includes(key))
            || input.limit !== undefined
              && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 32)
            || input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 16384)
          ) {
            throw new Error('INVALID_REQUEST')
          }
          return {
            status: 'ok',
            ...await this.consumer.continuation.history(callerSession, {
              ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            }),
          }
        }
        if (operation === 'continuation-checkpoint') {
          if (Object.keys(input).length) throw new Error('INVALID_REQUEST')
          const checkpoint = this.consumer.continuation.read(callerSession).checkpoint ?? null
          return { status: 'ok', revision: checkpoint?.revision ?? 0, checkpoint }
        }
        if (
          Object.keys(input).some(key => !['checkpoint', 'expectedRevision'].includes(key))
          || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
        ) throw new Error('INVALID_REQUEST')
        return {
          status: 'ok',
          checkpoint: await this.consumer.continuation.setCheckpoint(
            callerSession,
            input.checkpoint,
            Number(input.expectedRevision),
          ),
        }
      }
      if (
        nativeCaller && this.consumer?.taskSettings.isBound(nativeCaller)
        && [
          'send',
          'send-many',
          'media-prepare',
          'ask',
          'question-cancel',
          'bind',
          'unbind',
          'policy-set',
          'execution-defaults-set',
          'execution-settings-set',
        ]
          .includes(operation)
        && !source
      ) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
      if (source && ['policy-set', 'execution-defaults-set'].includes(operation)) {
        throw new Error('PROFILE_SETTINGS_REQUIRE_LOCAL_USER')
      }
      if (source && operation === 'execution-settings-set') {
        const patch = object(input.settings)
        if (Object.keys(patch).some(key => key !== 'effort')) {
          throw new Error('EXECUTION_SETTINGS_REQUIRE_CHANNEL_COMMAND')
        }
        return await this.consumer!.taskSettings.request(source, String(input.sessionId ?? callerSession), patch)
      }
      if (operation.startsWith('execution-')) {
        if (!this.consumer && !this.execution) return { status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
        const callerSession = scopedCaller?.threadId ?? callerThreadId(metadata)
        if (callerSession && operation.endsWith('-set') && operation.includes('defaults')) {
          throw new Error('PROFILE_SETTINGS_REQUIRE_LOCAL_USER')
        }
        if (callerSession && input.sessionId !== undefined && input.sessionId !== callerSession) {
          throw new Error('SESSION_SCOPE_MISMATCH')
        }
        const args = {
          ...input,
          ...(operation.includes('defaults') ? {} : { sessionId: input.sessionId ?? callerSession }),
        }
        return this.execution
          ? await this.execution(operation, args)
          : await this.consumer!.executionOperation(operation, args)
      }
      const current = this.access()
      if (!current) return { status: 'unavailable', code: 'CHANNEL_NOT_CONFIGURED' }
      if (CHANNEL_MESSAGE_OPERATION_COMMANDS.includes(operation as typeof CHANNEL_MESSAGE_OPERATION_COMMANDS[number])) {
        if (nativeCaller && this.consumer?.taskSettings.isBound(nativeCaller) && !source) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        if (!current.messageOperations) return { status: 'unavailable', code: 'CHANNEL_OPERATION_UNAVAILABLE' }
        return current.messageOperations(operation, input, {
          source,
          callerScope: messageOperationCallerScope(callerSession, source),
          authorize: (event, write) => {
            if (!current.accounts().some(item => sameAccount(item.ref, event) && item.state === 'ready')) {
              throw new Error('CONNECTION_NOT_READY')
            }
            if (source && this.consumer && !this.consumer.commandAllowed(source, write ? 'send' : 'history')) {
              throw new Error('CHANNEL_POLICY_DENIED')
            }
            if (write && this.consumer && !this.consumer.sendAllowed(event)) throw new Error('CHANNEL_POLICY_DENIED')
            if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
              throw new Error('CHANNEL_GENERATION_CHANGED')
            }
          },
        })
      }
      if (operation === 'reply-mode') {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        const callerSession = scopedCaller?.threadId ?? callerThreadId(metadata)
        const sessionId = input.sessionId === undefined ? callerSession : text(input.sessionId)
        if (!sessionId) throw new Error('SESSION_REQUIRED')
        if (callerSession !== undefined && callerSession !== sessionId) throw new Error('REPLY_OPERATION_NOT_FOUND')
        const { sessionId: _session, ...request } = input
        return { status: 'ok', ...await this.consumer.selectReplyMode(request, sessionId, callerTurnId(metadata)) }
      }
      if (['bind', 'unbind', 'bind-status', 'history', 'policy', 'policy-set'].includes(operation)) {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        if (operation === 'policy') return { status: 'ok', ...this.consumer.policy() }
        if (operation === 'policy-set') {
          if (
            Object.keys(input).some(key => !['policy', 'expectedRevision'].includes(key))
            || !Number.isSafeInteger(input.expectedRevision)
          ) {
            throw new Error('INVALID_REQUEST')
          }
          return { status: 'ok', ...await this.consumer.policySet(input.policy, Number(input.expectedRevision)) }
        }
        // Native metadata defaults to the current chat. Local CLI may explicitly address a chat in this profile.
        const sessionId = input.sessionId === undefined ? callerSession : text(input.sessionId)
        if (!sessionId) throw new Error('SESSION_REQUIRED')
        if (callerSession !== undefined && sessionId !== callerSession) throw new Error('SESSION_SCOPE_MISMATCH')
        if (source && ['bind', 'unbind'].includes(operation) && !this.consumer.commandAllowed(source, operation)) {
          throw new Error('CHANNEL_POLICY_DENIED')
        }
        const { sessionId: _session, ...request } = input
        if (operation === 'bind') return { status: 'ok', binding: await this.consumer.bind(request, sessionId) }
        if (operation === 'unbind') return { status: 'ok', removed: await this.consumer.unbind(request, sessionId) }
        if (operation === 'history') return this.consumer.history(request, sessionId)
        if (Object.keys(request).length) throw new Error('INVALID_REQUEST')
        return this.consumer.status(sessionId)
      }
      if (operation === 'connections') {
        if (Object.keys(input).length) throw new Error('INVALID_REQUEST')
        return { status: 'ok', generation: current.generation, connections: current.accounts() }
      }
      const outboundCaller = { session: callerSession, turnId: scopedCaller?.turnId ?? callerTurnId(metadata), source }
      const authorizeOutbound = (target: ChannelThreadRef) => {
        if (source && this.consumer && !this.consumer.sendAllowed(source)) throw new Error('CHANNEL_POLICY_DENIED')
        if (
          this.consumer
          && !this.consumer.sendAllowed({
            ...target,
            eventId: String(input.operationId ?? 'media-prepare'),
            ...(source?.actor ? { actor: source.actor } : {}),
          })
        ) throw new Error('CHANNEL_POLICY_DENIED')
      }
      if (operation === 'media-prepare') {
        if (!current.outbound) throw new Error('CHANNEL_MEDIA_PREPARE_UNAVAILABLE')
        return current.outbound.prepare(input, outboundCaller, current.accounts(), authorizeOutbound)
      }
      const account = object(input.account)
      if (Object.keys(account).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      const ref = {
        adapterId: text(account.adapterId),
        accountId: text(account.accountId),
        tenantId: text(account.tenantId),
      }
      if (
        !current.accounts().some(item =>
          sameAccount(item.ref, ref) && (['receipt', 'question-cancel'].includes(operation) || item.state === 'ready')
        )
      ) {
        throw new Error('CONNECTION_NOT_READY')
      }
      const caller = {
        source: 'cordisx:native-channel',
        pluginId: 'host-channel-tools',
        // Correlation is not an ownership or permission grant. The endpoint is launch/user scoped.
        generation: outboundCallerScope(outboundCaller),
      }
      if (operation === 'ask' || operation === 'question-cancel') {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        if (operation === 'ask') {
          this.consumer.trackProgressDelivery(
            questionDeliveryId(caller, ref, text(input.operationId, 128)),
            source,
            callerSession,
            outboundCaller.turnId,
          )
        }
        return operation === 'ask'
          ? await this.consumer.questions.ask(input, ref, caller, source)
          : await this.consumer.questions.cancel(input, ref, caller)
      }
      if (operation === 'conversations') {
        if (Object.keys(input).some(key => key !== 'account')) throw new Error('INVALID_REQUEST')
        const directory = await current.conversations(ref)
        return { status: directory.complete ? 'ok' : 'partial', generation: current.generation, ...directory }
      }
      if (operation === 'message-get') {
        if (Object.keys(input).some(key => !['account', 'conversationId', 'kind', 'messageId'].includes(key))) {
          throw new Error('INVALID_REQUEST')
        }
        const conversationId = text(input.conversationId), kind = input.kind, messageId = text(input.messageId)
        if (
          !/^oc_[A-Za-z0-9_]+$/u.test(conversationId) || !['direct', 'group'].includes(String(kind))
          || !/^om_[A-Za-z0-9_]+$/u.test(messageId)
        ) throw new Error('INVALID_TARGET')
        if (nativeCaller && this.consumer?.taskSettings.isBound(nativeCaller) && !source) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        if (source && (!sameAccount(source, ref) || source.conversationId !== conversationId || source.kind !== kind)) {
          throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
        }
        if (!current.readMessage) return { status: 'unavailable', code: 'CHANNEL_MESSAGE_UNAVAILABLE' }
        const event = source ?? {
          ...ref,
          conversationId,
          kind: kind as 'direct' | 'group',
          threadId: conversationId,
          semantics: 'conversation' as const,
          eventId: messageId,
        }
        // An incoming Channel agent can only walk its own source's parent chain.
        let candidate = source ? source.messageId : messageId
        const seen = new Set<string>()
        for (let depth = 0; candidate && depth < 16 && !seen.has(candidate); depth++) {
          seen.add(candidate)
          const result = await current.readMessage(event, candidate)
          if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
            throw new Error('CHANNEL_GENERATION_CHANGED')
          }
          if (result.status !== 'ok') return result
          if (candidate === messageId) return result
          candidate = result.message.parentId
        }
        return { status: 'rejected', code: 'CHANNEL_MESSAGE_NOT_IN_REPLY_CHAIN' }
      }
      if (operation === 'remote-history') {
        if (
          Object.keys(input).some(key =>
            !['account', 'conversationId', 'kind', 'startTime', 'endTime', 'pageSize', 'pageToken', 'order'].includes(
              key,
            )
          )
        ) throw new Error('INVALID_REQUEST')
        const conversationId = text(input.conversationId), kind = input.kind
        if (!/^oc_[A-Za-z0-9_]+$/u.test(conversationId) || !['direct', 'group'].includes(String(kind))) {
          throw new Error('INVALID_TARGET')
        }
        const startTime = remoteHistoryTime(input.startTime), endTime = remoteHistoryTime(input.endTime)
        if (!/^\d{1,12}$/u.test(startTime) || !/^\d{1,12}$/u.test(endTime) || Number(startTime) >= Number(endTime)) {
          throw new Error('INVALID_TIME_RANGE')
        }
        const pageSize = input.pageSize ?? 50, order = input.order ?? 'desc'
        if (
          !Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 50
          || !['asc', 'desc'].includes(String(order))
        ) throw new Error('INVALID_REQUEST')
        const pageToken = input.pageToken === undefined ? undefined : text(input.pageToken, 2048)
        // A remotely triggered agent may inspect only its authenticated source, not other accounts or chats.
        if (nativeCaller && this.consumer?.taskSettings.isBound(nativeCaller) && !source) {
          throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
        }
        if (source && (!sameAccount(source, ref) || source.conversationId !== conversationId || source.kind !== kind)) {
          throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
        }
        if (!current.remoteHistory) return { status: 'unavailable', code: 'CHANNEL_REMOTE_HISTORY_UNAVAILABLE' }
        const result = await current.remoteHistory(ref, {
          conversationId,
          kind: kind as 'direct' | 'group',
          startTime,
          endTime,
          pageSize: Number(pageSize),
          order: order as 'asc' | 'desc',
          ...(pageToken ? { pageToken } : {}),
        })
        if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
          throw new Error('CHANNEL_GENERATION_CHANGED')
        }
        return result
      }
      if (operation === 'send' || operation === 'send-many' || operation === 'receipt') {
        const allowed = operation === 'send'
          ? ['account', 'target', 'text', 'operationId', 'payload', 'content', 'fallback', 'progressToken']
          : operation === 'send-many'
          ? ['account', 'targets', 'text', 'operationId', 'payload', 'content', 'fallback']
          : ['account', 'operationId', 'targetCount']
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
        const operationId = text(input.operationId, 128)
        const progressGuard = () => {
          if (input.progressToken !== undefined) {
            if (!this.consumer) throw new Error('CHANNEL_PROGRESS_NOTICE_STALE')
            this.consumer.assertProgressNotice(input.progressToken, source, callerSession)
          }
        }
        progressGuard()
        const targets = operation === 'send-many' ? input.targets : [input.target]
        if (operation === 'send-many' && (!Array.isArray(targets) || !targets.length || targets.length > 1000)) {
          throw new Error('INVALID_TARGET')
        }
        const typed = input.payload !== undefined || input.content !== undefined
        const sendText = operation === 'receipt' || typed ? undefined : text(input.text, 8192, true)
        // Validate the entire batch before enqueueing its first effect.
        const parsed = operation === 'receipt' ? [] : (targets as unknown[]).map(value => {
          const target = parseOutboundTarget(value, ref, operationId)
          if (input.progressToken !== undefined && (!source || !channelProgressTarget(source, target))) {
            throw new Error('CHANNEL_PROGRESS_TARGET_MISMATCH')
          }
          authorizeOutbound(target)
          return target
        })
        if (typed && !current.outbound) throw new Error('CHANNEL_MEDIA_PREPARE_UNAVAILABLE')
        if (
          operation === 'receipt' && input.targetCount !== undefined && (!Number.isSafeInteger(input.targetCount)
            || Number(input.targetCount) < 1 || Number(input.targetCount) > 1000)
        ) throw new Error('INVALID_REQUEST')
        const multiple = operation === 'send-many' || operation === 'receipt' && input.targetCount !== undefined
        const count = operation === 'receipt' ? Number(input.targetCount ?? 1) : parsed.length
        const deliveryIdFor = (index: number) =>
          `delivery:${
            createHash('sha256').update(
              JSON.stringify([caller, ref, multiple ? `${operationId}:${index}` : operationId]),
            ).digest('hex')
          }`
        const contents = operation === 'receipt'
          ? undefined
          : current.outbound?.content(
            input,
            outboundCaller,
            parsed,
            index => current.runtime.deliverySnapshot(deliveryIdFor(index), caller) !== undefined,
          )
        const receipts: unknown[] = []
        if (typed && contents) {
          for (let index = 0; index < parsed.length; index += 1) {
            if (current.runtime.deliverySnapshot(deliveryIdFor(index), caller) !== undefined) continue
            const capabilities = await current.runtime.outboundCapabilities(parsed[index]!, caller)
            const requested = contents[index]!
            if (
              Buffer.byteLength(
                JSON.stringify({
                  contract: 'cordisx.channel-message-send/v2',
                  schemaVersion: 2,
                  target: parsed[index],
                  kind: 'reply',
                  idempotencyKey: deliveryIdFor(index),
                  content: requested.content,
                  fallback: requested.fallback,
                }),
                'utf8',
              ) > 196_608
            ) throw new Error('INVALID_CHANNEL_PAYLOAD')
            const requirements = richtextRequirements(requested.content)
            if (requirements.userIds.length) {
              await current.runtime.validateMentionContent(parsed[index]!, requested.content, caller)
            }
            const richtext = requirements.paragraphs
              ? (await current.runtime.outboundCapabilitiesV2(parsed[index]!, caller)).richtext
              : undefined
            if (
              (!capabilities.types.includes(requested.content.type)
                || requirements.paragraphs && richtext?.paragraphs !== true
                || requirements.userIds.length > 0 && richtext?.mentions !== true)
              && !(requested.fallback.mode === 'text' && capabilities.types.includes('text'))
            ) {
              throw new Error('CHANNEL_OUTBOUND_TYPE_UNSUPPORTED')
            }
            if ('handle' in requested.content && capabilities.types.includes(requested.content.type)) {
              const media = current.outbound!.store.descriptor(
                outboundCallerScope(outboundCaller),
                requested.content.handle,
                parsed[index]!,
              )
              if (!Number.isSafeInteger(capabilities.maxMediaBytes) || media.size > capabilities.maxMediaBytes) {
                throw new Error('MEDIA_SIZE_DENIED')
              }
            }
            if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
              throw new Error('CHANNEL_GENERATION_CHANGED')
            }
          }
        }
        let attempted = 0
        try {
          for (let index = 0; index < count; index += 1) {
            if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
              throw new Error('CHANNEL_GENERATION_CHANGED')
            }
            const deliveryId = deliveryIdFor(index)
            if (operation !== 'receipt') {
              progressGuard()
              this.consumer?.trackProgressDelivery(deliveryId, source, callerSession, outboundCaller.turnId)
              attempted += 1
              const notification = {
                target: parsed[index]!,
                kind: 'reply' as const,
                text: sendText ?? '',
                ...(contents ? contents[index]! : {}),
              }
              if (input.progressToken !== undefined) {
                if (!current.runtime.notifyGuardedOnce) throw new Error('CHANNEL_PROGRESS_GUARD_UNAVAILABLE')
                await current.runtime.notifyGuardedOnce(notification, caller, deliveryId, () => {
                  try {
                    progressGuard()
                    return this.access()?.generation === current.generation
                  } catch {
                    return false
                  }
                })
              } else {await current.runtime.notifyOnce(
                  {
                    target: parsed[index]!,
                    kind: 'reply',
                    text: sendText ?? '',
                    ...(contents ? contents[index]! : {}),
                  },
                  caller,
                  deliveryId,
                )}
              if (!this.lifetime.signal.aborted) await current.drain(ref)
            }
            // Missing is explicit. JSON.stringify must never silently erase a missing receipt.
            receipts.push(current.runtime.deliverySnapshot(deliveryId, caller) ?? null)
          }
        } catch (error) {
          return {
            status: 'partial',
            generation: current.generation,
            operationId,
            deliveryState: 'unknown',
            receipts,
            attempted,
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'CHANNEL_EFFECT_UNCERTAIN',
          }
        }
        return {
          status: 'ok',
          generation: current.generation,
          operationId,
          deliveryState: receipts.every(receipt => (receipt as { state?: string } | null)?.state === 'sent')
            ? 'sent'
            : receipts.every(receipt => receipt === null)
            ? 'not-found'
            : receipts.some(receipt =>
                ['dead-letter', 'cancelled'].includes(String((receipt as { state?: string } | null)?.state))
              )
            ? 'failed'
            : receipts.some(receipt =>
                ['queued', 'sending', 'retrying'].includes(String((receipt as { state?: string } | null)?.state))
              )
            ? 'pending'
            : 'unknown',
          ...(multiple ? { receipts } : { receipt: receipts[0] }),
        }
      }
      if (
        operation !== 'listen'
        || Object.keys(input).some(key =>
          !['account', 'conversationIds', 'afterCursor', 'timeoutSeconds'].includes(key)
        )
      ) {
        throw new Error('INVALID_REQUEST')
      }
      if (!Array.isArray(input.conversationIds) || !input.conversationIds.length) {
        throw new Error('INVALID_TARGET')
      }
      const ids = input.conversationIds.map(id => text(id))
      if (ids.some(id => !/^oc_[A-Za-z0-9_]+$/u.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error('INVALID_TARGET')
      }
      const timeout = input.timeoutSeconds ?? 30
      if (!Number.isInteger(timeout) || Number(timeout) < 0 || Number(timeout) > 60 || this.pendingListeners >= 16) {
        throw new Error('INVALID_DURATION')
      }
      const filters: ChannelSubscriptionFilter[] = ids.map(conversationId => ({ account: ref, conversationId }))
      const cursor = input.afterCursor === undefined ? current.runtime.latestInputCursor() : text(input.afterCursor)
      let readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
      if (readback.messages.length || timeout === 0) return { status: 'ok', ...readback }
      this.pendingListeners += 1
      const subscriptions: (() => void)[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake: () => void = () => {}
      const ready = new Promise<void>(resolve => {
        wake = resolve
      })
      const abort = () => wake()
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      try {
        for (const filter of filters) subscriptions.push(await current.runtime.subscribe(caller, filter, wake))
        // Re-read after registration so an event between the first read and subscribe is retained.
        readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
        if (!readback.messages.length) {
          timer = setTimeout(wake, Number(timeout) * 1000)
          await ready
          const latest = this.access()
          if (
            this.lifetime.signal.aborted || latest?.generation !== current.generation
            || latest.runtime !== current.runtime
          ) {
            throw new Error('CHANNEL_GENERATION_CHANGED')
          }
          readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
        }
        return { status: 'ok', ...readback }
      } finally {
        this.pendingListeners -= 1
        if (timer) clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', abort)
        subscriptions.forEach(dispose => dispose())
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
        ? error.message
        : 'CHANNEL_OPERATION_FAILED'
      return { status: 'rejected', code }
    }
  }
  dispose(): void {
    this.lifetime.abort()
  }
}
