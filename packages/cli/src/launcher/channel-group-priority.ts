import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationState, ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelIdlePriorityGrant } from './channel-idle-priority-grant.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { sameConversation } from './channel-conversation-refs.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelCommandDenied, channelPolicyAllows } from './channel-conversation-policy.js'
import { channelTaskChangeAllowed, channelTaskChangeDenied, channelTaskFields } from './channel-task-config.js'
import { channelTaskCatalog, validateChannelTaskSelection } from './channel-task-selection.js'
import { boundedChannelSelectionValidation } from './channel-model-priority-dispatch.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'

type Offers = Map<string, { grant: ChannelIdlePriorityGrant; expiresAt: number }>
type Candidate = ChannelIdlePriorityGrant['target']

/** Group authority is derived from the authenticated admin and the exact bound conversation. */
export function channelGroupPriorityCurrent(
  state: ChannelConversationState,
  grant: ChannelIdlePriorityGrant,
  event: ChannelEventRef,
  target?: Candidate,
): boolean {
  const binding = state.bindings[grant.bindingId]
  if (
    !grant.groupScope || !binding || binding.state !== 'active' || binding.mode !== 'deliver'
    || binding.channel.kind !== 'group' || event.kind !== 'group'
    || binding.hostId !== 'local' || binding.profileId !== grant.source.profileId
    || binding.sessionId !== grant.source.sessionId || !sameConversation(binding.channel, event)
    || Object.values(state.bindings).filter(row => row.state === 'active' && row.sessionId === binding.sessionId).length
      !== 1
    || !grant.groupLinked && Object.values(state.bindings).some(row =>
        row.sessionId === binding.sessionId
        && (row.channel.kind !== 'group' || !sameConversation(row.channel, binding.channel))
      )
    || !grant.groupLinked && Object.values(state.jobs).some(job => {
        if (job.sessionId !== binding.sessionId) return false
        const origin = state.inputs[job.recordId]?.input.source.event
        return !origin || origin.kind !== 'group' || !sameConversation(origin, binding.channel)
      })
    || !grant.groupLinked
      && Object.values(state.logicalContinuations?.relations ?? {}).some(relation =>
        relation.destination.sessionId === binding.sessionId
      )
    || !event.actor?.userId || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
    || event.actor.tenantId !== event.tenantId || !channelDispatchAllowed(state, event)
    || !state.policy.enabled || state.policyRevision !== grant.policyRevision
    || state.taskConfigRevision !== grant.taskConfigRevision || state.modelPriority.revision !== grant.priorityRevision
    || grant.expiresAt <= Date.now()
    || !isDeepStrictEqual(state.logicalContinuations?.idlePriorityGrants?.[grant.bindingId], grant)
    || grant.logicalId !== logicalConversationIdentity(state.logicalContinuations, grant.source)
  ) return false
  const admin: ChannelEventRef = {
    ...binding.channel,
    eventId: 'group-priority',
    actor: {
      adapterId: binding.channel.adapterId,
      accountId: binding.channel.accountId,
      tenantId: binding.channel.tenantId,
      userId: grant.actor.principal,
    },
  }
  if (
    !isDeepStrictEqual(channelLogicalActor(admin), grant.actor)
    || !channelPolicyAllows(state.policy, 'command', admin, 'allow-user')
    || !channelPolicyAllows(state.policy, 'command', admin, 'continue-provider')
  ) return false
  const candidates = [grant.target, ...(grant.fallbackTargets ?? [])]
  const list = state.modelPriority.candidates
  let position = list.findIndex(row =>
    isDeepStrictEqual(row, {
      providerId: grant.selection.providerId,
      model: grant.selection.model,
    })
  )
  if (
    position < 0 || !candidates.every(candidate => {
      position = list.findIndex((row, index) => index > position && isDeepStrictEqual(row, candidate))
      return position >= 0 && (!!grant.groupLinked || candidate.providerId === grant.selection.providerId)
    })
  ) return false
  const chosen = target ?? grant.target
  if (!candidates.some(candidate => isDeepStrictEqual(candidate, chosen))) return false
  const denied = (actor: ChannelEventRef) =>
    [...channelTaskFields(chosen), 'continue-provider', 'task-settings'].some(command =>
      channelCommandDenied(state.policy, actor, command)
    )
    || channelTaskChangeDenied(state.taskConfig, state.policy, actor, chosen, { ...grant.selection, ...chosen })
  const adminAllowed = (actor: ChannelEventRef) =>
    !denied(actor)
    && channelTaskChangeAllowed(state.taskConfig, state.policy, actor, chosen, { ...grant.selection, ...chosen })
  if (!adminAllowed(admin) || denied(event)) return false
  return Object.values(state.jobs).filter(job => job.sessionId === binding.sessionId && job.state === 'queued')
    .every(job => {
      const record = state.inputs[job.recordId], origin = record?.input.source.event
      return job.bindingId === binding.id && !job.autoCreate && !!record?.accepted && !!origin
        && origin.kind === 'group' && sameConversation(origin, binding.channel)
        && !!origin.actor?.userId && origin.actor.adapterId === origin.adapterId
        && origin.actor.accountId === origin.accountId && origin.actor.tenantId === origin.tenantId
        && channelDispatchAllowed(state, origin)
        && !denied(origin)
    })
}

/** One explicit group rule; target list is disclosed and same-provider only. */
export async function channelGroupPriorityCommand(input: {
  store: ChannelConversationStore
  native?: ChannelNativeSessions | undefined
  appId?: string
  profileId: string
  event: ChannelEventRef
  parts: string[]
  idlePriorityOffers?: Offers
}): Promise<string> {
  const { store, native, appId, profileId, event, parts, idlePriorityOffers } = input
  if (!appId || event.kind !== 'group' || !event.actor?.userId) return '当前环境不支持此操作。'
  const state = store.snapshot()
  const matches = Object.values(state.bindings).filter(binding =>
    binding.state === 'active'
    && binding.profileId === profileId && binding.channel.kind === 'group' && sameConversation(binding.channel, event)
  )
  if (matches.length !== 1) return '需要当前群恰好绑定一个对话。'
  const binding = matches[0]!
  if (
    !channelDispatchAllowed(state, event) || !channelPolicyAllows(state.policy, 'command', event, 'allow-user')
    || !channelPolicyAllows(state.policy, 'command', event, 'continue-provider')
  ) return '当前用户没有群管理权限。'
  if (parts[0] === 'group-auto-off' && parts.length === 1) {
    for (const [token, offer] of idlePriorityOffers ?? []) {
      if (offer.grant.bindingId === binding.id && offer.grant.groupScope) idlePriorityOffers!.delete(token)
    }
    await channelLogicalTransactionStore(store).mutate(current => {
      if (current.logicalContinuations?.idlePriorityGrants?.[binding.id]?.groupScope) {
        removeChannelIdlePriorityGrant(current.logicalContinuations, binding.id)
      }
      for (const intent of Object.values(current.logicalContinuations?.intents ?? {})) {
        const projection = intent.groupProjection
        if (projection && sameConversation(projection.group, binding.channel)) projection.revoked = true
      }
    })
    return '已撤销当前群的自动切换规则。'
  }
  const linked = ['group-linked-suggest', 'group-linked'].includes(parts[0] ?? '')
  const suggest = ['group-auto-suggest', 'group-linked-suggest'].includes(parts[0] ?? '') && parts.length === 3
  const confirm = parts[0] === 'group-auto' && parts.length === 4 && /^--confirm=[a-f0-9]{32}$/u.test(parts[3]!)
    || parts[0] === 'group-linked' && parts.length === 5 && parts[3] === '--history=group-recorded'
      && /^--confirm=[a-f0-9]{32}$/u.test(parts[4]!)
  if (!idlePriorityOffers || !suggest && !confirm) {
    return '用法：/continue-provider group-auto-suggest <当前服务商> <当前模型>；使用 group-auto-off 撤销。'
  }
  if (!native || !store.hasCommitBarrier()) return '当前运行方式无法安全保存规则。'
  const source = { hostId: 'local', appId, profileId, sessionId: binding.sessionId }
  let selection
  try {
    selection = await native.taskSelection(source.sessionId)
  } catch {
    return '无法确认当前模型。'
  }
  if (
    selection.providerId !== parts[1] || selection.model !== parts[2] || !selection.effort
    || typeof selection.fast !== 'boolean'
  ) return '当前模型或执行设置无法确认。'
  const index = state.modelPriority.candidates.findIndex(row =>
    row.providerId === selection.providerId && row.model === selection.model
  )
  if (index < 0) return '当前模型不在优先级配置中。'
  const allowed: Candidate[] = []
  for (const candidate of state.modelPriority.candidates.slice(index + 1)) {
    if (!linked && candidate.providerId !== selection.providerId) break
    if (
      channelTaskFields(candidate).some(command => channelCommandDenied(state.policy, event, command))
      || !channelTaskChangeAllowed(state.taskConfig, state.policy, event, candidate, { ...selection, ...candidate })
    ) continue
    try {
      await boundedChannelSelectionValidation(async () => {
        validateChannelTaskSelection(channelTaskCatalog(await native.modelOperation('list', {})), {
          ...selection,
          ...candidate,
        })
        await native.validateTaskConfiguration({ ...selection, ...candidate }, source.sessionId)
      })
      allowed.push(candidate)
    } catch { /* Unsupported candidates do not gain authorization. */ }
  }
  if (!allowed.length) return '没有可授权的同服务商后续模型。跨服务商群历史接续暂不可用。'
  const logicalId = logicalConversationIdentity(state.logicalContinuations, source)
  if (!logicalId) return '无法确认对话关系。'
  const grant: ChannelIdlePriorityGrant = {
    bindingId: binding.id,
    source,
    actor: channelLogicalActor({ ...event, threadId: binding.channel.threadId, semantics: binding.channel.semantics }),
    logicalId,
    priorityRevision: state.modelPriority.revision,
    taskConfigRevision: state.taskConfigRevision,
    policyRevision: state.policyRevision,
    selection,
    target: allowed[0]!,
    fallbackTargets: allowed.slice(1),
    expiresAt: Date.now() + 24 * 60 * 60_000,
    groupScope: true,
    ...(linked ? { groupLinked: true as const } : {}),
  }
  if (suggest) {
    const token = randomBytes(16).toString('hex')
    if (idlePriorityOffers.size >= 128) return '待确认的授权过多，请稍后再试。'
    idlePriorityOffers.set(token, { grant, expiresAt: Date.now() + 10 * 60_000 })
    const command = linked
      ? `group-linked ${selection.providerId} ${selection.model} --history=group-recorded`
      : `group-auto ${selection.providerId} ${selection.model}`
    const history = linked
      ? '目标服务可按需读取本群最多最近16条已派发任务的文本输入及其确认送达的最终回复，每条最多4096字符；未记录、未确认、主动发送、附件、工具及推理内容会遗漏，不共享完整原生历史。'
      : '保留原对话和项目。'
    return `本群空闲时，当前模型确认不可用后，将按顺序尝试 ${
      allowed.map(row => `${row.providerId} / ${row.model}`).join('、')
    }；${history}探测可能产生费用。确认本群规则请在 10 分钟内发送 /continue-provider ${command} --confirm=${token}。`
  }
  const token = parts[linked ? 4 : 3]!.slice('--confirm='.length), offer = idlePriorityOffers.get(token)
  if (
    !offer || offer.expiresAt <= Date.now()
    || !isDeepStrictEqual(offer.grant, { ...grant, expiresAt: offer.grant.expiresAt })
  ) {
    return '确认已过期或配置已变化。'
  }
  const approved = offer.grant
  return channelLogicalTransactionStore(store).mutate(current => {
    if (idlePriorityOffers.get(token) !== offer || offer.expiresAt <= Date.now()) return '确认已过期。'
    current.logicalContinuations!.idlePriorityGrants ??= {}
    const previous = current.logicalContinuations!.idlePriorityGrants[binding.id]
    if (previous && !previous.groupScope) return '当前绑定已有个人授权。'
    current.logicalContinuations!.idlePriorityGrants[binding.id] = approved
    if (
      ![approved.target, ...(approved.fallbackTargets ?? [])]
        .some(candidate => channelGroupPriorityCurrent(current, approved, event, candidate))
    ) {
      if (previous) current.logicalContinuations!.idlePriorityGrants[binding.id] = previous
      else removeChannelIdlePriorityGrant(current.logicalContinuations!, binding.id)
      return '配置或权限已变化，未授权。'
    }
    idlePriorityOffers.delete(token)
    return linked
      ? '已授权本群按配置顺序自动接续；仅共享最多最近16条已派发任务的文本输入及其确认送达的最终回复，每条最多4096字符，其他历史会遗漏，24 小时内有效。'
      : '已授权本群按配置顺序进行同服务商自动切换，24 小时内有效。'
  })
}
