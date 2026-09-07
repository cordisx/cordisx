import type { AgentConversationShellSubscription } from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationItem as ProtocolItemV4,
  AgentConversationSelection as ProtocolSelectionV4,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type { AgentConversationShellSnapshot as AgentConversationShellSnapshotV5 } from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationItem as ProtocolItemV6,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationItem as ProtocolItemV7,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
} from '@cordisx/protocol/agent-conversation-shell/v11'
import {
  agentLoopHandle,
  assertAction,
  assertApprovalAgentBinding,
  assertCommand,
  assertDefinitionIdentity,
  assertDisabled,
  assertLocalizedText,
  assertParticipant,
  assertReactionValue,
  exactKeys,
  opaque,
  plainObject,
  safeSequence,
  sameAvatar,
  sameDefinitionIdentity,
  text,
} from './agent-conversation-shell-validation.js'

export function assertSelectionV4(value: unknown, label: string): asserts value is ProtocolSelectionV4 {
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
  if (typeof value.multiParticipant !== 'boolean') throw new Error(`${label}.multiParticipant is invalid`)
  if (value.participantPresentation !== 'none' && value.participantPresentation !== 'host-initials') {
    throw new Error(`${label}.participantPresentation is invalid`)
  }
  if (!value.multiParticipant && value.participantPresentation !== 'none') {
    throw new Error(`${label}.participantPresentation crosses room multiplicity`)
  }
  if (!Array.isArray(value.participants) || value.participants.length > 64) {
    throw new Error(`${label}.participants is invalid`)
  }
  const participants = new Set<string>()
  value.participants.forEach((participant, index) => {
    assertParticipant(participant, `${label}.participants[${index}]`)
    if (participants.has(participant.participantId)) throw new Error(`${label}.participants has a duplicate id`)
    participants.add(participant.participantId)
  })
  if (value.activeRuns === undefined) return
  if (!Array.isArray(value.activeRuns) || value.activeRuns.length > 64) {
    throw new Error(`${label}.activeRuns is invalid`)
  }
  const runs = new Set<string>()
  value.activeRuns.forEach((run, index) => {
    const site = `${label}.activeRuns[${index}]`
    plainObject(run, site)
    exactKeys(run, ['participantId', 'memberId', 'runId', 'sessionId', 'lifecycle', 'details'], site)
    opaque(run.participantId, `${site}.participantId`)
    opaque(run.memberId, `${site}.memberId`)
    opaque(run.runId, `${site}.runId`)
    opaque(run.sessionId, `${site}.sessionId`)
    if (!participants.has(run.participantId)) throw new Error(`${site} association is invalid`)
    plainObject(run.lifecycle, `${site}.lifecycle`)
    exactKeys(run.lifecycle, ['phase', 'updatedAt'], `${site}.lifecycle`)
    if (!['active', 'running', 'waiting', 'attention'].includes(run.lifecycle.phase as string)) {
      throw new Error(`${site}.lifecycle.phase is invalid`)
    }
    if (
      run.lifecycle.updatedAt !== undefined
      && (typeof run.lifecycle.updatedAt !== 'string' || !Number.isFinite(Date.parse(run.lifecycle.updatedAt)))
    ) throw new Error(`${site}.lifecycle.updatedAt is invalid`)
    if (run.details !== undefined) {
      plainObject(run.details, `${site}.details`)
      exactKeys(run.details, ['kind', 'ref'], `${site}.details`)
      if (run.details.kind !== 'host') throw new Error(`${site}.details.kind is invalid`)
      agentLoopHandle(run.details.ref, `${site}.details.ref`)
    }
    const key = JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])
    if (runs.has(key)) throw new Error(`${label}.activeRuns has a duplicate association`)
    runs.add(key)
  })
}

export function assertItemV4(
  value: unknown,
  label: string,
  allowPluginCommands = false,
  allowRoomUserMessages = false,
): asserts value is ProtocolItemV4 {
  plainObject(value, label)
  if (value.kind === 'status') {
    exactKeys(value, ['kind', 'itemId', 'sequence', 'label', 'state', 'ariaLive'], label)
    opaque(value.itemId, `${label}.itemId`)
    safeSequence(value.sequence, `${label}.sequence`)
    assertLocalizedText(value.label, `${label}.label`)
    if (
      !['info', 'working', 'warning', 'error'].includes(value.state as string)
      || !['off', 'polite'].includes(value.ariaLive as string)
    ) throw new Error(`${label} state is invalid`)
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
      'sessionId',
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
    opaque(value.sessionId, `${label}.sessionId`)
    if (
      !['inviting', 'creating', 'joined', 'ready', 'failed'].includes(value.state as string)
      || typeof value.retryable !== 'boolean'
    ) throw new Error(`${label} state is invalid`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (value.retry !== undefined) assertCommand(value.retry, `${label}.retry`)
    if (
      value.state !== 'failed' && value.retry !== undefined
      || value.state === 'failed' && !value.retryable && value.retry !== undefined
    ) throw new Error(`${label}.retry is invalid`)
    return
  }
  if (value.kind === 'approval') {
    exactKeys(value, [
      'kind',
      'itemId',
      'sequence',
      'participantId',
      'memberId',
      'runId',
      'sessionId',
      'agentGeneration',
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
    opaque(value.sessionId, `${label}.sessionId`)
    if (!Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1) {
      throw new Error(`${label}.agentGeneration is invalid`)
    }
    agentLoopHandle(value.approvalId, `${label}.approvalId`)
    if (
      !['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string)
      || !['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)
    ) throw new Error(`${label} state is invalid`)
    if (value.rationale !== undefined) assertLocalizedText(value.rationale, `${label}.rationale`)
    if (value.diagnostic !== undefined) assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    if (
      !Array.isArray(value.actions) || value.actions.length > 3
      || (value.state === 'pending' ? value.actions.length === 0 : value.actions.length !== 0)
    ) throw new Error(`${label}.actions are invalid`)
    const decisions = new Set<string>()
    value.actions.forEach((action, index) => {
      plainObject(action, `${label}.actions[${index}]`)
      exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
      if (
        !['approve', 'deny', 'cancel'].includes(action.decision as string) || decisions.has(action.decision as string)
      ) throw new Error(`${label}.actions are invalid`)
      decisions.add(action.decision as string)
      assertCommand(action.command, `${label}.actions[${index}].command`)
    })
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
  plainObject(value.source, `${label}.source`)
  if (value.source.kind === 'session-event') {
    exactKeys(value.source, ['kind', 'sessionId', 'eventSeq'], `${label}.source`)
    opaque(value.source.sessionId, `${label}.source.sessionId`)
    if (!Number.isSafeInteger(value.source.eventSeq) || (value.source.eventSeq as number) < 1) {
      throw new Error(`${label}.source.eventSeq is invalid`)
    }
  } else if (allowPluginCommands && value.source.kind === 'plugin-command') {
    exactKeys(value.source, [
      'kind',
      'roomId',
      'messageId',
      'sessionId',
      'participantId',
      'memberId',
      'runId',
      'operationId',
      'sequence',
    ], `${label}.source`)
    for (const key of ['roomId', 'messageId', 'sessionId', 'participantId', 'memberId', 'runId', 'operationId']) {
      opaque(value.source[key], `${label}.source.${key}`)
    }
    safeSequence(value.source.sequence, `${label}.source.sequence`)
    if (
      (value.source.sequence as number) < 1 || value.source.messageId !== value.messageId
      || value.source.participantId !== value.author.participantId || value.author.role !== 'agent'
    ) throw new Error(`${label} plugin command identity mismatch`)
  } else if (allowRoomUserMessages && value.source.kind === 'room-user-message') {
    exactKeys(value.source, ['kind', 'roomId', 'messageId', 'sequence'], `${label}.source`)
    opaque(value.source.roomId, `${label}.source.roomId`)
    opaque(value.source.messageId, `${label}.source.messageId`)
    safeSequence(value.source.sequence, `${label}.source.sequence`)
    if (value.source.messageId !== value.messageId || value.author.role !== 'human') {
      throw new Error(`${label} Room user message identity mismatch`)
    }
  } else if (value.source.kind === 'chatroom-acknowledgement') exactKeys(value.source, ['kind'], `${label}.source`)
  else throw new Error(`${label}.source.kind is invalid`)
  plainObject(value.semantic, `${label}.semantic`)
  if (value.semantic.purpose === 'conversation') {
    exactKeys(value.semantic, ['purpose', 'correlation'], `${label}.semantic`)
    if (value.semantic.correlation !== undefined) {
      plainObject(value.semantic.correlation, `${label}.semantic.correlation`)
      exactKeys(value.semantic.correlation, ['requestMessageId'], `${label}.semantic.correlation`)
      opaque(value.semantic.correlation.requestMessageId, `${label}.semantic.correlation.requestMessageId`)
    }
  } else if (value.semantic.purpose === 'member-self-introduction') {
    exactKeys(value.semantic, ['purpose', 'correlation', 'participantId', 'memberId', 'runId'], `${label}.semantic`)
    plainObject(value.semantic.correlation, `${label}.semantic.correlation`)
    exactKeys(value.semantic.correlation, ['sessionId', 'requestMessageId'], `${label}.semantic.correlation`)
    opaque(value.semantic.correlation.sessionId, `${label}.semantic.correlation.sessionId`)
    opaque(value.semantic.correlation.requestMessageId, `${label}.semantic.correlation.requestMessageId`)
    opaque(value.semantic.participantId, `${label}.semantic.participantId`)
    opaque(value.semantic.memberId, `${label}.semantic.memberId`)
    opaque(value.semantic.runId, `${label}.semantic.runId`)
  } else if (value.semantic.purpose === 'chatroom-acknowledgement') {
    exactKeys(value.semantic, ['purpose'], `${label}.semantic`)
  } else throw new Error(`${label}.semantic.purpose is invalid`)
  if (value.source.kind === 'chatroom-acknowledgement' !== (value.semantic.purpose === 'chatroom-acknowledgement')) {
    throw new Error(`${label}.source and semantic mismatch`)
  }
  if (
    (value.source.kind === 'plugin-command' || value.source.kind === 'room-user-message')
    && value.semantic.purpose !== 'conversation'
  ) {
    throw new Error(`${label} plugin command semantic mismatch`)
  }
  if (!Array.isArray(value.body) || value.body.length === 0 || value.body.length > 64) {
    throw new Error(`${label}.body is invalid`)
  }
  value.body.forEach((block, index) => {
    plainObject(block, `${label}.body[${index}]`)
    exactKeys(block, ['kind', 'text'], `${label}.body[${index}]`)
    if (block.kind !== 'text') throw new Error(`${label}.body is invalid`)
    assertLocalizedText(block.text, `${label}.body[${index}].text`)
  })
  if (
    typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || !['pending', 'sent', 'delivered', 'failed'].includes(value.deliveryState as string)
    || !['idle', 'running', 'stopped', 'failed'].includes(value.runState as string)
    || !['off', 'polite'].includes(value.ariaLive as string)
  ) throw new Error(`${label} presentation is invalid`)
  if (!Array.isArray(value.actions) || value.actions.length > 8) throw new Error(`${label}.actions is invalid`)
  value.actions.forEach((action, index) => assertAction(action, `${label}.actions[${index}]`))
  if (!Array.isArray(value.reactions) || value.reactions.length > 64) throw new Error(`${label}.reactions is invalid`)
  const reactionIds = new Set<string>()
  value.reactions.forEach((reaction, index) => {
    plainObject(reaction, `${label}.reactions[${index}]`)
    exactKeys(reaction, ['reactionId', 'actorParticipantId', 'value', 'state'], `${label}.reactions[${index}]`)
    opaque(reaction.reactionId, `${label}.reactions[${index}].reactionId`)
    opaque(reaction.actorParticipantId, `${label}.reactions[${index}].actorParticipantId`)
    assertReactionValue(reaction.value, `${label}.reactions[${index}].value`)
    if (
      reactionIds.has(reaction.reactionId) || !['pending', 'completed', 'failed'].includes(reaction.state as string)
    ) throw new Error(`${label}.reactions are invalid`)
    reactionIds.add(reaction.reactionId)
  })
}

export function assertItemV6(value: unknown, label: string): asserts value is ProtocolItemV6 {
  plainObject(value, label)
  if (value.kind !== 'approval') {
    assertItemV4(value, label)
    return
  }
  exactKeys(value, [
    'kind',
    'itemId',
    'sequence',
    'participantId',
    'memberId',
    'runId',
    'sessionId',
    'agentGeneration',
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
  opaque(value.sessionId, `${label}.sessionId`)
  agentLoopHandle(value.approvalId, `${label}.approvalId`)
  if (
    !['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string)
    || !['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)
  ) throw new Error(`${label} state is invalid`)
  if (value.rationale !== undefined) assertLocalizedText(value.rationale, `${label}.rationale`)
  if (!Array.isArray(value.actions) || value.actions.length > 3) throw new Error(`${label}.actions are invalid`)
  if (value.state === 'pending') {
    if (
      !Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1
      || value.actions.length === 0 || value.diagnostic !== undefined
    ) {
      throw new Error(`${label} pending approval is invalid`)
    }
  } else {
    if (
      value.agentGeneration !== undefined
      && (!Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1)
    ) {
      throw new Error(`${label}.agentGeneration is invalid`)
    }
    if (value.actions.length !== 0) throw new Error(`${label} terminal approval is invokable`)
    if (value.state === 'failed') assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    else if (value.diagnostic !== undefined) throw new Error(`${label}.diagnostic requires failed state`)
  }
  const decisions = new Set<string>()
  value.actions.forEach((action, index) => {
    plainObject(action, `${label}.actions[${index}]`)
    exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
    if (
      !['approve', 'deny', 'cancel'].includes(action.decision as string) || decisions.has(action.decision as string)
    ) throw new Error(`${label}.actions are invalid`)
    decisions.add(action.decision as string)
    assertCommand(action.command, `${label}.actions[${index}].command`)
  })
}

export function assertItemV7(
  value: unknown,
  label: string,
  allowPluginCommands = false,
  allowRoomUserMessages = false,
): asserts value is ProtocolItemV7 {
  plainObject(value, label)
  if (value.kind !== 'approval') {
    assertItemV4(value, label, allowPluginCommands, allowRoomUserMessages)
    return
  }
  exactKeys(value, [
    'kind',
    'itemId',
    'sequence',
    'participantId',
    'memberId',
    'runId',
    'sessionId',
    'agentGeneration',
    'approvalId',
    'approvalKind',
    'requester',
    'authority',
    'reason',
    'authorityBinding',
    'state',
    'actions',
    'diagnostic',
  ], label)
  opaque(value.itemId, `${label}.itemId`)
  safeSequence(value.sequence, `${label}.sequence`)
  opaque(value.participantId, `${label}.participantId`)
  opaque(value.memberId, `${label}.memberId`)
  opaque(value.runId, `${label}.runId`)
  opaque(value.sessionId, `${label}.sessionId`)
  opaque(value.approvalId, `${label}.approvalId`)
  if (
    !['command', 'file-change', 'external-action', 'other'].includes(value.approvalKind as string)
    || !['pending', 'approved', 'denied', 'cancelled', 'failed'].includes(value.state as string)
  ) throw new Error(`${label} state is invalid`)
  assertDefinitionIdentity(value.requester, `${label}.requester`)
  plainObject(value.authority, `${label}.authority`)
  exactKeys(value.authority, ['participantId', 'memberId', 'identity'], `${label}.authority`)
  opaque(value.authority.participantId, `${label}.authority.participantId`)
  opaque(value.authority.memberId, `${label}.authority.memberId`)
  assertDefinitionIdentity(value.authority.identity, `${label}.authority.identity`)
  plainObject(value.reason, `${label}.reason`)
  exactKeys(value.reason, ['kind', 'text'], `${label}.reason`)
  if (
    value.reason.kind !== 'plain-text' || typeof value.reason.text !== 'string' || value.reason.text.length < 1
    || value.reason.text.length > 10_000 || /[\u0000\u000B\u000C\u000E-\u001F\u007F]/u.test(value.reason.text)
  ) throw new Error(`${label}.reason is invalid`)
  if (!Array.isArray(value.actions)) throw new Error(`${label}.actions are invalid`)
  if (value.state === 'pending') {
    if (
      !Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1
      || value.diagnostic !== undefined
    ) throw new Error(`${label} pending approval is invalid`)
    assertApprovalAgentBinding(value.authorityBinding, `${label}.authorityBinding`)
    if (!sameDefinitionIdentity(value.authorityBinding.definition, value.authority.identity)) {
      throw new Error(`${label}.authorityBinding definition differs from authority`)
    }
    if (
      value.actions.length !== 2 || value.actions[0]?.decision !== 'approve' || value.actions[1]?.decision !== 'reject'
    ) throw new Error(`${label}.actions must be ordered approve/reject`)
  } else {
    if (
      value.agentGeneration !== undefined
      && (!Number.isSafeInteger(value.agentGeneration) || (value.agentGeneration as number) < 1)
    ) throw new Error(`${label}.agentGeneration is invalid`)
    if (value.authorityBinding !== undefined || value.actions.length !== 0) {
      throw new Error(`${label} terminal approval is invokable`)
    }
    if (value.state === 'failed') assertLocalizedText(value.diagnostic, `${label}.diagnostic`)
    else if (value.diagnostic !== undefined) throw new Error(`${label}.diagnostic requires failed state`)
  }
  value.actions.forEach((action, index) => {
    plainObject(action, `${label}.actions[${index}]`)
    exactKeys(action, ['decision', 'command'], `${label}.actions[${index}]`)
    if (!['approve', 'reject'].includes(action.decision as string)) {
      throw new Error(`${label}.actions[${index}].decision is invalid`)
    }
    assertCommand(action.command, `${label}.actions[${index}].command`)
  })
}

export function assertSnapshotV4(value: unknown): asserts value is AgentConversationShellSnapshotV4 {
  plainObject(value, 'v4 snapshot')
  exactKeys(
    value,
    ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'],
    'v4 snapshot',
  )
  plainObject(value.binding, 'v4 snapshot.binding')
  exactKeys(value.binding, ['bindingId', 'ownerGeneration'], 'v4 snapshot.binding')
  opaque(value.binding.bindingId, 'v4 snapshot.binding.bindingId')
  opaque(value.binding.ownerGeneration, 'v4 snapshot.binding.ownerGeneration')
  opaque(value.generation, 'v4 snapshot.generation')
  safeSequence(value.snapshotSequence, 'v4 snapshot.snapshotSequence')
  assertSelectionV4(value.selection, 'v4 snapshot.selection')
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('v4 snapshot.items is invalid')
  value.items.forEach((item, index) => assertItemV4(item, `v4 snapshot.items[${index}]`))
  if (value.items.some(item => item.sequence > (value.snapshotSequence as number))) {
    throw new Error('v4 snapshot item sequence exceeds watermark')
  }
  plainObject(value.composer, 'v4 snapshot.composer')
  exactKeys(value.composer, ['availability', 'placeholder', 'disabled', 'submit'], 'v4 snapshot.composer')
  if (!['available', 'unavailable'].includes(value.composer.availability as string)) {
    throw new Error('v4 snapshot composer is invalid')
  }
  assertLocalizedText(value.composer.placeholder, 'v4 snapshot.composer.placeholder')
  assertDisabled(value.composer.disabled, 'v4 snapshot.composer.disabled')
  assertCommand(value.composer.submit, 'v4 snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) {
    throw new Error('v4 snapshot.headerActions is invalid')
  }
  value.headerActions.forEach((action, index) => assertAction(action, `v4 snapshot.headerActions[${index}]`))
  if (value.selection.kind !== 'room') {
    if (
      value.items.some(item =>
        item.kind === 'approval' || item.kind === 'message' && item.semantic.purpose === 'member-self-introduction'
      )
    ) throw new Error('v4 no-room snapshot contains Room items')
    return
  }
  const participants = new Map(
    value.selection.participants.map(participant => [participant.participantId, participant]),
  )
  const runs = new Set(
    (value.selection.activeRuns ?? []).map(run =>
      JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])
    ),
  )
  for (const item of value.items) {
    if (item.kind === 'message') {
      const participant = participants.get(item.author.participantId)
      if (
        participant === undefined
        || participant.role !== item.author.role
        || JSON.stringify(participant.displayName) !== JSON.stringify(item.author.displayName)
        || !sameAvatar(participant.avatar, item.author.avatar)
        || JSON.stringify(participant.agentIdentity) !== JSON.stringify(item.author.agentIdentity)
      ) {
        throw new Error('v4 message author is not the exact Room participant')
      }
      if (item.source.kind === 'session-event' && item.semantic.purpose === 'member-self-introduction') {
        if (
          item.author.role !== 'agent' || item.author.agentIdentity === undefined
          || item.semantic.participantId !== item.author.participantId
          || item.semantic.correlation.sessionId !== item.source.sessionId
        ) throw new Error('v4 self-introduction association is invalid')
      }
    } else if (item.kind === 'approval') {
      if (!runs.has(JSON.stringify([item.participantId, item.memberId, item.runId, item.sessionId]))) {
        throw new Error('v4 approval does not match an active run')
      }
    }
  }
}

export function assertSnapshotV5(value: unknown): asserts value is AgentConversationShellSnapshotV5 {
  plainObject(value, 'v5 snapshot')
  exactKeys(
    value,
    ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'],
    'v5 snapshot',
  )
  plainObject(value.composer, 'v5 snapshot.composer')
  exactKeys(
    value.composer,
    ['availability', 'placeholder', 'disabled', 'shortcutPolicy', 'submit'],
    'v5 snapshot.composer',
  )
  if (value.composer.shortcutPolicy !== 'enter' && value.composer.shortcutPolicy !== 'mod-enter') {
    throw new Error('v5 snapshot.composer.shortcutPolicy is invalid')
  }
  const { shortcutPolicy: _shortcutPolicy, ...composerV4 } = value.composer
  assertSnapshotV4({ ...value, composer: composerV4 })
}

export function assertSnapshotV6(value: unknown): asserts value is AgentConversationShellSnapshotV6 {
  plainObject(value, 'v6 snapshot')
  exactKeys(
    value,
    ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'],
    'v6 snapshot',
  )
  plainObject(value.binding, 'v6 snapshot.binding')
  exactKeys(value.binding, ['bindingId', 'ownerGeneration'], 'v6 snapshot.binding')
  opaque(value.binding.bindingId, 'v6 snapshot.binding.bindingId')
  opaque(value.binding.ownerGeneration, 'v6 snapshot.binding.ownerGeneration')
  opaque(value.generation, 'v6 snapshot.generation')
  safeSequence(value.snapshotSequence, 'v6 snapshot.snapshotSequence')
  assertSelectionV4(value.selection, 'v6 snapshot.selection')
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('v6 snapshot.items is invalid')
  value.items.forEach((item, index) => assertItemV6(item, `v6 snapshot.items[${index}]`))
  if (value.items.some(item => item.sequence > (value.snapshotSequence as number))) {
    throw new Error('v6 snapshot item sequence exceeds watermark')
  }
  plainObject(value.composer, 'v6 snapshot.composer')
  exactKeys(
    value.composer,
    ['availability', 'placeholder', 'disabled', 'shortcutPolicy', 'submit'],
    'v6 snapshot.composer',
  )
  if (
    !['available', 'unavailable'].includes(value.composer.availability as string)
    || value.composer.shortcutPolicy !== 'enter' && value.composer.shortcutPolicy !== 'mod-enter'
  ) throw new Error('v6 snapshot composer is invalid')
  assertLocalizedText(value.composer.placeholder, 'v6 snapshot.composer.placeholder')
  assertDisabled(value.composer.disabled, 'v6 snapshot.composer.disabled')
  assertCommand(value.composer.submit, 'v6 snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) {
    throw new Error('v6 snapshot.headerActions is invalid')
  }
  value.headerActions.forEach((action, index) => assertAction(action, `v6 snapshot.headerActions[${index}]`))
  if (value.selection.kind !== 'room') {
    if (
      value.items.some(item =>
        item.kind === 'approval' || item.kind === 'message' && item.semantic.purpose === 'member-self-introduction'
      )
    ) throw new Error('v6 no-room snapshot contains Room items')
    return
  }
  const participants = new Map(
    value.selection.participants.map(participant => [participant.participantId, participant]),
  )
  const runs = new Set(
    (value.selection.activeRuns ?? []).map(run =>
      JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])
    ),
  )
  const approvals = new Set<string>()
  for (const item of value.items) {
    if (item.kind === 'message') {
      const participant = participants.get(item.author.participantId)
      if (
        participant === undefined || participant.role !== item.author.role
        || JSON.stringify(participant.displayName) !== JSON.stringify(item.author.displayName)
        || !sameAvatar(participant.avatar, item.author.avatar)
        || JSON.stringify(participant.agentIdentity) !== JSON.stringify(item.author.agentIdentity)
      ) throw new Error('v6 message author is not the exact Room participant')
      if (
        item.source.kind === 'session-event' && item.semantic.purpose === 'member-self-introduction'
        && (item.author.role !== 'agent' || item.author.agentIdentity === undefined
          || item.semantic.participantId !== item.author.participantId
          || item.semantic.correlation.sessionId !== item.source.sessionId)
      ) throw new Error('v6 self-introduction association is invalid')
    } else if (item.kind === 'approval') {
      if (!runs.has(JSON.stringify([item.participantId, item.memberId, item.runId, item.sessionId]))) {
        throw new Error('v6 approval does not match an active run')
      }
      const approval = JSON.stringify([item.sessionId, item.approvalId])
      if (approvals.has(approval)) throw new Error('v6 snapshot contains a duplicate Session approval')
      approvals.add(approval)
    }
  }
}

export function assertSnapshotV7(
  value: unknown,
  allowPluginCommands = false,
  allowRoomUserMessages = false,
): asserts value is AgentConversationShellSnapshotV7 {
  plainObject(value, 'v7 snapshot')
  exactKeys(
    value,
    ['binding', 'generation', 'snapshotSequence', 'selection', 'items', 'composer', 'headerActions'],
    'v7 snapshot',
  )
  plainObject(value.binding, 'v7 snapshot.binding')
  exactKeys(value.binding, ['bindingId', 'ownerGeneration'], 'v7 snapshot.binding')
  opaque(value.binding.bindingId, 'v7 snapshot.binding.bindingId')
  opaque(value.binding.ownerGeneration, 'v7 snapshot.binding.ownerGeneration')
  opaque(value.generation, 'v7 snapshot.generation')
  safeSequence(value.snapshotSequence, 'v7 snapshot.snapshotSequence')
  assertSelectionV4(value.selection, 'v7 snapshot.selection')
  if (!Array.isArray(value.items) || value.items.length > 500) throw new Error('v7 snapshot.items is invalid')
  value.items.forEach((item, index) =>
    assertItemV7(item, `v7 snapshot.items[${index}]`, allowPluginCommands, allowRoomUserMessages)
  )
  if (value.items.some(item => item.sequence > (value.snapshotSequence as number))) {
    throw new Error('v7 snapshot item sequence exceeds watermark')
  }
  plainObject(value.composer, 'v7 snapshot.composer')
  exactKeys(
    value.composer,
    ['availability', 'placeholder', 'disabled', 'shortcutPolicy', 'submit'],
    'v7 snapshot.composer',
  )
  if (
    !['available', 'unavailable'].includes(value.composer.availability as string)
    || value.composer.shortcutPolicy !== 'enter' && value.composer.shortcutPolicy !== 'mod-enter'
  ) throw new Error('v7 snapshot composer is invalid')
  assertLocalizedText(value.composer.placeholder, 'v7 snapshot.composer.placeholder')
  assertDisabled(value.composer.disabled, 'v7 snapshot.composer.disabled')
  assertCommand(value.composer.submit, 'v7 snapshot.composer.submit')
  if (!Array.isArray(value.headerActions) || value.headerActions.length > 12) {
    throw new Error('v7 snapshot.headerActions is invalid')
  }
  value.headerActions.forEach((action, index) => assertAction(action, `v7 snapshot.headerActions[${index}]`))
  if (value.selection.kind !== 'room') {
    if (
      value.items.some(item =>
        item.kind === 'approval'
        || item.kind === 'message'
          && (item.semantic.purpose === 'member-self-introduction'
            || (item.source.kind === 'plugin-command' || item.source.kind === 'room-user-message'))
      )
    ) throw new Error('v7 no-room snapshot contains Room items')
    return
  }
  const participants = new Map(
    value.selection.participants.map(participant => [participant.participantId, participant]),
  )
  const runs = new Set(
    (value.selection.activeRuns ?? []).map(run =>
      JSON.stringify([run.participantId, run.memberId, run.runId, run.sessionId])
    ),
  )
  const approvals = new Set<string>()
  for (const item of value.items) {
    if (item.kind === 'message') {
      if (
        (item.source.kind === 'plugin-command' || item.source.kind === 'room-user-message')
        && item.source.roomId !== value.selection.roomId
      ) {
        throw new Error('plugin command belongs to another Room')
      }
      const participant = participants.get(item.author.participantId)
      if (
        participant === undefined || participant.role !== item.author.role
        || JSON.stringify(participant.displayName) !== JSON.stringify(item.author.displayName)
        || !sameAvatar(participant.avatar, item.author.avatar)
        || JSON.stringify(participant.agentIdentity) !== JSON.stringify(item.author.agentIdentity)
      ) throw new Error('v7 message author is not the exact Room participant')
    } else if (item.kind === 'approval') {
      const requester = participants.get(item.participantId)
      const authority = participants.get(item.authority.participantId)
      if (
        requester?.role !== 'agent' || requester.agentIdentity === undefined
        || !sameDefinitionIdentity(requester.agentIdentity, item.requester)
      ) throw new Error('v7 approval requester is not the exact outer Agent participant')
      if (
        authority?.role !== 'agent' || authority.agentIdentity === undefined
        || !sameDefinitionIdentity(authority.agentIdentity, item.authority.identity)
      ) throw new Error('v7 approval authority is not the exact Agent participant')
      if (!runs.has(JSON.stringify([item.participantId, item.memberId, item.runId, item.sessionId]))) {
        throw new Error('v7 approval does not match the requester run')
      }
      if (
        item.state === 'pending'
        && !(value.selection.activeRuns ?? []).some(run =>
          run.participantId === item.authority.participantId
          && run.memberId === item.authority.memberId && run.sessionId === item.authorityBinding.sessionId
        )
      ) throw new Error('v7 pending approval does not match the live authority run')
      const approval = JSON.stringify([item.sessionId, item.approvalId])
      if (approvals.has(approval)) throw new Error('v7 snapshot contains a duplicate Session approval')
      approvals.add(approval)
    }
  }
}

export function sameBinding(
  left: { bindingId: string; ownerGeneration: string },
  right: { bindingId: string; ownerGeneration: string },
): boolean {
  return left.bindingId === right.bindingId && left.ownerGeneration === right.ownerGeneration
}

export function assertSubscription(value: unknown, label: string): asserts value is AgentConversationShellSubscription {
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
  if (value.afterSequence > value.snapshotSequence) {
    throw new Error(`${label}.afterSequence exceeds its snapshot watermark`)
  }
}

export function sameSubscription(
  left: AgentConversationShellSubscription,
  right: AgentConversationShellSubscription,
): boolean {
  return left.subscriptionId === right.subscriptionId
    && sameBinding(left.binding, right.binding)
    && left.generation === right.generation
    && left.afterSequence === right.afterSequence
    && left.snapshotSequence === right.snapshotSequence
}
