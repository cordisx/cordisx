/** Pure preference authority. The Host supplies atomic persistence and lifecycle fencing. */
export interface ManagementOverlayEntry {
  readonly id: string
  readonly blocked: boolean
  readonly pinRank?: number
}

export interface ManagementOverlay {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly revision: string
  readonly entries: readonly ManagementOverlayEntry[]
}

export interface ManagementOverlayData {
  readonly schemaVersion: 1
  readonly revision: number
  readonly overlays: readonly ManagementOverlay[]
}

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
const scopeKey = (bindingRef: string, scopeRevision: string): string => JSON.stringify([bindingRef, scopeRevision])
const freezeOverlay = (value: ManagementOverlay): ManagementOverlay =>
  Object.freeze({
    ...value,
    entries: Object.freeze(value.entries.map(entry => Object.freeze({ ...entry }))),
  })

export function parseManagementOverlayData(value: unknown): ManagementOverlayData {
  const input = object(value)
  exact(input, ['schemaVersion', 'revision', 'overlays'])
  if (
    input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0
    || !Array.isArray(input.overlays) || input.overlays.length > 512
  ) invalid()
  const seen = new Set<string>()
  const overlays = (input.overlays as unknown[]).map(value => {
    const item = object(value)
    exact(item, ['bindingRef', 'scopeRevision', 'revision', 'entries'])
    if (
      !text(item.bindingRef) || !text(item.scopeRevision) || !text(item.revision)
      || !Array.isArray(item.entries) || item.entries.length > 10_000
    ) invalid()
    const key = scopeKey(item.bindingRef as string, item.scopeRevision as string)
    if (seen.has(key)) invalid()
    seen.add(key)
    const ids = new Set<string>()
    const ranks = new Set<number>()
    const entries = (item.entries as unknown[]).map(value => {
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
      return {
        id: entry.id as string,
        blocked: entry.blocked as boolean,
        ...(entry.pinRank === undefined ? {} : { pinRank: Number(entry.pinRank) }),
      }
    })
    return freezeOverlay({
      bindingRef: item.bindingRef as string,
      scopeRevision: item.scopeRevision as string,
      revision: item.revision as string,
      entries,
    })
  })
  return Object.freeze({ schemaVersion: 1, revision: Number(input.revision), overlays: Object.freeze(overlays) })
}

export function serializeManagementOverlayData(data: ManagementOverlayData): string {
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
  private state: ManagementOverlayData
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly persist: (data: ManagementOverlayData) => Promise<void>, initial?: unknown) {
    this.state = parseManagementOverlayData(initial ?? { schemaVersion: 1, revision: 0, overlays: [] })
  }

  snapshot = (): ManagementOverlayData => this.state
  read(bindingRef: string, scopeRevision: string): ManagementOverlay {
    if (!text(bindingRef) || !text(scopeRevision)) invalid()
    return this.state.overlays.find(item => item.bindingRef === bindingRef && item.scopeRevision === scopeRevision)
      ?? freezeOverlay({ bindingRef, scopeRevision, revision: '0', entries: [] })
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
      const next = freezeOverlay({
        ...current,
        revision: String(revision),
        entries: [...entries.values()].filter(item => item.blocked || item.pinRank !== undefined)
          .sort((a, b) => order(a.id, b.id)),
      })
      const data = parseManagementOverlayData({
        schemaVersion: 1,
        revision,
        overlays: [
          ...this.state.overlays.filter(item =>
            item.bindingRef !== current.bindingRef || item.scopeRevision !== current.scopeRevision
          ),
          next,
        ],
      })
      try {
        await this.persist(data)
      } catch {
        throw new ManagementOverlayError('persist-failed')
      }
      this.state = data
      return next
    }
    const result = this.writes.then(execute)
    this.writes = result.catch(() => {})
    return result
  }
}
