/** Pure preference authority. The profile owner supplies atomic persistence and lifecycle fencing. */
export interface ManagementPreferenceEntry {
  readonly id: string
  readonly blocked: boolean
  readonly pinRank?: number
}

export interface ManagementPreferenceBinding {
  readonly bindingRef: string
  readonly revision: string
  readonly entries: readonly ManagementPreferenceEntry[]
}

/** Versioned section embedded in the profile-owned managed catalog document. */
export interface ManagementPreferenceData {
  readonly schemaVersion: 2
  readonly revision: number
  readonly bindings: readonly ManagementPreferenceBinding[]
}

/** Command-scoped view. scopeRevision fences source writes but is not preference identity. */
export interface ManagementOverlay extends ManagementPreferenceBinding {
  readonly scopeRevision: string
}

export type ManagementOverlayData = ManagementPreferenceData
export type ManagementOverlayEntry = ManagementPreferenceEntry

export type ManagementOverlayMutation =
  & {
    readonly bindingRef: string
    readonly scopeRevision: string
    readonly expectedRevision: string
  }
  & (
    | {
      readonly operation: 'setOverlay'
      readonly modelId: string
      readonly blocked?: boolean
      readonly pinned?: boolean
    }
    | { readonly operation: 'resetOrder' | 'restoreBlocked' }
  )

export class ManagementOverlayError extends Error {
  constructor(readonly code: 'source-invalid' | 'conflict' | 'persist-failed' | 'unavailable') {
    super(code)
  }
}

export const emptyManagementPreferenceData = (): ManagementPreferenceData =>
  Object.freeze({ schemaVersion: 2, revision: 0, bindings: Object.freeze([]) })

const invalid = (): never => {
  throw new ManagementOverlayError('source-invalid')
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid()
}
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const revisionOrder = (value: string): number | undefined =>
  /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined
const freezeBinding = (value: ManagementPreferenceBinding): ManagementPreferenceBinding =>
  Object.freeze({
    ...value,
    entries: Object.freeze(value.entries.map(entry => Object.freeze({ ...entry }))),
  })
const overlayView = (binding: ManagementPreferenceBinding, scopeRevision: string): ManagementOverlay =>
  Object.freeze({ ...binding, scopeRevision })

function parseEntries(value: unknown): readonly ManagementPreferenceEntry[] {
  const values = Array.isArray(value) ? value : invalid()
  if (values.length > 10_000) invalid()
  const ids = new Set<string>()
  const ranks = new Set<number>()
  return Object.freeze(values.map((value: unknown) => {
    const entry = object(value)
    exact(entry, ['id', 'blocked', 'pinRank'])
    if (!text(entry.id) || typeof entry.blocked !== 'boolean' || ids.has(entry.id)) invalid()
    ids.add(entry.id as string)
    if (entry.pinRank !== undefined) {
      if (!Number.isSafeInteger(entry.pinRank) || Number(entry.pinRank) < 0 || ranks.has(Number(entry.pinRank))) {
        invalid()
      }
      ranks.add(Number(entry.pinRank))
    }
    return Object.freeze({
      id: entry.id as string,
      blocked: entry.blocked as boolean,
      ...(entry.pinRank === undefined ? {} : { pinRank: Number(entry.pinRank) }),
    })
  }))
}

function parseBinding(value: unknown, legacy = false): ManagementPreferenceBinding {
  const item = object(value)
  exact(item, legacy ? ['bindingRef', 'scopeRevision', 'revision', 'entries'] : ['bindingRef', 'revision', 'entries'])
  if (!text(item.bindingRef) || !text(item.revision) || legacy && !text(item.scopeRevision)) invalid()
  return freezeBinding({
    bindingRef: item.bindingRef as string,
    revision: item.revision as string,
    entries: parseEntries(item.entries),
  })
}

/** Accepts the legacy scope-keyed shape and migrates each binding's latest durable preference. */
export function parseManagementOverlayData(value: unknown): ManagementPreferenceData {
  const input = object(value)
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) invalid()
  if (input.schemaVersion === 2) {
    exact(input, ['schemaVersion', 'revision', 'bindings'])
    if (!Array.isArray(input.bindings) || input.bindings.length > 512) invalid()
    const seen = new Set<string>()
    const bindings = (input.bindings as unknown[]).map(value => {
      const binding = parseBinding(value)
      if (seen.has(binding.bindingRef)) invalid()
      seen.add(binding.bindingRef)
      return binding
    })
    return Object.freeze({ schemaVersion: 2, revision: Number(input.revision), bindings: Object.freeze(bindings) })
  }
  exact(input, ['schemaVersion', 'revision', 'overlays'])
  if (input.schemaVersion !== 1 || !Array.isArray(input.overlays) || input.overlays.length > 512) invalid()
  const latest = new Map<string, ManagementPreferenceBinding>()
  for (const value of input.overlays as unknown[]) {
    const binding = parseBinding(value, true)
    const prior = latest.get(binding.bindingRef)
    if (!prior) {
      latest.set(binding.bindingRef, binding)
      continue
    }
    const nextRevision = revisionOrder(binding.revision)
    const priorRevision = revisionOrder(prior.revision)
    if (nextRevision === undefined) return invalid()
    if (priorRevision === undefined) return invalid()
    if (nextRevision === priorRevision) return invalid()
    if (nextRevision > priorRevision) latest.set(binding.bindingRef, binding)
  }
  return Object.freeze({
    schemaVersion: 2,
    revision: Number(input.revision),
    bindings: Object.freeze([...latest.values()].sort((a, b) => order(a.bindingRef, b.bindingRef))),
  })
}

export function serializeManagementOverlayData(data: ManagementPreferenceData): string {
  return JSON.stringify(parseManagementOverlayData(data))
}

export interface OverlaySourceModel {
  readonly id: string
  readonly label: string
  readonly selectable?: boolean
}

/** No source mutation, member creation, identity normalization, or capability elevation. */
export function projectManagementOverlay<T extends OverlaySourceModel>(
  models: readonly T[],
  overlay: ManagementOverlay,
) {
  const entries = new Map(overlay.entries.map(entry => [entry.id, entry]))
  const ids = new Set(models.map(model => model.id))
  const active = [...models].sort((a, b) => {
    const left = entries.get(a.id)?.pinRank
    const right = entries.get(b.id)?.pinRank
    if (left !== undefined || right !== undefined) {
      if (left === undefined) return 1
      if (right === undefined) return -1
      if (left !== right) return left - right
    }
    return order(a.id, b.id)
  }).map(model => {
    const entry = entries.get(model.id)
    return Object.freeze({
      ...model,
      present: true,
      blocked: entry?.blocked ?? false,
      pinned: entry?.pinRank !== undefined,
      selectable: model.selectable === true && entry?.blocked !== true,
    })
  })
  const dormant = overlay.entries.filter(entry => !ids.has(entry.id))
    .sort((a, b) => (a.pinRank ?? Infinity) - (b.pinRank ?? Infinity) || order(a.id, b.id))
    .map(entry =>
      Object.freeze({
        id: entry.id,
        label: entry.id,
        present: false,
        selectable: false,
        blocked: entry.blocked,
        pinned: entry.pinRank !== undefined,
      })
    )
  return Object.freeze({ active: Object.freeze(active), dormant: Object.freeze(dormant) })
}

export class ManagementOverlayStore {
  private state: ManagementPreferenceData
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly persist: (data: ManagementPreferenceData, expectedRevision: number) => Promise<void>,
    initial?: unknown,
  ) {
    this.state = initial === undefined ? emptyManagementPreferenceData() : parseManagementOverlayData(initial)
  }

  snapshot = (): ManagementPreferenceData => this.state
  read(bindingRef: string, scopeRevision: string): ManagementOverlay {
    if (!text(bindingRef) || !text(scopeRevision)) invalid()
    const binding = this.state.bindings.find(item => item.bindingRef === bindingRef)
      ?? freezeBinding({ bindingRef, revision: '0', entries: [] })
    return overlayView(binding, scopeRevision)
  }

  mutate(input: ManagementOverlayMutation, currentModelIds: readonly string[]): Promise<ManagementOverlay> {
    const execute = async () => {
      const current = this.read(input.bindingRef, input.scopeRevision)
      if (current.revision !== input.expectedRevision) throw new ManagementOverlayError('conflict')
      const entries = new Map(current.entries.map(entry => [entry.id, { ...entry }]))
      if (input.operation === 'setOverlay') {
        if (
          !text(input.modelId) || (input.blocked === undefined && input.pinned === undefined)
          || input.blocked !== undefined && typeof input.blocked !== 'boolean'
          || input.pinned !== undefined && typeof input.pinned !== 'boolean'
        ) invalid()
        if (!currentModelIds.includes(input.modelId) && !entries.has(input.modelId)) {
          throw new ManagementOverlayError('unavailable')
        }
        const entry = entries.get(input.modelId) ?? { id: input.modelId, blocked: false }
        if (input.blocked !== undefined) entry.blocked = input.blocked
        if (input.pinned === false) delete entry.pinRank
        if (input.pinned === true && entry.pinRank === undefined) {
          const highest = Math.max(-1, ...[...entries.values()].map(item => item.pinRank ?? -1))
          if (!Number.isSafeInteger(highest + 1)) invalid()
          entry.pinRank = highest + 1
        }
        entries.set(entry.id, entry)
      } else if (input.operation === 'resetOrder') {
        for (const entry of entries.values()) delete entry.pinRank
      } else if (input.operation === 'restoreBlocked') {
        for (const entry of entries.values()) entry.blocked = false
      } else invalid()
      const revision = this.state.revision + 1
      if (!Number.isSafeInteger(revision)) invalid()
      const next = freezeBinding({
        bindingRef: current.bindingRef,
        revision: String(revision),
        entries: [...entries.values()].filter(item => item.blocked || item.pinRank !== undefined)
          .sort((a, b) => order(a.id, b.id)),
      })
      const data = parseManagementOverlayData({
        schemaVersion: 2,
        revision,
        bindings: [
          ...this.state.bindings.filter(item => item.bindingRef !== current.bindingRef),
          next,
        ],
      })
      try {
        await this.persist(data, this.state.revision)
      } catch {
        throw new ManagementOverlayError('persist-failed')
      }
      this.state = data
      return overlayView(next, input.scopeRevision)
    }
    const result = this.writes.then(execute)
    this.writes = result.catch(() => {})
    return result
  }
}
