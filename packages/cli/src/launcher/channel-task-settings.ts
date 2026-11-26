import { randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'
import {
  channelCommandDenied,
  channelExact,
  channelPolicyAllows,
  channelRecord,
  channelText,
} from './channel-conversation-policy.js'
import {
  channelTaskChangeAllowed,
  channelTaskDefaults,
  channelTaskFields,
  type ChannelTaskPatch,
  parseChannelTaskConfig,
  parseChannelTaskPatch,
} from './channel-task-config.js'
import { ChannelConversationStore, type ChannelTaskRequest } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelAgentAccess } from './channel-agent-access.js'
import { channelApprovalCard, channelApprovalPreview } from './channel-approval-card.js'
import {
  channelTaskCatalog,
  channelTaskSelectionMatches,
  resolveChannelTaskSelection,
  validateChannelTaskSelection,
} from './channel-task-selection.js'
import { ChannelTaskSettingsPump } from './channel-task-settings-pump.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'

const same = (left: ChannelEventRef, right: ChannelEventRef) =>
  ['adapterId', 'accountId', 'tenantId', 'conversationId']
    .every(field => left[field as keyof ChannelEventRef] === right[field as keyof ChannelEventRef])
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Commands, MCP, local CLI and Host forms share the same exact model-change authority. */
export class ChannelTaskSettings {
  private readonly application: ChannelTaskSettingsPump
  private readonly cardUpdates = new Map<string, Promise<void>>()
  constructor(
    private readonly input: {
      store: ChannelConversationStore
      native(): ChannelNativeSessions | undefined
      access(): ChannelConversationAccess | undefined
      agent: ChannelAgentAccess
      notify?(event: ChannelEventRef, text: string, operationId: string): Promise<unknown>
      logical?: { appId: string; profileId: string; fence: ChannelNativeSourceFence; claims: Set<string> }
    },
  ) {
    this.application = new ChannelTaskSettingsPump({
      ...input,
      isBound: id => this.isBound(id),
      bound: (event, id) => this.bound(event, id),
      allowed: (event, patch, selection) => this.allowed(event, patch, selection),
      validate: (patch, threadId) => this.validate(patch, threadId),
      card: request => this.card(request),
    })
  }
  async defaults(event: ChannelEventRef): Promise<ChannelTaskPatch> {
    const state = this.input.store.snapshot()
    const patch = channelTaskDefaults(state.taskConfig, state.policy, event)
    if (!Object.keys(patch).length) return {}
    const native = this.input.native()
    if (!native) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
    const catalog = channelTaskCatalog(await native.modelOperation('list', {}))
    const selection = resolveChannelTaskSelection(catalog, await native.creationSelection(), patch).selection
    await native.validateTaskConfiguration?.(selection)
    return selection
  }
  isBound(threadId: string): boolean {
    return Object.values(this.input.store.snapshot().bindings).some(binding =>
      binding.state === 'active' && binding.sessionId === threadId
    )
  }
  ready(threadId: string): boolean {
    const setting = this.input.store.snapshot().taskSettings[threadId]
    return !setting || !['saved', 'applying', 'unknown'].includes(setting.application)
  }
  private bound(event: ChannelEventRef, threadId: string): boolean {
    return Object.values(this.input.store.snapshot().bindings).some(binding =>
      binding.state === 'active' && binding.sessionId === threadId
      && same({ ...binding.channel, eventId: '' }, event)
    )
  }
  boundTo(event: ChannelEventRef, threadId: string): boolean {
    return this.bound(event, threadId)
  }
  requests(event: ChannelEventRef) {
    return Object.values(this.input.store.snapshot().taskRequests).filter(item =>
      same(item.source, event) && item.state === 'pending' && item.expiresAt > Date.now()
    )
  }
  private caller(metadata: unknown) {
    const scoped = this.input.agent.caller(metadata)
    if (object(metadata)['cordisx/channelContext'] !== undefined) return scoped
    if (scoped) return scoped
    const threadId = callerThreadId(metadata), turnId = callerTurnId(metadata)
    if (!threadId) return undefined
    const source = this.input.agent.source(threadId, turnId)
    return source ? { source, threadId, ...(turnId ? { turnId } : {}) } : undefined
  }
  async read(threadId: string) {
    const native = this.input.native()
    if (!native) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
    const observed = await native.taskSelection(threadId)
    const stored = this.input.store.snapshot().taskSettings[threadId]
    return {
      status: 'ok',
      threadId,
      revision: stored?.revision ?? 0,
      settings: observed,
      ...(stored?.pending ? { pending: stored.pending } : {}),
      application: stored?.application ?? 'applied',
      ...(stored?.code ? { code: stored.code } : {}),
    }
  }
  async catalog(caller?: string) {
    const native = this.input.native()
    if (!native) return { status: 'unavailable', code: 'MODEL_CATALOG_UNAVAILABLE' }
    let projects: readonly { projectId: string; name: string }[] = [], projectAvailability = 'available'
    try {
      projects = await native.projects(caller)
    } catch {
      projectAvailability = 'unavailable'
    }
    return { status: 'ok', ...object(await native.modelOperation('list', {})), projects, projectAvailability }
  }
  async configurationRequest(
    operation: string,
    source: ChannelEventRef,
    session: string,
    args: Record<string, unknown>,
  ) {
    const native = this.input.native()
    if (!native) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
    if (args.expectedRevision !== await native.configurationRevision(session)) throw new Error('REVISION_CONFLICT')
    return this.request(source, session, operation === 'fast-set' ? { fast: args.fast } : { projectId: args.projectId })
  }
  async validate(selection: ChannelTaskPatch, threadId?: string): Promise<ChannelTaskPatch> {
    const validated = validateChannelTaskSelection(
      channelTaskCatalog(await this.input.native()?.modelOperation('list', {})),
      selection,
    )
    await this.input.native()?.validateTaskConfiguration?.(validated, threadId)
    return validated
  }
  private allowed(event: ChannelEventRef, patch: ChannelTaskPatch, selection: ChannelTaskPatch): boolean {
    const state = this.input.store.snapshot()
    return !channelTaskFields(patch).some(command => channelCommandDenied(state.policy, event, command))
      && channelTaskChangeAllowed(state.taskConfig, state.policy, event, patch, selection)
  }
  async request(event: ChannelEventRef | undefined, threadId: string, value: unknown, expectedRevision?: number) {
    if (!this.isBound(threadId) || event && !this.bound(event, threadId)) throw new Error('CHANNEL_TARGET_NOT_BOUND')
    if (event && !event.actor?.userId) throw new Error('CHANNEL_ACTOR_REQUIRED')
    const requested = parseChannelTaskPatch(value)
    if (!Object.keys(requested).length) throw new Error('EMPTY_TASK_PATCH')
    const current = await this.read(threadId)
    if (
      expectedRevision !== undefined
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision)
    ) throw new Error('REVISION_CONFLICT')
    if (current.pending || ['applying', 'submitted'].includes(current.application)) {
      throw new Error('TASK_CHANGE_PENDING')
    }
    const { patch, selection } = resolveChannelTaskSelection(
      channelTaskCatalog(await this.input.native()?.modelOperation('list', {})),
      current.settings,
      requested,
    )
    await this.validate(selection, threadId)
    const now = Date.now()
    const request: ChannelTaskRequest | undefined = event
      ? {
        id: randomBytes(4).toString('hex'),
        token: randomBytes(24).toString('hex'),
        source: structuredClone(event),
        threadId,
        patch,
        selection,
        baseSelection: current.settings,
        expectedRevision: current.revision,
        createdAt: now,
        expiresAt: now + 10 * 60_000,
        state: this.allowed(event, patch, selection) ? 'queued' : 'pending',
      }
      : undefined
    if (request?.state === 'queued') request.approvedBy = structuredClone(event!)
    await this.input.store.mutate(state => {
      if (ChannelConversationStore.logicalSourceFenced(state, threadId)) throw new Error('CONTINUATION_PENDING')
      if ((state.taskSettings[threadId]?.revision ?? 0) !== current.revision) throw new Error('REVISION_CONFLICT')
      if (state.taskSettings[threadId]?.pending || state.taskSettings[threadId]?.application === 'applying') {
        throw new Error('TASK_CHANGE_PENDING')
      }
      if (request) {
        if (
          Object.values(state.taskRequests).filter(row => ['pending', 'queued', 'applying'].includes(row.state)).length
            >= 512
        ) throw new Error('TASK_REQUEST_CAPACITY')
        state.taskRequests[request.id] = request
      }
      if (!request || request.state === 'queued') {
        state.taskSettings[threadId] = {
          revision: current.revision + 1,
          settings: current.settings,
          pending: selection,
          pendingPatch: patch,
          baseSelection: current.settings,
          application: 'saved',
        }
      }
    })
    if (request?.state === 'pending') await this.card(request)
    return {
      status: 'ok',
      threadId,
      revision: current.revision + (request?.state === 'pending' ? 0 : 1),
      application: request?.state === 'pending' ? 'approval-required' : 'saved',
      ...(request ? { requestId: request.id } : {}),
      settings: selection,
    }
  }
  async answer(event: ChannelEventRef, id: string, decision: 'accept' | 'decline', cardMessageId?: string) {
    if (!event.actor?.userId) throw new Error('CHANNEL_ACTOR_REQUIRED')
    const request = Object.values(this.input.store.snapshot().taskRequests).find(item =>
      item.id === id || item.token === id
    )
    if (!request || !same(request.source, event)) throw new Error('TASK_REQUEST_NOT_FOUND')
    if (cardMessageId && cardMessageId !== request.cardMessageId) throw new Error('APPROVAL_CARD_MISMATCH')
    if (request.state !== 'pending') return '此请求已处理；不会重复执行。'
    if (request.expiresAt <= Date.now()) throw new Error('TASK_REQUEST_EXPIRED')
    if (!this.bound(request.source, request.threadId)) throw new Error('CHANNEL_TARGET_NOT_BOUND')
    const permitted = this.allowed(event, request.patch, request.selection)
    if (
      decision === 'accept' ? !permitted : !permitted && event.actor.userId !== request.source.actor?.userId
        && !channelPolicyAllows(this.input.store.snapshot().policy, 'command', event, 'task-deny')
    ) throw new Error('MODEL_CHANGE_PERMISSION_DENIED')
    if (decision === 'accept') {
      await this.validate(request.selection, request.threadId)
      const current = await this.read(request.threadId)
      if (!channelTaskSelectionMatches(current.settings, request.baseSelection)) throw new Error('REVISION_CONFLICT')
    }
    await this.input.store.mutate(state => {
      const pending = state.taskRequests[request.id]!
      if (ChannelConversationStore.logicalSourceFenced(state, request.threadId)) throw new Error('CONTINUATION_PENDING')
      if (pending.state !== 'pending') throw new Error('TASK_REQUEST_ALREADY_HANDLED')
      if (!this.bound(request.source, request.threadId) || pending.expiresAt <= Date.now()) {
        throw new Error('TASK_REQUEST_EXPIRED')
      }
      if (decision === 'decline') {
        pending.state = 'denied'
        pending.code = 'USER_DENIED'
        return
      }
      if (!this.allowed(event, request.patch, request.selection)) throw new Error('MODEL_CHANGE_PERMISSION_DENIED')
      if (
        (state.taskSettings[request.threadId]?.revision ?? 0) !== request.expectedRevision
        || state.taskSettings[request.threadId]?.pending
      ) throw new Error('REVISION_CONFLICT')
      state.taskSettings[request.threadId] = {
        revision: request.expectedRevision + 1,
        settings: request.baseSelection,
        pending: request.selection,
        pendingPatch: request.patch,
        baseSelection: request.baseSelection,
        application: 'saved',
      }
      pending.state = 'queued'
      pending.approvedBy = structuredClone(event)
    })
    await this.card(this.input.store.snapshot().taskRequests[request.id]!)
    return decision === 'accept' ? '已批准这次具体变更；对话空闲后应用。' : '已拒绝；未修改模型配置。'
  }
  private card(request: ChannelTaskRequest): Promise<void> {
    const before = this.cardUpdates.get(request.id) ?? Promise.resolve()
    const update = before.catch(() => undefined).then(() =>
      this.publishCard(this.input.store.snapshot().taskRequests[request.id] ?? request)
    )
    this.cardUpdates.set(request.id, update)
    void update.finally(() => {
      if (this.cardUpdates.get(request.id) === update) this.cardUpdates.delete(request.id)
    }).catch(() => undefined)
    return update
  }
  private async publishCard(request: ChannelTaskRequest) {
    const access = this.input.access()
    const labels: Record<string, string> = {
      providerId: '服务商',
      model: '模型',
      effort: '强度',
      fast: 'Fast',
      projectId: '项目',
    }
    const summary = Object.entries(request.patch).map(([key, value]) =>
      `${labels[key] ?? key}：${
        typeof value === 'boolean' ? value ? '开启' : '关闭' : channelApprovalPreview(value, '未知')
      }`
    ).join(' · ')
    const reason = '请求调整对话任务配置，需要有对应字段和目标值权限的用户批准。'
    const status = request.state === 'pending'
      ? '等待批准'
      : request.state === 'queued'
      ? '等待对话空闲'
      : request.state === 'submitted'
      ? '已保存，下次对话生效'
      : request.state === 'applied'
      ? '已应用'
      : request.state === 'denied'
      ? '已拒绝'
      : request.state === 'expired'
      ? '已过期'
      : request.state === 'unknown'
      ? '执行结果未知，请重新读取'
      : '正在应用'
    const display = {
      id: request.id,
      token: `task:${request.token}`,
      chat: await this.input.native()?.label(request.threadId).catch(() => undefined) ?? 'Codex 对话',
      ...(request.source.actor?.userId ? { requester: request.source.actor.userId } : {}),
      summary,
      reason,
      scope: channelApprovalPreview(JSON.stringify({ threadId: request.threadId, patch: request.patch }), ''),
      statusText: status,
      state: request.state === 'pending'
        ? 'pending' as const
        : ['queued', 'applying', 'submitted'].includes(request.state)
        ? 'submitted' as const
        : request.state === 'expired'
        ? 'expired' as const
        : request.state === 'unknown'
        ? 'unknown' as const
        : 'resolved' as const,
      sessionApproval: false,
    }
    try {
      if (!access?.sendCard) throw new Error('CHANNEL_CARD_UNAVAILABLE')
      if (request.cardMessageId && access.updateCard) {
        await access.updateCard(request.source, request.cardMessageId, channelApprovalCard(display))
      } else {
        const id = await access.sendCard(request.source, channelApprovalCard(display))
        await this.input.store.mutate(state => {
          if (state.taskRequests[request.id]) state.taskRequests[request.id]!.cardMessageId = id
        })
      }
    } catch {
      if (request.state === 'pending') {
        await this.input.notify?.(
          request.source,
          `${summary}；等待任务配置权限批准。用 /task-approve ${request.id} 或 /task-deny ${request.id}。`,
          `task-approval:${request.id}:fallback`,
        ).catch(() => undefined)
      }
    }
  }
  pump(): Promise<void> {
    return this.application.pump()
  }
  async call(operation: string, value: unknown, metadata?: unknown): Promise<unknown> {
    const args = channelRecord(value), caller = this.caller(metadata)
    const metadataRecord = object(metadata)
    const metadataThread = callerThreadId(metadata)
    const mutation = operation.endsWith('-set') || ['task-approve', 'task-deny'].includes(operation)
    if (
      (metadataRecord['cordisx/channelContext'] !== undefined
        || mutation && metadataThread && this.isBound(metadataThread)) && !caller
    ) {
      throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
    }
    if (operation === 'model-list') {
      channelExact(args, [])
      return this.catalog(caller?.threadId ?? metadataThread)
    }
    if (operation === 'task-config') {
      channelExact(args, [])
      const state = this.input.store.snapshot()
      return { status: 'ok', revision: state.taskConfigRevision, config: state.taskConfig }
    }
    if (operation === 'task-config-set') {
      if (caller || metadataThread) throw new Error('PROFILE_SETTINGS_REQUIRE_LOCAL_USER')
      channelExact(args, ['config', 'expectedRevision'])
      const config = parseChannelTaskConfig(args.config)
      if ([config.defaults, ...config.scopes.map(rule => rule.settings)].some(patch => Object.keys(patch).length)) {
        const native = this.input.native()
        if (!native) throw new Error('NATIVE_BACKEND_UNAVAILABLE')
        const catalog = channelTaskCatalog(await native.modelOperation('list', {}))
        const base = Object.keys(config.defaults).length
          ? resolveChannelTaskSelection(catalog, await native.creationSelection(), config.defaults).selection
          : await native.creationSelection()
        await native.validateTaskConfiguration?.(base)
        for (const rule of config.scopes) {
          if (Object.keys(rule.settings).length) {
            const selected = resolveChannelTaskSelection(catalog, base, rule.settings).selection
            await native.validateTaskConfiguration?.(selected)
          }
        }
      }
      return this.input.store.mutate(state => {
        if (state.taskConfigRevision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
        const groups = new Set(state.policy.groups.map(group => group.id))
        if ([...config.scopes, ...config.permissions].some(rule => rule.userGroupIds?.some(id => !groups.has(id)))) {
          throw new Error('USER_GROUP_NOT_FOUND')
        }
        state.taskConfig = config
        state.taskConfigRevision += 1
        return { status: 'ok', revision: state.taskConfigRevision, config }
      })
    }
    if (operation === 'task-requests') {
      channelExact(args, [])
      return {
        status: 'ok',
        requests: Object.values(this.input.store.snapshot().taskRequests).filter(item =>
          caller ? same(item.source, caller.source) : !metadataThread || item.threadId === metadataThread
        )
          .map(({ token: _token, cardMessageId: _card, ...item }) => item),
      }
    }
    if (operation === 'task-approve' || operation === 'task-deny') throw new Error('EXPLICIT_CHANNEL_USER_REQUIRED')
    channelExact(
      args,
      operation === 'task-settings-set' ? ['sessionId', 'settings', 'expectedRevision'] : ['sessionId'],
    )
    const threadId = channelText(args.sessionId ?? caller?.threadId ?? metadataThread)
    if (
      caller && !this.bound(caller.source, threadId) && !(operation === 'task-settings' && threadId === caller.threadId)
    ) throw new Error('CHANNEL_TARGET_NOT_BOUND')
    if (!caller && metadataThread && metadataThread !== threadId) throw new Error('SESSION_SCOPE_MISMATCH')
    if (operation === 'task-settings') return this.read(threadId)
    if (operation !== 'task-settings-set') throw new Error('INVALID_REQUEST')
    if (metadataThread && !caller) throw new Error('CHANNEL_TARGET_NOT_BOUND')
    if (args.expectedRevision !== undefined && !Number.isSafeInteger(args.expectedRevision)) {
      throw new Error('INVALID_REQUEST')
    }
    return this.request(caller?.source, threadId, args.settings, args.expectedRevision as number | undefined)
  }
  async externalSelection(value: unknown, metadata: unknown): Promise<unknown | undefined> {
    const args = object(value), caller = this.caller(metadata)
    if (object(metadata)['cordisx/channelContext'] !== undefined && !caller) {
      return { status: 'rejected', reason: 'channel-context-required', tool: 'channel_task_settings_set' }
    }
    if (caller) {
      return this.request(caller.source, channelText(args.threadId), { providerId: args.providerId, model: args.model })
    }
    const callerId = callerThreadId(metadata)
    if ((!callerId || !this.isBound(callerId)) && (typeof args.threadId !== 'string' || !this.isBound(args.threadId))) {
      return undefined
    }
    return { status: 'rejected', reason: 'channel-context-required', tool: 'channel_task_settings_set' }
  }
}
