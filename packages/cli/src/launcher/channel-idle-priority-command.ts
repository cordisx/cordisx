import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { eventThread } from './channel-conversation-refs.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import { channelLogicalBindingAdmitted } from './channel-logical-continuation-bind.js'
import { channelIdleGrantCurrent, type ChannelIdlePriorityGrant } from './channel-idle-priority-grant.js'
import { removeChannelIdlePriorityGrant } from './channel-idle-priority-revoke.js'
import { channelCommandDenied, channelPolicyAllows } from './channel-conversation-policy.js'
import { channelTaskChangeAllowed, channelTaskFields, type ChannelTaskPatch } from './channel-task-config.js'
import { channelTaskCatalog, validateChannelTaskSelection } from './channel-task-selection.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import { boundedChannelSelectionValidation } from './channel-model-priority-dispatch.js'

const lifetimeMs = 24 * 60 * 60_000

/** Exact source and target arguments disclose the one linked-history consent being granted. */
export async function channelIdlePriorityCommand(input: {
  store: ChannelConversationStore
  native?: ChannelNativeSessions | undefined
  appId?: string
  profileId: string
  event: ChannelEventRef
  parts: string[]
  idlePriorityOffers?: Map<string, { grant: ChannelIdlePriorityGrant; expiresAt: number }>
}): Promise<string> {
  const { store, native, appId, profileId, event, parts, idlePriorityOffers } = input
  if (!appId || event.kind !== 'direct' || !event.actor?.userId) return '当前环境不支持此操作。'
  const matches = Object.values(store.snapshot().bindings).filter(binding =>
    binding.state === 'active' && binding.profileId === profileId
    && isDeepStrictEqual(binding.channel, eventThread(event))
  )
  if (matches.length !== 1) return '需要当前私聊恰好绑定一个对话。'
  const binding = matches[0]!, source = { hostId: 'local', appId, profileId, sessionId: binding.sessionId }
  if (parts.length === 1 && parts[0] === 'auto-off') {
    let removedOffer = false
    for (const [token, offer] of idlePriorityOffers ?? []) {
      if (offer.grant.bindingId === binding.id && isDeepStrictEqual(offer.grant.actor, channelLogicalActor(event))) {
        idlePriorityOffers!.delete(token)
        removedOffer = true
      }
    }
    return channelLogicalTransactionStore(store).mutate(state => {
      const grant = state.logicalContinuations!.idlePriorityGrants?.[binding.id]
      if (!grant || !isDeepStrictEqual(grant.actor, channelLogicalActor(event))) {
        return removedOffer ? '已取消待确认的自动切换授权。' : '当前没有可撤销的自动切换授权。'
      }
      removeChannelIdlePriorityGrant(state.logicalContinuations!, binding.id)
      return '已撤销自动切换授权。'
    })
  }
  if (!native?.logicalMigrationLease || !store.hasCommitBarrier()) return '当前运行方式无法安全保护原对话，未授权。'
  const suggest = parts.length === 5 && parts[0] === 'auto-suggest'
  const confirm = parts.length === 8 && parts[0] === 'auto' && parts[5] === '--history=user,assistant'
    && parts[6] === '--no-checkpoint' && /^--confirm=[a-f0-9]{32}$/u.test(parts[7]!)
  if (!idlePriorityOffers || !suggest && !confirm) {
    return '用法：/continue-provider auto-suggest <当前服务商> <当前模型> <后续服务商> <后续模型>。确认前会说明历史共享范围。使用 auto-off 撤销。'
  }
  const target = { providerId: parts[3]!, model: parts[4]! }, state = store.snapshot()
  if (
    !channelLogicalBindingAdmitted(state, event, profileId, source.sessionId)
    || !channelPolicyAllows(state.policy, 'command', event, 'continue-provider')
  ) return '当前权限或对话状态不允许授权。'
  let selection: ChannelTaskPatch
  try {
    selection = await native.taskSelection(source.sessionId)
    if (
      selection.providerId !== parts[1] || selection.model !== parts[2] || !selection.effort
      || typeof selection.fast !== 'boolean'
    ) {
      return '当前模型或执行设置无法确认，未授权。'
    }
    await boundedChannelSelectionValidation(async () => {
      validateChannelTaskSelection(channelTaskCatalog(await native.modelOperation('list', {})), {
        ...selection,
        ...target,
      })
      await native.validateTaskConfiguration({ ...selection, ...target }, source.sessionId)
    })
  } catch {
    return '无法确认目标模型支持当前设置，未授权。'
  }
  if (
    channelTaskFields(target).some(command => channelCommandDenied(state.policy, event, command))
    || !channelTaskChangeAllowed(state.taskConfig, state.policy, event, target, { ...selection, ...target })
  ) {
    return '当前用户没有目标模型的授权。'
  }
  const logicalId = logicalConversationIdentity(state.logicalContinuations, source)
  if (!logicalId) return '无法确认对话关系，未授权。'
  const grant: ChannelIdlePriorityGrant = {
    bindingId: binding.id,
    source,
    actor: channelLogicalActor(event),
    logicalId,
    priorityRevision: state.modelPriority.revision,
    taskConfigRevision: state.taskConfigRevision,
    policyRevision: state.policyRevision,
    selection,
    target,
    expiresAt: Date.now() + lifetimeMs,
  }
  const candidates = state.modelPriority.candidates
  const index = candidates.findIndex(row => row.providerId === selection.providerId && row.model === selection.model)
  if (index < 0 || !isDeepStrictEqual(candidates[index + 1], target)) return '目标不是当前配置中的下一模型，未授权。'
  if (suggest) {
    const current = store.snapshot()
    if (
      current.modelPriority.revision !== grant.priorityRevision || current.policyRevision !== grant.policyRevision
      || current.taskConfigRevision !== grant.taskConfigRevision
      || !channelLogicalBindingAdmitted(current, event, profileId, source.sessionId)
    ) return '配置或权限已变化，未授权。'
    for (const [token, offer] of idlePriorityOffers) if (offer.expiresAt <= Date.now()) idlePriorityOffers.delete(token)
    if (idlePriorityOffers.size >= 128) return '待确认的授权过多，请稍后再试。'
    const token = randomBytes(16).toString('hex')
    idlePriorityOffers.set(token, { grant, expiresAt: Date.now() + 10 * 60_000 })
    return `自动接续将从 ${selection.providerId} / ${selection.model} 切换到 ${target.providerId} / ${target.model}；目标服务可按需读取获准的用户和助手文本，不共享检查点。探测可能产生模型费用。若同意一次授权，请在 10 分钟内发送 /continue-provider auto ${selection.providerId} ${selection.model} ${target.providerId} ${target.model} --history=user,assistant --no-checkpoint --confirm=${token}。`
  }
  const token = parts[7]!.slice('--confirm='.length), offer = idlePriorityOffers.get(token)
  if (
    !offer || offer.expiresAt <= Date.now()
    || !isDeepStrictEqual(offer.grant, { ...grant, expiresAt: offer.grant.expiresAt })
  ) {
    return '确认已过期或配置已变化，请重新查看授权说明。'
  }
  const approved = offer.grant
  return channelLogicalTransactionStore(store).mutate(current => {
    if (idlePriorityOffers.get(token) !== offer || offer.expiresAt <= Date.now()) {
      return '确认已过期，请重新查看授权说明。'
    }
    if (
      !channelLogicalBindingAdmitted(current, event, profileId, source.sessionId)
      || current.modelPriority.revision !== grant.priorityRevision
      || current.taskConfigRevision !== state.taskConfigRevision || current.policyRevision !== state.policyRevision
    ) {
      return '配置或权限已变化，未授权。'
    }
    current.logicalContinuations!.idlePriorityGrants ??= {}
    const previous = current.logicalContinuations!.idlePriorityGrants[binding.id]
    if (previous && !isDeepStrictEqual(previous.actor, grant.actor)) return '当前绑定已有其他用户的授权。'
    current.logicalContinuations!.idlePriorityGrants[binding.id] = approved
    if (!channelIdleGrantCurrent(current, approved, event)) {
      if (previous) current.logicalContinuations!.idlePriorityGrants[binding.id] = previous
      else removeChannelIdlePriorityGrant(current.logicalContinuations!, binding.id)
      return '目标不是当前配置中的下一模型，未授权。'
    }
    idlePriorityOffers.delete(token)
    return `已授权一次自动接续至 ${target.providerId} / ${target.model}，24 小时内有效；目标可按需读取获准的用户和助手文本，不共享检查点。`
  })
}
