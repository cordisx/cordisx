import { Context, type Disposable, Service } from '@deepseek-ai/cordis'
import { type AgentAvatarRef, cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { AgentPageComposerCommandAdapter } from '@cordisx/protocol/agent-page-admission/v2'
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
  CORDISX_PAGE_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V2,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../contracts.js'
import type {
  CordisXIconToken,
  CordisXJsonScalar,
  CordisXLocalizedText,
  CordisXManagerContentNavigation,
  CordisXManagerContentNavigationDeclarationV1,
  CordisXManagerContentNavigationDeclarationV2,
  CordisXManagerContentNavigationDeclarationV3,
  CordisXManagerContentNavigationDeclarationV4,
  CordisXManagerContentNavigationDeclarationV5,
  CordisXManagerContentRecordTitleV1,
  CordisXMessageDefinition,
  CordisXOutletName,
  CordisXPageHeaderAction,
  CordisXPageMetadata,
  CordisXPageMount,
  CordisXPageMountContext,
  CordisXPageNavigation,
  CordisXPages,
  CordisXRouteDefinition,
  CordisXRouteReference,
  CordisXRoutes,
  ManagerContentNavigationTabV2,
  ManagerContentRecordSummaryProjectionV2,
} from '../contracts.js'
import type { ManagerContentConfigBindingHandle } from './manager-content-config.js'
import { mountManagerContentConfigForm } from './manager-content-config-form.js'
import type { CordisXCommandService } from './commands.js'
import { CordisXI18nService, type LocalizationEffectOwner } from './i18n.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { createHostSurfaceIcon } from './icons.js'
import { ownerFromContext, qualifyOwnedId, sourceFromContext } from './ownership.js'
import {
  type GenerationVisibilityCoordinator,
  generationVisibilityFromContext,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import {
  type PageAdmissionBinding,
  PageAdmissionBindingRegistry,
  type PageAdmissionRoute,
} from './page-admission-lifecycle.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import { dismissHostTooltips, HostTooltipController } from './tooltips.js'
import { HostPageControls } from './page-controls.js'
import { mountManagerCollectionHost } from './manager/components/ManagerCollection.js'
import type { ManagerCollectionHostCopyKey } from './manager-collection.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import type {
  CodexRouteHistoryAdapter,
  CodexRouteHistoryEntry,
  CodexRouteHistorySnapshot,
} from './codex-router-history.js'
import {
  assertLocalId,
  assertLocalizedText,
  assertReference,
  assertWhenExpression,
  evaluateWhen,
  HostContextStore,
  ICON_TOKEN_PATTERN,
  immutableSnapshot,
  whenContextKeys,
} from './validation.js'

import { assertKeys, type PageComposerAdapterFactory } from './navigation-pages.js'
import { sameRouteParams } from './navigation-model.js'
export interface ManagerContentDeclarationRecord {
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly declaration:
    | CordisXManagerContentNavigationDeclarationV1
    | CordisXManagerContentNavigationDeclarationV2
    | CordisXManagerContentNavigationDeclarationV3
    | CordisXManagerContentNavigationDeclarationV4
    | CordisXManagerContentNavigationDeclarationV5
  readonly config?: ManagerContentConfigBindingHandle
}

interface ManagerContentTitleRecord {
  readonly owner: string
  readonly id: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly title: CordisXLocalizedText
}

export function sameReference(left: CordisXRouteReference, right: CordisXRouteReference): boolean {
  return left.id === right.id && sameRouteParams(left.params ?? {}, right.params ?? {})
}

export function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStructuredValue(value, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && sameStructuredValue(leftRecord[key], rightRecord[key])
    )
}

export interface ManagerContentPresentation {
  readonly title: string
  readonly description: string
  readonly icon?: CordisXIconToken
  readonly parent?: CordisXRouteReference
  readonly recordSummary?: Readonly<{
    readonly leadingVisual: Readonly<{ readonly kind: 'agent-avatar'; readonly avatar: AgentAvatarRef }>
    readonly title: string
    readonly description?: string
    /** Exact immutable protocol projection retained before Host localization. */
    readonly source: ManagerContentRecordSummaryProjectionV2
  }>
  /**
   * A Host semantic icon is projected from the exact same-owner page route.
   * The manager renders it; plugins never supply DOM or renderer callbacks.
   */
  /** Host activation of one projected sibling replaces the current Manager history entry. */
  readonly tabs: readonly Readonly<{
    readonly id: string
    readonly label: string
    readonly icon: CordisXIconToken
    readonly route: CordisXRouteReference
    readonly active: boolean
  }>[]
  /** Host-internal authority source. It is never projected into plugin ctx. */
  readonly config?: ManagerContentConfigBindingHandle
}

export interface ManagerContentAgentDefinitionTarget {
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly identity: AgentDefinitionIdentity
  readonly route: CordisXRouteReference
  readonly parent?: CordisXRouteReference
}

export class ManagerContentNavigationRegistry {
  private readonly declarations = new Map<string, ManagerContentDeclarationRecord>()
  private readonly titles = new Map<string, ManagerContentTitleRecord>()
  private readonly projections = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()
  private readonly disconnectVisibility: (() => void) | undefined
  private notificationDepth = 0
  private notificationPending = false
  private configFactory:
    | ((input: {
      readonly owner: string
      readonly declarationId: string
      readonly moduleGeneration: string
      readonly view?: PluginGenerationView
      readonly body: NonNullable<CordisXManagerContentNavigationDeclarationV4['body']>
      readonly contractVersion: 1 | 2
    }) => ManagerContentConfigBindingHandle)
    | undefined

  constructor(private readonly visibility?: GenerationVisibilityCoordinator) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  setConfigFactory(factory: NonNullable<ManagerContentNavigationRegistry['configFactory']>): void {
    if (this.configFactory !== undefined) throw new Error('manager content config authority is already installed')
    this.configFactory = factory
  }

  register(
    ownerOrContext: string | Context,
    declaration:
      | CordisXManagerContentNavigationDeclarationV1
      | CordisXManagerContentNavigationDeclarationV2
      | CordisXManagerContentNavigationDeclarationV3
      | CordisXManagerContentNavigationDeclarationV4
      | CordisXManagerContentNavigationDeclarationV5,
  ): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertKeys(
      declaration,
      declaration.schemaVersion >= 3
        ? [
          '$schema',
          'schemaVersion',
          'id',
          'route',
          'parentRoute',
          'header',
          'subject',
          'recordSummary',
          'tabs',
          ...(declaration.schemaVersion >= 4 ? ['body'] : []),
        ]
        : ['$schema', 'schemaVersion', 'id', 'route', 'parentRoute', 'header', 'tabs'],
      'manager content navigation declaration',
    )
    const version =
      declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1 && declaration.schemaVersion === 1
        ? 1
        : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2 && declaration.schemaVersion === 2
        ? 2
        : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3 && declaration.schemaVersion === 3
        ? 3
        : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4 && declaration.schemaVersion === 4
        ? 4
        : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5 && declaration.schemaVersion === 5
        ? 5
        : undefined
    if (version === undefined) {
      throw new Error('manager content navigation declaration has an unsupported schema tuple')
    }
    assertLocalId(declaration.id, 'manager content navigation declaration id')
    this.assertRouteReference(declaration.route, 'manager content navigation declaration route')
    if (declaration.parentRoute !== undefined) {
      this.assertRouteReference(declaration.parentRoute, 'manager content navigation declaration parent route')
    }
    assertKeys(declaration.header, ['title'], 'manager content navigation declaration header')
    const title = declaration.header.title
    if (title === null || typeof title !== 'object' || Array.isArray(title)) {
      throw new Error('manager content navigation header title is invalid')
    }
    if (title.kind === 'record') {
      assertKeys(title, ['kind', 'recordIdParam', 'fallback'], 'manager content navigation record header')
      if (!/^[a-z][a-zA-Z0-9]*$/u.test(title.recordIdParam)) {
        throw new Error('manager content navigation recordIdParam is invalid')
      }
      assertLocalizedText(title.fallback, 'manager content navigation record fallback')
      if (!Object.hasOwn(declaration.route.params ?? {}, title.recordIdParam)) {
        throw new Error('manager content navigation record header requires its current route parameter')
      }
    } else if (title.kind === 'route') {
      assertKeys(title, ['kind'], 'manager content navigation route header')
    } else {
      throw new Error('manager content navigation header title kind is invalid')
    }
    const ids = new Set<string>()
    for (const tab of declaration.tabs ?? []) {
      assertKeys(tab, version >= 2 ? ['id', 'route', 'label'] : ['id', 'route'], 'manager content navigation tab')
      assertLocalId(tab.id, 'manager content navigation tab id')
      if (ids.has(tab.id)) throw new Error(`manager content navigation declaration has duplicate tab ${tab.id}`)
      ids.add(tab.id)
      this.assertRouteReference(tab.route, 'manager content navigation tab route')
      if (version >= 2 && Object.hasOwn(tab, 'label')) {
        assertLocalizedText((tab as ManagerContentNavigationTabV2).label, 'manager content navigation tab label')
      }
    }
    if (version >= 3) {
      this.assertV3(
        declaration as
          | CordisXManagerContentNavigationDeclarationV3
          | CordisXManagerContentNavigationDeclarationV4
          | CordisXManagerContentNavigationDeclarationV5,
        candidateView,
      )
    }
    const key = `${owner}\u0000${declaration.id}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.declarations.has(key)) {
      throw new Error(`manager content navigation declaration ${declaration.id} is already registered`)
    }
    let config: ManagerContentConfigBindingHandle | undefined
    if (
      version >= 4
      && (declaration as CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5)
          .body !== undefined
    ) {
      const body =
        (declaration as CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5)
          .body!
      this.assertConfigBody(body)
      if (this.configFactory === undefined) throw new Error('manager content config authority is unavailable')
      const moduleGeneration = generation.moduleGeneration
      if (moduleGeneration === undefined) throw new Error('manager content config requires an exact plugin generation')
      config = this.configFactory({
        owner,
        declarationId: declaration.id,
        moduleGeneration,
        body,
        contractVersion: version === 5 ? 2 : 1,
        ...(candidateView === undefined ? {} : { view: candidateView }),
      })
    }
    this.declarations.set(key, {
      owner,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      declaration: immutableSnapshot(declaration),
      ...(config === undefined ? {} : { config }),
    })
    if (this.visibility?.visible(generation) !== false) this.notify()
    return () => {
      const record = this.declarations.get(key)
      if (record === undefined || !this.declarations.delete(key)) return
      record.config?.close(
        this.visibleDeclarations().some(candidate =>
            candidate.owner === owner
            && candidate.declaration.id === declaration.id
          )
          ? 'generation-replaced'
          : 'declaration-replaced',
      )
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
  }

  registerRecordTitles(
    ownerOrContext: string | Context,
    records: readonly CordisXManagerContentRecordTitleV1[],
  ): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    const entries: string[] = []
    for (const record of records) {
      assertKeys(record, ['id', 'title'], 'manager content record title')
      if (typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 512) {
        throw new Error('manager content record title id is invalid')
      }
      assertLocalizedText(record.title, 'manager content record title')
      const key = `${owner}\u0000${record.id}\u0000${generation.moduleGeneration ?? 'host'}`
      if (this.titles.has(key)) throw new Error(`manager content record title ${record.id} is already registered`)
      this.titles.set(key, {
        owner,
        id: record.id,
        generation,
        ...(candidateView === undefined ? {} : { candidateView }),
        title: immutableSnapshot(record.title),
      })
      entries.push(key)
    }
    this.notify()
    return () => {
      let changed = false
      for (const key of entries) changed = this.titles.delete(key) || changed
      if (changed) this.notify()
    }
  }

  /** Atomically replace an owner projection so route observers never see a partial catalog. */
  replaceProjection(
    ownerOrContext: string | Context,
    projection: Readonly<{
      readonly declarations: readonly (
        | CordisXManagerContentNavigationDeclarationV1
        | CordisXManagerContentNavigationDeclarationV2
        | CordisXManagerContentNavigationDeclarationV3
        | CordisXManagerContentNavigationDeclarationV4
        | CordisXManagerContentNavigationDeclarationV5
      )[]
      readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
    }>,
  ): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const projectionKey = `${owner}\u0000${generation.moduleGeneration ?? 'host'}`
    let dispose: () => void = () => {}
    this.transaction(() => {
      this.projections.get(projectionKey)?.()
      const declarations: (() => void)[] = []
      let titles: (() => void) | undefined
      try {
        for (const declaration of projection.declarations) declarations.push(this.register(ownerOrContext, declaration))
        titles = this.registerRecordTitles(ownerOrContext, projection.recordTitles)
      } catch (error) {
        titles?.()
        for (const unregister of declarations.reverse()) unregister()
        throw error
      }
      dispose = () =>
        this.transaction(() => {
          titles?.()
          for (const unregister of declarations.reverse()) unregister()
        })
      this.projections.set(projectionKey, dispose)
    })
    return () => {
      if (this.projections.get(projectionKey) !== dispose) return
      this.projections.delete(projectionKey)
      dispose()
    }
  }

  resolve(
    owner: string,
    reference: CordisXRouteReference,
    view?: PluginGenerationView,
  ): ManagerContentDeclarationRecord | undefined {
    const matches = this.visibleDeclarations(view).filter(record =>
      record.owner === owner && sameReference(record.declaration.route, reference)
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  declarationsFor(owner: string, view?: PluginGenerationView): readonly ManagerContentDeclarationRecord[] {
    return this.visibleDeclarations(view).filter(record => record.owner === owner)
  }

  title(owner: string, id: string, view?: PluginGenerationView): CordisXLocalizedText | undefined {
    const matches = [...this.titles.values()].filter(record =>
      record.owner === owner && record.id === id
      && (this.visibility?.visible(record.generation, view) ?? true)
    )
    return matches.length === 1 ? matches[0]?.title : undefined
  }

  resolveAgentDefinitionSubject(identity: AgentDefinitionIdentity): ManagerContentAgentDefinitionTarget | undefined {
    const matches = this.visibleDeclarations().filter(record => {
      const subject = record.declaration.schemaVersion >= 3
        ? (record.declaration as
          | CordisXManagerContentNavigationDeclarationV3
          | CordisXManagerContentNavigationDeclarationV4
          | CordisXManagerContentNavigationDeclarationV5).subject
        : undefined
      return subject?.kind === 'agent-definition'
        && subject.identity.agentId === identity.agentId
        && subject.identity.revision === identity.revision
    })
    if (matches.length !== 1) return undefined
    const match = matches[0]!
    const subject = (match.declaration as
      | CordisXManagerContentNavigationDeclarationV3
      | CordisXManagerContentNavigationDeclarationV4
      | CordisXManagerContentNavigationDeclarationV5).subject!
    return Object.freeze({
      owner: match.owner,
      generation: match.generation,
      identity: immutableSnapshot(subject.identity),
      route: immutableSnapshot(match.declaration.route),
      ...(match.declaration.parentRoute === undefined
        ? {}
        : { parent: immutableSnapshot(match.declaration.parentRoute) }),
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disconnectVisibility?.()
    this.projections.clear()
    for (const record of this.declarations.values()) record.config?.close('owner-disposed')
    this.declarations.clear()
    this.titles.clear()
    this.listeners.clear()
  }

  private visibleDeclarations(view?: PluginGenerationView): ManagerContentDeclarationRecord[] {
    return [...this.declarations.values()].filter(record => this.visibility?.visible(record.generation, view) ?? true)
  }

  private assertV3(
    declaration:
      | CordisXManagerContentNavigationDeclarationV3
      | CordisXManagerContentNavigationDeclarationV4
      | CordisXManagerContentNavigationDeclarationV5,
    view?: PluginGenerationView,
  ): void {
    if (declaration.subject !== undefined) {
      assertKeys(declaration.subject, ['kind', 'identity'], 'manager content navigation subject')
      if (declaration.subject.kind !== 'agent-definition') {
        throw new Error('manager content navigation subject kind is invalid')
      }
      assertKeys(declaration.subject.identity, ['agentId', 'revision'], 'manager content navigation subject identity')
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(declaration.subject.identity.agentId)
        || typeof declaration.subject.identity.revision !== 'string'
        || declaration.subject.identity.revision.length < 1
        || declaration.subject.identity.revision.length > 512
      ) {
        throw new Error('manager content navigation subject identity is invalid')
      }
      const duplicate = this.visibleDeclarations(view).find(record => {
        const subject = record.declaration.schemaVersion >= 3
          ? (record.declaration as
            | CordisXManagerContentNavigationDeclarationV3
            | CordisXManagerContentNavigationDeclarationV4
            | CordisXManagerContentNavigationDeclarationV5).subject
          : undefined
        return subject?.kind === 'agent-definition'
          && subject.identity.agentId === declaration.subject!.identity.agentId
          && subject.identity.revision === declaration.subject!.identity.revision
      })
      if (duplicate !== undefined) {
        throw new Error(
          `manager content navigation subject ${declaration.subject.identity.agentId}@${declaration.subject.identity.revision} is already claimed`,
        )
      }
    }
    if (declaration.recordSummary !== undefined) {
      assertKeys(declaration.recordSummary, ['leadingVisual', 'title', 'description'], 'manager content record summary')
      assertKeys(
        declaration.recordSummary.leadingVisual,
        ['kind', 'avatar'],
        'manager content record summary leading visual',
      )
      if (declaration.recordSummary.leadingVisual.kind !== 'agent-avatar') {
        throw new Error('manager content record summary leading visual kind is invalid')
      }
      cloneAgentAvatarRef(declaration.recordSummary.leadingVisual.avatar)
      assertLocalizedText(declaration.recordSummary.title, 'manager content record summary title')
      if (
        typeof declaration.recordSummary.title.fallback !== 'string'
        || declaration.recordSummary.title.fallback.trim() === ''
      ) {
        throw new Error('manager content record summary title fallback is invalid')
      }
      if (declaration.recordSummary.description !== undefined) {
        assertLocalizedText(declaration.recordSummary.description, 'manager content record summary description')
        if (
          typeof declaration.recordSummary.description.fallback !== 'string'
          || declaration.recordSummary.description.fallback.trim() === ''
        ) {
          throw new Error('manager content record summary description fallback is invalid')
        }
      }
    }
  }

  private assertConfigBody(body: NonNullable<CordisXManagerContentNavigationDeclarationV4['body']>): void {
    assertKeys(body, ['kind', 'namespace', 'defaultMaterialization'], 'manager content config body')
    if (body.kind !== 'plugin-config-form') throw new Error('manager content config body kind is invalid')
    assertLocalId(body.namespace, 'manager content config namespace')
    const defaults = body.defaultMaterialization
    if (defaults === undefined) return
    assertKeys(defaults, ['mode', 'fields'], 'manager content config default materialization')
    if (
      defaults.mode !== 'missing-only' || !Array.isArray(defaults.fields) || defaults.fields.length < 1
      || defaults.fields.length > 16
    ) {
      throw new Error('manager content config default materialization is invalid')
    }
    for (const field of defaults.fields) {
      assertKeys(field, ['path', 'value'], 'manager content config missing default')
      if (
        !Array.isArray(field.path) || field.path.length < 1 || field.path.length > 32
        || field.path.some((segment: unknown) =>
          typeof segment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(segment)
        )
      ) {
        throw new Error('manager content config default path is invalid')
      }
      if (!['string', 'number', 'boolean'].includes(typeof field.value) && field.value !== null) {
        throw new Error('manager content config default value is invalid')
      }
    }
  }

  private assertRouteReference(reference: CordisXRouteReference, label: string): void {
    assertKeys(reference, ['id', 'params'], label)
    assertLocalId(reference.id, `${label} id`)
    for (const [key, value] of Object.entries(reference.params ?? {})) {
      if (!/^[a-z][a-zA-Z0-9]*$/u.test(key)) throw new Error(`${label} param ${key} is invalid`)
      if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
        throw new Error(`${label} param ${key} is not scalar`)
      }
    }
  }

  private notify(): void {
    if (this.notificationDepth > 0) {
      this.notificationPending = true
      return
    }
    for (const listener of this.listeners) listener()
  }

  private transaction<Value>(work: () => Value): Value {
    this.notificationDepth += 1
    try {
      return work()
    } finally {
      this.notificationDepth -= 1
      if (this.notificationDepth === 0 && this.notificationPending) {
        this.notificationPending = false
        for (const listener of this.listeners) listener()
      }
    }
  }
}
