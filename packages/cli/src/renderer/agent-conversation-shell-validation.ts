import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { CommandReference, Disabled, LocalizedText } from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationAction as ProtocolActionV3,
  AgentConversationItem as ProtocolItemV3,
  AgentConversationParticipant as ProtocolParticipantV3,
  AgentConversationRoomSettingsPatch,
  AgentConversationSelection as ProtocolSelectionV3,
  AgentConversationShellPage as AgentConversationShellPageV3,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV3,
  AgentConversationShellSource as AgentConversationShellSourceV3,
  AgentConversationShellUpdate as AgentConversationShellUpdateV3,
} from '@cordisx/protocol/agent-conversation-shell/v3'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { CordisXJsonValue } from '../contracts.js'
import { validateAgentLoopTaskDetailsUrl } from './host-ui/AgentTaskDetailsNavigator.js'
import { LOCAL_ID_PATTERN, REFERENCE_PATTERN } from './validation.js'

export type ProtocolAction = ProtocolActionV3
export type ProtocolItem = ProtocolItemV3
export type ProtocolParticipant = ProtocolParticipantV3
export type ProtocolSelection = ProtocolSelectionV3
export type AgentConversationShellPage = AgentConversationShellPageV3
export type AgentConversationShellSnapshot = AgentConversationShellSnapshotV3
export type AgentConversationShellSource = AgentConversationShellSourceV3
export type AgentConversationShellUpdate = AgentConversationShellUpdateV3
export type PlaygroundScenarioConversationOwnerResolver = (
  owner: string,
  moduleGeneration: string | undefined,
) => PluginOwnerIdentity | undefined

export function exactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value)
  const unknown = keys.find(key => !expected.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

export function plainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.prototype.toString.call(value) !== '[object Object]'
  ) {
    throw new Error(`${label} must be a plain object`)
  }
}

export function text(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} characters`)
  }
}

export function opaque(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/u.test(value)) {
    throw new Error(`${label} must be an opaque identifier`)
  }
}

export function definitionRevision(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || (!/^[A-Za-z0-9._~-]{1,512}$/u.test(value) && !/^sha256:[a-f0-9]{64}$/u.test(value))
  ) {
    throw new Error(`${label} must be an opaque definition revision`)
  }
}

export function agentLoopHandle(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > 512) {
    throw new Error(`${label} must be an AgentLoop opaque handle`)
  }
}

export function safeSequence(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

export function assertRoomSettingsPatch(value: unknown): asserts value is AgentConversationRoomSettingsPatch {
  plainObject(value, 'room settings patch')
  exactKeys(value, ['name', 'description'], 'room settings patch')
  if (Object.keys(value).length === 0) throw new Error('room settings patch must not be empty')
  if (
    value.name !== undefined && (typeof value.name !== 'string' || [...value.name].length < 1
      || [...value.name].length > 256 || /[\u0000-\u001F\u007F]/u.test(value.name))
  ) {
    throw new Error('room settings patch name is invalid')
  }
  if (value.description !== undefined) {
    plainObject(value.description, 'room settings patch description')
    if (value.description.state === 'empty') exactKeys(value.description, ['state'], 'room settings patch description')
    else if (value.description.state === 'present') {
      exactKeys(value.description, ['state', 'text'], 'room settings patch description')
      if (
        typeof value.description.text !== 'string' || [...value.description.text].length < 1
        || [...value.description.text].length > 4_000
        || /[\u0000-\u0009\u000B-\u001F\u007F]/u.test(value.description.text)
      ) {
        throw new Error('room settings patch description text is invalid')
      }
    } else throw new Error('room settings patch description state is invalid')
  }
}

export function assertJsonValue(value: unknown, label: string, depth = 0): asserts value is CordisXJsonValue {
  if (depth > 32) throw new Error(`${label} exceeds the JSON depth limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite JSON numbers`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new Error(`${label} exceeds the JSON array limit`)
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, depth + 1))
    return
  }
  plainObject(value, label)
  if (Object.keys(value).length > 1_024) throw new Error(`${label} exceeds the JSON object limit`)
  for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${label}.${key}`, depth + 1)
}

export function assertLocalizedText(value: unknown, label: string): asserts value is LocalizedText {
  plainObject(value, label)
  exactKeys(value, ['key', 'fallback', 'namespace'], label)
  if (typeof value.key !== 'string' || !LOCAL_ID_PATTERN.test(value.key)) throw new Error(`${label}.key is invalid`)
  text(value.fallback, `${label}.fallback`, 32_000)
  if (
    value.namespace !== undefined && (typeof value.namespace !== 'string' || !REFERENCE_PATTERN.test(value.namespace))
  ) {
    throw new Error(`${label}.namespace is invalid`)
  }
}

export function assertCommand(value: unknown, label: string): asserts value is CommandReference {
  plainObject(value, label)
  exactKeys(value, ['id', 'arguments'], label)
  if (typeof value.id !== 'string' || !REFERENCE_PATTERN.test(value.id)) throw new Error(`${label}.id is invalid`)
  if (value.arguments !== undefined) assertJsonValue(value.arguments, `${label}.arguments`)
}

export function assertDisabled(value: unknown, label: string): asserts value is Disabled {
  plainObject(value, label)
  exactKeys(value, ['value', 'reason'], label)
  if (typeof value.value !== 'boolean') throw new Error(`${label}.value must be boolean`)
  if (value.reason !== undefined) assertLocalizedText(value.reason, `${label}.reason`)
}

export function assertAction(value: unknown, label: string): asserts value is ProtocolAction {
  plainObject(value, label)
  exactKeys(value, ['id', 'label', 'icon', 'command', 'disabled'], label)
  if (typeof value.id !== 'string' || !LOCAL_ID_PATTERN.test(value.id)) throw new Error(`${label}.id is invalid`)
  assertLocalizedText(value.label, `${label}.label`)
  if (
    value.icon !== undefined && (typeof value.icon !== 'string' || !/^host:[a-z][a-z0-9.-]{0,63}$/u.test(value.icon))
  ) {
    throw new Error(`${label}.icon must be a Host icon token`)
  }
  assertCommand(value.command, `${label}.command`)
  assertDisabled(value.disabled, `${label}.disabled`)
}

export function assertParticipant(value: unknown, label: string): asserts value is ProtocolParticipant {
  plainObject(value, label)
  exactKeys(value, ['participantId', 'role', 'displayName', 'avatar', 'agentIdentity'], label)
  opaque(value.participantId, `${label}.participantId`)
  if (!['human', 'agent', 'system'].includes(value.role as string)) throw new Error(`${label}.role is invalid`)
  assertLocalizedText(value.displayName, `${label}.displayName`)
  if (value.avatar !== undefined) cloneAgentAvatarRef(value.avatar)
  if (value.agentIdentity !== undefined) {
    if (value.role !== 'agent') throw new Error(`${label}.agentIdentity requires agent role`)
    plainObject(value.agentIdentity, `${label}.agentIdentity`)
    exactKeys(value.agentIdentity, ['agentId', 'revision'], `${label}.agentIdentity`)
    opaque(value.agentIdentity.agentId, `${label}.agentIdentity.agentId`)
    definitionRevision(value.agentIdentity.revision, `${label}.agentIdentity.revision`)
  }
}

export function assertDefinitionIdentity(
  value: unknown,
  label: string,
): asserts value is { readonly agentId: string; readonly revision: string } {
  plainObject(value, label)
  exactKeys(value, ['agentId', 'revision'], label)
  opaque(value.agentId, `${label}.agentId`)
  definitionRevision(value.revision, `${label}.revision`)
  if (value.agentId === '*' || value.revision === '*') throw new Error(`${label} must be exact`)
}

export function sameDefinitionIdentity(
  left: { readonly agentId: string; readonly revision: string },
  right: { readonly agentId: string; readonly revision: string },
): boolean {
  return left.agentId === right.agentId && left.revision === right.revision
}

export function assertApprovalAgentBinding(
  value: unknown,
  label: string,
): asserts value is import('@cordisx/protocol/approval/v2').ApprovalAgentBinding {
  plainObject(value, label)
  exactKeys(value, ['agentId', 'sessionId', 'agentGeneration', 'definition'], label)
  opaque(value.agentId, `${label}.agentId`)
  opaque(value.sessionId, `${label}.sessionId`)
  if (!Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1) {
    throw new Error(`${label}.agentGeneration is invalid`)
  }
  assertDefinitionIdentity(value.definition, `${label}.definition`)
  if (value.agentId !== value.sessionId) throw new Error(`${label} crosses Agent/Session identity`)
}

export function assertReactionValue(
  value: unknown,
  label: string,
): asserts value is { readonly kind: 'semantic'; readonly token: string } | {
  readonly kind: 'emoji'
  readonly emoji: string
} {
  plainObject(value, label)
  if (value.kind === 'semantic') {
    exactKeys(value, ['kind', 'token'], label)
    if (typeof value.token !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/u.test(value.token)) {
      throw new Error(`${label}.token is not canonical`)
    }
    return
  }
  if (value.kind !== 'emoji') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, ['kind', 'emoji'], label)
  if (
    typeof value.emoji !== 'string' || value.emoji !== value.emoji.trim()
    || value.emoji !== value.emoji.normalize('NFC')
  ) throw new Error(`${label}.emoji is not canonical`)
  const scalars = [...value.emoji]
  if (scalars.length < 1 || scalars.length > 32) throw new Error(`${label}.emoji scalar length is invalid`)
  const keycaps = value.emoji.match(/[#*0-9]\uFE0F?\u20E3/gu) ?? []
  const remainder = value.emoji.replace(/[#*0-9]\uFE0F?\u20E3/gu, '')
  if (/[#*0-9\u20E3]/u.test(remainder)) throw new Error(`${label}.emoji contains an incomplete keycap`)
  const allowedScalar = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\u200D|\uFE0F)$/u
  if (
    [...remainder].some(scalar => !allowedScalar.test(scalar))
    || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(remainder) && keycaps.length === 0
  ) {
    throw new Error(`${label}.emoji contains a non-emoji scalar`)
  }
}

export function sameAvatar(left: ProtocolParticipant['avatar'], right: ProtocolParticipant['avatar']): boolean {
  if (left === undefined || right === undefined) return left === right
  return JSON.stringify(cloneAgentAvatarRef(left)) === JSON.stringify(cloneAgentAvatarRef(right))
}

export function assertSelection(value: unknown, label: string): asserts value is ProtocolSelection {
  plainObject(value, label)
  if (value.kind === 'no-room') {
    exactKeys(value, ['kind'], label)
    return
  }
  if (value.kind !== 'room') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, [
    'kind',
    'roomId',
    'title',
    'description',
    'secondary',
    'multiParticipant',
    'participantPresentation',
    'participants',
    'activeRuns',
  ], label)
  opaque(value.roomId, `${label}.roomId`)
  assertLocalizedText(value.title, `${label}.title`)
  if (value.description !== undefined) {
    plainObject(value.description, `${label}.description`)
    exactKeys(value.description, ['state', 'text'], `${label}.description`)
    if (value.description.state === 'present') assertLocalizedText(value.description.text, `${label}.description.text`)
    else if (value.description.state !== 'empty') throw new Error(`${label}.description.state is invalid`)
  }
  if (value.secondary !== undefined) assertLocalizedText(value.secondary, `${label}.secondary`)
  if (typeof value.multiParticipant !== 'boolean') throw new Error(`${label}.multiParticipant must be boolean`)
  if (value.participantPresentation !== 'none' && value.participantPresentation !== 'host-initials') {
    throw new Error(`${label}.participantPresentation is invalid`)
  }
  if (!value.multiParticipant && value.participantPresentation !== 'none') {
    throw new Error(`${label} cannot request initials for a single-participant room`)
  }
  if (!Array.isArray(value.participants) || value.participants.length > 64) {
    throw new Error(`${label}.participants is invalid`)
  }
  const ids = new Set<string>()
  value.participants.forEach((participant, index) => {
    assertParticipant(participant, `${label}.participants[${index}]`)
    if (ids.has(participant.participantId)) throw new Error(`${label}.participants has a duplicate id`)
    ids.add(participant.participantId)
  })
  if (value.activeRuns !== undefined) {
    if (!Array.isArray(value.activeRuns) || value.activeRuns.length > 64) {
      throw new Error(`${label}.activeRuns is invalid`)
    }
    const runKeys = new Set<string>()
    value.activeRuns.forEach((run, index) => {
      plainObject(run, `${label}.activeRuns[${index}]`)
      exactKeys(run, ['participantId', 'memberId', 'runId', 'lifecycle', 'detailsUrl'], `${label}.activeRuns[${index}]`)
      opaque(run.participantId, `${label}.activeRuns[${index}].participantId`)
      opaque(run.memberId, `${label}.activeRuns[${index}].memberId`)
      opaque(run.runId, `${label}.activeRuns[${index}].runId`)
      if (!ids.has(run.participantId)) throw new Error(`${label}.activeRuns[${index}] association is invalid`)
      plainObject(run.lifecycle, `${label}.activeRuns[${index}].lifecycle`)
      exactKeys(run.lifecycle, ['phase', 'updatedAt'], `${label}.activeRuns[${index}].lifecycle`)
      if (!['active', 'running', 'waiting', 'attention'].includes(run.lifecycle.phase as string)) {
        throw new Error(`${label}.activeRuns[${index}].lifecycle is invalid`)
      }
      validateAgentLoopTaskDetailsUrl(run.detailsUrl as never)
      const key = JSON.stringify([run.participantId, run.memberId, run.runId])
      if (runKeys.has(key)) throw new Error(`${label}.activeRuns has duplicate association`)
      runKeys.add(key)
    })
  }
}

export function assertItem(value: unknown, label: string): asserts value is ProtocolItem {
  plainObject(value, label)
  if (value.kind === 'approval') {
    exactKeys(value, [
      'kind',
      'itemId',
      'sequence',
      'participantId',
      'memberId',
      'runId',
      'binding',
      'turn',
      'approvalId',
      'approvalKind',
      'rationale',
      'state',
      'actions',
      'diagnostic',
    ], label)
    opaque(value.itemId, `${label}.itemId`)
    safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`)
    opaque(value.memberId, `${label}.memberId`)
    opaque(value.runId, `${label}.runId`)
    plainObject(value.binding, `${label}.binding`)
    exactKeys(value.binding, ['bindingId', 'generation'], `${label}.binding`)
    agentLoopHandle(value.binding.bindingId, `${label}.binding.bindingId`)
    safeSequence(value.binding.generation, `${label}.binding.generation`)
    agentLoopHandle(value.turn, `${label}.turn`)
    agentLoopHandle(value.approvalId, `${label}.approvalId`)
    if (!['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string)) {
      throw new Error(`${label}.approvalKind is invalid`)
    }
    if (!['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)) {
      throw new Error(`${label}.state is invalid`)
    }
    if (value.rationale !== undefined) assertLocalizedText(value.rationale, `${label}.rationale`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (!Array.isArray(value.actions) || value.actions.length > 3) throw new Error(`${label}.actions is invalid`)
    const decisions = new Set<string>()
    value.actions.forEach((action, index) => {
      plainObject(action, `${label}.actions[${index}]`)
      exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
      if (!['approve', 'deny', 'cancel'].includes(action.decision as string)) {
        throw new Error(`${label}.actions[${index}].decision is invalid`)
      }
      if (decisions.has(action.decision as string)) throw new Error(`${label}.actions has a duplicate decision`)
      decisions.add(action.decision as string)
      assertCommand(action.command, `${label}.actions[${index}].command`)
    })
    if (value.state === 'pending' ? value.actions.length === 0 : value.actions.length !== 0) {
      throw new Error(`${label}.actions do not match approval state`)
    }
    return
  }
  if (value.kind === 'member-presence') {
    exactKeys(value, [
      'kind',
      'itemId',
      'sequence',
      'participantId',
      'memberId',
      'runId',
      'state',
      'retryable',
      'diagnostic',
      'retry',
    ], label)
    opaque(value.itemId, `${label}.itemId`)
    safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`)
    opaque(value.memberId, `${label}.memberId`)
    opaque(value.runId, `${label}.runId`)
    if (!['inviting', 'creating', 'joined', 'ready', 'failed'].includes(value.state as string)) {
      throw new Error(`${label}.state is invalid`)
    }
    if (typeof value.retryable !== 'boolean') throw new Error(`${label}.retryable is invalid`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (value.retry !== undefined) assertCommand(value.retry, `${label}.retry`)
    if (value.state !== 'failed' && value.retry !== undefined) throw new Error(`${label}.retry requires failed state`)
    return
  }
  if (value.kind === 'status') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'label', 'state', 'ariaLive'], label)
    opaque(value.itemId, `${label}.itemId`)
    safeSequence(value.sequence, `${label}.sequence`)
    assertLocalizedText(value.label, `${label}.label`)
    if (!['info', 'working', 'warning', 'error'].includes(value.state as string)) {
      throw new Error(`${label}.state is invalid`)
    }
    if (!['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label}.ariaLive is invalid`)
    return
  }
  if (value.kind !== 'message') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, [
    'kind',
    'itemId',
    'messageId',
    'sequence',
    'source',
    'author',
    'semantic',
    'body',
    'reactions',
    'timestamp',
    'deliveryState',
    'runState',
    'ariaLive',
    'actions',
  ], label)
  opaque(value.itemId, `${label}.itemId`)
  opaque(value.messageId, `${label}.messageId`)
  safeSequence(value.sequence, `${label}.sequence`)
  assertParticipant(value.author, `${label}.author`)
  if (!Array.isArray(value.body) || value.body.length === 0 || value.body.length > 64) {
    throw new Error(`${label}.body is invalid`)
  }
  value.body.forEach((block, index) => {
    plainObject(block, `${label}.body[${index}]`)
    exactKeys(block, ['kind', 'text'], `${label}.body[${index}]`)
    if (block.kind !== 'text') throw new Error(`${label}.body[${index}].kind is invalid`)
    assertLocalizedText(block.text, `${label}.body[${index}].text`)
  })
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error(`${label}.timestamp is invalid`)
  }
  if (!['pending', 'sent', 'delivered', 'failed'].includes(value.deliveryState as string)) {
    throw new Error(`${label}.deliveryState is invalid`)
  }
  if (!['idle', 'running', 'stopped', 'failed'].includes(value.runState as string)) {
    throw new Error(`${label}.runState is invalid`)
  }
  if (!['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label}.ariaLive is invalid`)
  if (!Array.isArray(value.actions) || value.actions.length > 8) throw new Error(`${label}.actions is invalid`)
  value.actions.forEach((action, index) => assertAction(action, `${label}.actions[${index}]`))
  if (value.source !== 'agent-loop' && value.source !== 'chatroom-acknowledgement') {
    throw new Error(`${label}.source is invalid`)
  }
  if (value.semantic === undefined) throw new Error(`${label}.semantic is required`)
  {
    plainObject(value.semantic, `${label}.semantic`)
    if (value.semantic.purpose === 'conversation') {
      exactKeys(value.semantic, ['purpose', 'causation'], `${label}.semantic`)
    } else if (value.semantic.purpose === 'member-self-introduction') {
      exactKeys(
        value.semantic,
        ['purpose', 'causation', 'participantId', 'memberId', 'runId', 'binding', 'turn'],
        `${label}.semantic`,
      )
      opaque(value.semantic.participantId, `${label}.semantic.participantId`)
      opaque(value.semantic.memberId, `${label}.semantic.memberId`)
      opaque(value.semantic.runId, `${label}.semantic.runId`)
      agentLoopHandle(value.semantic.turn, `${label}.semantic.turn`)
      plainObject(value.semantic.binding, `${label}.semantic.binding`)
      exactKeys(value.semantic.binding, ['bindingId', 'generation'], `${label}.semantic.binding`)
      agentLoopHandle(value.semantic.binding.bindingId, `${label}.semantic.binding.bindingId`)
      safeSequence(value.semantic.binding.generation, `${label}.semantic.binding.generation`)
    } else if (value.semantic.purpose === 'chatroom-acknowledgement') {
      exactKeys(value.semantic, ['purpose'], `${label}.semantic`)
    } else throw new Error(`${label}.semantic.purpose is invalid`)
    if (value.semantic.causation !== undefined) {
      plainObject(value.semantic.causation, `${label}.semantic.causation`)
      exactKeys(value.semantic.causation, ['operationId'], `${label}.semantic.causation`)
      agentLoopHandle(value.semantic.causation.operationId, `${label}.semantic.causation.operationId`)
    }
    if (
      value.source === 'agent-loop' && value.semantic.purpose === 'chatroom-acknowledgement'
      || value.source === 'chatroom-acknowledgement' && value.semantic.purpose !== 'chatroom-acknowledgement'
    ) {
      throw new Error(`${label}.source and semantic purpose do not match`)
    }
  }
  if (value.reactions !== undefined) {
    if (!Array.isArray(value.reactions) || value.reactions.length > 64) throw new Error(`${label}.reactions is invalid`)
    const reactionIds = new Set<string>()
    const reactionActorValues = new Set<string>()
    value.reactions.forEach((reaction, index) => {
      plainObject(reaction, `${label}.reactions[${index}]`)
      exactKeys(reaction, ['reactionId', 'actorParticipantId', 'value', 'state'], `${label}.reactions[${index}]`)
      opaque(reaction.reactionId, `${label}.reactions[${index}].reactionId`)
      opaque(reaction.actorParticipantId, `${label}.reactions[${index}].actorParticipantId`)
      if (reactionIds.has(reaction.reactionId)) throw new Error(`${label}.reactions has duplicate id`)
      reactionIds.add(reaction.reactionId)
      assertReactionValue(reaction.value, `${label}.reactions[${index}].value`)
      const actorValue = JSON.stringify([
        reaction.actorParticipantId,
        reaction.value.kind,
        reaction.value.kind === 'emoji' ? reaction.value.emoji : reaction.value.token,
      ])
      if (reactionActorValues.has(actorValue)) throw new Error(`${label}.reactions has duplicate actor/value pair`)
      reactionActorValues.add(actorValue)
      if (!['pending', 'completed', 'failed'].includes(reaction.state as string)) {
        throw new Error(`${label}.reactions[${index}].state is invalid`)
      }
    })
  }
}

export function assertSnapshotAssociations(value: AgentConversationShellSnapshot): void {
  if (value.selection.kind !== 'room') {
    if (
      value.items.some(item =>
        item.kind === 'approval'
        || item.kind === 'message' && item.semantic.purpose === 'member-self-introduction'
      )
    ) {
      throw new Error('no-room snapshot contains Room-associated items')
    }
    return
  }
  const participants = new Map(
    value.selection.participants.map(participant => [participant.participantId, participant]),
  )
  const runs = new Set(
    (value.selection.activeRuns ?? []).map(run => JSON.stringify([run.participantId, run.memberId, run.runId])),
  )
  const approvals = new Set<string>()
  const introductions = new Set<string>()
  for (const item of value.items) {
    if (item.kind === 'message') {
      const participant = participants.get(item.author.participantId)
      if (participant === undefined || JSON.stringify(participant) !== JSON.stringify(item.author)) {
        throw new Error('message author is not the exact Room participant')
      }
      for (const reaction of item.reactions ?? []) {
        if (!participants.has(reaction.actorParticipantId)) throw new Error('reaction actor is not a Room participant')
      }
      if (item.semantic.purpose === 'member-self-introduction') {
        if (
          item.author.role !== 'agent' || item.author.agentIdentity === undefined
          || item.semantic.participantId !== item.author.participantId
        ) {
          throw new Error('self-introduction message author association is invalid')
        }
        const run = JSON.stringify([item.semantic.participantId, item.semantic.memberId, item.semantic.runId])
        const association = JSON.stringify([
          run,
          item.semantic.binding.bindingId,
          item.semantic.binding.generation,
          item.semantic.turn,
        ])
        if (introductions.has(association)) throw new Error('duplicate self-introduction association')
        introductions.add(association)
      }
    }
    if (item.kind === 'approval') {
      const participant = participants.get(item.participantId)
      if (participant?.role !== 'agent' || participant.agentIdentity === undefined) {
        throw new Error('approval participant is not an identified Agent')
      }
      const run = JSON.stringify([item.participantId, item.memberId, item.runId])
      if (!runs.has(run)) throw new Error('approval does not match an active run')
      const association = JSON.stringify([item.binding.bindingId, item.binding.generation, item.turn, item.approvalId])
      if (approvals.has(association)) throw new Error('duplicate approval association')
      approvals.add(association)
    }
  }
}

export function assertSnapshot(value: unknown): asserts value is AgentConversationShellSnapshot {
  plainObject(value, 'snapshot')
  exactKeys(
    value,
    ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'],
    'snapshot',
  )
  plainObject(value.binding, 'snapshot.binding')
  exactKeys(value.binding, ['bindingId', 'ownerGeneration'], 'snapshot.binding')
  opaque(value.binding.bindingId, 'snapshot.binding.bindingId')
  opaque(value.binding.ownerGeneration, 'snapshot.binding.ownerGeneration')
  opaque(value.generation, 'snapshot.generation')
  safeSequence(value.snapshotSequence, 'snapshot.snapshotSequence')
  assertSelection(value.selection, 'snapshot.selection')
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('snapshot.items is invalid')
  value.items.forEach((item, index) => assertItem(item, `snapshot.items[${index}]`))
  if (value.items.some(item => item.sequence > (value.snapshotSequence as number))) {
    throw new Error('snapshot item sequence exceeds snapshot.snapshotSequence')
  }
  assertSnapshotAssociations(value as unknown as AgentConversationShellSnapshot)
  plainObject(value.composer, 'snapshot.composer')
  exactKeys(value.composer, ['availability', 'placeholder', 'disabled', 'submit'], 'snapshot.composer')
  if (!['available', 'unavailable'].includes(value.composer.availability as string)) {
    throw new Error('snapshot.composer.availability is invalid')
  }
  assertLocalizedText(value.composer.placeholder, 'snapshot.composer.placeholder')
  assertDisabled(value.composer.disabled, 'snapshot.composer.disabled')
  assertCommand(value.composer.submit, 'snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) {
    throw new Error('snapshot.headerActions is invalid')
  }
  value.headerActions.forEach((action, index) => assertAction(action, `snapshot.headerActions[${index}]`))
}
