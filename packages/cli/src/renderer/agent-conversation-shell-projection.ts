import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { LocalizedText } from '@cordisx/protocol/agent-conversation-shell/v1'
import type { AgentConversationShellSnapshot as AgentConversationShellSnapshotV4 } from '@cordisx/protocol/agent-conversation-shell/v4'
import type { AgentConversationShellSnapshot as AgentConversationShellSnapshotV5 } from '@cordisx/protocol/agent-conversation-shell/v5'
import type { AgentConversationShellSnapshot as AgentConversationShellSnapshotV6 } from '@cordisx/protocol/agent-conversation-shell/v6'
import type { AgentConversationShellSnapshot as AgentConversationShellSnapshotV7 } from '@cordisx/protocol/agent-conversation-shell/v10'
import type { CordisXJsonValue, CordisXLocalizedText } from '../contracts.js'
import type { AgentConversationRendererCopy } from './host-ui/conversation/AgentConversationRenderer.js'
import {
  type AgentConversationAction,
  type AgentConversationModel,
  createAgentConversationModel,
} from './host-ui/conversation/model.js'
import { immutableSnapshot } from './validation.js'
import {
  type AgentConversationShellSnapshot,
  assertSnapshot,
  type ProtocolAction,
  sameAvatar,
} from './agent-conversation-shell-validation.js'
import {
  assertSnapshotV4,
  assertSnapshotV5,
  assertSnapshotV6,
  assertSnapshotV7,
} from './agent-conversation-shell-validation-v4.js'

export function encodedGeneration(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length === 0 || bytes.length > 240) throw new Error('plugin owner generation is invalid')
  return `g-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function protocolMessage(message: LocalizedText): CordisXLocalizedText {
  return {
    key: message.key,
    fallback: message.fallback,
    ...(message.namespace === undefined ? {} : { namespace: message.namespace }),
  }
}

export interface ProjectionLocalization {
  resolve(message: LocalizedText, site: string): string
}

export function projectAction(
  action: ProtocolAction,
  localization: ProjectionLocalization,
  site: string,
): AgentConversationAction {
  return {
    id: action.id,
    label: localization.resolve(action.label, `${site}.label`),
    ...(action.icon === undefined ? {} : { icon: action.icon }),
    command: {
      id: action.command.id,
      ...(action.command.arguments === undefined ? {} : { arguments: action.command.arguments as CordisXJsonValue }),
    },
    disabled: action.disabled.value,
    ...(action.disabled.reason === undefined
      ? {}
      : { disabledReason: localization.resolve(action.disabled.reason, `${site}.disabled`) }),
  }
}

export function projectSnapshot(
  owner: string,
  snapshotInput: AgentConversationShellSnapshot,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshot(snapshot)
  const participants = snapshot.selection.kind === 'room'
    ? snapshot.selection.participants.map((participant, index) => ({
      id: participant.participantId,
      role: participant.role,
      name: localization.resolve(participant.displayName, `participants.${index}`),
      ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
      ...(participant.role !== 'agent' || participant.agentIdentity === undefined
        ? {}
        : { agentIdentity: participant.agentIdentity }),
    }))
    : []
  const participantById = new Map(
    snapshot.selection.kind === 'room'
      ? snapshot.selection.participants.map(participant => [participant.participantId, participant])
      : [],
  )
  const entries = snapshot.items.map((item, index) => {
    if (item.kind === 'status') {
      return {
        kind: 'status' as const,
        itemId: item.itemId,
        sequence: item.sequence,
        label: localization.resolve(item.label, `items.${index}.label`),
        state: item.state,
        ariaLive: item.ariaLive,
      }
    }
    if (item.kind === 'member-presence') {
      return {
        kind: 'member-presence' as const,
        itemId: item.itemId,
        sequence: item.sequence,
        participantId: item.participantId,
        memberId: item.memberId,
        runId: item.runId,
        state: item.state,
        retryable: item.retryable,
        ...(item.diagnostic === undefined
          ? {}
          : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
        ...(item.retry === undefined
          ? {}
          : {
            retry: {
              id: item.retry.id,
              ...(item.retry.arguments === undefined ? {} : { arguments: item.retry.arguments as CordisXJsonValue }),
            },
          }),
      }
    }
    if (item.kind === 'approval') {
      return {
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
        actions: item.actions.map(action => ({
          decision: action.decision,
          command: {
            id: action.command.id,
            ...(action.command.arguments === undefined
              ? {}
              : { arguments: action.command.arguments as CordisXJsonValue }),
          },
        })),
        ...(item.rationale === undefined
          ? {}
          : { rationale: localization.resolve(item.rationale, `items.${index}.rationale`) }),
        ...(item.diagnostic === undefined
          ? {}
          : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
      }
    }
    const declared = participantById.get(item.author.participantId)
    if (
      declared === undefined || declared.role !== item.author.role
      || JSON.stringify(declared.displayName) !== JSON.stringify(item.author.displayName)
      || !sameAvatar(declared.avatar, item.author.avatar)
      || JSON.stringify(declared.agentIdentity) !== JSON.stringify(item.author.agentIdentity)
    ) {
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
      actions: item.actions.map((action, actionIndex) =>
        projectAction(action, localization, `items.${index}.actions.${actionIndex}`)
      ),
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
          : {
            state: 'present' as const,
            text: localization.resolve(snapshot.selection.description.text, 'selection.description'),
          },
      }),
      ...(snapshot.selection.secondary === undefined
        ? {}
        : { secondary: localization.resolve(snapshot.selection.secondary, 'selection.secondary') }),
      multiParticipant: snapshot.selection.multiParticipant,
      participantPresentation: snapshot.selection.participantPresentation,
      participants,
      activeRuns: snapshot.selection.activeRuns ?? [],
    }
    headerActions = snapshot.headerActions.map((action, index) =>
      projectAction(action, localization, `headerActions.${index}`)
    )
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
        ...(snapshot.composer.submit.arguments === undefined
          ? {}
          : { arguments: snapshot.composer.submit.arguments as CordisXJsonValue }),
      },
    },
    headerActions,
  })
}

export function projectAgentConversationShellSnapshotVersioned(
  owner: string,
  snapshot:
    | AgentConversationShellSnapshotV4
    | AgentConversationShellSnapshotV5
    | AgentConversationShellSnapshotV6
    | AgentConversationShellSnapshotV7,
  localization: ProjectionLocalization,
  shortcutPolicy: 'enter' | 'mod-enter',
): AgentConversationModel {
  const participants = snapshot.selection.kind === 'room'
    ? snapshot.selection.participants.map((participant, index) => ({
      id: participant.participantId,
      role: participant.role,
      name: localization.resolve(participant.displayName, `participants.${index}`),
      ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
      ...(participant.role !== 'agent' || participant.agentIdentity === undefined
        ? {}
        : { agentIdentity: participant.agentIdentity }),
    }))
    : []
  const participantById = new Map(
    snapshot.selection.kind === 'room'
      ? snapshot.selection.participants.map(participant => [participant.participantId, participant])
      : [],
  )
  const entries = snapshot.items.map((item, index) => {
    if (item.kind === 'status') {
      return {
        kind: 'status' as const,
        itemId: item.itemId,
        sequence: item.sequence,
        label: localization.resolve(item.label, `items.${index}.label`),
        state: item.state,
        ariaLive: item.ariaLive,
      }
    }
    if (item.kind === 'member-presence') {
      return {
        kind: 'member-presence' as const,
        itemId: item.itemId,
        sequence: item.sequence,
        participantId: item.participantId,
        memberId: item.memberId,
        runId: item.runId,
        sessionId: item.sessionId,
        state: item.state,
        retryable: item.retryable,
        ...(item.diagnostic === undefined
          ? {}
          : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
        ...(item.retry === undefined
          ? {}
          : {
            retry: {
              id: item.retry.id,
              ...(item.retry.arguments === undefined ? {} : { arguments: item.retry.arguments as CordisXJsonValue }),
            },
          }),
      }
    }
    if (item.kind === 'approval') {
      if ('requester' in item) {
        return {
          kind: 'approval' as const,
          itemId: item.itemId,
          sequence: item.sequence,
          participantId: item.participantId,
          memberId: item.memberId,
          runId: item.runId,
          sessionId: item.sessionId,
          ...(item.agentGeneration === undefined ? {} : { agentGeneration: item.agentGeneration }),
          approvalId: item.approvalId,
          approvalKind: item.approvalKind,
          state: item.state,
          requester: item.requester,
          authority: item.authority,
          reason: item.reason,
          ...(item.authorityBinding === undefined ? {} : { authorityBinding: item.authorityBinding }),
          actions: item.actions.map(action => ({
            decision: action.decision,
            command: {
              id: action.command.id,
              ...(action.command.arguments === undefined
                ? {}
                : { arguments: action.command.arguments as CordisXJsonValue }),
            },
          })),
          ...(item.diagnostic === undefined
            ? {}
            : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
        }
      }
      return {
        kind: 'approval' as const,
        itemId: item.itemId,
        sequence: item.sequence,
        participantId: item.participantId,
        memberId: item.memberId,
        runId: item.runId,
        sessionId: item.sessionId,
        ...(item.agentGeneration === undefined ? {} : { agentGeneration: item.agentGeneration }),
        approvalId: item.approvalId,
        approvalKind: item.approvalKind,
        state: item.state,
        actions: item.actions.map(action => ({
          decision: action.decision,
          command: {
            id: action.command.id,
            ...(action.command.arguments === undefined
              ? {}
              : { arguments: action.command.arguments as CordisXJsonValue }),
          },
        })),
        ...(item.rationale === undefined
          ? {}
          : { rationale: localization.resolve(item.rationale, `items.${index}.rationale`) }),
        ...(item.diagnostic === undefined
          ? {}
          : { diagnostic: localization.resolve(item.diagnostic, `items.${index}.diagnostic`) }),
      }
    }
    const declared = participantById.get(item.author.participantId)
    if (
      declared === undefined
      || declared.role !== item.author.role
      || JSON.stringify(declared.displayName) !== JSON.stringify(item.author.displayName)
      || !sameAvatar(declared.avatar, item.author.avatar)
      || JSON.stringify(declared.agentIdentity) !== JSON.stringify(item.author.agentIdentity)
    ) {
      throw new Error(`v4 snapshot.items[${index}].author does not match the selected room participant`)
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
      actions: item.actions.map((action, actionIndex) =>
        projectAction(action, localization, `items.${index}.actions.${actionIndex}`)
      ),
      source: item.source,
      semantic: item.semantic,
      reactions: item.reactions.map(reaction => ({
        reactionId: reaction.reactionId,
        actorParticipantId: reaction.actorParticipantId,
        value: reaction.value,
        state: reaction.state,
      })),
    }
  })
  const selection: AgentConversationModel['selection'] = snapshot.selection.kind === 'no-room' ? { kind: 'no-room' } : {
    kind: 'room',
    roomId: snapshot.selection.roomId,
    title: localization.resolve(snapshot.selection.title, 'selection.title'),
    ...(snapshot.selection.description === undefined
      ? {}
      : {
        description: snapshot.selection.description.state === 'empty'
          ? { state: 'empty' as const }
          : {
            state: 'present' as const,
            text: localization.resolve(snapshot.selection.description.text, 'selection.description'),
          },
      }),
    ...(snapshot.selection.secondary === undefined
      ? {}
      : { secondary: localization.resolve(snapshot.selection.secondary, 'selection.secondary') }),
    multiParticipant: snapshot.selection.multiParticipant,
    participantPresentation: snapshot.selection.participantPresentation,
    participants,
    activeRuns: snapshot.selection.activeRuns ?? [],
  }
  if (snapshot.selection.kind === 'no-room' && (snapshot.items.length !== 0 || snapshot.headerActions.length !== 0)) {
    throw new Error('v4 no-room snapshot requires an empty timeline and no header actions')
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
      shortcutPolicy,
      ...(snapshot.composer.disabled.reason === undefined
        ? {}
        : { disabledReason: localization.resolve(snapshot.composer.disabled.reason, 'composer.disabled') }),
      submit: {
        id: snapshot.composer.submit.id,
        ...(snapshot.composer.submit.arguments === undefined
          ? {}
          : { arguments: snapshot.composer.submit.arguments as CordisXJsonValue }),
      },
    },
    headerActions: snapshot.headerActions.map((action, index) =>
      projectAction(action, localization, `headerActions.${index}`)
    ),
  })
}

export function projectAgentConversationShellSnapshotV4(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV4,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV4(snapshot)
  return projectAgentConversationShellSnapshotVersioned(owner, snapshot, localization, 'enter')
}

export function projectAgentConversationShellSnapshotV5(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV5,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV5(snapshot)
  return projectAgentConversationShellSnapshotVersioned(owner, snapshot, localization, snapshot.composer.shortcutPolicy)
}

export function projectAgentConversationShellSnapshotV6(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV6,
  localization: ProjectionLocalization,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV6(snapshot)
  return projectAgentConversationShellSnapshotVersioned(owner, snapshot, localization, snapshot.composer.shortcutPolicy)
}

export function projectAgentConversationShellSnapshotV7(
  owner: string,
  snapshotInput: AgentConversationShellSnapshotV7,
  localization: ProjectionLocalization,
  allowPluginCommands = false,
): AgentConversationModel {
  const snapshot = immutableSnapshot(snapshotInput)
  assertSnapshotV7(snapshot, allowPluginCommands)
  return projectAgentConversationShellSnapshotVersioned(owner, snapshot, localization, snapshot.composer.shortcutPolicy)
}

export function rendererCopy(locale: string): AgentConversationRendererCopy {
  const chinese = locale.toLowerCase().startsWith('zh')
  return chinese
    ? {
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
    }
    : {
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
