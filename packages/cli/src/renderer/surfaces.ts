import { Context, Service, type Effect } from '@deepseek-ai/cordis'
import {
  CORDISX_SURFACE_NAMES,
  type CordisXCommandReference,
  type CordisXContributionHandle,
  type CordisXContributionOptions,
  type CordisXDisabledState,
  type CordisXEnvironmentRow,
  type CordisXEnvironmentRowAction,
  type CordisXEnvironmentSection,
  type CordisXEnvironmentSectionAction,
  type CordisXIconToken,
  type CordisXNavigationItem,
  type CordisXSlots,
  type CordisXStructuredAction,
  type CordisXSurfaceMap,
  type CordisXSurfaceName,
  type CordisXToolbarItem,
  type CordisXWhen,
} from '../contracts.js'
import { ownerFromContext, qualifyOwnedId } from './ownership.js'
import {
  HostContextStore,
  ICON_TOKEN_PATTERN,
  assertWhenExpression,
  assertLocalId,
  assertLocalizedText,
  assertReference,
  evaluateWhen,
  immutableSnapshot,
  whenContextKeys,
  type CordisXContextValues,
} from './validation.js'

export const CORDISX_HOST_ICON_TOKENS = [
  'host:analytics',
  'host:back',
  'host:close',
  'host:error',
  'host:files',
  'host:history',
  'host:info',
  'host:layers',
  'host:more',
  'host:open',
  'host:refresh',
  'host:review',
  'host:settings',
  'host:success',
  'host:warning',
] as const satisfies readonly CordisXIconToken[]

interface SurfaceRecord {
  readonly sequence: number
  readonly owner: string
  readonly qualifiedId: string
  readonly options: CordisXContributionOptions
  item: unknown
  validationError?: string
  rendered: boolean
}

export interface SurfaceContributionSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly surface: string
  readonly group: string
  readonly order: number
  readonly item: unknown
  readonly visible: boolean
  readonly disabled: boolean
  readonly valid: boolean
  readonly pending: boolean
  readonly rendered: boolean
  readonly error?: string
}

export interface SurfaceResolvers {
  command(owner: string, reference: CordisXCommandReference): boolean
  route(owner: string, id: string): boolean
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function assertIcon(icon: CordisXIconToken | undefined, label: string): void {
  if (icon === undefined) return
  if (!ICON_TOKEN_PATTERN.test(icon)) throw new Error(`${label} has an invalid host icon token`)
  if (!(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) throw new Error(`${label} uses unknown host icon token ${icon}`)
}

function assertCommand(reference: CordisXCommandReference, label: string): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a command reference`)
  assertReference(reference.id, `${label} command id`)
  assertKeys(reference, ['id', 'arguments'], `${label} command`)
}

function assertAction(action: CordisXStructuredAction, label: string): void {
  assertLocalizedText(action.label, `${label} label`)
  if (action.ariaLabel !== undefined) assertLocalizedText(action.ariaLabel, `${label} ariaLabel`)
  assertIcon(action.icon, label)
  assertCommand(action.command, label)
}

function assertDisabled(disabled: CordisXDisabledState | undefined): void {
  if (disabled === undefined) return
  if (typeof disabled.value !== 'boolean') throw new Error('disabled.value must be a boolean')
  assertKeys(disabled, ['value', 'reason'], 'disabled')
  if (disabled.reason !== undefined) assertLocalizedText(disabled.reason, 'disabled reason')
}

function validateItem(surface: CordisXSurfaceName, item: unknown): unknown {
  const snapshot = immutableSnapshot(item)
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`surface ${surface} requires a structured object item`)
  }
  if (surface === 'sidebar.footer.before-control'
    || surface === 'sidebar.footer.after-control'
    || surface === 'sidebar.footer.menu'
    || surface === 'environment.panel.header-actions') {
    assertKeys(snapshot, ['label', 'ariaLabel', 'icon', 'command'], surface)
    assertAction(snapshot as CordisXStructuredAction, surface)
  } else if (surface === 'sidebar.navigation.items') {
    const navigation = snapshot as CordisXNavigationItem
    assertKeys(snapshot, ['label', 'description', 'icon', 'command', 'route', 'actions'], 'navigation item')
    assertLocalizedText(navigation.label, 'navigation label')
    if (navigation.description !== undefined) assertLocalizedText(navigation.description, 'navigation description')
    assertIcon(navigation.icon, 'navigation item')
    if (navigation.command === undefined && navigation.route === undefined) {
      throw new Error('navigation item requires a command or route')
    }
    if (navigation.command !== undefined) assertCommand(navigation.command, 'navigation item')
    if (navigation.route !== undefined) {
      assertKeys(navigation.route, ['id', 'params'], 'navigation route')
      assertReference(navigation.route.id, 'navigation route id')
    }
    for (const action of navigation.actions ?? []) {
      assertKeys(action, ['id', 'label', 'ariaLabel', 'icon', 'command', 'when', 'disabled'], 'navigation action')
      assertLocalId(action.id, 'navigation action id')
      assertAction(action, 'navigation action')
      assertWhenExpression(action.when)
      assertDisabled(action.disabled)
    }
  } else if (surface === 'workspace.toolbar.items') {
    const toolbar = snapshot as CordisXToolbarItem
    assertKeys(snapshot, ['label', 'ariaLabel', 'icon', 'command', 'anchor', 'placement'], 'toolbar item')
    assertAction(toolbar, 'toolbar item')
    assertLocalId(toolbar.anchor, 'toolbar anchor')
    if (!['before', 'after', 'menu'].includes(toolbar.placement)) throw new Error('toolbar placement is invalid')
  } else if (surface === 'environment.panel.sections') {
    const section = snapshot as CordisXEnvironmentSection
    assertKeys(snapshot, ['sectionId', 'title', 'description', 'icon'], 'environment section')
    assertLocalId(section.sectionId, 'environment section id')
    assertLocalizedText(section.title, 'environment section title')
    if (section.description !== undefined) assertLocalizedText(section.description, 'environment section description')
    assertIcon(section.icon, 'environment section')
  } else if (surface === 'environment.section.actions') {
    const action = snapshot as CordisXEnvironmentSectionAction
    assertKeys(snapshot, ['sectionId', 'label', 'ariaLabel', 'icon', 'command'], 'environment section action')
    assertReference(action.sectionId, 'environment section target')
    assertAction(action, 'environment section action')
  } else if (surface === 'environment.section.rows') {
    const row = snapshot as CordisXEnvironmentRow
    assertKeys(snapshot, ['sectionId', 'rowId', 'label', 'value', 'description', 'status'], 'environment row')
    assertReference(row.sectionId, 'environment row section target')
    assertLocalId(row.rowId, 'environment row id')
    assertLocalizedText(row.label, 'environment row label')
    if (row.description !== undefined) assertLocalizedText(row.description, 'environment row description')
    if (row.value !== undefined && typeof row.value === 'object') assertLocalizedText(row.value, 'environment row value')
    assertIcon(row.status, 'environment row status')
  } else {
    const action = snapshot as CordisXEnvironmentRowAction
    assertKeys(snapshot, ['rowId', 'label', 'ariaLabel', 'icon', 'command'], 'environment row action')
    assertReference(action.rowId, 'environment row target')
    assertAction(action, 'environment row action')
  }
  return snapshot
}

export class SurfaceRegistry {
  private readonly records = new Map<string, SurfaceRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly declared = new Set<string>(CORDISX_SURFACE_NAMES)
  private readonly toolbarAnchors = new Set<string>()
  private nextSequence = 0
  private disposed = false
  private resolvers: SurfaceResolvers = { command: () => false, route: () => false }

  constructor(private readonly contexts: HostContextStore) {}

  setResolvers(resolvers: SurfaceResolvers): void {
    this.resolvers = resolvers
    this.notify()
  }

  declareSurface(name: string): () => void {
    if (this.declared.has(name)) throw new Error(`surface ${name} is already declared`)
    this.declared.add(name)
    this.notify()
    return () => {
      this.declared.delete(name)
      this.notify()
    }
  }

  setToolbarAnchors(anchors: readonly string[]): void {
    const next = new Set(anchors)
    if (next.size === this.toolbarAnchors.size && [...next].every(anchor => this.toolbarAnchors.has(anchor))) return
    this.toolbarAnchors.clear()
    for (const anchor of next) this.toolbarAnchors.add(anchor)
    this.notify()
  }

  isDeclared(name: string): boolean {
    return this.declared.has(name)
  }

  register<Name extends CordisXSurfaceName>(
    owner: string,
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    if (this.disposed) throw new Error('CordisX surface registry is disposed')
    assertLocalId(owner, 'surface owner')
    assertKeys(options, ['name', 'id', 'group', 'order', 'when', 'disabled'], 'surface contribution options')
    assertLocalId(options.id, 'surface contribution id')
    assertLocalId(options.group ?? 'default', 'surface contribution group')
    assertWhenExpression(options.when)
    assertDisabled(options.disabled)
    const qualifiedId = qualifyOwnedId(owner, options.id)
    const key = `${options.name}\u0000${qualifiedId}`
    if (this.records.has(key)) throw new Error(`surface contribution ${options.name}/${qualifiedId} is already registered`)
    let snapshot: unknown
    let validationError: string | undefined
    try {
      snapshot = validateItem(options.name, item)
    } catch (error) {
      snapshot = undefined
      validationError = error instanceof Error ? error.message : String(error)
    }
    const record: SurfaceRecord = {
      sequence: this.nextSequence++,
      owner,
      qualifiedId,
      options: immutableSnapshot(options),
      item: snapshot,
      ...(validationError === undefined ? {} : { validationError }),
      rendered: false,
    }
    this.records.set(key, record)
    this.notify()
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.records.delete(key)
      this.notify()
    }
    const handle = dispose as CordisXContributionHandle<CordisXSurfaceMap[Name]>
    handle.dispose = dispose
    handle.update = (next): void => {
      if (!active) throw new Error(`surface contribution ${qualifiedId} is disposed`)
      try {
        record.item = validateItem(options.name, next)
        delete record.validationError
      } catch (error) {
        record.item = undefined
        record.validationError = error instanceof Error ? error.message : String(error)
      }
      this.notify()
    }
    return handle
  }

  markRendered(surface: string, qualifiedId: string, rendered: boolean): void {
    const record = this.records.get(`${surface}\u0000${qualifiedId}`)
    if (record === undefined || record.rendered === rendered) return
    record.rendered = rendered
    this.notify()
  }

  snapshot(): readonly SurfaceContributionSnapshot[] {
    const contexts = this.contexts.getSnapshot()
    const knownKeys = new Set(Object.keys(contexts))
    const sections = new Set<string>()
    const rows = new Set<string>()
    for (const record of this.records.values()) {
      if (record.options.name === 'environment.panel.sections' && record.item !== undefined) {
        sections.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentSection).sectionId))
      }
      if (record.options.name === 'environment.section.rows' && record.item !== undefined) {
        rows.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentRow).rowId))
      }
    }
    return [...this.records.values()]
      .sort((left, right) => {
        return (left.options.group ?? 'default').localeCompare(right.options.group ?? 'default')
          || (left.options.order ?? 0) - (right.options.order ?? 0)
          || left.qualifiedId.localeCompare(right.qualifiedId)
          || left.sequence - right.sequence
      })
      .map((record) => {
        let error = record.validationError
        let pending = false
        const item = record.item as Record<string, unknown> | undefined
        if (error === undefined && !this.declared.has(record.options.name)) error = `surface ${record.options.name} is not declared by the host`
        const unknownWhen = whenContextKeys(record.options.when).find(key => !knownKeys.has(key))
        if (error === undefined && unknownWhen !== undefined) error = `when context key ${unknownWhen} is not declared by the host`
        if (error === undefined && item !== undefined) {
          const command = item.command as CordisXCommandReference | undefined
          const route = item.route as { id: string } | undefined
          if (command !== undefined && !this.resolvers.command(record.owner, command)) error = `command ${command.id} is not available`
          else if (command === undefined && route !== undefined && !this.resolvers.route(record.owner, route.id)) error = `route ${route.id} is not available`
          const actions = item.actions as readonly { command: CordisXCommandReference }[] | undefined
          const missingAction = actions?.find(action => !this.resolvers.command(record.owner, action.command))
          if (error === undefined && missingAction !== undefined) error = `command ${missingAction.command.id} is not available`
          const actionWithUnknownWhen = (item.actions as readonly { when?: CordisXWhen }[] | undefined)
            ?.find(action => whenContextKeys(action.when).some(key => !knownKeys.has(key)))
          const unknownActionKey = actionWithUnknownWhen === undefined
            ? undefined
            : whenContextKeys(actionWithUnknownWhen.when).find(key => !knownKeys.has(key))
          if (error === undefined && unknownActionKey !== undefined) error = `when context key ${unknownActionKey} is not declared by the host`
          if (record.options.name === 'workspace.toolbar.items') {
            const anchor = (item as unknown as CordisXToolbarItem).anchor
            if (!this.toolbarAnchors.has(anchor)) pending = true
          }
          if (record.options.name === 'environment.section.actions' || record.options.name === 'environment.section.rows') {
            const target = qualifyOwnedId(record.owner, String(item.sectionId))
            if (!sections.has(target)) pending = true
          }
          if (record.options.name === 'environment.row.trailing-actions') {
            const target = qualifyOwnedId(record.owner, String(item.rowId))
            if (!rows.has(target)) pending = true
          }
        }
        return {
          owner: record.owner,
          id: record.options.id,
          qualifiedId: record.qualifiedId,
          surface: record.options.name,
          group: record.options.group ?? 'default',
          order: record.options.order ?? 0,
          item: record.item,
          visible: error === undefined && evaluateWhen(record.options.when, contexts),
          disabled: record.options.disabled?.value ?? false,
          valid: error === undefined,
          pending,
          rendered: record.rendered,
          ...(error === undefined ? {} : { error }),
        }
      })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    this.listeners.clear()
    this.declared.clear()
    this.toolbarAnchors.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export class CordisXSlotService extends Service implements CordisXSlots {
  readonly registry: SurfaceRegistry
  readonly contexts: HostContextStore

  constructor(ctx: Context, registry?: SurfaceRegistry) {
    super(ctx, 'slots')
    this.contexts = new HostContextStore()
    this.registry = registry ?? new SurfaceRegistry(this.contexts)
    ctx.effect(() => () => {
      this.registry.dispose()
      this.contexts.dispose()
    }, 'cordisx: structured surface registry')
  }

  inject<Name extends CordisXSurfaceName>(name: Name, setup: () => Effect): ReturnType<CordisXSlots['inject']> {
    if (!this.registry.isDeclared(name)) {
      throw new Error(`surface ${JSON.stringify(name)} is not declared; direct-DOM slots were removed in structured UI v1`)
    }
    return this.ctx.effect(setup, `slots.inject(${JSON.stringify(name)})`)
  }

  register<Name extends CordisXSurfaceName>(
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    const handle = this.registry.register(ownerFromContext(this.ctx), options, item)
    this.ctx.effect(() => handle, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
    return handle
  }

  snapshot(): readonly SurfaceContributionSnapshot[] {
    return this.registry.snapshot()
  }

  subscribeInternal(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  setResolvers(resolvers: SurfaceResolvers): void {
    this.registry.setResolvers(resolvers)
  }
}
