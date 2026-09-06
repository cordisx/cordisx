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
import type {
  ManagedManagerPageMount,
  ManagedSettingsPageMount,
  NavigationPageSnapshot,
  NavigationProductMetadata,
  PageRecord,
} from './navigation-pages.js'
import type { OutletSnapshot } from './navigation-outlets.js'

export interface RouteRecord {
  readonly owner: string
  /** Host-authenticated launcher source; never projected through public navigation snapshots. */
  readonly source?: string
  readonly qualifiedId: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly definition: CordisXRouteDefinition
  readonly parameters: readonly string[]
}

export interface RouteEntry {
  readonly record: RouteRecord
  readonly params: Readonly<Record<string, CordisXJsonScalar>>
  readonly path: string
}

export interface MountedPage {
  readonly entry: RouteEntry
  readonly contextKey: string
  readonly content: HTMLElement
  readonly abort: AbortController
  readonly pageAdmissionBinding: PageAdmissionBinding
  readonly effects: Disposable<void>[]
  dispose?: Disposable<void>
  error?: string
}

export interface ManagedSettingsPageMountRecord extends ManagedSettingsPageMount {
  readonly route: RouteRecord
  readonly page: PageRecord
  readonly content: HTMLElement
  readonly effects: Disposable<void>[]
  readonly abortController: AbortController
  pageDispose?: Disposable<void>
  disposed: boolean
}

export interface ManagedManagerPageMountRecord extends ManagedManagerPageMount {
  readonly route: RouteRecord
  readonly page: PageRecord
  readonly content: HTMLElement
  readonly effects: Disposable<void>[]
  readonly abortController: AbortController
  pageDispose?: Disposable<void>
  disposed: boolean
}

export interface OutletNavigationState {
  current?: RouteEntry
  mount?: MountedPage
  contextKey?: string
  returnFocus?: HTMLElement
  error?: string
  presentation?: 'presented' | 'suspended'
  suspendedBy?: string
}

export interface RouteSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly definition: CordisXRouteDefinition
  readonly productMetadata: NavigationProductMetadata
  readonly valid: boolean
  readonly authorized: boolean
  readonly pointPolicy: 'inherit' | 'allow' | 'deny'
  readonly effectivePointPolicy: 'allow' | 'deny'
  readonly pointPolicyReason?: string
  readonly error?: string
}

/** Host-private coordinate joining Agent authority to one navigation owner. */
export interface AgentRuntimeNavigationOwner {
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
}

/** Host-private route facts admitted to the Agent Session scope authority. */
export interface AgentRuntimeNavigationRoute {
  readonly id: string
  readonly path: string
  readonly schemaVersion?: 1 | 2
}

export interface ResolvedAgentRuntimeNavigationRoute extends AgentRuntimeNavigationRoute {
  readonly owner: AgentRuntimeNavigationOwner
}

export interface NavigationSnapshot {
  readonly routes: readonly RouteSnapshot[]
  readonly pages: readonly NavigationPageSnapshot[]
  readonly outlets: readonly OutletSnapshot[]
}

export interface RouteProjection {
  readonly active: boolean
  readonly presented: boolean
  readonly outlet?: CordisXOutletName
}

export function sameRouteParams(
  left: Readonly<Record<string, CordisXJsonScalar>>,
  right: Readonly<Record<string, CordisXJsonScalar>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
}

export function routeParameters(path: string): readonly string[] {
  const names = path.split('/').filter(segment => segment.startsWith(':')).map(segment => segment.slice(1))
  if (new Set(names).size !== names.length) throw new Error(`route path ${path} repeats a parameter`)
  return names
}

export function buildPath(record: RouteRecord, params: Readonly<Record<string, CordisXJsonScalar>>): string {
  const expected = new Set(record.parameters)
  const actual = Object.keys(params)
  const missing = record.parameters.find(name => !Object.hasOwn(params, name))
  if (missing !== undefined) throw new Error(`route ${record.qualifiedId} is missing parameter ${missing}`)
  const extra = actual.find(name => !expected.has(name))
  if (extra !== undefined) throw new Error(`route ${record.qualifiedId} has unknown parameter ${extra}`)
  return record.definition.path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment
    const value = params[segment.slice(1)]
    if (value === null) throw new Error(`route ${record.qualifiedId} parameter ${segment.slice(1)} cannot be null`)
    return encodeURIComponent(String(value))
  }).join('/')
}

export function matchPath(record: RouteRecord, path: string): Readonly<Record<string, string>> | undefined {
  const expected = record.definition.path.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const pattern = expected[index]!
    const value = actual[index]!
    if (!pattern.startsWith(':')) {
      if (pattern !== value) return undefined
      continue
    }
    try {
      params[pattern.slice(1)] = decodeURIComponent(value)
    } catch {
      return undefined
    }
  }
  return Object.freeze(params)
}

/** Host-side, data-only registry for protocol manager-content-navigation.v1/v2. */
