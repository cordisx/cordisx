import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type {
  ManagerCollectionAction,
  ManagerCollectionActionResultV1,
  ManagerCollectionDisplayText,
  ManagerCollectionItem,
  ManagerCollectionQueryV1,
  ManagerCollectionRegistrationHandleV1,
  ManagerCollectionRegistrationV1,
  ManagerCollectionRegistryV1,
  ManagerCollectionRouteReference,
  ManagerCollectionSnapshotV1,
  ManagerCollectionSourceV1,
  ManagerCollectionTextInputAction,
} from '@cordisx/protocol/manager-collection/v1'
import type { NavigationCollectionCommandAction } from '@cordisx/protocol/navigation-collection-actions/v1'
import type { CordisXCommandReference, CordisXLocalizedText } from '../contracts.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import { ICON_TOKEN_PATTERN, assertLocalId, assertLocalizedText, assertReference, immutableSnapshot } from './validation.js'
import { managerCollectionCodePointIncludes, normalizeManagerCollectionSearch } from './manager-collection-normalization.js'

const REGISTRATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json'
const QUERY_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-query.v1.schema.json'
const SNAPSHOT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json'
const RESULT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-action-result.v1.schema.json'
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,512}$/u
const PARAMETER_ID = /^[a-z][a-zA-Z0-9]*$/u
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

export type ManagerCollectionLoadState = 'unregistered' | 'loading' | 'ready' | 'error'

export interface ManagerCollectionDialogState {
  readonly kind: 'confirmation' | 'text-input'
  readonly tone: 'neutral' | 'danger'
  readonly itemId: string
  readonly actionId: string
  readonly title: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
  readonly confirmLabel: CordisXLocalizedText
  readonly input?: ManagerCollectionTextInputAction['input']
}

export interface ManagerCollectionFeedbackState {
  readonly id: number
  readonly tone: 'success' | 'error'
  readonly message: CordisXLocalizedText
}

export interface HostManagerCollectionSnapshot {
  readonly version: number
  readonly state: ManagerCollectionLoadState
  readonly registration?: ManagerCollectionRegistrationV1
  readonly source?: ManagerCollectionSnapshotV1
  readonly view?: string
  readonly search: string
  readonly busy?: Readonly<{ readonly itemId: string; readonly actionId: string }>
  readonly dialog?: ManagerCollectionDialogState
  readonly feedback?: ManagerCollectionFeedbackState
}

export interface HostManagerCollectionPageOptions {
  readonly document: Document
  readonly owner: string
  readonly routeId: string
  readonly pageId: string
  readonly resolveText: (value: CordisXLocalizedText, site: string) => string
  readonly clearTextSite: (site: string) => void
  readonly navigate: (reference: ManagerCollectionRouteReference) => Promise<void>
  readonly deepLink: (reference: ManagerCollectionRouteReference) => string
  readonly executeCommand: (
    actionId: string,
    reference: CordisXCommandReference,
    invocationKey: string,
  ) => Promise<unknown>
  readonly writeClipboard: (value: string) => Promise<void>
  readonly hostCopy: (key: ManagerCollectionHostCopyKey) => string
}

export type ManagerCollectionHostCopyKey =
  | 'cancel'
  | 'clear-feedback'
  | 'clear-search'
  | 'empty'
  | 'error-description'
  | 'error-title'
  | 'loading'
  | 'more-actions'
  | 'retry'
  | 'views'

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertDisplayText(value: ManagerCollectionDisplayText, label: string): void {
  assertManagerLocalizedText(value, label)
  if (typeof value.fallback !== 'string') throw new Error(`${label} requires fallback text`)
}

function assertManagerLocalizedText(value: CordisXLocalizedText, label: string): void {
  assertLocalizedText(value, label)
  if (value.fallback !== undefined && [...value.fallback].length > 4_000) throw new Error(`${label}.fallback is too long`)
  if (value.params !== undefined && Object.keys(value.params).length > 32) throw new Error(`${label}.params has too many entries`)
  for (const [key, item] of Object.entries(value.params ?? {})) {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`${label}.params.${key} is not finite`)
  }
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} is not finite`)
    return
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} contains a cycle`)
    if (value.length > 100) throw new Error(`${label} has too many entries`)
    seen.add(value)
    for (const [index, child] of value.entries()) assertJsonValue(child, `${label}.${index}`, seen)
    seen.delete(value)
    return
  }
  assertRecord(value, label)
  if (seen.has(value)) throw new Error(`${label} contains a cycle`)
  if (Object.keys(value).length > 100) throw new Error(`${label} has too many entries`)
  seen.add(value)
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${label}.${key}`, seen)
  seen.delete(value)
}

function assertDisabled(value: ManagerCollectionItem['disabled'], label: string): void {
  assertRecord(value, label)
  assertKeys(value, ['value', 'reason'], label)
  if (typeof value.value !== 'boolean') throw new Error(`${label}.value must be a boolean`)
  if (value.reason !== undefined) assertManagerLocalizedText(value.reason, `${label}.reason`)
}

function assertIcon(value: string | undefined, label: string, hostOnly = false): void {
  if (value === undefined) return
  if (!ICON_TOKEN_PATTERN.test(value)) throw new Error(`${label} is not a structured icon token`)
  if (hostOnly && (!(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(value) || !value.startsWith('host:'))) {
    throw new Error(`${label} requires a registered host icon token`)
  }
}

function assertFeedback(value: ManagerCollectionAction['feedback'], label: string): void {
  assertRecord(value, label)
  assertKeys(value, ['success', 'failure'], label)
  assertManagerLocalizedText(value.success, `${label}.success`)
  assertManagerLocalizedText(value.failure, `${label}.failure`)
}

function assertRoute(reference: ManagerCollectionRouteReference, label: string): void {
  assertRecord(reference, label)
  assertKeys(reference, ['id', 'params'], label)
  assertLocalId(reference.id, `${label}.id`)
  if (reference.params === undefined) return
  assertRecord(reference.params, `${label}.params`)
  if (Object.keys(reference.params).length > 32) throw new Error(`${label}.params has too many entries`)
  for (const [key, value] of Object.entries(reference.params)) {
    if (!PARAMETER_ID.test(key)) throw new Error(`${label}.params.${key} is invalid`)
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${label}.params.${key} is not scalar`)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label}.params.${key} is not finite`)
  }
}

function assertInputAction(action: ManagerCollectionTextInputAction, label: string): void {
  assertKeys(action, ['kind', 'id', 'label', 'ariaLabel', 'icon', 'placement', 'tone', 'pressed', 'disabled', 'command', 'input', 'feedback'], label)
  if (action.kind !== 'text-input-command' || action.tone !== 'neutral') throw new Error(`${label} has an invalid text-input action kind or tone`)
  assertRecord(action.command, `${label}.command`)
  assertKeys(action.command, ['id', 'arguments'], `${label}.command`)
  if (typeof action.command.id !== 'string') throw new Error(`${label}.command.id is required`)
  assertReference(action.command.id, `${label}.command.id`)
  if (action.command.arguments !== undefined) {
    assertRecord(action.command.arguments, `${label}.command.arguments`)
    if (Object.keys(action.command.arguments).length > 32) throw new Error(`${label}.command.arguments has too many entries`)
    for (const [key, value] of Object.entries(action.command.arguments)) assertJsonValue(value, `${label}.command.arguments.${key}`)
  }
  assertRecord(action.input, `${label}.input`)
  assertKeys(action.input, ['argument', 'title', 'description', 'label', 'placeholder', 'submitLabel', 'initialValue', 'minLength', 'maxLength', 'trim'], `${label}.input`)
  assertLocalId(action.input.argument, `${label}.input.argument`)
  if (Object.hasOwn(action.command.arguments ?? {}, action.input.argument)) throw new Error(`${label}.input.argument collides with an existing command argument`)
  assertDisplayText(action.input.title, `${label}.input.title`)
  if (action.input.description !== undefined) assertDisplayText(action.input.description, `${label}.input.description`)
  assertDisplayText(action.input.label, `${label}.input.label`)
  if (action.input.placeholder !== undefined) assertDisplayText(action.input.placeholder, `${label}.input.placeholder`)
  assertDisplayText(action.input.submitLabel, `${label}.input.submitLabel`)
  if (!Number.isInteger(action.input.minLength) || action.input.minLength < 0 || action.input.minLength > 4_000) throw new Error(`${label}.input.minLength is invalid`)
  if (!Number.isInteger(action.input.maxLength) || action.input.maxLength < 1 || action.input.maxLength > 4_000 || action.input.maxLength < action.input.minLength) throw new Error(`${label}.input.maxLength is invalid`)
  if (action.input.trim !== 'none' && action.input.trim !== 'both') throw new Error(`${label}.input.trim is invalid`)
  if (action.input.initialValue !== undefined && ([...action.input.initialValue].length > 4_000 || CONTROL_CHARACTER.test(action.input.initialValue))) {
    throw new Error(`${label}.input.initialValue is invalid`)
  }
}

function assertAction(action: ManagerCollectionAction, label: string): void {
  assertRecord(action, label)
  if (action.kind === 'text-input-command') assertInputAction(action, label)
  else if (action.kind === 'command') {
    assertKeys(action, ['kind', 'id', 'label', 'ariaLabel', 'icon', 'placement', 'tone', 'pressed', 'disabled', 'command', 'confirmation', 'feedback'], label)
    assertRecord(action.command, `${label}.command`)
    assertKeys(action.command, ['id', 'arguments'], `${label}.command`)
    if (typeof action.command.id !== 'string') throw new Error(`${label}.command.id is required`)
    assertReference(action.command.id, `${label}.command.id`)
    if (action.command.arguments !== undefined) assertJsonValue(action.command.arguments, `${label}.command.arguments`)
    if (action.tone === 'danger' && action.confirmation === undefined) throw new Error(`${label} requires confirmation for a danger command`)
    if (action.confirmation !== undefined) {
      assertRecord(action.confirmation, `${label}.confirmation`)
      assertKeys(action.confirmation, ['title', 'description', 'confirmLabel'], `${label}.confirmation`)
      assertManagerLocalizedText(action.confirmation.title, `${label}.confirmation.title`)
      assertManagerLocalizedText(action.confirmation.description, `${label}.confirmation.description`)
      assertManagerLocalizedText(action.confirmation.confirmLabel, `${label}.confirmation.confirmLabel`)
    }
  } else if (action.kind === 'copy-route-link') {
    assertKeys(action, ['kind', 'id', 'label', 'ariaLabel', 'icon', 'placement', 'tone', 'pressed', 'disabled', 'feedback'], label)
  } else if (action.kind === 'copy-text') {
    assertKeys(action, ['kind', 'id', 'label', 'ariaLabel', 'icon', 'placement', 'tone', 'pressed', 'disabled', 'text', 'feedback'], label)
    assertRecord(action.text, `${label}.text`)
    assertKeys(action.text, ['value'], `${label}.text`)
    if (typeof action.text.value !== 'string' || [...action.text.value].length < 1 || [...action.text.value].length > 4_096 || action.text.value.includes('\0')) {
      throw new Error(`${label}.text.value is invalid`)
    }
  } else throw new Error(`${label} has an unsupported action kind`)
  assertLocalId(action.id, `${label}.id`)
  assertManagerLocalizedText(action.label, `${label}.label`)
  if (action.ariaLabel !== undefined) assertManagerLocalizedText(action.ariaLabel, `${label}.ariaLabel`)
  assertIcon(action.icon, `${label}.icon`)
  if (action.placement !== 'direct' && action.placement !== 'overflow') throw new Error(`${label}.placement is invalid`)
  if (action.tone !== 'neutral' && action.tone !== 'danger') throw new Error(`${label}.tone is invalid`)
  if (typeof action.pressed !== 'boolean') throw new Error(`${label}.pressed must be a boolean`)
  assertDisabled(action.disabled, `${label}.disabled`)
  assertFeedback(action.feedback, `${label}.feedback`)
}

function assertRegistration(input: ManagerCollectionRegistrationV1): ManagerCollectionRegistrationV1 {
  assertRecord(input, 'manager collection registration')
  assertKeys(input, ['$schema', 'contract', 'schemaVersion', 'id', 'label', 'description', 'views', 'defaultView', 'search'], 'manager collection registration')
  if (input.$schema !== REGISTRATION_SCHEMA || input.contract !== 'cordisx.manager-collection-registration/v1' || input.schemaVersion !== 1) throw new Error('manager collection registration has an unsupported schema tuple')
  assertLocalId(input.id, 'manager collection registration id')
  assertDisplayText(input.label, 'manager collection registration label')
  assertDisplayText(input.description, 'manager collection registration description')
  if (!Array.isArray(input.views) || input.views.length < 1 || input.views.length > 8) throw new Error('manager collection registration views are invalid')
  const ids = new Set<string>()
  for (const [index, view] of input.views.entries()) {
    assertRecord(view, `manager collection view ${index}`)
    assertKeys(view, ['id', 'label', 'emptyTitle', 'emptyDescription'], `manager collection view ${index}`)
    assertLocalId(view.id, `manager collection view ${index} id`)
    if (ids.has(view.id)) throw new Error(`manager collection registration has duplicate view ${view.id}`)
    ids.add(view.id)
    assertDisplayText(view.label, `manager collection view ${index} label`)
    assertDisplayText(view.emptyTitle, `manager collection view ${index} emptyTitle`)
    assertDisplayText(view.emptyDescription, `manager collection view ${index} emptyDescription`)
  }
  if (!ids.has(input.defaultView)) throw new Error('manager collection defaultView must reference a declared view')
  assertRecord(input.search, 'manager collection search')
  assertKeys(input.search, ['fields', 'normalization', 'label', 'placeholder', 'noMatchTitle', 'noMatchDescription'], 'manager collection search')
  if (input.search.fields.length !== 2 || input.search.fields[0] !== 'title' || input.search.fields[1] !== 'summary' || input.search.normalization !== 'nfkc-casefold') throw new Error('manager collection search descriptor is invalid')
  assertDisplayText(input.search.label, 'manager collection search label')
  assertDisplayText(input.search.placeholder, 'manager collection search placeholder')
  assertDisplayText(input.search.noMatchTitle, 'manager collection search noMatchTitle')
  assertDisplayText(input.search.noMatchDescription, 'manager collection search noMatchDescription')
  return immutableSnapshot(input)
}

function assertSnapshot(input: ManagerCollectionSnapshotV1, query: ManagerCollectionQueryV1): ManagerCollectionSnapshotV1 {
  assertRecord(input, 'manager collection snapshot')
  assertKeys(input, ['$schema', 'contract', 'schemaVersion', 'collectionId', 'queryRevision', 'view', 'normalizedSearch', 'revision', 'items'], 'manager collection snapshot')
  if (input.$schema !== SNAPSHOT_SCHEMA || input.contract !== 'cordisx.manager-collection-snapshot/v1' || input.schemaVersion !== 1) throw new Error('manager collection snapshot has an unsupported schema tuple')
  if (input.collectionId !== query.collectionId || input.queryRevision !== query.queryRevision || input.view !== query.view || input.normalizedSearch !== query.search.normalized) throw new Error('manager collection snapshot query fence mismatch')
  if ([...input.normalizedSearch].length > 8_192 || CONTROL_CHARACTER.test(input.normalizedSearch)) throw new Error('manager collection snapshot normalizedSearch is invalid')
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('manager collection snapshot revision is invalid')
  if (!Array.isArray(input.items) || input.items.length > 1_000) throw new Error('manager collection snapshot items are invalid')
  const ids = new Set<string>()
  for (const [index, item] of input.items.entries()) {
    assertRecord(item, `manager collection item ${index}`)
    assertKeys(item, ['id', 'title', 'summary', 'leadingVisual', 'route', 'order', 'disabled', 'actions'], `manager collection item ${index}`)
    if (!OPAQUE_ID.test(item.id)) throw new Error(`manager collection item ${index} id is invalid`)
    if (ids.has(item.id)) throw new Error(`manager collection snapshot has duplicate item ${item.id}`)
    ids.add(item.id)
    assertDisplayText(item.title, `manager collection item ${index} title`)
    assertDisplayText(item.summary, `manager collection item ${index} summary`)
    assertRecord(item.leadingVisual, `manager collection item ${index} leadingVisual`)
    if (item.leadingVisual.kind === 'semantic-icon') {
      assertKeys(item.leadingVisual, ['kind', 'icon'], `manager collection item ${index} leadingVisual`)
      assertIcon(item.leadingVisual.icon, `manager collection item ${index} leadingVisual icon`, true)
    } else if (item.leadingVisual.kind === 'avatar') {
      assertKeys(item.leadingVisual, ['kind', 'avatar'], `manager collection item ${index} leadingVisual`)
      cloneAgentAvatarRef(item.leadingVisual.avatar)
    } else if (item.leadingVisual.kind === 'avatar-stack') {
      assertKeys(item.leadingVisual, ['kind', 'entries'], `manager collection item ${index} leadingVisual`)
      if (!Array.isArray(item.leadingVisual.entries) || item.leadingVisual.entries.length < 1 || item.leadingVisual.entries.length > 16) throw new Error(`manager collection item ${index} avatar stack is invalid`)
      const entryIds = new Set<string>()
      for (const [entryIndex, entry] of item.leadingVisual.entries.entries()) {
        assertRecord(entry, `manager collection item ${index} avatar ${entryIndex}`)
        assertKeys(entry, ['id', 'avatar'], `manager collection item ${index} avatar ${entryIndex}`)
        if (!OPAQUE_ID.test(entry.id) || entryIds.has(entry.id)) throw new Error(`manager collection item ${index} avatar ${entryIndex} id is invalid`)
        entryIds.add(entry.id)
        cloneAgentAvatarRef(entry.avatar)
      }
    } else throw new Error(`manager collection item ${index} leadingVisual kind is invalid`)
    assertRoute(item.route, `manager collection item ${index} route`)
    if (!Number.isSafeInteger(item.order) || item.order < -1_000_000_000 || item.order > 1_000_000_000) throw new Error(`manager collection item ${index} order is invalid`)
    assertDisabled(item.disabled, `manager collection item ${index} disabled`)
    if (!Array.isArray(item.actions) || item.actions.length > 8) throw new Error(`manager collection item ${index} actions are invalid`)
    const actionIds = new Set<string>()
    for (const [actionIndex, action] of item.actions.entries()) {
      assertAction(action, `manager collection item ${index} action ${actionIndex}`)
      if (actionIds.has(action.id)) throw new Error(`manager collection item ${index} has duplicate action ${action.id}`)
      actionIds.add(action.id)
    }
  }
  return immutableSnapshot(input)
}

function commandReference(action: NavigationCollectionCommandAction | ManagerCollectionTextInputAction, value?: string): CordisXCommandReference {
  if (action.kind === 'command') return action.command as CordisXCommandReference
  const base = action.command.arguments ?? {}
  return { id: action.command.id, arguments: { ...base, [action.input.argument]: value ?? '' } }
}

function validActionResult(input: unknown, collectionId: string, itemId: string, actionId: string): ManagerCollectionActionResultV1 {
  assertRecord(input, 'manager collection action result')
  assertKeys(input, ['$schema', 'contract', 'schemaVersion', 'collectionId', 'itemId', 'actionId', 'status', 'code', 'revision'], 'manager collection action result')
  if (input.$schema !== RESULT_SCHEMA || input.contract !== 'cordisx.manager-collection-action-result/v1' || input.schemaVersion !== 1) throw new Error('manager collection action result has an unsupported schema tuple')
  if (input.collectionId !== collectionId || input.itemId !== itemId || input.actionId !== actionId) throw new Error('manager collection action result identity mismatch')
  if (typeof input.code !== 'string') throw new Error('manager collection action result code is invalid')
  assertLocalId(input.code, 'manager collection action result code')
  if (!['applied', 'rejected', 'conflict', 'unavailable'].includes(String(input.status))) throw new Error('manager collection action result status is invalid')
  if (input.status === 'applied') {
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new Error('manager collection applied result revision is invalid')
  } else if (input.revision !== undefined) throw new Error('manager collection non-applied result cannot carry revision')
  return immutableSnapshot(input as unknown as ManagerCollectionActionResultV1)
}

export class HostManagerCollectionPageRegistry implements ManagerCollectionRegistryV1 {
  private registration?: ManagerCollectionRegistrationV1
  private source?: ManagerCollectionSourceV1
  private sourceDispose?: () => void
  private unsubscribeSource?: () => void
  private queryAbort?: AbortController
  private accepted?: ManagerCollectionSnapshotV1
  private view?: string
  private search = ''
  private state: ManagerCollectionLoadState = 'unregistered'
  private busy?: Readonly<{ readonly itemId: string; readonly actionId: string }>
  private dialog?: ManagerCollectionDialogState
  private feedback?: ManagerCollectionFeedbackState
  private feedbackSequence = 0
  private queryRevision = 0
  private version = 0
  private currentSnapshot: HostManagerCollectionSnapshot = Object.freeze({ version: 0, state: 'unregistered', search: '' })
  private readonly listeners = new Set<() => void>()
  private readonly localizationSites = new Set<string>()
  private disposed = false

  constructor(readonly options: HostManagerCollectionPageOptions) {}

  register(registration: ManagerCollectionRegistrationV1, source: ManagerCollectionSourceV1): ManagerCollectionRegistrationHandleV1 {
    if (this.disposed) throw new Error('manager collection page registry is disposed')
    if (this.registration !== undefined) throw new Error('manager collection page registry already has an active registration')
    if (source === null || typeof source !== 'object' || typeof source.snapshot !== 'function' || typeof source.subscribe !== 'function') throw new Error('manager collection source requires snapshot and subscribe functions')
    this.registration = assertRegistration(registration)
    const activeRegistration = this.registration
    this.source = source
    this.view = this.registration.defaultView
    this.search = ''
    this.state = 'loading'
    let sourceDisposed = false
    this.sourceDispose = () => {
      if (sourceDisposed) return
      sourceDisposed = true
      source.dispose?.()
    }
    try {
      const unsubscribe = source.subscribe(() => { void this.load() })
      if (typeof unsubscribe !== 'function') throw new Error('manager collection source subscribe must return an unsubscribe function')
      this.unsubscribeSource = unsubscribe
    } catch (error) {
      this.clearRegistration()
      throw error
    }
    this.publish()
    void this.load()
    let active = true
    return Object.freeze({
      dispose: () => {
        if (!active) return
        active = false
        if (this.registration !== activeRegistration) return
        this.clearRegistration()
      },
    })
  }

  snapshot(): HostManagerCollectionSnapshot { return this.currentSnapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  localized(value: CordisXLocalizedText, site: string): string {
    const qualifiedSite = `manager-collection:${this.options.pageId}:${site}`
    this.localizationSites.add(qualifiedSite)
    return this.options.resolveText(value, qualifiedSite)
  }

  setSearch(value: string): void {
    if (this.registration === undefined) return
    if (value === this.search) return
    this.search = value
    this.publish()
    void this.load()
  }

  setView(view: string): void {
    if (this.registration === undefined || this.view === view || !this.registration.views.some(candidate => candidate.id === view)) return
    this.view = view
    this.publish()
    void this.load()
  }

  retry(): void {
    if (this.registration !== undefined && !this.disposed) void this.load()
  }

  async open(itemId: string): Promise<void> {
    const item = this.item(itemId)
    if (item === undefined || item.disabled.value) return
    try {
      await this.options.navigate(item.route)
    } catch {
      if (!this.disposed && this.item(itemId) === item) {
        this.state = 'error'
        this.publish()
      }
    }
  }

  requestAction(itemId: string, actionId: string): void {
    const action = this.action(itemId, actionId)
    if (action === undefined || action.disabled.value || this.busy !== undefined) return
    if (action.kind === 'text-input-command') {
      this.dialog = Object.freeze({
        kind: 'text-input', tone: 'neutral', itemId, actionId,
        title: action.input.title,
        ...(action.input.description === undefined ? {} : { description: action.input.description }),
        confirmLabel: action.input.submitLabel,
        input: action.input,
      })
      this.publish()
      return
    }
    if (action.kind === 'command' && action.confirmation !== undefined) {
      this.dialog = Object.freeze({
        kind: 'confirmation', tone: action.tone, itemId, actionId,
        title: action.confirmation.title,
        description: action.confirmation.description,
        confirmLabel: action.confirmation.confirmLabel,
      })
      this.publish()
      return
    }
    void this.invoke(itemId, actionId)
  }

  cancelDialog(): void {
    if (this.dialog === undefined) return
    this.dialog = undefined
    this.publish()
  }

  submitDialog(value?: string): void {
    const dialog = this.dialog
    if (dialog === undefined) return
    this.dialog = undefined
    this.publish()
    void this.invoke(dialog.itemId, dialog.actionId, value)
  }

  clearFeedback(): void {
    if (this.feedback === undefined) return
    this.feedback = undefined
    this.publish()
  }

  localeChanged(): void { void this.load() }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearRegistration()
    this.listeners.clear()
  }

  private item(itemId: string): ManagerCollectionItem | undefined {
    return this.accepted?.items.find(item => item.id === itemId)
  }

  private action(itemId: string, actionId: string): ManagerCollectionAction | undefined {
    return this.item(itemId)?.actions.find(action => action.id === actionId)
  }

  private async invoke(itemId: string, actionId: string, inputValue?: string): Promise<void> {
    const registration = this.registration
    const source = this.source
    const item = this.item(itemId)
    const action = this.action(itemId, actionId)
    if (registration === undefined || source === undefined || item === undefined || action === undefined || item.disabled.value || action.disabled.value || this.busy !== undefined || this.disposed) return
    if (action.kind === 'text-input-command') {
      const value = action.input.trim === 'both' ? (inputValue ?? '').trim() : inputValue ?? ''
      if ([...value].length < action.input.minLength || [...value].length > action.input.maxLength || CONTROL_CHARACTER.test(value)) {
        this.failure(action)
        return
      }
      inputValue = value
    }
    const capturedRevision = this.accepted?.revision ?? -1
    this.busy = Object.freeze({ itemId, actionId })
    this.publish()
    try {
      if (this.registration !== registration || this.source !== source || this.action(itemId, actionId) === undefined) return
      if (action.kind === 'copy-text') {
        await this.options.writeClipboard(action.text.value)
        this.success(action)
        return
      }
      if (action.kind === 'copy-route-link') {
        await this.options.writeClipboard(this.options.deepLink(item.route))
        this.success(action)
        return
      }
      const result = validActionResult(
        await this.options.executeCommand(
          action.id,
          commandReference(action, inputValue),
          `manager-collection:${this.options.pageId}:${registration.id}:${item.id}:${action.id}`,
        ),
        registration.id,
        item.id,
        action.id,
      )
      if (result.status !== 'applied' || result.revision <= capturedRevision) {
        this.failure(action)
        return
      }
      if ((this.accepted?.revision ?? -1) < result.revision) {
        const refreshed = await this.load(result.revision)
        if (!refreshed) {
          this.failure(action)
          return
        }
      }
      this.success(action)
    } catch {
      if (!this.disposed && this.registration === registration && this.source === source) this.failure(action)
    } finally {
      if (!this.disposed && this.busy?.itemId === itemId && this.busy.actionId === actionId) {
        this.busy = undefined
        this.publish()
      }
    }
  }

  private success(action: ManagerCollectionAction): void {
    if (this.disposed) return
    this.feedback = Object.freeze({ id: ++this.feedbackSequence, tone: 'success', message: action.feedback.success })
    this.publish()
  }

  private failure(action: ManagerCollectionAction): void {
    if (this.disposed) return
    this.feedback = Object.freeze({ id: ++this.feedbackSequence, tone: 'error', message: action.feedback.failure })
    this.publish()
  }

  private async load(minimumRevision?: number): Promise<boolean> {
    const registration = this.registration
    const source = this.source
    const view = this.view
    if (this.disposed || registration === undefined || source === undefined || view === undefined) return false
    this.queryAbort?.abort()
    const abort = new AbortController()
    this.queryAbort = abort
    let normalized: string
    try {
      if (CONTROL_CHARACTER.test(this.search)) throw new Error('manager collection search input contains a control character')
      normalized = normalizeManagerCollectionSearch(this.search, {
        maximumInputCodePoints: 256,
        maximumOutputCodePoints: 8_192,
      })
    } catch {
      this.state = 'error'
      this.publish()
      return false
    }
    const queryRevision = ++this.queryRevision
    const query = Object.freeze({
      $schema: QUERY_SCHEMA,
      contract: 'cordisx.manager-collection-query/v1',
      schemaVersion: 1,
      collectionId: registration.id,
      queryRevision,
      view,
      search: Object.freeze({ input: this.search, normalized }),
    }) as ManagerCollectionQueryV1
    this.state = 'loading'
    this.publish()
    try {
      const candidate = await source.snapshot(query, abort.signal)
      if (abort.signal.aborted || this.disposed || this.registration !== registration || this.source !== source || this.queryAbort !== abort) return false
      const snapshot = assertSnapshot(candidate, query)
      if (this.accepted !== undefined && snapshot.revision < this.accepted.revision) throw new Error('manager collection snapshot revision moved backwards')
      if (minimumRevision !== undefined && snapshot.revision < minimumRevision) throw new Error('manager collection action result revision is not yet authoritative')
      const defensive = normalized === '' ? snapshot.items : snapshot.items.filter(item => {
        const title = normalizeManagerCollectionSearch(this.localized(item.title, `item:${item.id}:title`))
        const summary = normalizeManagerCollectionSearch(this.localized(item.summary, `item:${item.id}:summary`))
        return managerCollectionCodePointIncludes(title, normalized) || managerCollectionCodePointIncludes(summary, normalized)
      })
      this.clearLocalizationSites()
      this.accepted = Object.freeze({
        ...snapshot,
        items: Object.freeze([...defensive].sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))),
      })
      this.state = 'ready'
      this.publish()
      return true
    } catch {
      if (abort.signal.aborted || this.disposed || this.registration !== registration || this.source !== source || this.queryAbort !== abort) return false
      this.state = 'error'
      this.publish()
      return false
    }
  }

  private clearRegistration(): void {
    this.queryAbort?.abort()
    this.queryAbort = undefined
    try { this.unsubscribeSource?.() } catch {
      // Continue teardown even when a plugin-owned unsubscribe misbehaves.
    } finally {
      this.unsubscribeSource = undefined
      try { this.sourceDispose?.() } catch {
        // A plugin cleanup failure cannot retain a page-scoped Host binding.
      } finally { this.sourceDispose = undefined }
    }
    this.registration = undefined
    this.source = undefined
    this.accepted = undefined
    this.view = undefined
    this.search = ''
    this.state = 'unregistered'
    this.busy = undefined
    this.dialog = undefined
    this.feedback = undefined
    this.queryRevision = 0
    this.clearLocalizationSites()
    if (!this.disposed) this.publish()
  }

  private clearLocalizationSites(): void {
    for (const site of this.localizationSites) this.options.clearTextSite(site)
    this.localizationSites.clear()
  }

  private publish(): void {
    this.currentSnapshot = Object.freeze({
      version: ++this.version,
      state: this.state,
      ...(this.registration === undefined ? {} : { registration: this.registration }),
      ...(this.accepted === undefined ? {} : { source: this.accepted }),
      ...(this.view === undefined ? {} : { view: this.view }),
      search: this.search,
      ...(this.busy === undefined ? {} : { busy: this.busy }),
      ...(this.dialog === undefined ? {} : { dialog: this.dialog }),
      ...(this.feedback === undefined ? {} : { feedback: this.feedback }),
    })
    for (const listener of this.listeners) {
      try { listener() } catch {
        // One observer cannot prevent the Host from publishing the new state.
      }
    }
  }
}
