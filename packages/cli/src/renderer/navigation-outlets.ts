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
import { assertKeys } from './navigation-pages.js'

export type OutletPlacement = 'fixed' | 'absolute' | 'portal'
export type OutletContextPolicy = 'generation' | 'semantic'

export interface OutletDescriptor {
  readonly schemaVersion: 1
  readonly id: string
  readonly authority: 'host-adapter'
  readonly scope: string
  readonly preferredPlacement: OutletPlacement
  readonly contextPolicy: OutletContextPolicy
  readonly presentationGroup?: string
}

export interface OutletHostSnapshot {
  readonly available: boolean
  readonly contextKey?: string
  readonly container?: HTMLElement
  readonly placement: OutletPlacement
  readonly nativeSessionId?: string
  readonly error?: string
}

/** Private host-adapter contract. Controllers may touch host DOM; plugins cannot receive them. */
export interface OutletController {
  getSnapshot(): OutletHostSnapshot
  subscribe(listener: () => void): () => void
  show(): void | Promise<void>
  hide(): void | Promise<void>
}

interface OutletRecord {
  readonly descriptor: OutletDescriptor
  readonly controller: OutletController
  readonly validatePath: (path: string) => boolean
  readonly unsubscribe: () => void
}

export interface OutletSnapshot extends OutletDescriptor, OutletHostSnapshot {
  readonly mounted: boolean
  readonly presentation: 'inactive' | 'presented' | 'suspended'
  readonly suspendedBy?: string
  readonly activeRoute?: string
  readonly error?: string
}

export class OutletRegistry {
  private readonly records = new Map<string, OutletRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  declare(
    descriptor: OutletDescriptor,
    controller: OutletController,
    validatePath: (path: string) => boolean,
  ): () => void {
    if (this.disposed) throw new Error('CordisX outlet registry is disposed')
    assertKeys(descriptor, [
      'schemaVersion',
      'id',
      'authority',
      'scope',
      'preferredPlacement',
      'contextPolicy',
      'presentationGroup',
    ], 'outlet descriptor')
    if (descriptor.schemaVersion !== 1) {
      throw new Error(`unsupported outlet schema version: ${descriptor.schemaVersion}`)
    }
    assertReference(descriptor.id, 'outlet id')
    if (descriptor.authority !== 'host-adapter') throw new Error('outlet authority must be host-adapter')
    assertLocalId(descriptor.scope, 'outlet scope')
    if (!['fixed', 'absolute', 'portal'].includes(descriptor.preferredPlacement)) {
      throw new Error('invalid outlet placement')
    }
    if (!['generation', 'semantic'].includes(descriptor.contextPolicy)) throw new Error('invalid outlet context policy')
    if (descriptor.presentationGroup !== undefined) {
      assertLocalId(descriptor.presentationGroup, 'outlet presentation group')
    }
    if (typeof validatePath !== 'function') throw new Error('outlet requires a host path validator')
    if (this.records.has(descriptor.id)) throw new Error(`outlet ${descriptor.id} is already declared`)
    const frozen = immutableSnapshot(descriptor)
    const unsubscribe = controller.subscribe(() => this.notify())
    this.records.set(descriptor.id, { descriptor: frozen, controller, validatePath, unsubscribe })
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      const record = this.records.get(descriptor.id)
      if (record === undefined) return
      record.unsubscribe()
      this.records.delete(descriptor.id)
      this.notify()
    }
  }

  get(id: string): OutletRecord | undefined {
    return this.records.get(id)
  }

  descriptors(): readonly OutletDescriptor[] {
    return [...this.records.values()].map(record => record.descriptor).sort((a, b) => a.id.localeCompare(b.id))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) record.unsubscribe()
    this.records.clear()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('CordisX outlet subscriber failed', error)
      }
    }
  }
}
