import type {
  StartupActionAvailabilityV1,
  StartupCapabilityRefV1,
  StartupCatalogReportV1,
  StartupCatalogV1,
  StartupMilestoneReportV1,
  StartupModeV1,
  StartupObserverV1,
  StartupProjectionV1,
  StartupReporterV1,
} from '@cordisx/protocol/startup/v1'
import type { ManagedServiceProjectionV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { validateStartupCatalog } from './managed-service-startup-catalog.js'
import { createStartupObserverSource } from './managed-service-startup-observer.js'
import {
  projectStartupCapability,
  type StartupCapabilityEvidence,
  unavailable,
} from './managed-service-startup-projection.js'
import {
  startupCapabilityKey,
  type StartupPluginAdmission,
  validateStartupAdmissions,
} from './managed-service-startup-admission.js'
import { StartupSession } from './managed-service-startup-session.js'

export interface StartupServiceOwner {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly serviceGeneration: string
}
interface Entry extends Omit<StartupCapabilityEvidence, 'milestones'> {
  bindingGeneration?: string
  catalogSequence: number
  attempt?: object
  readonly admission: StartupPluginAdmission
  milestones: Map<string, { sequence: number; state: 'pending' | 'satisfied' | 'failed' }>
}
const ownerKey = (pluginId: string, generation: string) => `${pluginId}\u0000${generation}`
const entryKey = (ref: StartupCapabilityRefV1, generation: string) =>
  `${ownerKey(ref.pluginId, generation)}\u0000${ref.capabilityId}`

/** Sole Host startup authority. Transport and renderer never mutate this store. */
export class ManagedServiceStartupAuthority {
  private readonly entries = new Map<string, Entry>()
  private readonly admissions = new Map<string, StartupPluginAdmission>()
  private readonly selected = new Map<string, string>()
  private readonly changes = new StartupSession(0)
  private readonly scopes = new Map<ReturnType<typeof createStartupObserverSource>, string | undefined>()
  private disposed = false

  constructor(readonly options: { readonly profileId: string; readonly hostGeneration: string }) {}

  /** Candidate declarations are invisible to broad observers until selectOwners. */
  admit(plugins: readonly StartupPluginAdmission[]): void {
    if (this.disposed) throw new Error('startup authority disposed')
    const replacementIds = new Set(plugins.map(plugin => plugin.pluginId))
    const retained = [...this.selected].flatMap(([id, generation]) => {
      const admission = this.admissions.get(ownerKey(id, generation))
      return replacementIds.has(id) || admission === undefined ? [] : [admission]
    })
    validateStartupAdmissions([...retained, ...plugins])
    for (const raw of plugins) {
      const plugin = structuredClone(raw)
      const key = ownerKey(plugin.pluginId, plugin.pluginGeneration)
      const prior = this.admissions.get(key)
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(plugin)) {
          throw new Error('startup owner generation changed declaration')
        }
        continue
      }
      this.admissions.set(key, plugin)
      for (const declaration of plugin.startup.capabilities) {
        this.entries.set(
          entryKey({ pluginId: plugin.pluginId, capabilityId: declaration.id }, plugin.pluginGeneration),
          {
            catalogSequence: 0,
            admission: plugin,
            pluginId: plugin.pluginId,
            pluginGeneration: plugin.pluginGeneration,
            hostGeneration: this.options.hostGeneration,
            declaration,
            adopted: false,
            preparing: false,
            prepared: false,
            failed: false,
            revoked: false,
            canAuthenticate: false,
            published: false,
            catalog: { state: declaration.kind === 'provider' ? 'unknown' : 'not-applicable' },
            milestones: new Map(),
          },
        )
      }
    }
    this.changed()
  }

  selectOwners(owners: readonly { readonly pluginId: string; readonly pluginGeneration: string }[]): void {
    this.selected.clear()
    for (const owner of owners) this.selected.set(owner.pluginId, owner.pluginGeneration)
    this.changed()
  }

  declaration(ref: StartupCapabilityRefV1, pluginGeneration = this.selected.get(ref.pluginId)) {
    const entry = pluginGeneration === undefined ? undefined : this.entries.get(entryKey(ref, pluginGeneration))
    return entry === undefined
      ? undefined
      : structuredClone({
        declaration: entry.declaration,
        owner: { pluginId: entry.pluginId, pluginGeneration: entry.pluginGeneration, source: entry.admission.source },
        sourceRevision: entry.admission.sourceRevision,
      })
  }

  private ownerEntries(owner: StartupServiceOwner): Entry[] {
    return [...this.entries.values()].filter(entry =>
      entry.pluginId === owner.pluginId
      && entry.pluginGeneration === owner.pluginGeneration && entry.declaration.serviceId === owner.serviceId
    )
  }

  bindService(owner: StartupServiceOwner, capabilityId?: string): StartupReporterV1 {
    for (const entry of this.ownerEntries(owner)) {
      if (entry.revoked) throw new Error('startup owner is revoked')
      Object.assign(entry, { bindingGeneration: owner.serviceGeneration, serviceGeneration: owner.serviceGeneration })
    }
    this.changed()
    return this.reporter(owner, capabilityId)
  }

  private reporter(
    owner: StartupServiceOwner,
    capabilityId?: string,
    current: () => boolean = () => true,
  ): StartupReporterV1 {
    return Object.freeze({
      report: async (report: StartupMilestoneReportV1) =>
        !current()
          ? { status: 'rejected' as const, reason: 'revoked' as const }
          : capabilityId !== undefined && report.target.capabilityId !== capabilityId
          ? { status: 'rejected' as const, reason: 'not-owner' as const }
          : this.report(owner, report),
      reportCatalog: async (report: StartupCatalogReportV1) =>
        !current()
          ? { status: 'rejected' as const, reason: 'revoked' as const }
          : capabilityId !== undefined && report.target.capabilityId !== capabilityId
          ? { status: 'rejected' as const, reason: 'not-owner' as const }
          : this.reportCatalog(owner, report),
    })
  }

  beginAttempt(owner: StartupServiceOwner, capabilityId: string, signal: AbortSignal) {
    const entry = this.entries.get(entryKey({ pluginId: owner.pluginId, capabilityId }, owner.pluginGeneration))
    if (entry === undefined || entry.revoked || entry.bindingGeneration !== owner.serviceGeneration) {
      throw new Error('startup preparation owner is unavailable')
    }
    const attempt = {}
    for (const [id, prior] of entry.milestones) entry.milestones.set(id, { ...prior, state: 'pending' })
    Object.assign(entry, {
      attempt,
      preparing: true,
      prepared: false,
      failed: false,
      published: false,
      catalog: { state: entry.declaration.kind === 'provider' ? 'pending' : 'not-applicable' },
    })
    const current = () =>
      !signal.aborted && !this.disposed && !entry.revoked && entry.attempt === attempt
      && entry.serviceGeneration === owner.serviceGeneration
    this.changed()
    return {
      current,
      reporter: this.reporter(owner, capabilityId, current),
      finish: (failed = false) => {
        if (!current()) return
        Object.assign(entry, { preparing: false, prepared: !failed, failed })
        this.changed()
      },
    }
  }

  updateService(owner: StartupServiceOwner, service: ManagedServiceProjectionV1, canAuthenticate: boolean): void {
    for (const entry of this.ownerEntries(owner)) {
      if (entry.revoked || entry.bindingGeneration !== owner.serviceGeneration) continue
      if (
        service.binding.identity.pluginId !== owner.pluginId || service.binding.identity.serviceId !== owner.serviceId
        || service.binding.hostGeneration !== this.options.hostGeneration
      ) continue
      // Registration lifetime stays stable while restart rotates execution binding.
      if (
        entry.service !== undefined && entry.service.binding.serviceGeneration !== service.binding.serviceGeneration
      ) {
        entry.milestones.clear()
        Object.assign(entry, {
          attempt: undefined,
          prepared: false,
          published: false,
          catalogSequence: 0,
          catalog: { state: entry.declaration.kind === 'provider' ? 'unknown' : 'not-applicable' },
        })
      }
      Object.assign(entry, {
        service: structuredClone(service),
        canAuthenticate,
        serviceGeneration: service.binding.serviceGeneration,
      })
    }
    this.changed()
  }

  adopt(owner: StartupServiceOwner): void {
    this.patchOwner(owner, { adopted: true })
  }
  preparing(owner: StartupServiceOwner, capabilityId?: string): void {
    this.patchOwner(owner, { preparing: true, failed: false }, capabilityId)
  }
  settled(owner: StartupServiceOwner, failed = false, capabilityId?: string): void {
    this.patchOwner(owner, { preparing: false, prepared: !failed, failed }, capabilityId)
  }
  revoke(owner: StartupServiceOwner): void {
    this.patchOwner(owner, { revoked: true, published: false })
  }

  publication(owner: StartupServiceOwner, providerId: string, catalog: StartupCatalogV1 | undefined): void {
    for (const entry of this.ownerEntries(owner)) {
      if (
        entry.revoked || entry.bindingGeneration !== owner.serviceGeneration || entry.declaration.kind !== 'provider'
        || entry.declaration.providerId !== providerId
      ) continue
      if (catalog === undefined) Object.assign(entry, { published: false })
      else if (
        entry.catalog.state === 'known' && catalog.state === 'known'
        && entry.catalog.generation === catalog.generation && entry.catalog.modelIds.length === catalog.modelIds.length
        && entry.catalog.modelIds.every(id => catalog.modelIds.includes(id))
      ) Object.assign(entry, { published: true })
    }
    this.changed()
  }

  acceptsPublication(
    owner: StartupServiceOwner,
    providerId: string,
    compositionOrigin: string,
    catalog?: { readonly generation: string; readonly routes: readonly { readonly alias: string }[] },
  ): boolean {
    return this.ownerEntries(owner).some(entry =>
      !entry.revoked && entry.adopted
      && entry.bindingGeneration === owner.serviceGeneration && entry.declaration.kind === 'provider'
      && entry.declaration.providerId === providerId && entry.declaration.compositionOrigin === compositionOrigin
      && entry.serviceGeneration === owner.serviceGeneration
      && (catalog === undefined || (entry.catalog.state === 'known' && entry.catalog.generation === catalog.generation
        && entry.catalog.modelIds.length === catalog.routes.length && catalog.routes.every(route =>
          entry.catalog.state === 'known' && entry.catalog.modelIds.includes(route.alias)
        )))
    )
  }

  private patchOwner(owner: StartupServiceOwner, patch: Partial<Entry>, capabilityId?: string): void {
    for (const entry of this.ownerEntries(owner)) {
      if (
        !entry.revoked && entry.bindingGeneration === owner.serviceGeneration
        && (capabilityId === undefined || entry.declaration.id === capabilityId)
      ) Object.assign(entry, patch)
    }
    this.changed()
  }

  private report(
    owner: StartupServiceOwner,
    report: StartupMilestoneReportV1,
  ): Awaited<ReturnType<StartupReporterV1['report']>> {
    const reject = (
      reason: Extract<Awaited<ReturnType<StartupReporterV1['report']>>, { status: 'rejected' }>['reason'],
    ) => ({ status: 'rejected' as const, reason })
    if (this.disposed) return reject('revoked')
    if (report.target.pluginId !== owner.pluginId) return reject('not-owner')
    const entry = this.entries.get(entryKey(report.target, owner.pluginGeneration))
    if (entry === undefined || !entry.declaration.milestones.includes(report.milestoneId)) return reject('undeclared')
    if (entry.declaration.serviceId !== owner.serviceId) return reject('not-owner')
    if (entry.revoked) return reject('revoked')
    if (
      report.generation.host !== this.options.hostGeneration || report.generation.plugin !== owner.pluginGeneration
      || report.generation.service !== entry.serviceGeneration || owner.serviceGeneration !== entry.bindingGeneration
    ) return reject('stale-generation')
    if (
      report.contract !== 'cordisx.startup-milestone/v1' || (report.state !== 'satisfied' && report.state !== 'failed')
    ) return reject('undeclared')
    const previous = entry.milestones.get(report.milestoneId)
    if (!Number.isSafeInteger(report.sequence) || report.sequence <= (previous?.sequence ?? 0)) {
      return reject('stale-sequence')
    }
    entry.milestones.set(report.milestoneId, { sequence: report.sequence, state: report.state })
    this.changed()
    return { status: 'accepted' }
  }

  private reportCatalog(
    owner: StartupServiceOwner,
    report: StartupCatalogReportV1,
  ): Awaited<ReturnType<StartupReporterV1['reportCatalog']>> {
    const reject = (
      reason: Extract<Awaited<ReturnType<StartupReporterV1['reportCatalog']>>, { status: 'rejected' }>['reason'],
    ) => ({ status: 'rejected' as const, reason })
    if (this.disposed) return reject('revoked')
    if (report.target.pluginId !== owner.pluginId) return reject('not-owner')
    const entry = this.entries.get(entryKey(report.target, owner.pluginGeneration))
    if (entry === undefined) return reject('undeclared')
    if (entry.declaration.serviceId !== owner.serviceId) return reject('not-owner')
    if (entry.revoked) return reject('revoked')
    if (
      report.generation.host !== this.options.hostGeneration || report.generation.plugin !== owner.pluginGeneration
      || report.generation.service !== entry.serviceGeneration || owner.serviceGeneration !== entry.bindingGeneration
    ) return reject('stale-generation')
    if (entry.declaration.kind !== 'provider') return reject('not-provider')
    if (report.contract !== 'cordisx.startup-catalog-report/v1' || !validateStartupCatalog(report.catalog)) {
      return reject('invalid-catalog')
    }
    if (!Number.isSafeInteger(report.sequence) || report.sequence <= entry.catalogSequence) {
      return reject('stale-sequence')
    }
    const catalog: StartupCatalogV1 = report.catalog.state === 'known'
      ? { state: 'known', generation: report.catalog.generation, modelIds: [...report.catalog.modelIds] }
      : { state: report.catalog.state }
    const same = entry.catalog.state === 'known' && catalog.state === 'known'
      && entry.catalog.generation === catalog.generation && entry.catalog.modelIds.length === catalog.modelIds.length
      && entry.catalog.modelIds.every(id => catalog.modelIds.includes(id))
    Object.assign(entry, { catalog, catalogSequence: report.sequence, published: same && entry.published })
    this.changed()
    return { status: 'accepted' }
  }

  subscribe(listener: () => void): () => void {
    let first = true
    return this.changes.subscribe(() => {
      if (first) first = false
      else listener()
    })
  }

  providerReference(providerId: string): StartupCapabilityRefV1 | undefined {
    return this.projections(this.selected).find(entry => entry.identity.providerId === providerId)?.identity
  }

  private projections(owners: ReadonlyMap<string, string>): StartupProjectionV1[] {
    const projected = new Map<string, StartupProjectionV1>()
    const visit = (ref: StartupCapabilityRefV1): StartupProjectionV1 | undefined => {
      const key = startupCapabilityKey(ref)
      if (projected.has(key)) return projected.get(key)
      const generation = owners.get(ref.pluginId)
      const entry = generation === undefined ? undefined : this.entries.get(entryKey(ref, generation))
      if (entry === undefined) return undefined
      const ready = entry.declaration.dependsOn.every(dependency =>
        visit(dependency)?.actions.execute.available === true
      )
      const value = projectStartupCapability(entry, ready)
      projected.set(key, value)
      return value
    }
    for (const [pluginId, generation] of owners) {
      for (const declaration of this.admissions.get(ownerKey(pluginId, generation))?.startup.capabilities ?? []) {
        visit({ pluginId, capabilityId: declaration.id })
      }
    }
    return [...projected.values()]
  }

  availability(
    ref: StartupCapabilityRefV1,
    modelId?: string,
    owners: ReadonlyMap<string, string> = this.selected,
  ): StartupActionAvailabilityV1 {
    const entry = this.projections(owners).find(entry =>
      startupCapabilityKey(entry.identity) === startupCapabilityKey(ref)
    )
    if (entry === undefined) return unavailable('unknown-target')
    if (!entry.actions.execute.available) {
      if (entry.actions.execute.reason === 'dependency-not-ready') {
        for (const dependency of this.declaration(ref, owners.get(ref.pluginId))?.declaration.dependsOn ?? []) {
          const result = this.availability(dependency, undefined, owners)
          if (
            !result.available
            && ['unknown-target', 'failed', 'revoked', 'stopped', 'catalog-empty', 'authentication-required'].includes(
              result.reason,
            )
          ) return result
        }
      }
      return entry.actions.execute
    }
    if (modelId !== undefined && (entry.catalog.state !== 'known' || !entry.catalog.modelIds.includes(modelId))) {
      return unavailable('model-unavailable')
    }
    return { available: true }
  }

  async waitForDependency(
    ref: StartupCapabilityRefV1,
    owners: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.changes.wait(() => {
      const result = this.availability(ref, undefined, owners)
      if (result.available) return true
      if (
        ['unknown-target', 'failed', 'revoked', 'stopped', 'catalog-empty', 'authentication-required'].includes(
          result.reason,
        )
      ) throw new Error(`startup dependency ${result.reason}`)
      return false
    }, { signal })
  }

  ownerSelections(): ReadonlyMap<string, string> {
    return new Map(this.selected)
  }

  targets(mode: StartupModeV1, explicit?: StartupCapabilityRefV1): readonly StartupCapabilityRefV1[] {
    const roots = explicit === undefined
      ? [...this.selected].flatMap(([pluginId, generation]) =>
        (this.admissions.get(ownerKey(pluginId, generation))?.startup.capabilities ?? [])
          .filter(capability => capability.wait[mode] === 'always').map(capability => ({
            pluginId,
            capabilityId: capability.id,
          }))
      )
      : [explicit]
    const result = new Map<string, StartupCapabilityRefV1>()
    const visit = (ref: StartupCapabilityRefV1) => {
      const key = startupCapabilityKey(ref)
      if (result.has(key)) return
      result.set(key, ref)
      for (const dependency of this.declaration(ref)?.declaration.dependsOn ?? []) visit(dependency)
    }
    roots.forEach(visit)
    return [...result.values()]
  }

  async wait(
    ref: StartupCapabilityRefV1,
    options: { readonly modelId?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<StartupActionAvailabilityV1> {
    const terminal = new Set([
      'unknown-target',
      'authentication-required',
      'catalog-empty',
      'model-unavailable',
      'failed',
      'stopped',
      'revoked',
    ])
    await this.changes.wait(() => {
      const result = this.availability(ref, options.modelId)
      return result.available || terminal.has(result.reason)
    }, options)
    return this.availability(ref, options.modelId)
  }

  observer(input: {
    readonly scopeId: string
    readonly owner?: { readonly pluginId: string; readonly pluginGeneration: string }
    readonly authorizePage?: (pluginId: string, pageId: string, actionId: string) => boolean
    readonly authorize: (ref: StartupCapabilityRefV1, action: 'execute' | 'authenticate' | 'retry') => boolean
  }): StartupObserverV1 {
    const scope = createStartupObserverSource({
      scopeId: `${this.options.profileId}:${input.scopeId}`,
      hostGeneration: this.options.hostGeneration,
      subscribe: changed => {
        let first = true
        return this.changes.subscribe(() => {
          if (first) first = false
          else changed()
        })
      },
      read: () => {
        const owners = new Map(this.selected)
        if (input.owner !== undefined) owners.set(input.owner.pluginId, input.owner.pluginGeneration)
        const ownerAdmission = input.owner === undefined
          ? undefined
          : this.admissions.get(ownerKey(input.owner.pluginId, input.owner.pluginGeneration))
        const visible = input.owner === undefined ? undefined : new Set([
          ...(ownerAdmission?.startup.capabilities.map(item =>
            startupCapabilityKey({ pluginId: input.owner!.pluginId, capabilityId: item.id })
          ) ?? []),
          ...(ownerAdmission?.startup.pages.flatMap(page => [
            ...page.observes,
            ...page.actions.flatMap(action => action.requires),
          ]).map(startupCapabilityKey) ?? []),
        ])
        const entries = this.projections(owners).filter(entry =>
          visible === undefined || visible.has(startupCapabilityKey(entry.identity))
        )
          .map(entry => ({
            ...entry,
            actions: Object.fromEntries(
              Object.entries(entry.actions).map((
                [action, availability],
              ) => [
                action,
                input.authorize(entry.identity, action as 'execute' | 'authenticate' | 'retry')
                  ? availability
                  : unavailable('permission-denied'),
              ]),
            ) as StartupProjectionV1['actions'],
          }))
        const pages = [...owners].flatMap(([pluginId, generation]) => {
          if (input.owner !== undefined && input.owner.pluginId !== pluginId) return []
          return (this.admissions.get(ownerKey(pluginId, generation))?.startup.pages ?? []).map(page => ({
            pluginId,
            pageId: page.pageId,
            actions: page.actions.map(action => ({
              actionId: action.actionId,
              availability: action.requires.map(ref =>
                entries.find(entry =>
                  startupCapabilityKey(entry.identity) === startupCapabilityKey(ref)
                )?.actions
                  .execute ?? unavailable('unknown-target')
              )
                .find(result => !result.available)
                ?? (input.authorizePage?.(pluginId, page.pageId, action.actionId) === true
                  ? { available: true as const }
                  : unavailable('permission-denied')),
            })),
          }))
        })
        return { entries, pages }
      },
    })
    this.scopes.set(
      scope,
      input.owner === undefined ? undefined : ownerKey(input.owner.pluginId, input.owner.pluginGeneration),
    )
    return scope.observer
  }

  retireOwner(pluginId: string, pluginGeneration: string): void {
    const key = ownerKey(pluginId, pluginGeneration)
    for (const [scope, owner] of this.scopes) {
      if (owner === key) {
        scope.close('scope-revoked')
        this.scopes.delete(scope)
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.pluginId === pluginId && entry.pluginGeneration === pluginGeneration) {
        Object.assign(entry, { revoked: true, published: false, attempt: undefined })
      }
    }
    this.changed()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const scope of this.scopes.keys()) scope.close('host-replaced')
    this.scopes.clear()
    this.changes.dispose()
  }

  private changed(): void {
    this.changes.update(this.changes.snapshot().value + 1)
  }
}
