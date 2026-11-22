import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelNativeSourceFence } from './channel-native-source-fence.js'
import { eventThread, identity } from './channel-conversation-refs.js'
import { startChannelLogicalContinuation } from './channel-logical-continuation.js'
import type { LogicalContinuationRequest } from './logical-continuation-control.js'
import { channelLogicalActor } from './channel-logical-actor.js'
import { channelLogicalTransactionStore } from './channel-logical-continuation-store.js'
import {
  logicalPreferenceRevision,
  resolveLogicalContinuationPreference,
  setLogicalContinuationPreference,
} from './logical-continuation-preferences.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { channelLogicalContinuationAdmitted } from './channel-logical-continuation-scope.js'
import { logicalConversationIdentity } from './logical-conversation-identity.js'
import type { ChannelConversationState } from './channel-conversation-store.js'
import type { ConversationContinuationPreferenceV1 } from '@cordisx/protocol/conversation-continuation/v1'
import { abandonChannelLogicalContinuation } from './channel-logical-abandon.js'
import { channelDesktopAuthorization } from './channel-desktop-authorization.js'
import type { DesktopChannelGrants } from './desktop-channel-grants.js'
import { jointHistorySourceAllowed } from './channel-joint-history.js'

function conversationScope(state: ChannelConversationState, appId: string, profileId: string, event: ChannelEventRef) {
  const matches = Object.values(state.bindings).filter(binding =>
    binding.state === 'active'
    && binding.profileId === profileId && isDeepStrictEqual(binding.channel, eventThread(event))
  )
  if (matches.length !== 1) return undefined
  const source = { hostId: 'local', appId, profileId, sessionId: matches[0]!.sessionId }
  const logicalId = logicalConversationIdentity(state.logicalContinuations, source)
  return logicalId ? { source, logicalId } : undefined
}
async function defaultMode(
  state: ChannelConversationState,
  native: ChannelNativeSessions,
  source: { sessionId: string },
  target: { providerId: string; model: string },
) {
  const config = await native.continuationConfiguration(source.sessionId)
  if (!config) return undefined
  const linkedParent = Object.values(state.logicalContinuations?.relations ?? {}).some(relation =>
    relation.mode === 'linked' && isDeepStrictEqual(relation.destination, source)
  )
  return native.supportsLogicalFork?.() === true && !linkedParent
      && config.providerId === target.providerId && config.model === target.model
    ? 'fork' as const
    : 'linked' as const
}

async function preferredMode(
  preference: ConversationContinuationPreferenceV1 | undefined,
  state: ChannelConversationState,
  native: ChannelNativeSessions,
  source: { sessionId: string },
  target: { providerId: string; model: string },
) {
  if (preference?.mode === 'fresh') return undefined
  if (preference?.mode === 'linked') return 'linked' as const
  return await defaultMode(state, native, source, target)
}

/** Exact command syntax is the user's explicit consent to the displayed history categories. */
export async function channelLogicalCommand(input: {
  store: ChannelConversationStore
  native: ChannelNativeSessions | undefined
  fence: ChannelNativeSourceFence
  claims: Set<string>
  appId?: string
  profileId: string
  event: ChannelEventRef
  recordId: string
  argument: string
  desktopGrants?: DesktopChannelGrants
}) {
  const parts = input.argument.trim().split(/\s+/u)
  if (parts.length === 2 && parts[0] === 'status') {
    const intent = input.store.snapshot().logicalContinuations?.intents[parts[1]!]
    if (!intent || !isDeepStrictEqual(intent.actor, channelLogicalActor(input.event))) return '未找到此操作。'
    if (intent.state === 'applied') return '切换已完成，绑定已迁移。'
    if (intent.state === 'rejected' && intent.code === 'USER_ABANDONED_UNKNOWN') {
      return '已解除原对话屏障；未确认的目标可能仍存在，未自动删除或重试。'
    }
    if (intent.state === 'rejected') return `切换未执行：${intent.code ?? 'NATIVE_REJECTED'}。`
    return `结果尚未确认；原对话派发仍暂停。${
      intent.destination ? '已记录目标对话：' + intent.destination.sessionId + '。' : ''
    }请先核对原生对话，勿重复提交。如接受可能存在孤儿目标，可用 /continue-provider abandon ${
      parts[1]
    } --confirm-orphan-possible 解除屏障；不会删除目标。`
  }
  if (
    parts.length === 7 && parts[0] === 'authorize-desktop' && parts[1] === 'linked'
    && parts[4] === '--history=user-assistant'
    && parts[5] === '--no-checkpoint'
    && /^--challenge=[A-Za-z0-9_-]{32}$/u.test(parts[6]!)
  ) {
    if (!input.desktopGrants || !input.native || !input.appId || input.event.kind !== 'direct') {
      return '当前环境不支持桌面授权。'
    }
    const state = input.store.snapshot(), context = conversationScope(state, input.appId, input.profileId, input.event)
    if (!context) return '需要当前私聊恰好绑定一个对话。'
    const target = { providerId: parts[2]!, model: parts[3]! }
    const selection = await input.native.taskSelection(context.source.sessionId)
    if (
      !jointHistorySourceAllowed(input.store.snapshot(), context.source, input.event)
      || !await input.native.logicalJointSourceRoot(context.source)
      || !channelDesktopAuthorization(
        input.store.snapshot(),
        input.event,
        input.profileId,
        context.source.sessionId,
        target,
        selection,
      )
    ) {
      return '当前权限或对话状态不允许授权。'
    }
    if (
      !input.desktopGrants.authorize(
        parts[6]!.slice('--challenge='.length),
        context.source.sessionId,
        target,
        input.event,
        'linked',
      )
    ) {
      return '桌面确认已过期或不匹配，请从桌面重新发起。'
    }
    return '已授权桌面迁移此私聊绑定及符合条件的排队消息，并允许新对话按需读取来源和双方此前授权的接续历史中的用户与助手文本；目标服务可能收到这些文本。不共享检查点。请在桌面完成确认。'
  }
  if (parts.length === 3 && parts[0] === 'suggest') {
    if (!input.native || !input.appId || input.event.kind !== 'direct' || !input.event.actor?.userId) {
      return '当前环境不支持此操作。'
    }
    const state = input.store.snapshot(), context = conversationScope(state, input.appId, input.profileId, input.event)
    if (!context) return '需要当前私聊恰好绑定一个对话，且关系明确。'
    if (!channelPolicyAllows(state.policy, 'command', input.event, 'continue-provider')) {
      return '当前用户没有设置权限。'
    }
    if (!channelLogicalContinuationAdmitted(state, input.event, input.profileId, context.source.sessionId)) {
      return '当前权限或对话状态不允许此操作，请确认权限并等待对话空闲。'
    }
    const preference = state.logicalContinuations
      && resolveLogicalContinuationPreference(state.logicalContinuations, {
        profileId: input.profileId,
        conversationId: context.logicalId,
      })
    if (preference?.mode === 'fresh') {
      return '此前保存的空白模式已不再用于接续；请重新选择 linked 或 fork，并明确授权历史。原设置和历史记录保留。'
    }
    const mode = await preferredMode(preference, state, input.native, context.source, {
      providerId: parts[1]!,
      model: parts[2]!,
    })
    if (!mode) return '当前无法确认来源配置，请待对话空闲后重试。'
    const consent = mode === 'fork'
      ? '--history=inherit --no-checkpoint'
      : '--history=user,assistant --no-checkpoint'
    return `建议模式：${mode}。确认授权后使用 /continue-provider preferred ${parts[1]} ${
      parts[2]
    } ${consent}。fork 继承完整原生历史；linked 允许按需读取用户和助手文本，形似内部上下文凭据的字符串可能被遮蔽。`
  }
  if (parts.length === 3 && parts[0] === 'abandon' && parts[2] === '--confirm-orphan-possible') {
    if (!input.appId || input.event.kind !== 'direct') return '当前环境不支持此操作。'
    const abandoned = await abandonChannelLogicalContinuation({ ...input, appId: input.appId, operationId: parts[1]! })
    return abandoned
      ? '已解除原对话屏障；未确认的目标可能仍存在，未自动删除或重试。'
      : '不能解除此操作；请检查状态和当前权限。'
  }
  if (parts.length === 2 && parts[0] === 'preference') {
    const mode = parts[1]
    if (!['linked', 'fork', 'inherit'].includes(mode ?? '')) {
      return '可选模式：linked、fork 或 inherit。'
    }
    if (
      !input.appId || input.event.kind !== 'direct' || !input.event.actor?.userId
      || input.event.actor.adapterId !== input.event.adapterId || input.event.actor.accountId !== input.event.accountId
      || input.event.actor.tenantId !== input.event.tenantId
    ) return '当前环境不支持此操作。'
    return channelLogicalTransactionStore(input.store).mutate(state => {
      if (
        !state.policy.enabled || !channelPolicyAllows(state.policy, 'command', input.event, 'continue-provider')
        || !channelPolicyAllows(state.policy, 'command', input.event, 'task-settings')
      ) return '当前用户没有设置权限。'
      const context = conversationScope(state, input.appId!, input.profileId, input.event)
      if (!context) return '需要当前私聊恰好绑定一个对话。'
      const scope = { kind: 'conversation' as const, id: context.logicalId }, logical = state.logicalContinuations!
      setLogicalContinuationPreference(
        logical,
        scope,
        mode === 'inherit' ? null : mode as 'linked' | 'fork',
        logicalPreferenceRevision(logical, scope),
      )
      return mode === 'inherit'
        ? '已清除本对话覆盖，使用更宽范围的设置。'
        : `已设置本对话首选模式：${mode}。每次切换仍需明确授权历史范围。`
    })
  }
  if (
    parts.length !== 5 || !['linked', 'fork', 'preferred'].includes(parts[0] ?? '')
    || !['--history=user,assistant', '--history=inherit'].includes(parts[3] ?? '')
    || !['--no-checkpoint', '--checkpoint'].includes(parts[4] ?? '')
  ) {
    return '用法：linked 使用 --history=user,assistant，允许按需读取文本，形似内部上下文凭据的字符串可能被遮蔽；--checkpoint 还发送已保存的任务检查点。fork 使用 --history=inherit --no-checkpoint，继承完整原生历史（包括工具内容等），仅支持相同服务商和模型且来源没有更早的按需接续。原对话均会保留。'
  }
  if (!input.native || !input.appId || input.event.kind !== 'direct') return '当前环境不支持此操作。'
  const state = input.store.snapshot(), operationId = `channel-logical:${identity(input.recordId)}`
  const previous = state.logicalContinuations?.intents[operationId]
  let request: LogicalContinuationRequest
  let chosenPreference: ConversationContinuationPreferenceV1 | null | undefined
  if (previous) {
    request = previous.request
    if (request.mode === 'fresh') return '此旧操作仅可查看状态；请重新选择 linked 或 fork。'
    if (
      request.target.providerId !== parts[1] || request.target.model !== parts[2]
      || parts[0] !== 'preferred' && request.mode !== parts[0]
      || request.mode === 'linked' && request.handoffConsent !== (parts[4] === '--checkpoint' ? 'checkpoint' : 'none')
    ) {
      return '操作内容已变化，请重新发起。'
    }
  } else {
    const context = conversationScope(state, input.appId, input.profileId, input.event)
    if (!context) return '需要当前私聊恰好绑定一个对话，且关系明确。'
    const { source, logicalId } = context
    const preference = state.logicalContinuations
      && resolveLogicalContinuationPreference(state.logicalContinuations, {
        profileId: input.profileId,
        conversationId: logicalId,
      })
    if (parts[0] === 'preferred' && preference?.mode === 'fresh') {
      return '此前保存的空白模式已不再用于接续；请重新选择 linked 或 fork，并明确授权历史。原设置和历史记录保留。'
    }
    const selected = parts[0] === 'preferred'
      ? await preferredMode(preference, state, input.native, source, { providerId: parts[1]!, model: parts[2]! })
      : parts[0]
    if (parts[0] === 'preferred') chosenPreference = preference ?? null
    if (!selected) return '当前无法确认来源配置，请待对话空闲后重试。'
    const common = {
      contract: 'cordisx.conversation-continuation-request/v1',
      operationId,
      logicalConversationId: logicalId,
      source,
      expectedRevision: state.logicalContinuations?.revision ?? 0,
      target: { providerId: parts[1]!, model: parts[2]! },
    } as const
    request = selected === 'linked'
      ? {
        ...common,
        mode: 'linked',
        historyConsent: 'on-demand',
        handoffConsent: parts[4] === '--checkpoint' ? 'checkpoint' : 'none',
        historyCategories: ['user-text', 'assistant-text'],
      }
      : { ...common, mode: 'fork', historyConsent: 'inherit' }
  }
  if (
    parts[3] !== (request.mode === 'linked'
      ? '--history=user,assistant'
      : '--history=inherit')
  ) {
    return '授权范围与选择的模式不一致；未执行切换。'
  }
  if (request.mode !== 'linked' && parts[4] !== '--no-checkpoint') return '此模式不能传送检查点。'
  const result = await startChannelLogicalContinuation({
    ...input,
    native: input.native,
    appId: input.appId,
    request,
    ...(chosenPreference === undefined ? {} : { preference: chosenPreference }),
  })
  if (result.state === 'applied') {
    return request.mode === 'linked'
      ? `已切换到新对话；原对话已保留，后续消息可按需读取获准的历史文本。${
        request.handoffConsent === 'checkpoint' ? '已授权的检查点将在后续派发时交接。' : ''
      }`
      : '已创建完整原生 fork 并迁移绑定；原对话已保留。'
  }
  if (result.state === 'unknown') return `切换结果尚未确认（${operationId}）；已暂停原对话派发，请勿重复提交。`
  if (result.code === 'HANDOFF_GUARD_UNAVAILABLE') {
    return '当前运行方式无法安全交接检查点，未切换。可选择 --no-checkpoint，或使用具备写入保护的运行方式。'
  }
  if (result.code === 'PREFLIGHT_UNAVAILABLE') {
    return '无法确认目标授权或原对话的状态、工作模式、权限设置和历史。请检查目标及授权并确认原对话空闲；如同意使用默认工作模式，可先执行 /work-mode default，待下一回合完成后重试。'
  }
  return `未切换：${result.code}。原对话和绑定保持不变。`
}
