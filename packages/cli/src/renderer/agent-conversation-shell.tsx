import { Context, Service } from '@deepseek-ai/cordis'
import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type {
  AgentConversationShellBindRequest,
  AgentConversationShellBindResult,
  AgentConversationShellBinding,
  AgentConversationShellHost,
  AgentConversationShellSubscription,
  CommandReference,
  Disabled,
  LocalizedText,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationAction as ProtocolActionV3,
  AgentConversationItem as ProtocolItemV3,
  AgentConversationParticipant as ProtocolParticipantV3,
  AgentConversationSelection as ProtocolSelectionV3,
  AgentConversationShellPage as AgentConversationShellPageV3,
  AgentConversationRoomSettingsPatch,
  AgentConversationRoomSettingsUpdateRequest,
  AgentConversationRoomSettingsUpdateResult,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV3,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV3,
  AgentConversationShellSource as AgentConversationShellSourceV3,
  AgentConversationShellUpdate as AgentConversationShellUpdateV3,
} from '@cordisx/protocol/agent-conversation-shell/v3'
import type {
  AgentConversationAction as ProtocolActionV4,
  AgentConversationItem as ProtocolItemV4,
  AgentConversationParticipant as ProtocolParticipantV4,
  AgentConversationSelection as ProtocolSelectionV4,
  AgentConversationShellPage as AgentConversationShellPageV4,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV4,
  AgentConversationShellSource as AgentConversationShellSourceV4,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV4,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV4,
  AgentConversationShellUpdate as AgentConversationShellUpdateV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type {
  AgentConversationShellPage as AgentConversationShellPageV5,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellSource as AgentConversationShellSourceV5,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV5,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV5,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV5,
  AgentConversationShellUpdate as AgentConversationShellUpdateV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellRegistration,
  CordisXAgentConversationShellSourceFactory,
  CordisXAgentConversationShellSourceFactoryV2,
  CordisXAgentConversationShellSourceFactoryV3,
  CordisXAgentConversationShellSourceFactoryV4,
  CordisXAgentConversationShellSourceFactoryV5,
  CordisXJsonValue,
  CordisXLocalizedText,
  CordisXPageMount,
  CordisXPageMountContext,
} from '../contracts.js'
import { markAgentConversationPageMount } from './agent-conversation-page.js'
import { CordisXCommandService } from './commands.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
} from './generation-visibility.js'
import {
  AgentConversationRenderer,
  type AgentConversationRendererCopy,
  type AgentConversationRendererProps,
} from './host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from './host-ui/conversation/commands.js'
import { validateAgentLoopTaskDetailsUrl } from './host-ui/AgentTaskDetailsNavigator.js'
import { AGENT_CONVERSATION_STYLES } from './host-ui/conversation/styles.js'
import {
  createAgentConversationModel,
  type AgentConversationAction,
  type AgentConversationModel,
} from './host-ui/conversation/model.js'
import { CordisXI18nService } from './i18n.js'
import { HostThemeProjection } from './host-theme.js'
import { ownerFromContext } from './ownership.js'
import type { PluginConsoleAspect, PluginPrincipalToken } from './plugin-console.js'
import type { PlaygroundScenarioConversationSourceAuthority } from './playground-scenario-session-scope.js'
import { immutableSnapshot, LOCAL_ID_PATTERN, REFERENCE_PATTERN } from './validation.js'

type ProtocolAction = ProtocolActionV3
type ProtocolItem = ProtocolItemV3
type ProtocolParticipant = ProtocolParticipantV3
type ProtocolSelection = ProtocolSelectionV3
type AgentConversationShellPage = AgentConversationShellPageV3
type AgentConversationShellSnapshot = AgentConversationShellSnapshotV3
type AgentConversationShellSource = AgentConversationShellSourceV3
type AgentConversationShellUpdate = AgentConversationShellUpdateV3
export type PlaygroundScenarioConversationOwnerResolver = (owner: string, moduleGeneration: string | undefined) => string | undefined

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value)
  const unknown = keys.find(key => !expected.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function plainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.prototype.toString.call(value) !== '[object Object]') {
    throw new Error(`${label} must be a plain object`)
  }
}

function text(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || [...value].length > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} characters`)
  }
}

function opaque(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/u.test(value)) {
    throw new Error(`${label} must be an opaque identifier`)
  }
}

function definitionRevision(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string'
    || (!/^[A-Za-z0-9._~-]{1,512}$/u.test(value) && !/^sha256:[a-f0-9]{64}$/u.test(value))) {
    throw new Error(`${label} must be an opaque definition revision`)
  }
}

function agentLoopHandle(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > 512) {
    throw new Error(`${label} must be an AgentLoop opaque handle`)
  }
}

function safeSequence(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
}

function assertRoomSettingsPatch(value: unknown): asserts value is AgentConversationRoomSettingsPatch {
  plainObject(value, 'room settings patch')
  exactKeys(value, ['name', 'description'], 'room settings patch')
  if (Object.keys(value).length === 0) throw new Error('room settings patch must not be empty')
  if (value.name !== undefined && (typeof value.name !== 'string' || [...value.name].length < 1
    || [...value.name].length > 256 || /[\u0000-\u001F\u007F]/u.test(value.name))) {
    throw new Error('room settings patch name is invalid')
  }
  if (value.description !== undefined) {
    plainObject(value.description, 'room settings patch description')
    if (value.description.state === 'empty') exactKeys(value.description, ['state'], 'room settings patch description')
    else if (value.description.state === 'present') {
      exactKeys(value.description, ['state', 'text'], 'room settings patch description')
      if (typeof value.description.text !== 'string' || [...value.description.text].length < 1
        || [...value.description.text].length > 4_000 || /[\u0000-\u0009\u000B-\u001F\u007F]/u.test(value.description.text)) {
        throw new Error('room settings patch description text is invalid')
      }
    } else throw new Error('room settings patch description state is invalid')
  }
}

function assertJsonValue(value: unknown, label: string, depth = 0): asserts value is CordisXJsonValue {
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

function assertLocalizedText(value: unknown, label: string): asserts value is LocalizedText {
  plainObject(value, label)
  exactKeys(value, ['key', 'fallback', 'namespace'], label)
  if (typeof value.key !== 'string' || !LOCAL_ID_PATTERN.test(value.key)) throw new Error(`${label}.key is invalid`)
  text(value.fallback, `${label}.fallback`, 32_000)
  if (value.namespace !== undefined && (typeof value.namespace !== 'string' || !REFERENCE_PATTERN.test(value.namespace))) {
    throw new Error(`${label}.namespace is invalid`)
  }
}

function assertCommand(value: unknown, label: string): asserts value is CommandReference {
  plainObject(value, label)
  exactKeys(value, ['id', 'arguments'], label)
  if (typeof value.id !== 'string' || !REFERENCE_PATTERN.test(value.id)) throw new Error(`${label}.id is invalid`)
  if (value.arguments !== undefined) assertJsonValue(value.arguments, `${label}.arguments`)
}

function assertDisabled(value: unknown, label: string): asserts value is Disabled {
  plainObject(value, label)
  exactKeys(value, ['value', 'reason'], label)
  if (typeof value.value !== 'boolean') throw new Error(`${label}.value must be boolean`)
  if (value.reason !== undefined) assertLocalizedText(value.reason, `${label}.reason`)
}

function assertAction(value: unknown, label: string): asserts value is ProtocolAction {
  plainObject(value, label)
  exactKeys(value, ['id', 'label', 'icon', 'command', 'disabled'], label)
  if (typeof value.id !== 'string' || !LOCAL_ID_PATTERN.test(value.id)) throw new Error(`${label}.id is invalid`)
  assertLocalizedText(value.label, `${label}.label`)
  if (value.icon !== undefined && (typeof value.icon !== 'string' || !/^host:[a-z][a-z0-9.-]{0,63}$/u.test(value.icon))) {
    throw new Error(`${label}.icon must be a Host icon token`)
  }
  assertCommand(value.command, `${label}.command`)
  assertDisabled(value.disabled, `${label}.disabled`)
}

function assertParticipant(value: unknown, label: string): asserts value is ProtocolParticipant {
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

function assertReactionValue(value: unknown, label: string): asserts value is { readonly kind: 'semantic'; readonly token: string } | { readonly kind: 'emoji'; readonly emoji: string } {
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
  if (typeof value.emoji !== 'string' || value.emoji !== value.emoji.trim()
    || value.emoji !== value.emoji.normalize('NFC')) throw new Error(`${label}.emoji is not canonical`)
  const scalars = [...value.emoji]
  if (scalars.length < 1 || scalars.length > 32) throw new Error(`${label}.emoji scalar length is invalid`)
  const keycaps = value.emoji.match(/[#*0-9]\uFE0F?\u20E3/gu) ?? []
  const remainder = value.emoji.replace(/[#*0-9]\uFE0F?\u20E3/gu, '')
  if (/[#*0-9\u20E3]/u.test(remainder)) throw new Error(`${label}.emoji contains an incomplete keycap`)
  const allowedScalar = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\u200D|\uFE0F)$/u
  if ([...remainder].some(scalar => !allowedScalar.test(scalar))
    || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(remainder) && keycaps.length === 0) {
    throw new Error(`${label}.emoji contains a non-emoji scalar`)
  }
}

function sameAvatar(left: ProtocolParticipant['avatar'], right: ProtocolParticipant['avatar']): boolean {
  if (left === undefined || right === undefined) return left === right
  return JSON.stringify(cloneAgentAvatarRef(left)) === JSON.stringify(cloneAgentAvatarRef(right))
}

function assertSelection(value: unknown, label: string): asserts value is ProtocolSelection {
  plainObject(value, label)
  if (value.kind === 'no-room') {
    exactKeys(value, ['kind'], label)
    return
  }
  if (value.kind !== 'room') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, ['kind', 'roomId', 'title', 'description', 'secondary', 'multiParticipant', 'participantPresentation', 'participants', 'activeRuns'], label)
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
  if (!Array.isArray(value.participants) || value.participants.length > 64) throw new Error(`${label}.participants is invalid`)
  const ids = new Set<string>()
  value.participants.forEach((participant, index) => {
    assertParticipant(participant, `${label}.participants[${index}]`)
    if (ids.has(participant.participantId)) throw new Error(`${label}.participants has a duplicate id`)
    ids.add(participant.participantId)
  })
  if (value.activeRuns !== undefined) {
    if (!Array.isArray(value.activeRuns) || value.activeRuns.length > 64) throw new Error(`${label}.activeRuns is invalid`)
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
      if (!['active', 'running', 'waiting', 'attention'].includes(run.lifecycle.phase as string)) throw new Error(`${label}.activeRuns[${index}].lifecycle is invalid`)
      validateAgentLoopTaskDetailsUrl(run.detailsUrl as never)
      const key = JSON.stringify([run.participantId, run.memberId, run.runId])
      if (runKeys.has(key)) throw new Error(`${label}.activeRuns has duplicate association`)
      runKeys.add(key)
    })
  }
}

function assertItem(value: unknown, label: string): asserts value is ProtocolItem {
  plainObject(value, label)
  if (value.kind === 'approval') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'participantId', 'memberId', 'runId', 'binding', 'turn', 'approvalId', 'approvalKind', 'rationale', 'state', 'actions', 'diagnostic'], label)
    opaque(value.itemId, `${label}.itemId`); safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`); opaque(value.memberId, `${label}.memberId`); opaque(value.runId, `${label}.runId`)
    plainObject(value.binding, `${label}.binding`); exactKeys(value.binding, ['bindingId', 'generation'], `${label}.binding`)
    agentLoopHandle(value.binding.bindingId, `${label}.binding.bindingId`); safeSequence(value.binding.generation, `${label}.binding.generation`)
    agentLoopHandle(value.turn, `${label}.turn`); agentLoopHandle(value.approvalId, `${label}.approvalId`)
    if (!['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string)) throw new Error(`${label}.approvalKind is invalid`)
    if (!['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)) throw new Error(`${label}.state is invalid`)
    if (value.rationale !== undefined) assertLocalizedText(value.rationale, `${label}.rationale`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (!Array.isArray(value.actions) || value.actions.length > 3) throw new Error(`${label}.actions is invalid`)
    const decisions = new Set<string>()
    value.actions.forEach((action, index) => {
      plainObject(action, `${label}.actions[${index}]`); exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
      if (!['approve', 'deny', 'cancel'].includes(action.decision as string)) throw new Error(`${label}.actions[${index}].decision is invalid`)
      if (decisions.has(action.decision as string)) throw new Error(`${label}.actions has a duplicate decision`)
      decisions.add(action.decision as string)
      assertCommand(action.command, `${label}.actions[${index}].command`)
    })
    if (value.state === 'pending' ? value.actions.length === 0 : value.actions.length !== 0) throw new Error(`${label}.actions do not match approval state`)
    return
  }
  if (value.kind === 'member-presence') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'participantId', 'memberId', 'runId', 'state', 'retryable', 'diagnostic', 'retry'], label)
    opaque(value.itemId, `${label}.itemId`)
    safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`)
    opaque(value.memberId, `${label}.memberId`)
    opaque(value.runId, `${label}.runId`)
    if (!['inviting', 'creating', 'joined', 'ready', 'failed'].includes(value.state as string)) throw new Error(`${label}.state is invalid`)
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
    if (!['info', 'working', 'warning', 'error'].includes(value.state as string)) throw new Error(`${label}.state is invalid`)
    if (!['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label}.ariaLive is invalid`)
    return
  }
  if (value.kind !== 'message') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, ['kind', 'itemId', 'messageId', 'sequence', 'source', 'author', 'semantic', 'body', 'reactions', 'timestamp', 'deliveryState', 'runState', 'ariaLive', 'actions'], label)
  opaque(value.itemId, `${label}.itemId`)
  opaque(value.messageId, `${label}.messageId`)
  safeSequence(value.sequence, `${label}.sequence`)
  assertParticipant(value.author, `${label}.author`)
  if (!Array.isArray(value.body) || value.body.length === 0 || value.body.length > 64) throw new Error(`${label}.body is invalid`)
  value.body.forEach((block, index) => {
    plainObject(block, `${label}.body[${index}]`)
    exactKeys(block, ['kind', 'text'], `${label}.body[${index}]`)
    if (block.kind !== 'text') throw new Error(`${label}.body[${index}].kind is invalid`)
    assertLocalizedText(block.text, `${label}.body[${index}].text`)
  })
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) throw new Error(`${label}.timestamp is invalid`)
  if (!['pending', 'sent', 'delivered', 'failed'].includes(value.deliveryState as string)) throw new Error(`${label}.deliveryState is invalid`)
  if (!['idle', 'running', 'stopped', 'failed'].includes(value.runState as string)) throw new Error(`${label}.runState is invalid`)
  if (!['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label}.ariaLive is invalid`)
  if (!Array.isArray(value.actions) || value.actions.length > 8) throw new Error(`${label}.actions is invalid`)
  value.actions.forEach((action, index) => assertAction(action, `${label}.actions[${index}]`))
  if (value.source !== 'agent-loop' && value.source !== 'chatroom-acknowledgement') throw new Error(`${label}.source is invalid`)
  if (value.semantic === undefined) throw new Error(`${label}.semantic is required`)
  {
    plainObject(value.semantic, `${label}.semantic`)
    if (value.semantic.purpose === 'conversation') {
      exactKeys(value.semantic, ['purpose', 'causation'], `${label}.semantic`)
    } else if (value.semantic.purpose === 'member-self-introduction') {
      exactKeys(value.semantic, ['purpose', 'causation', 'participantId', 'memberId', 'runId', 'binding', 'turn'], `${label}.semantic`)
      opaque(value.semantic.participantId, `${label}.semantic.participantId`); opaque(value.semantic.memberId, `${label}.semantic.memberId`); opaque(value.semantic.runId, `${label}.semantic.runId`); agentLoopHandle(value.semantic.turn, `${label}.semantic.turn`)
      plainObject(value.semantic.binding, `${label}.semantic.binding`); exactKeys(value.semantic.binding, ['bindingId', 'generation'], `${label}.semantic.binding`)
      agentLoopHandle(value.semantic.binding.bindingId, `${label}.semantic.binding.bindingId`); safeSequence(value.semantic.binding.generation, `${label}.semantic.binding.generation`)
    } else if (value.semantic.purpose === 'chatroom-acknowledgement') exactKeys(value.semantic, ['purpose'], `${label}.semantic`)
    else throw new Error(`${label}.semantic.purpose is invalid`)
    if (value.semantic.causation !== undefined) {
      plainObject(value.semantic.causation, `${label}.semantic.causation`); exactKeys(value.semantic.causation, ['operationId'], `${label}.semantic.causation`); agentLoopHandle(value.semantic.causation.operationId, `${label}.semantic.causation.operationId`)
    }
    if (value.source === 'agent-loop' && value.semantic.purpose === 'chatroom-acknowledgement'
      || value.source === 'chatroom-acknowledgement' && value.semantic.purpose !== 'chatroom-acknowledgement') {
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
      if (!['pending', 'completed', 'failed'].includes(reaction.state as string)) throw new Error(`${label}.reactions[${index}].state is invalid`)
    })
  }
}

function assertSnapshotAssociations(value: AgentConversationShellSnapshot): void {
  if (value.selection.kind !== 'room') {
    if (value.items.some(item => item.kind === 'approval'
      || item.kind === 'message' && item.semantic.purpose === 'member-self-introduction')) {
      throw new Error('no-room snapshot contains Room-associated items')
    }
    return
  }
  const participants = new Map(value.selection.participants.map(participant => [participant.participantId, participant]))
  const runs = new Set((value.selection.activeRuns ?? []).map(run => JSON.stringify([run.participantId, run.memberId, run.runId])))
  const approvals = new Set<string>()
  const introductions = new Set<string>()
  for (const item of value.items) {
    if (item.kind === 'message') {
      const participant = participants.get(item.author.participantId)
      if (participant === undefined || JSON.stringify(participant) !== JSON.stringify(item.author)) throw new Error('message author is not the exact Room participant')
      for (const reaction of item.reactions ?? []) {
        if (!participants.has(reaction.actorParticipantId)) throw new Error('reaction actor is not a Room participant')
      }
      if (item.semantic.purpose === 'member-self-introduction') {
        if (item.author.role !== 'agent' || item.author.agentIdentity === undefined
          || item.semantic.participantId !== item.author.participantId) {
          throw new Error('self-introduction message author association is invalid')
        }
        const run = JSON.stringify([item.semantic.participantId, item.semantic.memberId, item.semantic.runId])
        const association = JSON.stringify([run, item.semantic.binding.bindingId, item.semantic.binding.generation, item.semantic.turn])
        if (introductions.has(association)) throw new Error('duplicate self-introduction association')
        introductions.add(association)
      }
    }
    if (item.kind === 'approval') {
      const participant = participants.get(item.participantId)
      if (participant?.role !== 'agent' || participant.agentIdentity === undefined) throw new Error('approval participant is not an identified Agent')
      const run = JSON.stringify([item.participantId, item.memberId, item.runId])
      if (!runs.has(run)) throw new Error('approval does not match an active run')
      const association = JSON.stringify([item.binding.bindingId, item.binding.generation, item.turn, item.approvalId])
      if (approvals.has(association)) throw new Error('duplicate approval association')
      approvals.add(association)
    }
  }
}

function assertSnapshot(value: unknown): asserts value is AgentConversationShellSnapshot {
  plainObject(value, 'snapshot')
  exactKeys(value, ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'], 'snapshot')
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
  if (!['available', 'unavailable'].includes(value.composer.availability as string)) throw new Error('snapshot.composer.availability is invalid')
  assertLocalizedText(value.composer.placeholder, 'snapshot.composer.placeholder')
  assertDisabled(value.composer.disabled, 'snapshot.composer.disabled')
  assertCommand(value.composer.submit, 'snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) throw new Error('snapshot.headerActions is invalid')
  value.headerActions.forEach((action, index) => assertAction(action, `snapshot.headerActions[${index}]`))
}

function assertSelectionV4(value: unknown, label: string): asserts value is ProtocolSelectionV4 {
  plainObject(value, label)
  if (value.kind === 'no-room') { exactKeys(value, ['kind'], label); return }
  if (value.kind !== 'room') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, ['kind', 'roomId', 'title', 'description', 'secondary', 'multiParticipant', 'participantPresentation', 'participants', 'activeRuns'], label)
  opaque(value.roomId, `${label}.roomId`); assertLocalizedText(value.title, `${label}.title`)
  if (value.description !== undefined) {
    plainObject(value.description, `${label}.description`); exactKeys(value.description, ['state', 'text'], `${label}.description`)
    if (value.description.state === 'present') assertLocalizedText(value.description.text, `${label}.description.text`)
    else if (value.description.state !== 'empty') throw new Error(`${label}.description.state is invalid`)
  }
  if (value.secondary !== undefined) assertLocalizedText(value.secondary, `${label}.secondary`)
  if (typeof value.multiParticipant !== 'boolean') throw new Error(`${label}.multiParticipant is invalid`)
  if (value.participantPresentation !== 'none' && value.participantPresentation !== 'host-initials') throw new Error(`${label}.participantPresentation is invalid`)
  if (!value.multiParticipant && value.participantPresentation !== 'none') throw new Error(`${label}.participantPresentation crosses room multiplicity`)
  if (!Array.isArray(value.participants) || value.participants.length > 64) throw new Error(`${label}.participants is invalid`)
  const participants = new Set<string>()
  value.participants.forEach((participant, index) => {
    assertParticipant(participant, `${label}.participants[${index}]`)
    if (participants.has(participant.participantId)) throw new Error(`${label}.participants has a duplicate id`)
    participants.add(participant.participantId)
  })
  if (value.activeRuns === undefined) return
  if (!Array.isArray(value.activeRuns) || value.activeRuns.length > 64) throw new Error(`${label}.activeRuns is invalid`)
  const runs = new Set<string>()
  value.activeRuns.forEach((run, index) => {
    const site = `${label}.activeRuns[${index}]`
    plainObject(run, site); exactKeys(run, ['participantId', 'memberId', 'runId', 'sessionId', 'lifecycle', 'details'], site)
    opaque(run.participantId, `${site}.participantId`); opaque(run.memberId, `${site}.memberId`); opaque(run.runId, `${site}.runId`); opaque(run.sessionId, `${site}.sessionId`)
    if (!participants.has(run.participantId)) throw new Error(`${site} association is invalid`)
    plainObject(run.lifecycle, `${site}.lifecycle`); exactKeys(run.lifecycle, ['phase', 'updatedAt'], `${site}.lifecycle`)
    if (!['active', 'running', 'waiting', 'attention'].includes(run.lifecycle.phase as string)) throw new Error(`${site}.lifecycle.phase is invalid`)
    if (run.lifecycle.updatedAt !== undefined && (typeof run.lifecycle.updatedAt !== 'string' || !Number.isFinite(Date.parse(run.lifecycle.updatedAt)))) throw new Error(`${site}.lifecycle.updatedAt is invalid`)
    if (run.details !== undefined) {
      plainObject(run.details, `${site}.details`); exactKeys(run.details, ['kind', 'ref'], `${site}.details`)
      if (run.details.kind !== 'host') throw new Error(`${site}.details.kind is invalid`)
      agentLoopHandle(run.details.ref, `${site}.details.ref`)
    }
    const key = JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])
    if (runs.has(key)) throw new Error(`${label}.activeRuns has a duplicate association`)
    runs.add(key)
  })
}

function assertItemV4(value: unknown, label: string): asserts value is ProtocolItemV4 {
  plainObject(value, label)
  if (value.kind === 'status') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'label', 'state', 'ariaLive'], label)
    opaque(value.itemId, `${label}.itemId`); safeSequence(value.sequence, `${label}.sequence`); assertLocalizedText(value.label, `${label}.label`)
    if (!['info', 'working', 'warning', 'error'].includes(value.state as string) || !['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label} state is invalid`)
    return
  }
  if (value.kind === 'member-presence') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'participantId', 'memberId', 'runId', 'sessionId', 'state', 'retryable', 'diagnostic', 'retry'], label)
    opaque(value.itemId, `${label}.itemId`); safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`); opaque(value.memberId, `${label}.memberId`); opaque(value.runId, `${label}.runId`); opaque(value.sessionId, `${label}.sessionId`)
    if (!['inviting', 'creating', 'joined', 'ready', 'failed'].includes(value.state as string) || typeof value.retryable !== 'boolean') throw new Error(`${label} state is invalid`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (value.retry !== undefined) assertCommand(value.retry, `${label}.retry`)
    if (value.state !== 'failed' && value.retry !== undefined || value.state === 'failed' && !value.retryable && value.retry !== undefined) throw new Error(`${label}.retry is invalid`)
    return
  }
  if (value.kind === 'approval') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'participantId', 'memberId', 'runId', 'sessionId', 'agentGeneration', 'approvalId', 'approvalKind', 'rationale', 'state', 'actions', 'diagnostic'], label)
    opaque(value.itemId, `${label}.itemId`); safeSequence(value.sequence, `${label}.sequence`)
    opaque(value.participantId, `${label}.participantId`); opaque(value.memberId, `${label}.memberId`); opaque(value.runId, `${label}.runId`); opaque(value.sessionId, `${label}.sessionId`)
    if (!Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1) throw new Error(`${label}.agentGeneration is invalid`)
    agentLoopHandle(value.approvalId, `${label}.approvalId`)
    if (!['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string) || !['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)) throw new Error(`${label} state is invalid`)
    if (value.rationale !== undefined) assertLocalizedText(value.rationale, `${label}.rationale`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (!Array.isArray(value.actions) || value.actions.length > 3 || (value.state === 'pending' ? value.actions.length === 0 : value.actions.length !== 0)) throw new Error(`${label}.actions are invalid`)
    const decisions = new Set<string>()
    value.actions.forEach((action, index) => {
      plainObject(action, `${label}.actions[${index}]`); exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
      if (!['approve', 'deny', 'cancel'].includes(action.decision as string) || decisions.has(action.decision as string)) throw new Error(`${label}.actions are invalid`)
      decisions.add(action.decision as string); assertCommand(action.command, `${label}.actions[${index}].command`)
    })
    return
  }
  if (value.kind !== 'message') throw new Error(`${label}.kind is invalid`)
  exactKeys(value, ['kind', 'itemId', 'messageId', 'sequence', 'source', 'author', 'semantic', 'body', 'reactions', 'timestamp', 'deliveryState', 'runState', 'ariaLive', 'actions'], label)
  opaque(value.itemId, `${label}.itemId`); opaque(value.messageId, `${label}.messageId`); safeSequence(value.sequence, `${label}.sequence`)
  assertParticipant(value.author, `${label}.author`)
  plainObject(value.source, `${label}.source`)
  if (value.source.kind === 'session-event') {
    exactKeys(value.source, ['kind', 'sessionId', 'eventSeq'], `${label}.source`); opaque(value.source.sessionId, `${label}.source.sessionId`)
    if (!Number.isSafeInteger(value.source.eventSeq) || (value.source.eventSeq as number) < 1) throw new Error(`${label}.source.eventSeq is invalid`)
  } else if (value.source.kind === 'chatroom-acknowledgement') exactKeys(value.source, ['kind'], `${label}.source`)
  else throw new Error(`${label}.source.kind is invalid`)
  plainObject(value.semantic, `${label}.semantic`)
  if (value.semantic.purpose === 'conversation') {
    exactKeys(value.semantic, ['purpose', 'correlation'], `${label}.semantic`)
    if (value.semantic.correlation !== undefined) { plainObject(value.semantic.correlation, `${label}.semantic.correlation`); exactKeys(value.semantic.correlation, ['requestMessageId'], `${label}.semantic.correlation`); opaque(value.semantic.correlation.requestMessageId, `${label}.semantic.correlation.requestMessageId`) }
  } else if (value.semantic.purpose === 'member-self-introduction') {
    exactKeys(value.semantic, ['purpose', 'correlation', 'participantId', 'memberId', 'runId'], `${label}.semantic`)
    plainObject(value.semantic.correlation, `${label}.semantic.correlation`); exactKeys(value.semantic.correlation, ['sessionId', 'requestMessageId'], `${label}.semantic.correlation`)
    opaque(value.semantic.correlation.sessionId, `${label}.semantic.correlation.sessionId`); opaque(value.semantic.correlation.requestMessageId, `${label}.semantic.correlation.requestMessageId`)
    opaque(value.semantic.participantId, `${label}.semantic.participantId`); opaque(value.semantic.memberId, `${label}.semantic.memberId`); opaque(value.semantic.runId, `${label}.semantic.runId`)
  } else if (value.semantic.purpose === 'chatroom-acknowledgement') exactKeys(value.semantic, ['purpose'], `${label}.semantic`)
  else throw new Error(`${label}.semantic.purpose is invalid`)
  if (value.source.kind === 'chatroom-acknowledgement' !== (value.semantic.purpose === 'chatroom-acknowledgement')) throw new Error(`${label}.source and semantic mismatch`)
  if (!Array.isArray(value.body) || value.body.length === 0 || value.body.length > 64) throw new Error(`${label}.body is invalid`)
  value.body.forEach((block, index) => { plainObject(block, `${label}.body[${index}]`); exactKeys(block, ['kind', 'text'], `${label}.body[${index}]`); if (block.kind !== 'text') throw new Error(`${label}.body is invalid`); assertLocalizedText(block.text, `${label}.body[${index}].text`) })
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) || !['pending', 'sent', 'delivered', 'failed'].includes(value.deliveryState as string) || !['idle', 'running', 'stopped', 'failed'].includes(value.runState as string) || !['off', 'polite'].includes(value.ariaLive as string)) throw new Error(`${label} presentation is invalid`)
  if (!Array.isArray(value.actions) || value.actions.length > 8) throw new Error(`${label}.actions is invalid`)
  value.actions.forEach((action, index) => assertAction(action, `${label}.actions[${index}]`))
  if (!Array.isArray(value.reactions) || value.reactions.length > 64) throw new Error(`${label}.reactions is invalid`)
  const reactionIds = new Set<string>()
  value.reactions.forEach((reaction, index) => {
    plainObject(reaction, `${label}.reactions[${index}]`); exactKeys(reaction, ['reactionId', 'actorParticipantId', 'value', 'state'], `${label}.reactions[${index}]`)
    opaque(reaction.reactionId, `${label}.reactions[${index}].reactionId`); opaque(reaction.actorParticipantId, `${label}.reactions[${index}].actorParticipantId`); assertReactionValue(reaction.value, `${label}.reactions[${index}].value`)
    if (reactionIds.has(reaction.reactionId) || !['pending', 'completed', 'failed'].includes(reaction.state as string)) throw new Error(`${label}.reactions are invalid`)
    reactionIds.add(reaction.reactionId)
  })
}

function assertSnapshotV4(value: unknown): asserts value is AgentConversationShellSnapshotV4 {
  plainObject(value, 'v4 snapshot'); exactKeys(value, ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'], 'v4 snapshot')
  plainObject(value.binding, 'v4 snapshot.binding'); exactKeys(value.binding, ['bindingId', 'ownerGeneration'], 'v4 snapshot.binding')
  opaque(value.binding.bindingId, 'v4 snapshot.binding.bindingId'); opaque(value.binding.ownerGeneration, 'v4 snapshot.binding.ownerGeneration'); opaque(value.generation, 'v4 snapshot.generation'); safeSequence(value.snapshotSequence, 'v4 snapshot.snapshotSequence')
  assertSelectionV4(value.selection, 'v4 snapshot.selection')
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('v4 snapshot.items is invalid')
  value.items.forEach((item, index) => assertItemV4(item, `v4 snapshot.items[${index}]`))
  if (value.items.some(item => item.sequence > (value.snapshotSequence as number))) throw new Error('v4 snapshot item sequence exceeds watermark')
  plainObject(value.composer, 'v4 snapshot.composer'); exactKeys(value.composer, ['availability', 'placeholder', 'disabled', 'submit'], 'v4 snapshot.composer')
  if (!['available', 'unavailable'].includes(value.composer.availability as string)) throw new Error('v4 snapshot composer is invalid')
  assertLocalizedText(value.composer.placeholder, 'v4 snapshot.composer.placeholder'); assertDisabled(value.composer.disabled, 'v4 snapshot.composer.disabled'); assertCommand(value.composer.submit, 'v4 snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) throw new Error('v4 snapshot.headerActions is invalid')
  value.headerActions.forEach((action, index) => assertAction(action, `v4 snapshot.headerActions[${index}]`))
  if (value.selection.kind !== 'room') {
    if (value.items.some(item => item.kind === 'approval' || item.kind === 'message' && item.semantic.purpose === 'member-self-introduction')) throw new Error('v4 no-room snapshot contains Room items')
    return
  }
  const participants = new Map(value.selection.participants.map(participant => [participant.participantId, participant]))
  const runs = new Set((value.selection.activeRuns ?? []).map(run => JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])))
  for (const item of value.items) {
    if (item.kind === 'message') {
      const participant = participants.get(item.author.participantId)
      if (participant === undefined
        || participant.role !== item.author.role
        || JSON.stringify(participant.displayName) !== JSON.stringify(item.author.displayName)
        || !sameAvatar(participant.avatar, item.author.avatar)
        || JSON.stringify(participant.agentIdentity) !== JSON.stringify(item.author.agentIdentity)) {
        throw new Error('v4 message author is not the exact Room participant')
      }
      if (item.source.kind === 'session-event' && item.semantic.purpose === 'member-self-introduction') {
        if (item.author.role !== 'agent' || item.author.agentIdentity === undefined || item.semantic.participantId !== item.author.participantId || item.semantic.correlation.sessionId !== item.source.sessionId) throw new Error('v4 self-introduction association is invalid')
      }
    } else if (item.kind === 'approval') {
      if (!runs.has(JSON.stringify([item.participantId, item.memberId, item.runId, item.sessionId]))) throw new Error('v4 approval does not match an active run')
    }
  }
}

function assertSnapshotV5(value: unknown): asserts value is AgentConversationShellSnapshotV5 {
  plainObject(value, 'v5 snapshot')
  exactKeys(value, ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'], 'v5 snapshot')
  plainObject(value.composer, 'v5 snapshot.composer')
  exactKeys(value.composer, ['availability', 'placeholder', 'disabled', 'shortcutPolicy', 'submit'], 'v5 snapshot.composer')
  if (value.composer.shortcutPolicy !== 'enter' && value.composer.shortcutPolicy !== 'mod-enter') {
    throw new Error('v5 snapshot.composer.shortcutPolicy is invalid')
  }
  const { shortcutPolicy: _shortcutPolicy, ...composerV4 } = value.composer
  assertSnapshotV4({ ...value, composer: composerV4 })
}

function sameBinding(left: { bindingId: string; ownerGeneration: string }, right: { bindingId: string; ownerGeneration: string }): boolean {
  return left.bindingId === right.bindingId && left.ownerGeneration === right.ownerGeneration
}

function assertSubscription(value: unknown, label: string): asserts value is AgentConversationShellSubscription {
  plainObject(value, label)
  exactKeys(value, ['subscriptionId', 'binding', 'generation', 'afterSequence', 'snapshotSequence'], label)
  opaque(value.subscriptionId, `${label}.subscriptionId`)
  plainObject(value.binding, `${label}.binding`)
  exactKeys(value.binding, ['bindingId', 'ownerGeneration'], `${label}.binding`)
  opaque(value.binding.bindingId, `${label}.binding.bindingId`)
  opaque(value.binding.ownerGeneration, `${label}.binding.ownerGeneration`)
  opaque(value.generation, `${label}.generation`)
  safeSequence(value.afterSequence, `${label}.afterSequence`)
  safeSequence(value.snapshotSequence, `${label}.snapshotSequence`)
  if (value.afterSequence > value.snapshotSequence) throw new Error(`${label}.afterSequence exceeds its snapshot watermark`)
}

function sameSubscription(left: AgentConversationShellSubscription, right: AgentConversationShellSubscription): boolean {
  return left.subscriptionId === right.subscriptionId
    && sameBinding(left.binding, right.binding)
    && left.generation === right.generation
    && left.afterSequence === right.afterSequence
    && left.snapshotSequence === right.snapshotSequence
}

function encodedGeneration(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length === 0 || bytes.length > 240) throw new Error('plugin owner generation is invalid')
  return `g-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function protocolMessage(message: LocalizedText): CordisXLocalizedText {
  return {
    key: message.key,
    fallback: message.fallback,
    ...(message.namespace === undefined ? {} : { namespace: message.namespace }),
  }
}

interface ProjectionLocalization {
  resolve(message: LocalizedText, site: string): string
}

function projectAction(action: ProtocolAction, localization: ProjectionLocalization, site: string): AgentConversationAction {
  return {
    id: action.id,
    label: localization.resolve(action.label, `${site}.label`),
    ...(action.icon === undefined ? {} : { icon: action.icon }),
    command: {
      id: action.command.id,
      ...(action.command.arguments === undefined ? {} : { arguments: action.command.arguments as CordisXJsonValue }),
    },
    disabled: action.disabled.value,
    ...(action.disabled.reason === undefined ? {} : { disabledReason: localization.resolve(action.disabled.reason, `${site}.disabled`) }),
  }
}

function projectSnapshot(
  owner: string,
  snapshotInput: AgentConversationShellSnapshot,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshot(snapshot)
  const participants = snapshot.selection.kind === 'room' ? snapshot.selection.participants.map((participant, index) => ({
    id: participant.participantId,
    role: participant.role,
    name: localization.resolve(participant.displayName, `participants.${index}`),
    ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
    ...(participant.role !== 'agent' || participant.agentIdentity === undefined ? {} : { agentIdentity: participant.agentIdentity }),
  })) : []
  const participantById = new Map(snapshot.selection.kind === 'room'
    ? snapshot.selection.participants.map(participant => [participant.participantId, participant])
    : [])
  const entries = snapshot.items.map((item, index) => {
    if (item.kind === 'status') return {
      kind: 'status' as const,
      itemId: item.itemId,
      sequence: item.sequence,
      label: localization.resolve(item.label, `items.${index}.label`),
      state: item.state,
      ariaLive: item.ariaLive,
    }
    if (item.kind === 'member-presence') return {
      kind: 'member-presence' as const,
      itemId: item.itemId,
      sequence: item.sequence,
      participantId: item.participantId,
      memberId: item.memberId,
      runId: item.runId,
      state: item.state,
      retryable: item.retryable,
      ...(item.diagnostic === undefined ? {} : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
      ...(item.retry === undefined ? {} : { retry: { id: item.retry.id, ...(item.retry.arguments === undefined ? {} : { arguments: item.retry.arguments as CordisXJsonValue }) } }),
    }
    if (item.kind === 'approval') return {
      kind: 'approval' as const,
      itemId: item.itemId,
      sequence: item.sequence,
      participantId: item.participantId,
      memberId: item.memberId,
      runId: item.runId,
      binding: item.binding,
      turn: item.turn,
      approvalId: item.approvalId,
      approvalKind: item.approvalKind,
      state: item.state,
      actions: item.actions.map(action => ({ decision: action.decision, command: { id: action.command.id, ...(action.command.arguments === undefined ? {} : { arguments: action.command.arguments as CordisXJsonValue }) } })),
      ...(item.rationale === undefined ? {} : { rationale: localization.resolve(item.rationale, `items.${index}.rationale`) }),
      ...(item.diagnostic === undefined ? {} : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
    }
    const declared = participantById.get(item.author.participantId)
    if (declared === undefined || declared.role !== item.author.role
      || JSON.stringify(declared.displayName) !== JSON.stringify(item.author.displayName)
      || !sameAvatar(declared.avatar, item.author.avatar)
      || JSON.stringify(declared.agentIdentity) !== JSON.stringify(item.author.agentIdentity)) {
      throw new Error(`snapshot.items[${index}].author does not match the selected room participant`)
    }
    return {
      kind: 'message' as const,
      itemId: item.itemId,
      messageId: item.messageId,
      sequence: item.sequence,
      authorId: item.author.participantId,
      body: item.body.map((block, blockIndex) => localization.resolve(block.text, `items.${index}.body.${blockIndex}`)),
      timestamp: item.timestamp,
      deliveryState: item.deliveryState,
      runState: item.runState,
      ariaLive: item.ariaLive,
      actions: item.actions.map((action, actionIndex) => projectAction(action, localization, `items.${index}.actions.${actionIndex}`)),
      source: item.source ?? 'agent-loop',
      ...(!('semantic' in item) || item.semantic === undefined ? {} : { semantic: item.semantic }),
      reactions: (item.reactions ?? []).map(reaction => ({
        reactionId: reaction.reactionId,
        actorParticipantId: reaction.actorParticipantId,
        value: reaction.value,
        state: reaction.state,
      })),
    }
  })
  let selection: AgentConversationModel['selection']
  let headerActions: readonly AgentConversationAction[]
  if (snapshot.selection.kind === 'no-room') {
    if (snapshot.items.length !== 0 || snapshot.headerActions.length !== 0) {
      throw new Error('no-room snapshot requires an empty timeline and no header actions')
    }
    selection = { kind: 'no-room' }
    headerActions = []
  } else {
    selection = {
      kind: 'room',
      roomId: snapshot.selection.roomId,
      title: localization.resolve(snapshot.selection.title, 'selection.title'),
      ...(!('description' in snapshot.selection) || snapshot.selection.description === undefined ? {} : {
        description: snapshot.selection.description.state === 'empty'
          ? { state: 'empty' as const }
          : { state: 'present' as const, text: localization.resolve(snapshot.selection.description.text, 'selection.description') },
      }),
      ...(snapshot.selection.secondary === undefined ? {} : { secondary: localization.resolve(snapshot.selection.secondary, 'selection.secondary') }),
      multiParticipant: snapshot.selection.multiParticipant,
      participantPresentation: snapshot.selection.participantPresentation,
      participants,
      activeRuns: snapshot.selection.activeRuns ?? [],
    }
    headerActions = snapshot.headerActions.map((action, index) => projectAction(action, localization, `headerActions.${index}`))
  }
  return createAgentConversationModel({
    ownerId: owner,
    shell: 'agent-desktop',
    binding: snapshot.binding,
    generation: snapshot.generation,
    snapshotSequence: snapshot.snapshotSequence,
    selection,
    entries,
    composer: {
      availability: snapshot.composer.availability,
      placeholder: localization.resolve(snapshot.composer.placeholder, 'composer.placeholder'),
      disabled: snapshot.composer.disabled.value,
      shortcutPolicy: 'enter',
      ...(snapshot.composer.disabled.reason === undefined ? {} : {
        disabledReason: localization.resolve(snapshot.composer.disabled.reason, 'composer.disabled'),
      }),
      submit: {
        id: snapshot.composer.submit.id,
        ...(snapshot.composer.submit.arguments === undefined ? {} : { arguments: snapshot.composer.submit.arguments as CordisXJsonValue }),
      },
    },
    headerActions,
  })
}

export function projectAgentConversationShellSnapshotV4(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV4,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV4(snapshot)
  const participants = snapshot.selection.kind === 'room' ? snapshot.selection.participants.map((participant, index) => ({
    id: participant.participantId, role: participant.role,
    name: localization.resolve(participant.displayName, `participants.${index}`),
    ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
    ...(participant.role !== 'agent' || participant.agentIdentity === undefined ? {} : { agentIdentity: participant.agentIdentity }),
  })) : []
  const participantById = new Map(snapshot.selection.kind === 'room' ? snapshot.selection.participants.map(participant => [participant.participantId, participant]) : [])
  const entries = snapshot.items.map((item, index) => {
    if (item.kind === 'status') return { kind: 'status' as const, itemId: item.itemId, sequence: item.sequence, label: localization.resolve(item.label, `items.${index}.label`), state: item.state, ariaLive: item.ariaLive }
    if (item.kind === 'member-presence') return {
      kind: 'member-presence' as const, itemId: item.itemId, sequence: item.sequence,
      participantId: item.participantId, memberId: item.memberId, runId: item.runId, sessionId: item.sessionId,
      state: item.state, retryable: item.retryable,
      ...(item.diagnostic === undefined ? {} : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
      ...(item.retry === undefined ? {} : { retry: { id: item.retry.id, ...(item.retry.arguments === undefined ? {} : { arguments: item.retry.arguments as CordisXJsonValue }) } }),
    }
    if (item.kind === 'approval') return {
      kind: 'approval' as const, itemId: item.itemId, sequence: item.sequence,
      participantId: item.participantId, memberId: item.memberId, runId: item.runId,
      sessionId: item.sessionId, agentGeneration: item.agentGeneration, approvalId: item.approvalId,
      approvalKind: item.approvalKind, state: item.state,
      actions: item.actions.map(action => ({ decision: action.decision, command: { id: action.command.id, ...(action.command.arguments === undefined ? {} : { arguments: action.command.arguments as CordisXJsonValue }) } })),
      ...(item.rationale === undefined ? {} : { rationale: localization.resolve(item.rationale, `items.${index}.rationale`) }),
      ...(item.diagnostic === undefined ? {} : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
    }
    const declared = participantById.get(item.author.participantId)
    if (declared === undefined
      || declared.role !== item.author.role
      || JSON.stringify(declared.displayName) !== JSON.stringify(item.author.displayName)
      || !sameAvatar(declared.avatar, item.author.avatar)
      || JSON.stringify(declared.agentIdentity) !== JSON.stringify(item.author.agentIdentity)) {
      throw new Error(`v4 snapshot.items[${index}].author does not match the selected room participant`)
    }
    return {
      kind: 'message' as const, itemId: item.itemId, messageId: item.messageId, sequence: item.sequence,
      authorId: item.author.participantId,
      body: item.body.map((block, blockIndex) => localization.resolve(block.text, `items.${index}.body.${blockIndex}`)),
      timestamp: item.timestamp, deliveryState: item.deliveryState, runState: item.runState, ariaLive: item.ariaLive,
      actions: item.actions.map((action, actionIndex) => projectAction(action, localization, `items.${index}.actions.${actionIndex}`)),
      source: item.source,
      semantic: item.semantic,
      reactions: item.reactions.map(reaction => ({ reactionId: reaction.reactionId, actorParticipantId: reaction.actorParticipantId, value: reaction.value, state: reaction.state })),
    }
  })
  const selection: AgentConversationModel['selection'] = snapshot.selection.kind === 'no-room' ? { kind: 'no-room' } : {
    kind: 'room', roomId: snapshot.selection.roomId,
    title: localization.resolve(snapshot.selection.title, 'selection.title'),
    ...(snapshot.selection.description === undefined ? {} : { description: snapshot.selection.description.state === 'empty' ? { state: 'empty' as const } : { state: 'present' as const, text: localization.resolve(snapshot.selection.description.text, 'selection.description') } }),
    ...(snapshot.selection.secondary === undefined ? {} : { secondary: localization.resolve(snapshot.selection.secondary, 'selection.secondary') }),
    multiParticipant: snapshot.selection.multiParticipant, participantPresentation: snapshot.selection.participantPresentation,
    participants,
    activeRuns: snapshot.selection.activeRuns ?? [],
  }
  if (snapshot.selection.kind === 'no-room' && (snapshot.items.length !== 0 || snapshot.headerActions.length !== 0)) throw new Error('v4 no-room snapshot requires an empty timeline and no header actions')
  return createAgentConversationModel({
    ownerId: owner, shell: 'agent-desktop', binding: snapshot.binding, generation: snapshot.generation,
    snapshotSequence: snapshot.snapshotSequence, selection, entries,
    composer: {
      availability: snapshot.composer.availability,
      placeholder: localization.resolve(snapshot.composer.placeholder, 'composer.placeholder'),
      disabled: snapshot.composer.disabled.value,
      shortcutPolicy: 'enter',
      ...(snapshot.composer.disabled.reason === undefined ? {} : { disabledReason: localization.resolve(snapshot.composer.disabled.reason, 'composer.disabled') }),
      submit: { id: snapshot.composer.submit.id, ...(snapshot.composer.submit.arguments === undefined ? {} : { arguments: snapshot.composer.submit.arguments as CordisXJsonValue }) },
    },
    headerActions: snapshot.headerActions.map((action, index) => projectAction(action, localization, `headerActions.${index}`)),
  })
}

export function projectAgentConversationShellSnapshotV5(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV5,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV5(snapshot)
  const { shortcutPolicy, ...composerV4 } = snapshot.composer
  const model = projectAgentConversationShellSnapshotV4(owner, {
    ...snapshot,
    composer: composerV4,
  }, localization)
  return createAgentConversationModel({
    ...model,
    composer: { ...model.composer, shortcutPolicy },
  })
}

function rendererCopy(locale: string): AgentConversationRendererCopy {
  const chinese = locale.toLowerCase().startsWith('zh')
  return chinese ? {
    locale,
    newRoomTitle: '新建房间',
    timelineLabel: '房间对话',
    composerLabel: '消息',
    sendLabel: '发送',
    running: '处理中',
    stopped: '已停止',
    failed: '未能完成',
    pending: '发送中',
    unavailable: '消息功能暂不可用。',
  } : {
    locale,
    newRoomTitle: 'New room',
    timelineLabel: 'Room conversation',
    composerLabel: 'Message',
    sendLabel: 'Send',
    running: 'Working',
    stopped: 'Stopped',
    failed: 'Could not complete',
    pending: 'Sending',
    unavailable: 'Messaging is unavailable.',
  }
}

interface RegisteredSource {
  readonly version: 3 | 4 | 5
  readonly owner: string
  readonly ownerGeneration: string
  readonly effect: PluginGenerationEffectIdentity
  readonly factory: CordisXAgentConversationShellSourceFactory | CordisXAgentConversationShellSourceFactoryV2 | CordisXAgentConversationShellSourceFactoryV3 | CordisXAgentConversationShellSourceFactoryV4 | CordisXAgentConversationShellSourceFactoryV5
  readonly principal?: PluginPrincipalToken
  readonly sessions: Set<MountedConversation>
  active: boolean
}

class BoundSourceHost implements AgentConversationShellHost {
  constructor(
    private readonly record: RegisteredSource,
    private readonly issueBindingId: () => string,
  ) {}

  async bind(requestInput: AgentConversationShellBindRequest): Promise<AgentConversationShellBindResult> {
    const request = immutableSnapshot(requestInput)
    plainObject(request, 'bind request')
    exactKeys(request, ['requestId', 'ownerGeneration', 'routeSelection'], 'bind request')
    opaque(request.requestId, 'bind request.requestId')
    opaque(request.ownerGeneration, 'bind request.ownerGeneration')
    plainObject(request.routeSelection, 'bind request.routeSelection')
    exactKeys(request.routeSelection, ['scope', 'selectedRoomParam'], 'bind request.routeSelection')
    if (request.routeSelection.scope !== 'room-or-new') throw new Error('bind request.routeSelection.scope is invalid')
    if (request.routeSelection.selectedRoomParam !== undefined) opaque(request.routeSelection.selectedRoomParam, 'bind request.routeSelection.selectedRoomParam')
    if (!this.record.active) return { type: 'bind', status: 'unavailable', code: 'disposed' }
    if (request.ownerGeneration !== this.record.ownerGeneration) {
      return { type: 'bind', status: 'unavailable', code: 'generation-replaced' }
    }
    const binding: AgentConversationShellBinding = immutableSnapshot({
      bindingId: this.issueBindingId(),
      shell: 'agent-desktop',
      ownerGeneration: this.record.ownerGeneration,
      routeSelection: request.routeSelection,
    })
    return { type: 'bind', status: 'accepted', code: 'allowed', binding }
  }
}

class MountedConversation {
  private source: AgentConversationShellSource | AgentConversationShellSourceV4 | AgentConversationShellSourceV5 | undefined
  private subscription: AgentConversationShellSubscription | AgentConversationShellSubscriptionV4 | AgentConversationShellSubscriptionV5 | undefined
  private unsubscribe: (() => void | Promise<unknown>) | undefined
  private snapshot: AgentConversationShellSnapshot | AgentConversationShellSnapshotV4 | AgentConversationShellSnapshotV5 | undefined
  private cursor = 0
  private terminal = false
  private disposed = false
  private readonly root: Root
  private readonly diagnosticSites = new Set<string>()
  private readonly disconnectLocale: () => void
  private readonly detachTheme: () => void
  private readonly previousOverflow: string
  private readonly previousMinHeight: string

  constructor(
    private readonly record: RegisteredSource,
    private readonly binding: AgentConversationShellBinding,
    private readonly mountContext: CordisXPageMountContext,
    private readonly commands: CordisXCommandService,
    private readonly i18n: CordisXI18nService,
    private readonly console: PluginConsoleAspect | undefined,
    private readonly identity: AgentConversationRendererProps['identity'],
    private readonly scenarioSource: PlaygroundScenarioConversationSourceAuthority | undefined,
    private readonly scenarioOwner: PlaygroundScenarioConversationOwnerResolver | undefined,
  ) {
    this.root = createRoot(mountContext.container)
    this.detachTheme = new HostThemeProjection(mountContext.document).attach(mountContext.container)
    this.previousOverflow = mountContext.container.style.overflow
    this.previousMinHeight = mountContext.container.style.minHeight
    mountContext.container.style.overflow = 'hidden'
    mountContext.container.style.minHeight = '0'
    this.disconnectLocale = i18n.subscribeInternal(() => this.render())
    this.renderStatus('loading')
  }

  start(): void {
    void this.initialize().catch(error => this.fail(error))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scenarioSource?.fenceBinding(this.binding.bindingId, 'route-replaced')
    this.disconnectLocale()
    this.releaseSource()
    for (const site of this.diagnosticSites) this.i18n.clearDiagnosticSite(this.record.owner, site)
    this.diagnosticSites.clear()
    this.root.unmount()
    this.detachTheme()
    this.mountContext.container.style.overflow = this.previousOverflow
    this.mountContext.container.style.minHeight = this.previousMinHeight
    this.record.sessions.delete(this)
  }

  private async initialize(): Promise<void> {
    const sourceCandidate = await this.runPlugin('agent-conversation-shell.source', () => (
      this.record.factory as CordisXAgentConversationShellSourceFactoryV2
    )(this.binding as never))
    if (this.disposed) {
      sourceCandidate.dispose()
      return
    }
    if (sourceCandidate === null || typeof sourceCandidate !== 'object'
      || typeof sourceCandidate.snapshot !== 'function' || typeof sourceCandidate.subscribe !== 'function' || typeof sourceCandidate.dispose !== 'function') {
      throw new Error('conversation source must implement snapshot, subscribe, and dispose')
    }
    const source = sourceCandidate as unknown as AgentConversationShellSource | AgentConversationShellSourceV4 | AgentConversationShellSourceV5
    this.source = source
    const initial = immutableSnapshot(await this.runPlugin<unknown>('agent-conversation-shell.snapshot', () => source.snapshot()))
    if (this.record.version === 5) assertSnapshotV5(initial)
    else if (this.record.version === 4) assertSnapshotV4(initial)
    else assertSnapshot(initial)
    this.assertSnapshotFence(initial)
    if (this.record.version === 5) projectAgentConversationShellSnapshotV5(this.record.owner, initial as AgentConversationShellSnapshotV5, { resolve: message => message.fallback })
    else if (this.record.version === 4) projectAgentConversationShellSnapshotV4(this.record.owner, initial as AgentConversationShellSnapshotV4, { resolve: message => message.fallback })
    else projectSnapshot(this.record.owner, initial as AgentConversationShellSnapshot, { resolve: message => message.fallback })
    this.snapshot = initial
    this.cursor = initial.snapshotSequence
    const subscribed = await this.runPlugin<unknown>('agent-conversation-shell.subscribe', () => source.subscribe(this.cursor)) as AgentConversationShellSubscribeRuntimeResultV3 | AgentConversationShellSubscribeRuntimeResultV4 | AgentConversationShellSubscribeRuntimeResultV5
    if (this.disposed) {
      if ('handle' in subscribed) subscribed.handle.unsubscribe()
      return
    }
    plainObject(subscribed, 'subscribe runtime result')
    plainObject(subscribed.result, 'subscribe result')
    if (subscribed.result.type !== 'subscribe') throw new Error('subscribe result type is invalid')
    if (subscribed.result.status !== 'accepted') {
      if ('handle' in subscribed) {
        const unexpected = subscribed.handle as unknown
        if (unexpected !== null && typeof unexpected === 'object'
          && typeof (unexpected as { unsubscribe?: unknown }).unsubscribe === 'function') {
          try {
            ;(unexpected as { unsubscribe(): void }).unsubscribe()
          } catch (error) {
            console.error('[cordisx] Agent conversation rejected runtime handle cleanup failed', error)
          }
        }
      }
      this.releaseSource()
      exactKeys(subscribed, ['result'], 'subscribe runtime result')
      exactKeys(subscribed.result, ['type', 'status', 'code'], 'subscribe result')
      if (subscribed.result.status !== 'denied' && subscribed.result.status !== 'unavailable') {
        throw new Error('subscribe result status is invalid')
      }
      if (subscribed.result.status === 'denied' && subscribed.result.code !== 'policy-denied') throw new Error('denied subscribe result code is invalid')
      if (subscribed.result.status === 'unavailable' && !['owner-unavailable', 'generation-replaced', 'disposed'].includes(subscribed.result.code)) {
        throw new Error('unavailable subscribe result code is invalid')
      }
      this.renderStatus('unavailable')
      return
    }
    exactKeys(subscribed, ['result', 'handle'], 'subscribe runtime result')
    exactKeys(subscribed.result, ['type', 'status', 'code', 'subscription'], 'subscribe result')
    if (subscribed.result.code !== 'allowed' || !('handle' in subscribed)) throw new Error('accepted subscribe result is missing its runtime handle')
    plainObject(subscribed.handle, 'subscribe runtime handle')
    exactKeys(subscribed.handle, this.record.version >= 4 ? ['subscription', 'pages', 'closed', 'unsubscribe'] : ['subscription', 'pages', 'unsubscribe'], 'subscribe runtime handle')
    if (typeof subscribed.handle.unsubscribe !== 'function') throw new Error('accepted subscribe result has an invalid runtime handle')
    this.unsubscribe = () => subscribed.handle.unsubscribe()
    if (this.record.version >= 4) {
      const closed = (subscribed.handle as { readonly closed?: unknown }).closed
      if (closed === null || typeof closed !== 'object' || typeof (closed as PromiseLike<unknown>).then !== 'function') throw new Error(`v${this.record.version} subscribe runtime handle.closed is invalid`)
      void Promise.resolve(closed).then(value => this.observeVersionedClosed(value)).catch(error => this.fail(new Error(`v${this.record.version} subscription closed Promise rejected: ${String(error)}`)))
    }
    assertSubscription(subscribed.result.subscription, 'subscribe result.subscription')
    assertSubscription(subscribed.handle.subscription, 'subscribe handle.subscription')
    if (!sameSubscription(subscribed.result.subscription, subscribed.handle.subscription)) {
      throw new Error('subscribe result and runtime handle descriptors differ')
    }
    const issued = subscribed.result.subscription
    if (!sameBinding(issued.binding, this.binding) || issued.generation !== initial.generation || issued.afterSequence !== this.cursor) {
      throw new Error('subscribe result crossed its binding, generation, or cursor fence')
    }
    if (subscribed.handle.pages === null
      || typeof subscribed.handle.pages !== 'object'
      || !(Symbol.asyncIterator in subscribed.handle.pages)) {
      throw new Error('accepted subscribe result has an invalid runtime handle')
    }
    this.subscription = immutableSnapshot(issued)
    this.render()
    await this.consume(subscribed.handle.pages as AsyncIterable<AgentConversationShellPage | AgentConversationShellPageV4 | AgentConversationShellPageV5>)
  }

  private async consume(pages: AsyncIterable<AgentConversationShellPage | AgentConversationShellPageV4 | AgentConversationShellPageV5>): Promise<void> {
    for await (const pageInput of pages) {
      if (this.disposed) return
      if (this.terminal) throw new Error('conversation source emitted a page after terminal disposal')
      const page = immutableSnapshot(pageInput)
      this.applyPage(page)
      if (this.terminal) return
    }
    if (!this.disposed && !this.terminal) throw new Error('conversation source ended without terminal disposal')
  }

  private applyPage(page: AgentConversationShellPage | AgentConversationShellPageV4 | AgentConversationShellPageV5): void {
    plainObject(page, 'subscription page')
    exactKeys(page, ['subscription', 'afterSequence', 'phase', 'updates', 'nextAfterSequence', 'hasMore'], 'subscription page')
    assertSubscription(page.subscription, 'subscription page.subscription')
    if (this.subscription === undefined || !sameSubscription(page.subscription, this.subscription)) {
      throw new Error('subscription page descriptor differs from the accepted subscription')
    }
    safeSequence(page.afterSequence, 'subscription page.afterSequence')
    safeSequence(page.nextAfterSequence, 'subscription page.nextAfterSequence')
    if (page.afterSequence !== this.cursor) throw new Error('subscription page cursor is not serialized')
    if (page.phase !== 'replay' && page.phase !== 'live') throw new Error('subscription page phase is invalid')
    if (this.cursor < this.subscription.snapshotSequence && page.phase !== 'replay') {
      throw new Error('live subscription page arrived before the replay watermark')
    }
    if (this.cursor >= this.subscription.snapshotSequence && page.phase !== 'live') {
      throw new Error('replay subscription page arrived after its watermark')
    }
    if (!Array.isArray(page.updates) || page.updates.length > 128) throw new Error('subscription page updates are invalid')
    if (typeof page.hasMore !== 'boolean') throw new Error('subscription page.hasMore must be boolean')
    let expected = this.cursor + 1
    let terminal = false
    for (const [index, update] of page.updates.entries()) {
      this.assertUpdate(update, `subscription page.updates[${index}]`)
      if (update.sequence !== expected) {
        throw new Error(`subscription updates are not monotonic (expected ${expected}, received ${update.sequence}, page after ${page.afterSequence})`)
      }
      if (page.phase === 'replay' && update.sequence > this.subscription.snapshotSequence) {
        throw new Error('replay subscription update crossed its snapshot watermark')
      }
      if (terminal) throw new Error('subscription page contains an update after terminal disposal')
      this.applyUpdate(update)
      terminal = update.kind === 'disposed'
      expected += 1
    }
    const expectedNext = page.updates.length === 0 ? this.cursor : page.updates.at(-1)!.sequence
    if (page.nextAfterSequence !== expectedNext) throw new Error('subscription next cursor is invalid')
    if (page.phase === 'replay' && page.nextAfterSequence > this.subscription.snapshotSequence) {
      throw new Error('replay subscription cursor crossed its snapshot watermark')
    }
    if (terminal && page.hasMore) throw new Error('terminal subscription page cannot have more pages')
    if (page.phase === 'replay' && !page.hasMore && page.nextAfterSequence !== this.subscription.snapshotSequence) {
      throw new Error('replay subscription did not reach its snapshot watermark')
    }
    this.cursor = page.nextAfterSequence
    this.terminal = terminal
    if (terminal) {
      this.releaseSource()
      this.renderStatus('unavailable')
    }
    else this.render()
  }

  private assertUpdate(value: unknown, label: string): asserts value is AgentConversationShellUpdate | AgentConversationShellUpdateV4 | AgentConversationShellUpdateV5 {
    plainObject(value, label)
    if (value.kind === 'snapshot-replaced') {
      exactKeys(value, ['kind', 'sequence', 'snapshot'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (this.record.version === 5) assertSnapshotV5(value.snapshot)
      else if (this.record.version === 4) assertSnapshotV4(value.snapshot)
      else assertSnapshot(value.snapshot)
      return
    }
    if (value.kind === 'item-appended' || value.kind === 'item-updated') {
      exactKeys(value, ['kind', 'sequence', 'item'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (this.record.version >= 4) assertItemV4(value.item, `${label}.item`)
      else assertItem(value.item, `${label}.item`)
      return
    }
    if (value.kind === 'disposed') {
      exactKeys(value, ['kind', 'sequence', 'reason'], label)
      safeSequence(value.sequence, `${label}.sequence`)
      if (!['explicit', 'owner-disposed', 'generation-replaced'].includes(value.reason as string)) throw new Error(`${label}.reason is invalid`)
      return
    }
    throw new Error(`${label}.kind is invalid`)
  }

  private applyUpdate(update: AgentConversationShellUpdate | AgentConversationShellUpdateV4 | AgentConversationShellUpdateV5): void {
    if (this.record.version >= 4) this.applyUpdateV4(update as AgentConversationShellUpdateV4 | AgentConversationShellUpdateV5)
    else this.applyUpdateV3(update as AgentConversationShellUpdate)
  }

  private applyUpdateV3(update: AgentConversationShellUpdate): void {
    const snapshot = this.snapshot as AgentConversationShellSnapshot | undefined
    if (snapshot === undefined) throw new Error('conversation snapshot is unavailable')
    if (update.kind === 'disposed') return
    if (update.kind === 'snapshot-replaced') {
      if (update.snapshot.snapshotSequence !== update.sequence) throw new Error('replacement snapshot sequence differs from its update')
      this.assertSnapshotFence(update.snapshot)
      if (update.snapshot.generation !== snapshot.generation) throw new Error('replacement snapshot crossed its generation fence')
      this.snapshot = immutableSnapshot(update.snapshot)
      return
    }
    if (update.item.sequence > update.sequence) throw new Error('conversation item sequence exceeds its update sequence')
    const existing = snapshot.items.findIndex(item => item.itemId === update.item.itemId)
    if (update.kind === 'item-appended' && existing !== -1) throw new Error('item-appended references an existing item')
    if (update.kind === 'item-updated' && existing === -1) throw new Error('item-updated references an unknown item')
    const items = [...snapshot.items]
    if (existing === -1) items.push(update.item)
    else {
      const previous = items[existing]!
      if (previous.kind !== update.item.kind || previous.sequence !== update.item.sequence) {
        throw new Error('item-updated changed its stable kind or item sequence')
      }
      if (previous.kind === 'message' && update.item.kind === 'message') {
        if (previous.messageId !== update.item.messageId
          || JSON.stringify(previous.author) !== JSON.stringify(update.item.author)
          || previous.source !== update.item.source
          || JSON.stringify(previous.semantic) !== JSON.stringify(update.item.semantic)) {
          throw new Error('item-updated changed its message association')
        }
        const priorReactions = previous.reactions ?? []
        const nextReactions = update.item.reactions ?? []
        if (nextReactions.length < priorReactions.length) throw new Error('item-updated removed an existing reaction')
        for (const [index, prior] of priorReactions.entries()) {
          const reaction = nextReactions[index]
          if (reaction === undefined
            || prior.reactionId !== reaction.reactionId
            || prior.actorParticipantId !== reaction.actorParticipantId
            || JSON.stringify(prior.value) !== JSON.stringify(reaction.value)
            || prior.state !== 'pending' && prior.state !== reaction.state) {
            throw new Error('item-updated changed its reaction identity or terminal state')
          }
        }
        if (nextReactions.slice(priorReactions.length).some(reaction => reaction.state !== 'pending')) {
          throw new Error('item-updated appended a terminal reaction')
        }
      }
      if (previous.kind === 'member-presence' && update.item.kind === 'member-presence'
        && (previous.participantId !== update.item.participantId
          || previous.memberId !== update.item.memberId
          || previous.runId !== update.item.runId)) {
        throw new Error('item-updated changed its member presence association')
      }
      if (previous.kind === 'approval' && update.item.kind === 'approval') {
        if (previous.participantId !== update.item.participantId
          || previous.memberId !== update.item.memberId
          || previous.runId !== update.item.runId
          || previous.binding.bindingId !== update.item.binding.bindingId
          || previous.binding.generation !== update.item.binding.generation
          || previous.turn !== update.item.turn
          || previous.approvalId !== update.item.approvalId
          || previous.approvalKind !== update.item.approvalKind
          || JSON.stringify(previous.rationale) !== JSON.stringify(update.item.rationale)) {
          throw new Error('item-updated changed its approval association')
        }
        if (previous.state !== 'pending') {
          if (JSON.stringify(previous) !== JSON.stringify(update.item)) throw new Error('item-updated changed a terminal approval')
        } else if (update.item.state === 'pending' && JSON.stringify(previous) !== JSON.stringify(update.item)) {
          throw new Error('item-updated changed a pending approval without resolving it')
        }
      }
      items[existing] = update.item
    }
    const next = immutableSnapshot({ ...snapshot, snapshotSequence: update.sequence, items })
    assertSnapshotAssociations(next)
    this.snapshot = next
  }

  private applyUpdateV4(update: AgentConversationShellUpdateV4 | AgentConversationShellUpdateV5): void {
    const snapshot = this.snapshot as AgentConversationShellSnapshotV4 | AgentConversationShellSnapshotV5 | undefined
    const label = `v${this.record.version}`
    if (snapshot === undefined) throw new Error(`${label} conversation snapshot is unavailable`)
    if (update.kind === 'disposed') return
    if (update.kind === 'snapshot-replaced') {
      if (update.snapshot.snapshotSequence !== update.sequence) throw new Error(`${label} replacement snapshot sequence differs from its update`)
      this.assertSnapshotFence(update.snapshot)
      if (update.snapshot.generation !== snapshot.generation) throw new Error(`${label} replacement snapshot crossed its generation fence`)
      this.snapshot = immutableSnapshot(update.snapshot)
      return
    }
    if (update.item.sequence > update.sequence) throw new Error(`${label} conversation item sequence exceeds its update sequence`)
    const existing = snapshot.items.findIndex(item => item.itemId === update.item.itemId)
    if (update.kind === 'item-appended' && existing !== -1) throw new Error(`${label} item-appended references an existing item`)
    if (update.kind === 'item-updated' && existing === -1) throw new Error(`${label} item-updated references an unknown item`)
    const items = [...snapshot.items]
    if (existing === -1) items.push(update.item)
    else {
      const previous = items[existing]!
      if (previous.kind !== update.item.kind || previous.sequence !== update.item.sequence) throw new Error(`${label} item-updated changed its stable kind or item sequence`)
      if (previous.kind === 'message' && update.item.kind === 'message') {
        if (previous.messageId !== update.item.messageId || JSON.stringify(previous.author) !== JSON.stringify(update.item.author)
          || JSON.stringify(previous.source) !== JSON.stringify(update.item.source) || JSON.stringify(previous.semantic) !== JSON.stringify(update.item.semantic)) throw new Error(`${label} item-updated changed its message association`)
      }
      if (previous.kind === 'member-presence' && update.item.kind === 'member-presence'
        && JSON.stringify([previous.participantId, previous.memberId, previous.runId, previous.sessionId]) !== JSON.stringify([update.item.participantId, update.item.memberId, update.item.runId, update.item.sessionId])) throw new Error(`${label} item-updated changed its member presence association`)
      if (previous.kind === 'approval' && update.item.kind === 'approval') {
        const prior = JSON.stringify([previous.participantId, previous.memberId, previous.runId, previous.sessionId, previous.agentGeneration, previous.approvalId, previous.approvalKind, previous.rationale])
        const next = JSON.stringify([update.item.participantId, update.item.memberId, update.item.runId, update.item.sessionId, update.item.agentGeneration, update.item.approvalId, update.item.approvalKind, update.item.rationale])
        if (prior !== next) throw new Error(`${label} item-updated changed its approval association`)
        if (previous.state !== 'pending' && JSON.stringify(previous) !== JSON.stringify(update.item)) throw new Error(`${label} item-updated changed a terminal approval`)
      }
      items[existing] = update.item
    }
    const next = immutableSnapshot({ ...snapshot, snapshotSequence: update.sequence, items })
    if (this.record.version === 5) assertSnapshotV5(next)
    else assertSnapshotV4(next)
    this.snapshot = next
  }

  private assertSnapshotFence(snapshot: AgentConversationShellSnapshot | AgentConversationShellSnapshotV4 | AgentConversationShellSnapshotV5): void {
    if (!sameBinding(snapshot.binding, this.binding)) throw new Error('conversation snapshot crossed its binding fence')
  }

  private render(): void {
    if (this.disposed || this.snapshot === undefined) return
    const localization: ProjectionLocalization = {
      resolve: (message, site) => {
        const key = `conversation:${this.binding.bindingId}:${site}`
        this.diagnosticSites.add(key)
        return this.i18n.resolveFor(this.record.owner, protocolMessage(message), key).text
      },
    }
    try {
      const model = this.record.version === 5
        ? projectAgentConversationShellSnapshotV5(this.record.owner, this.snapshot as AgentConversationShellSnapshotV5, localization)
        : this.record.version === 4
          ? projectAgentConversationShellSnapshotV4(this.record.owner, this.snapshot as AgentConversationShellSnapshotV4, localization)
          : projectSnapshot(this.record.owner, this.snapshot as AgentConversationShellSnapshot, localization)
      const controller = new AgentConversationCommandController({
        execute: async request => {
          const execute = async () => await this.commands.executeConversationFor(
            request.ownerId,
            request.reference,
            request.invocationKey,
            request.context,
          )
          if (this.scenarioSource === undefined || request.context.scope !== 'composer-submit'
            || model.selection.kind !== 'room') return await execute()
          const scenarioOwner = this.scenarioOwner?.(this.record.owner, this.record.effect.moduleGeneration)
          if (scenarioOwner === undefined) return await execute()
          const runs = (model.selection.activeRuns ?? []).flatMap(run => (
            'sessionId' in run ? [{ runId: run.runId, sessionId: run.sessionId }] : []
          ))
          if (runs.length === 0) return await execute()
          const roomId = model.selection.roomId
          const snapshotGeneration = model.generation
          const sourceStillActive = (): boolean => {
            const currentSelection = this.snapshot?.selection
            if (this.disposed || this.terminal || this.mountContext.signal.aborted || !this.record.active
              || this.snapshot?.generation !== snapshotGeneration || currentSelection?.kind !== 'room'
              || currentSelection.roomId !== roomId) return false
            const currentRuns = currentSelection.activeRuns ?? []
            return runs.every(run => currentRuns.some(current => 'sessionId' in current
              && current.runId === run.runId && current.sessionId === run.sessionId))
          }
          return await this.scenarioSource.execute({
            owner: scenarioOwner,
            bindingId: this.binding.bindingId,
            ownerGeneration: this.binding.ownerGeneration,
            snapshotGeneration,
            roomId,
            routeId: this.mountContext.routeId,
            runs,
            active: sourceStillActive,
          }, execute)
        },
      }, model)
      this.root.render(<AgentConversationRenderer
        model={model}
        commands={controller}
        copy={rendererCopy(this.i18n.getSnapshot().locale)}
        {...(typeof this.source?.updateRoomSettings !== 'function' || model.selection.kind !== 'room' ? {} : {
          roomSettings: { update: async (patch: AgentConversationRoomSettingsPatch) => await this.updateRoomSettings(patch) },
        })}
        {...(this.identity === undefined ? {} : { identity: this.identity })}
      />)
    } catch (error) {
      this.fail(error)
    }
  }

  private async updateRoomSettings(patch: AgentConversationRoomSettingsPatch): Promise<void> {
    if (this.source === undefined || this.snapshot === undefined || this.snapshot.selection.kind !== 'room'
      || typeof this.source.updateRoomSettings !== 'function') throw new Error('Room settings are unavailable')
    assertRoomSettingsPatch(patch)
    const request: AgentConversationRoomSettingsUpdateRequest = immutableSnapshot({
      requestId: `settings-${crypto.randomUUID()}`,
      binding: this.snapshot.binding,
      generation: this.snapshot.generation,
      roomId: this.snapshot.selection.roomId,
      expectedSnapshotSequence: this.snapshot.snapshotSequence,
      patch,
    })
    const result = immutableSnapshot(await this.runPlugin('agent-conversation-shell.update-room-settings', () => this.source!.updateRoomSettings(request as never)))
    this.assertRoomSettingsResult(result, request)
    if (result.status !== 'applied') throw new Error(`Room settings update ${result.code}`)
  }

  private assertRoomSettingsResult(result: AgentConversationRoomSettingsUpdateResult, request: AgentConversationRoomSettingsUpdateRequest): void {
    plainObject(result, 'room settings result')
    exactKeys(result, ['type', 'requestId', 'binding', 'generation', 'roomId', 'expectedSnapshotSequence', 'status', 'code', 'snapshotSequence', 'currentSnapshotSequence'], 'room settings result')
    if (result.type !== 'update-room-settings' || result.requestId !== request.requestId
      || !sameBinding(result.binding, request.binding) || result.generation !== request.generation
      || result.roomId !== request.roomId || result.expectedSnapshotSequence !== request.expectedSnapshotSequence) {
      throw new Error('Room settings result crossed its request fence')
    }
    if (result.status === 'applied') {
      if (result.code !== 'applied' || !Number.isSafeInteger(result.snapshotSequence)
        || result.snapshotSequence <= request.expectedSnapshotSequence || result.currentSnapshotSequence !== undefined) {
        throw new Error('Room settings applied result is invalid')
      }
      return
    }
    if (result.status === 'conflict') {
      if (!['request-conflict', 'owner-conflict', 'generation-conflict', 'room-conflict', 'snapshot-conflict'].includes(result.code)
        || result.snapshotSequence !== undefined
        || result.currentSnapshotSequence !== undefined && (!Number.isSafeInteger(result.currentSnapshotSequence) || result.currentSnapshotSequence < 0)) {
        throw new Error('Room settings conflict result is invalid')
      }
      return
    }
    if (result.status === 'unavailable') {
      if (!['owner-unavailable', 'settings-unavailable', 'disposed'].includes(result.code)
        || result.snapshotSequence !== undefined || result.currentSnapshotSequence !== undefined) {
        throw new Error('Room settings unavailable result is invalid')
      }
      return
    }
    throw new Error('Room settings result status is invalid')
  }

  private renderStatus(state: 'loading' | 'unavailable' | 'error', detail?: string): void {
    const locale = this.i18n.getSnapshot().locale
    const chinese = locale.toLowerCase().startsWith('zh')
    const label = state === 'loading'
      ? chinese ? '正在加载对话…' : 'Loading conversation…'
      : state === 'unavailable'
        ? chinese ? '对话暂不可用。' : 'Conversation is unavailable.'
        : chinese ? '无法加载对话。' : 'Could not load conversation.'
    this.root.render(<section className="cxa-root" data-agent-conversation-runtime-state={state} role="status" aria-live="polite">
      <style data-agent-conversation-styles="production">{AGENT_CONVERSATION_STYLES}</style>
      <div className="cxa-runtime-status"><p>{label}</p>{detail === undefined ? null : <p className="cxa-live-region">{detail}</p>}</div>
    </section>)
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    const detail = error instanceof Error ? error.message : String(error)
    this.releaseSource()
    this.renderStatus('error', detail)
    console.error('[cordisx] Agent conversation source failed', error)
  }

  private observeVersionedClosed(value: unknown): void {
    if (this.disposed || this.record.version < 4) return
    const version = this.record.version
    plainObject(value, `v${version} subscription close`)
    exactKeys(value, ['$schema', 'contract', 'schemaVersion', 'subscriptionId', 'binding', 'generation', 'status', 'code'], `v${version} subscription close`)
    const close = value as unknown as AgentConversationShellSubscriptionClosedV4 | AgentConversationShellSubscriptionClosedV5
    if (close.$schema !== `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v${version}.schema.json`
      || close.contract !== `cordisx.agent-conversation-shell-subscription-close/v${version}` || close.schemaVersion !== version
      || close.status !== 'closed' || !['unsubscribed', 'explicit', 'owner-disposed', 'generation-replaced', 'permission-revoked', 'connection-replaced', 'observer-failed'].includes(close.code)) {
      throw new Error(`v${version} subscription close is invalid`)
    }
    const subscription = this.subscription
    if (subscription === undefined || close.subscriptionId !== subscription.subscriptionId
      || !sameBinding(close.binding, subscription.binding) || close.generation !== subscription.generation) throw new Error(`v${version} subscription close crossed its subscription fence`)
    if (!this.terminal) {
      this.terminal = true
      this.releaseSource()
      this.renderStatus('unavailable')
    }
  }

  private releaseSource(): void {
    try {
      const result = this.unsubscribe?.()
      if (result !== undefined) void Promise.resolve(result).catch(error => console.error('[cordisx] Agent conversation unsubscribe failed', error))
    } catch (error) {
      console.error('[cordisx] Agent conversation unsubscribe failed', error)
    }
    this.unsubscribe = undefined
    try {
      this.source?.dispose()
    } catch (error) {
      console.error('[cordisx] Agent conversation source disposal failed', error)
    }
    this.source = undefined
  }

  private async runPlugin<Value>(operation: string, callback: () => Value | Promise<Value>): Promise<Value> {
    if (this.record.principal === undefined || this.console === undefined) return await callback()
    return await this.console.runInPluginContext(this.record.principal, {
      trigger: { kind: 'registration', registrationId: `${operation}:${this.record.owner}` },
    }, callback)
  }
}

export class AgentConversationShellRegistry {
  private readonly records = new Set<RegisteredSource>()
  private readonly disconnectVisibility: (() => void) | undefined
  private nextRequest = 1
  private nextBinding = 1
  private disposed = false

  constructor(
    private readonly commands: CordisXCommandService,
    private readonly i18n: CordisXI18nService,
    private readonly visibility?: GenerationVisibilityCoordinator,
    private readonly console?: PluginConsoleAspect,
    private readonly identity?: AgentConversationRendererProps['identity'],
    private readonly scenarioSource?: PlaygroundScenarioConversationSourceAuthority,
    private readonly scenarioOwner?: PlaygroundScenarioConversationOwnerResolver,
  ) {
    this.disconnectVisibility = visibility?.connect({ notify: () => {
      for (const record of [...this.records]) {
        if (!visibility.visible(record.effect)) this.disposeRecord(record)
      }
    } })
  }

  register(ctx: Context, factory: CordisXAgentConversationShellSourceFactory | CordisXAgentConversationShellSourceFactoryV2 | CordisXAgentConversationShellSourceFactoryV3 | CordisXAgentConversationShellSourceFactoryV4 | CordisXAgentConversationShellSourceFactoryV5, principal?: PluginPrincipalToken, version: 3 | 4 | 5 = 3): CordisXAgentConversationShellRegistration {
    if (this.disposed) throw new Error('Agent conversation shell registry is disposed')
    if (typeof factory !== 'function') throw new Error('Agent conversation shell source factory must be a function')
    const owner = ownerFromContext(ctx)
    const effect: PluginGenerationEffectIdentity = this.visibility?.effect(ctx) ?? Object.freeze({ pluginId: owner })
    if ([...this.records].some(record => record.owner === owner && record.version === version
      && record.effect.moduleGeneration === effect.moduleGeneration)) {
      throw new Error(`Agent conversation Shell v${version} source is already registered for ${owner}`)
    }
    const rawGeneration = effect.moduleGeneration ?? owner
    const record: RegisteredSource = {
      version,
      owner,
      ownerGeneration: encodedGeneration(rawGeneration),
      effect,
      factory,
      ...(principal === undefined ? {} : { principal }),
      sessions: new Set(),
      active: true,
    }
    this.records.add(record)
    const host = new BoundSourceHost(record, () => `binding-${this.nextBinding++}`)
    const mount: CordisXPageMount = markAgentConversationPageMount(mountContext => {
      if (!record.active || this.visibility?.visible(record.effect) === false) {
        throw new Error('Agent conversation shell source generation is unavailable')
      }
      const selected = mountContext.params.roomId
      const request: AgentConversationShellBindRequest = immutableSnapshot({
        requestId: `request-${this.nextRequest++}`,
        ownerGeneration: record.ownerGeneration,
        routeSelection: {
          scope: 'room-or-new',
          ...(typeof selected === 'string' && selected !== '' ? { selectedRoomParam: selected } : {}),
        },
      })
      let session: MountedConversation | undefined
      let mounted = true
      void host.bind(request).then(result => {
        if (!mounted || !record.active || result.status !== 'accepted') return
        session = new MountedConversation(
          record, result.binding, mountContext, this.commands, this.i18n, this.console,
          this.identity, this.scenarioSource, this.scenarioOwner,
        )
        record.sessions.add(session)
        session.start()
      }).catch(error => console.error('[cordisx] Agent conversation bind failed', error))
      return () => {
        mounted = false
        session?.dispose()
      }
    })
    let active = true
    return {
      mount,
      dispose: () => {
        if (!active) return
        active = false
        this.disposeRecord(record)
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    for (const record of [...this.records]) this.disposeRecord(record)
  }

  private disposeRecord(record: RegisteredSource): void {
    if (!record.active) return
    record.active = false
    this.records.delete(record)
    for (const session of [...record.sessions]) session.dispose()
  }
}

export interface CordisXAgentConversationShellServiceOptions {
  readonly registry?: AgentConversationShellRegistry
  readonly console?: PluginConsoleAspect
  readonly identity?: AgentConversationRendererProps['identity']
  readonly scenarioSource?: PlaygroundScenarioConversationSourceAuthority
  readonly scenarioOwner?: PlaygroundScenarioConversationOwnerResolver
}

/** Fiber-aware public service; the renderer and binding authority stay Host-owned. */
export class CordisXAgentConversationShellService extends Service implements CordisXAgentConversationShell {
  static readonly inject = ['commands', 'i18n']
  private readonly registry: AgentConversationShellRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, options: CordisXAgentConversationShellServiceOptions = {}) {
    super(ctx, 'agentConversationShell')
    this.console = options.console
    this.registry = options.registry ?? new AgentConversationShellRegistry(
      ctx.commands as CordisXCommandService,
      ctx.i18n as CordisXI18nService,
      generationVisibilityFromContext(ctx),
      options.console,
      options.identity,
      options.scenarioSource,
      options.scenarioOwner,
    )
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: Agent conversation shell registry')
  }

  registerSource(factory: CordisXAgentConversationShellSourceFactory | CordisXAgentConversationShellSourceFactoryV2 | CordisXAgentConversationShellSourceFactoryV3): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSource()')
    if (registration === undefined) throw new Error('Agent conversation shell source registration failed')
    return {
      mount: registration.mount,
      dispose: () => { dispose() },
    }
  }

  registerSourceV4(factory: CordisXAgentConversationShellSourceFactoryV4): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 4)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV4()')
    if (registration === undefined) throw new Error('Agent conversation Shell v4 source registration failed')
    return { mount: registration.mount, dispose: () => { dispose() } }
  }

  registerSourceV5(factory: CordisXAgentConversationShellSourceFactoryV5): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 5)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV5()')
    if (registration === undefined) throw new Error('Agent conversation Shell v5 source registration failed')
    return { mount: registration.mount, dispose: () => { dispose() } }
  }
}
