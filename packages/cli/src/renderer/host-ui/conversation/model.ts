import type { CordisXIconToken, CordisXJsonValue } from '../../../contracts.js'
import { CORDISX_HOST_ICON_TOKENS } from '../../surfaces.js'
import { immutableSnapshot, LOCAL_ID_PATTERN, REFERENCE_PATTERN } from '../../validation.js'

export type AgentConversationParticipantRole = 'human' | 'agent' | 'system'
export type AgentConversationDeliveryState = 'pending' | 'sent' | 'delivered' | 'failed'
export type AgentConversationRunState = 'idle' | 'running' | 'stopped' | 'failed'
export type AgentConversationStatusState = 'info' | 'working' | 'warning' | 'error'

export interface AgentConversationCommandReference {
  readonly id: string
  readonly arguments?: CordisXJsonValue
}

export interface AgentConversationAction {
  readonly id: string
  readonly label: string
  readonly icon?: CordisXIconToken
  readonly command: AgentConversationCommandReference
  readonly disabled: boolean
  readonly disabledReason?: string
}

export interface AgentConversationParticipant {
  readonly id: string
  readonly role: AgentConversationParticipantRole
  readonly name: string
}

export interface AgentConversationMessage {
  readonly kind: 'message'
  readonly itemId: string
  readonly messageId: string
  readonly sequence: number
  readonly authorId: string
  readonly body: readonly string[]
  readonly timestamp: string
  readonly deliveryState: AgentConversationDeliveryState
  readonly runState: AgentConversationRunState
  readonly ariaLive: 'off' | 'polite'
  readonly actions: readonly AgentConversationAction[]
}

export interface AgentConversationStatus {
  readonly kind: 'status'
  readonly itemId: string
  readonly sequence: number
  readonly label: string
  readonly state: AgentConversationStatusState
  readonly ariaLive: 'off' | 'polite'
}

export type AgentConversationEntry = AgentConversationMessage | AgentConversationStatus

export type AgentConversationSelection =
  | { readonly kind: 'new-room'; readonly newRoomAction: AgentConversationAction }
  | {
      readonly kind: 'room'
      readonly roomId: string
      readonly title: string
      readonly secondary?: string
      readonly multiParticipant: boolean
      readonly participantPresentation: 'none' | 'host-initials'
      readonly participants: readonly AgentConversationParticipant[]
    }

export interface AgentConversationComposer {
  readonly availability: 'available' | 'unavailable'
  readonly placeholder: string
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly submit: AgentConversationCommandReference
}

export interface AgentConversationBindingReference {
  readonly bindingId: string
  readonly ownerGeneration: string
}

/**
 * Host-private, renderer-ready projection. It is intentionally not the wire
 * protocol: a formal adapter must localize and validate the public snapshot
 * before constructing this immutable model.
 */
export interface AgentConversationModel {
  readonly ownerId: string
  readonly shell: 'agent-desktop'
  readonly binding: AgentConversationBindingReference
  readonly generation: string
  readonly snapshotSequence: number
  readonly selection: AgentConversationSelection
  readonly entries: readonly AgentConversationEntry[]
  readonly composer: AgentConversationComposer
  readonly headerActions: readonly AgentConversationAction[]
}

const DELIVERY_STATES = new Set<AgentConversationDeliveryState>(['pending', 'sent', 'delivered', 'failed'])
const RUN_STATES = new Set<AgentConversationRunState>(['idle', 'running', 'stopped', 'failed'])
const STATUS_STATES = new Set<AgentConversationStatusState>(['info', 'working', 'warning', 'error'])
const HOST_ICONS = new Set<string>(CORDISX_HOST_ICON_TOKENS)

function assertKnownKeys(value: object, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function assertOpaque(value: string, label: string): void {
  if (!/^[A-Za-z0-9._~-]{1,512}$/u.test(value)) throw new Error(`${label} must be an opaque identifier`)
}

function assertText(value: string, label: string, maximum = 4_000): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} characters`)
  }
}

function assertCommand(command: AgentConversationCommandReference, label: string): void {
  assertKnownKeys(command, ['id', 'arguments'], label)
  if (!REFERENCE_PATTERN.test(command.id)) throw new Error(`${label}.id is invalid`)
  if (command.arguments !== undefined) immutableSnapshot(command.arguments)
}

function assertAction(action: AgentConversationAction, label: string): void {
  assertKnownKeys(action, ['id', 'label', 'icon', 'command', 'disabled', 'disabledReason'], label)
  if (!LOCAL_ID_PATTERN.test(action.id)) throw new Error(`${label}.id is invalid`)
  assertText(action.label, `${label}.label`, 400)
  if (action.icon !== undefined && !HOST_ICONS.has(action.icon)) throw new Error(`${label}.icon is not a closed Host icon`)
  if (typeof action.disabled !== 'boolean') throw new Error(`${label}.disabled must be boolean`)
  if (action.disabledReason !== undefined) assertText(action.disabledReason, `${label}.disabledReason`, 400)
  assertCommand(action.command, `${label}.command`)
}

function assertActions(actions: readonly AgentConversationAction[], label: string, maximum: number): void {
  if (actions.length > maximum) throw new Error(`${label} exceeds ${maximum} items`)
  const ids = new Set<string>()
  for (const [index, action] of actions.entries()) {
    assertAction(action, `${label}[${index}]`)
    if (ids.has(action.id)) throw new Error(`${label} has duplicate action ${action.id}`)
    ids.add(action.id)
  }
}

function assertSelection(selection: AgentConversationSelection): void {
  if (selection.kind === 'new-room') {
    assertKnownKeys(selection, ['kind', 'newRoomAction'], 'selection')
    if (selection.newRoomAction === undefined) throw new Error('new-room selection requires newRoomAction')
    assertAction(selection.newRoomAction, 'selection.newRoomAction')
    if (selection.newRoomAction.id !== 'new-room') throw new Error('newRoomAction must be the Host new-room action')
    if (selection.newRoomAction.disabled) throw new Error('newRoomAction must be executable')
    return
  }
  assertKnownKeys(selection, ['kind', 'roomId', 'title', 'secondary', 'multiParticipant', 'participantPresentation', 'participants'], 'selection')
  assertOpaque(selection.roomId, 'selection.roomId')
  assertText(selection.title, 'selection.title', 1_000)
  if (selection.secondary !== undefined) assertText(selection.secondary, 'selection.secondary', 1_000)
  if (!selection.multiParticipant && selection.participantPresentation !== 'none') {
    throw new Error('single-participant rooms cannot request participant initials')
  }
  if (selection.participants.length > 64) throw new Error('selection.participants exceeds 64 items')
  const participantIds = new Set<string>()
  for (const [index, participant] of selection.participants.entries()) {
    assertKnownKeys(participant, ['id', 'role', 'name'], `selection.participants[${index}]`)
    assertOpaque(participant.id, `selection.participants[${index}].id`)
    if (participantIds.has(participant.id)) throw new Error(`duplicate participant ${participant.id}`)
    participantIds.add(participant.id)
    if (!['human', 'agent', 'system'].includes(participant.role)) throw new Error(`selection.participants[${index}].role is invalid`)
    assertText(participant.name, `selection.participants[${index}].name`, 400)
  }
}

function assertEntries(entries: readonly AgentConversationEntry[], selection: AgentConversationSelection): void {
  if (entries.length > 500) throw new Error('entries exceeds 500 items')
  const entryIds = new Set<string>()
  let previousSequence = -1
  const participantIds = new Set(selection.kind === 'room' ? selection.participants.map(item => item.id) : [])
  for (const [index, entry] of entries.entries()) {
    assertKnownKeys(entry, entry.kind === 'message'
      ? ['kind', 'itemId', 'messageId', 'sequence', 'authorId', 'body', 'timestamp', 'deliveryState', 'runState', 'ariaLive', 'actions']
      : ['kind', 'itemId', 'sequence', 'label', 'state', 'ariaLive'], `entries[${index}]`)
    assertOpaque(entry.itemId, `entries[${index}].itemId`)
    if (entryIds.has(entry.itemId)) throw new Error(`duplicate entry ${entry.itemId}`)
    entryIds.add(entry.itemId)
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence) {
      throw new Error('entries must have strictly increasing safe integer sequences')
    }
    previousSequence = entry.sequence
    if (entry.kind === 'status') {
      assertText(entry.label, `entries[${index}].label`, 4_000)
      if (!STATUS_STATES.has(entry.state)) throw new Error(`entries[${index}].state is invalid`)
      continue
    }
    assertOpaque(entry.messageId, `entries[${index}].messageId`)
    assertOpaque(entry.authorId, `entries[${index}].authorId`)
    if (!participantIds.has(entry.authorId)) throw new Error(`entries[${index}] references an unknown participant`)
    if (entry.body.length === 0 || entry.body.length > 64) throw new Error(`entries[${index}].body must contain 1 to 64 blocks`)
    for (const [bodyIndex, body] of entry.body.entries()) assertText(body, `entries[${index}].body[${bodyIndex}]`, 32_000)
    if (!Number.isFinite(Date.parse(entry.timestamp))) throw new Error(`entries[${index}].timestamp is invalid`)
    if (!DELIVERY_STATES.has(entry.deliveryState)) throw new Error(`entries[${index}].deliveryState is invalid`)
    if (!RUN_STATES.has(entry.runState)) throw new Error(`entries[${index}].runState is invalid`)
    assertActions(entry.actions, `entries[${index}].actions`, 8)
  }
}

/** Validate, clone and deeply freeze one renderer projection. */
export function createAgentConversationModel(input: AgentConversationModel): AgentConversationModel {
  assertKnownKeys(input, ['ownerId', 'shell', 'binding', 'generation', 'snapshotSequence', 'selection', 'entries', 'composer', 'headerActions'], 'model')
  assertOpaque(input.ownerId, 'ownerId')
  if (input.shell !== 'agent-desktop') throw new Error('shell must be agent-desktop')
  assertKnownKeys(input.binding, ['bindingId', 'ownerGeneration'], 'binding')
  assertOpaque(input.binding.bindingId, 'binding.bindingId')
  assertOpaque(input.binding.ownerGeneration, 'binding.ownerGeneration')
  assertOpaque(input.generation, 'generation')
  if (!Number.isSafeInteger(input.snapshotSequence) || input.snapshotSequence < 0) {
    throw new Error('snapshotSequence must be a non-negative safe integer')
  }
  assertSelection(input.selection)
  assertEntries(input.entries, input.selection)
  assertActions(input.headerActions, 'headerActions', 12)
  if (input.selection.kind === 'new-room') {
    if (input.entries.length !== 0) throw new Error('new-room selection cannot contain timeline entries')
    if (input.headerActions.length !== 0) throw new Error('new-room selection forbids separate header actions')
  }
  assertKnownKeys(input.composer, ['availability', 'placeholder', 'disabled', 'disabledReason', 'submit'], 'composer')
  if (!['available', 'unavailable'].includes(input.composer.availability)) throw new Error('composer.availability is invalid')
  assertText(input.composer.placeholder, 'composer.placeholder', 1_000)
  if (typeof input.composer.disabled !== 'boolean') throw new Error('composer.disabled must be boolean')
  if (input.composer.disabledReason !== undefined) assertText(input.composer.disabledReason, 'composer.disabledReason', 1_000)
  assertCommand(input.composer.submit, 'composer.submit')
  return immutableSnapshot(input)
}

export function participantInitials(name: string): string {
  const segments = name.trim().split(/\s+/u).filter(Boolean)
  if (segments.length === 0) return '?'
  if (segments.length === 1) return [...segments[0]!].slice(0, 2).join('').toLocaleUpperCase()
  return `${[...segments[0]!][0] ?? ''}${[...segments.at(-1)!][0] ?? ''}`.toLocaleUpperCase()
}

export function participantFor(model: AgentConversationModel, participantId: string): AgentConversationParticipant | undefined {
  if (model.selection.kind !== 'room') return undefined
  return model.selection.participants.find(participant => participant.id === participantId)
}
