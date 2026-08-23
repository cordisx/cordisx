import type { CordisXSlotComponent, CordisXSlotName, CordisXSlotOptions } from '../contracts.js'

export type SlotPlacement = 'append' | 'prepend' | 'before' | 'after'

/** One current Codex DOM anchor selected by the host adapter. */
export interface ResolvedSlotTarget {
  readonly anchor: Element
  readonly placement: SlotPlacement
}

/** Adapter probe for one semantic slot. */
export type SlotResolver = (document: Document) => ResolvedSlotTarget | undefined

interface MountedContribution {
  readonly abort: AbortController
  readonly container: HTMLElement
  readonly dispose?: () => void
}

interface ContributionRecord {
  readonly sequence: number
  readonly pluginId: string
  readonly options: CordisXSlotOptions
  readonly component: CordisXSlotComponent
  mounted: MountedContribution | undefined
}

/** Read-only manager view of one registered semantic-slot contribution. */
export interface SlotRegistrationSnapshot {
  readonly pluginId: string
  readonly slot: CordisXSlotName
  readonly id: string
  readonly order: number
  readonly priority: number
  readonly active: boolean
  readonly mounted: boolean
}

interface SlotState {
  outlet: HTMLElement | undefined
  target: ResolvedSlotTarget | undefined
}

function visible(element: Element): element is HTMLElement {
  if (!(element instanceof (element.ownerDocument.defaultView?.HTMLElement ?? HTMLElement))) return false
  return element.getClientRects().length > 0 || element.ownerDocument.defaultView === null
}

function firstVisible(document: Document, selectors: readonly string[]): HTMLElement | undefined {
  for (const selector of selectors) {
    const candidates = document.querySelectorAll(selector)
    for (const candidate of candidates) {
      if (visible(candidate)) return candidate
    }
  }
}

/** Default Codex DOM adapter. All version-sensitive probes live here. */
export function createDefaultSlotResolvers(): Record<CordisXSlotName, SlotResolver> {
  return {
    'header.actions': (document) => {
      const header = firstVisible(document, ['.app-header-tint', 'header'])
      if (header === undefined) return undefined
      const actions = firstVisible(header.ownerDocument, [
        '.app-header-tint [class*="ms-auto"][class*="flex"][class*="items-center"]',
        'header [class*="ms-auto"][class*="flex"][class*="items-center"]',
      ])
      return { anchor: actions ?? header, placement: 'append' }
    },
    'composer.before': (document) => {
      const editor = firstVisible(document, ['textarea', '[contenteditable="true"]'])
      const composer = editor?.closest('form') ?? editor?.parentElement
      return composer === null || composer === undefined
        ? undefined
        : { anchor: composer, placement: 'before' }
    },
    'composer.after': (document) => {
      const editor = firstVisible(document, ['textarea', '[contenteditable="true"]'])
      const composer = editor?.closest('form') ?? editor?.parentElement
      return composer === null || composer === undefined
        ? undefined
        : { anchor: composer, placement: 'after' }
    },
    'sidebar.footer': (document) => {
      const sidebar = firstVisible(document, ['nav[role="navigation"]', 'aside'])
      return sidebar === undefined ? undefined : { anchor: sidebar, placement: 'append' }
    },
    'shell.overlay': (document) => {
      const body = document.body
      return body === null ? undefined : { anchor: body, placement: 'append' }
    },
  }
}

/** Private host-adapter probe for the built-in manager trigger. */
export function resolveManagerTriggerTarget(document: Document): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
  for (const candidate of candidates) {
    if (!visible(candidate)) continue
    if (candidate.textContent?.trim() !== 'Codex') continue
    return candidate
  }
}

function sameTarget(left: ResolvedSlotTarget | undefined, right: ResolvedSlotTarget): boolean {
  return left?.anchor === right.anchor && left.placement === right.placement
}

function placeOutlet(outlet: HTMLElement, target: ResolvedSlotTarget): void {
  if (target.placement === 'append') target.anchor.append(outlet)
  if (target.placement === 'prepend') target.anchor.prepend(outlet)
  if (target.placement === 'before') target.anchor.before(outlet)
  if (target.placement === 'after') target.anchor.after(outlet)
}

/** DOM outlet manager with remount-on-anchor-replacement semantics. */
export class DomSlotRegistry {
  private readonly contributions = new Map<string, ContributionRecord>()
  private readonly states = new Map<CordisXSlotName, SlotState>()
  private readonly observer?: MutationObserver
  private scheduled = false
  private nextSequence = 0
  private disposed = false

  constructor(
    private readonly document: Document,
    private readonly resolvers: Record<CordisXSlotName, SlotResolver> = createDefaultSlotResolvers(),
  ) {
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer(() => this.schedule())
      const root = document.documentElement
      if (root !== null) this.observer.observe(root, { childList: true, subtree: true })
    }
  }

  /** Register a DSH-style list entry and return its idempotent disposer. */
  register(options: CordisXSlotOptions, component: CordisXSlotComponent, pluginId = 'unknown'): () => void {
    if (this.disposed) throw new Error('CordisX slot registry is disposed')
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.id)) {
      throw new Error(`invalid CordisX slot entry id: ${options.id}`)
    }
    const priority = options.priority ?? 0
    const key = `${options.name}\u0000${options.id}\u0000${priority}`
    if (this.contributions.has(key)) {
      throw new Error(
        `list slot ${JSON.stringify(options.name)} already has an entry with id ${JSON.stringify(options.id)} `
        + `at priority ${priority} — register at a different priority to shadow it (lowest renders)`,
      )
    }
    this.contributions.set(key, {
      sequence: this.nextSequence++,
      pluginId,
      options,
      component,
      mounted: undefined,
    })
    this.reconcileSlot(options.name)

    let active = true
    return () => {
      if (!active) return
      active = false
      const record = this.contributions.get(key)
      if (record === undefined) return
      this.unmount(record)
      this.contributions.delete(key)
      this.reconcileSlot(options.name)
    }
  }

  /** Snapshot registration ownership without exposing mutable registry state. */
  snapshot(): readonly SlotRegistrationSnapshot[] {
    const active = new Set<ContributionRecord>()
    for (const slot of Object.keys(this.resolvers) as CordisXSlotName[]) {
      for (const record of this.recordsFor(slot)) active.add(record)
    }
    return [...this.contributions.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(record => ({
        pluginId: record.pluginId,
        slot: record.options.name,
        id: record.options.id,
        order: record.options.order ?? 0,
        priority: record.options.priority ?? 0,
        active: active.has(record),
        mounted: record.mounted !== undefined,
      }))
  }

  /** Re-probe every semantic anchor. Useful for diagnostics and tests. */
  reconcile(): void {
    if (this.disposed) return
    for (const slot of Object.keys(this.resolvers) as CordisXSlotName[]) this.reconcileSlot(slot)
  }

  /** Dispose every contribution and observer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    for (const record of this.contributions.values()) this.unmount(record)
    this.contributions.clear()
    for (const state of this.states.values()) state.outlet?.remove()
    this.states.clear()
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.reconcile()
    })
  }

  private recordsFor(slot: CordisXSlotName): ContributionRecord[] {
    const sorted = [...this.contributions.values()]
      .filter(record => record.options.name === slot)
      .sort((left, right) => {
        const priority = (left.options.priority ?? 0) - (right.options.priority ?? 0)
        if (priority !== 0) return priority
        const order = (left.options.order ?? 0) - (right.options.order ?? 0)
        return order === 0 ? left.sequence - right.sequence : order
      })
    const ids = new Set<string>()
    return sorted
      .filter((record) => {
        if (ids.has(record.options.id)) return false
        ids.add(record.options.id)
        return true
      })
      .sort((left, right) => {
        const order = (left.options.order ?? 0) - (right.options.order ?? 0)
        return order === 0 ? left.sequence - right.sequence : order
      })
  }

  private reconcileSlot(slot: CordisXSlotName): void {
    if (this.disposed) return
    const records = this.recordsFor(slot)
    const winners = new Set(records)
    for (const record of this.contributions.values()) {
      if (record.options.name === slot && !winners.has(record)) this.unmount(record)
    }
    const state = this.states.get(slot) ?? { outlet: undefined, target: undefined }
    this.states.set(slot, state)

    if (records.length === 0) {
      state.outlet?.remove()
      state.outlet = undefined
      state.target = undefined
      return
    }

    const target = this.resolvers[slot](this.document)
    if (target === undefined || !target.anchor.isConnected) {
      for (const record of records) this.unmount(record)
      state.outlet?.remove()
      state.outlet = undefined
      state.target = undefined
      return
    }

    if (state.outlet === undefined || !state.outlet.isConnected || !sameTarget(state.target, target)) {
      for (const record of records) this.unmount(record)
      state.outlet?.remove()
      const outlet = this.document.createElement('div')
      outlet.dataset.cordisxOutlet = slot
      placeOutlet(outlet, target)
      state.outlet = outlet
      state.target = target
    }

    let cursor = state.outlet.firstChild
    for (const record of records) {
      if (record.mounted === undefined) this.mount(record, state.outlet)
      const container = record.mounted?.container
      if (container === undefined) continue
      if (container !== cursor) state.outlet.insertBefore(container, cursor)
      cursor = container.nextSibling
    }
  }

  private mount(record: ContributionRecord, outlet: HTMLElement): void {
    const container = this.document.createElement('div')
    container.dataset.cordisxContribution = record.options.id
    outlet.append(container)
    const abort = new AbortController()
    try {
      const dispose = record.component({
        container,
        document: this.document,
        signal: abort.signal,
        slot: record.options.name,
      })
      record.mounted = { abort, container, ...(dispose === undefined ? {} : { dispose }) }
    } catch (error) {
      container.dataset.cordisxError = 'true'
      container.textContent = `CordisX plugin ${record.options.id} failed to mount`
      console.error(`[cordisx] ${record.options.id} failed to mount`, error)
      record.mounted = { abort, container }
    }
  }

  private unmount(record: ContributionRecord): void {
    const mounted = record.mounted
    if (mounted === undefined) return
    record.mounted = undefined
    mounted.abort.abort()
    try {
      mounted.dispose?.()
    } catch (error) {
      console.error(`[cordisx] ${record.options.id} failed to dispose`, error)
    }
    mounted.container.remove()
  }
}
