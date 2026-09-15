import type {
  ManagerSettingsNavigationContributionProjectionV3,
  ManagerSettingsNavigationGroupCatalogV2,
  ManagerSettingsNavigationGroupIdV2,
  ManagerSettingsNavigationProjectionV3,
  ManagerSettingsNavigationSurfaceProvenanceV3,
} from '@cordisx/protocol/manager-settings-navigation/v3'
import { CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V11, CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9 } from '../contracts.js'
import type { CordisXManagerSettingsNavigationGroup } from '../contracts.js'
import type { CordisXPermissionCapabilityV4, CordisXPermissionScopeV4 } from '../permission-contracts.js'

export type ManagerSettingsNavigationGroup = CordisXManagerSettingsNavigationGroup
export type ManagerNavigationVisualGroup = ManagerSettingsNavigationGroupIdV2

export interface ManagerSettingsNavigationPermissionReview {
  readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read'
  readonly fingerprint: string
}

interface PermissionReviewSurface {
  readonly owner: string
  readonly authorized: boolean
  readonly pointPolicyReason?: string
  readonly error?: string
}

interface PermissionReviewRecord {
  readonly identity: Readonly<{ readonly id: string }>
  readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read'
  readonly fingerprint: string
  readonly scope: CordisXPermissionScopeV4
}

/** Only an active scoped Host review request can make a protected destination discoverable. */
export function resolveManagerSettingsNavigationPermissionReview(
  registration: PermissionReviewSurface,
  route: PermissionReviewSurface,
  permissions: readonly PermissionReviewRecord[],
): ManagerSettingsNavigationPermissionReview | undefined {
  const pointIds = [
    ...(!registration.authorized && registration.pointPolicyReason === 'permission.review-pending'
      ? ['manager.settings.navigation-items']
      : []),
    ...(!route.authorized && route.pointPolicyReason === 'permission.review-pending' ? ['manager.content'] : []),
  ]
  if (registration.error !== undefined && registration.error !== 'permission.review-pending') return undefined
  if (pointIds.length === 0) return undefined
  const permission = permissions.find(item =>
    item.identity.id === registration.owner
    && item.capability === 'ui.extension-points.render'
    && pointIds.some(pointId => item.scope.extensionPoints?.includes(pointId) === true)
  )
  return permission === undefined
    ? undefined
    : Object.freeze({ capability: permission.capability, fingerprint: permission.fingerprint })
}

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUPS_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-groups.v2.schema.json' as const

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_PROJECTION_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-projection.v3.schema.json' as const

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG = Object.freeze({
  $schema: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUPS_SCHEMA_V2,
  contract: 'cordisx.manager-settings-navigation-groups/v2',
  schemaVersion: 2,
  groups: Object.freeze(
    [
      Object.freeze({
        id: 'resources',
        label: Object.freeze({
          namespace: 'cordisx.manager.extension-points',
          key: 'manager.settings.navigation-group.resources',
          fallback: 'Resources',
        }),
        order: 100,
      }),
      Object.freeze({
        id: 'development',
        label: Object.freeze({
          namespace: 'cordisx.manager.extension-points',
          key: 'manager.settings.navigation-group.development',
          fallback: 'Development',
        }),
        order: 200,
      }),
      Object.freeze({
        id: 'collaboration',
        label: Object.freeze({
          namespace: 'cordisx.manager.extension-points',
          key: 'manager.settings.navigation-group.collaboration',
          fallback: 'Collaboration',
        }),
        order: 300,
      }),
      Object.freeze({
        id: 'external-accounts',
        label: Object.freeze({
          namespace: 'cordisx.manager.extension-points',
          key: 'manager.settings.navigation-group.external-accounts',
          fallback: 'External accounts',
        }),
        order: 400,
      }),
      Object.freeze({
        id: 'other',
        label: Object.freeze({
          namespace: 'cordisx.manager.extension-points',
          key: 'manager.settings.navigation-group.other',
          fallback: 'Other',
        }),
        order: 1000,
      }),
    ] as const,
  ),
  fallbackGroup: 'other',
}) satisfies ManagerSettingsNavigationGroupCatalogV2

/**
 * Pure input shape for the Manager navigation projection.
 * `id` is the owner-qualified contribution id, never the local plugin id.
 */
export interface ManagerSettingsNavigationSortable {
  readonly group: ManagerSettingsNavigationGroup
  readonly navigationGroup?: ManagerNavigationVisualGroup
  readonly order: number
  readonly owner: string
  readonly id: string
}

const INSERTION_GROUP_RANK: Readonly<Record<ManagerSettingsNavigationGroup, number>> = Object.freeze({
  'before-settings': 0,
  'after-settings': 1,
})

const VISUAL_GROUP_RANK = new Map(
  CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.groups.map(group => [group.id, group.order]),
)

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Visual group, insertion seam, contribution order and stable identity define the exact order. */
export function compareManagerSettingsNavigationItems(
  left: ManagerSettingsNavigationSortable,
  right: ManagerSettingsNavigationSortable,
): number {
  const leftVisualGroup = left.navigationGroup ?? CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.fallbackGroup
  const rightVisualGroup = right.navigationGroup ?? CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.fallbackGroup
  return (VISUAL_GROUP_RANK.get(leftVisualGroup) ?? Number.MAX_SAFE_INTEGER)
      - (VISUAL_GROUP_RANK.get(rightVisualGroup) ?? Number.MAX_SAFE_INTEGER)
    || compareCodeUnits(leftVisualGroup, rightVisualGroup)
    || INSERTION_GROUP_RANK[left.group] - INSERTION_GROUP_RANK[right.group]
    || left.order - right.order
    || compareCodeUnits(left.owner, right.owner)
    || compareCodeUnits(left.id, right.id)
}

/** Returns an immutable sorted copy and never mutates the registry/runtime snapshot. */
export function sortManagerSettingsNavigationItems<T extends ManagerSettingsNavigationSortable>(
  items: readonly T[],
): readonly T[] {
  return Object.freeze([...items].sort(compareManagerSettingsNavigationItems))
}

export interface ManagerSettingsNavigationProjectionInput {
  readonly owner: string
  readonly id: string
  readonly group: ManagerSettingsNavigationGroup
  readonly order: number
  readonly navigationGroup?: ManagerNavigationVisualGroup
  readonly surfaceProvenance: ManagerSettingsNavigationSurfaceProvenanceV3
}

/** Host-generated public diagnostic projection; runtime provenance is never inferred. */
export function projectManagerSettingsNavigation(
  inputs: readonly ManagerSettingsNavigationProjectionInput[],
): ManagerSettingsNavigationProjectionV3 {
  return Object.freeze({
    $schema: CORDISX_MANAGER_SETTINGS_NAVIGATION_PROJECTION_SCHEMA_V3,
    contract: 'cordisx.manager-settings-navigation-projection/v3',
    schemaVersion: 3,
    catalog: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG,
    contributions: Object.freeze(inputs.map((input): ManagerSettingsNavigationContributionProjectionV3 => {
      const base = {
        owner: input.owner,
        id: input.id,
        insertionGroup: input.group,
        order: input.order,
      } as const
      if (input.surfaceProvenance.kind === 'legacy-unversioned') {
        return Object.freeze({
          ...base,
          surfaceProvenance: input.surfaceProvenance,
          effectiveGroup: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.fallbackGroup,
          assignment: 'legacy-fallback',
        })
      }
      if (input.navigationGroup === undefined) {
        return Object.freeze({
          ...base,
          surfaceProvenance: input.surfaceProvenance,
          effectiveGroup: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.fallbackGroup,
          assignment: 'unassigned-fallback',
        })
      }
      if (input.surfaceProvenance.schemaVersion === 9) {
        if (input.navigationGroup === 'external-accounts') {
          throw new Error('surface-contribution.v9 cannot declare external-accounts')
        }
        return Object.freeze({
          ...base,
          surfaceProvenance: input.surfaceProvenance,
          declaredGroup: input.navigationGroup,
          effectiveGroup: input.navigationGroup,
          assignment: 'declared',
        })
      }
      return Object.freeze({
        ...base,
        surfaceProvenance: input.surfaceProvenance,
        declaredGroup: input.navigationGroup,
        effectiveGroup: input.navigationGroup,
        assignment: 'declared',
      })
    })),
  })
}

export const MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE = Object.freeze({
  kind: 'versioned',
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
  schemaVersion: 9,
}) satisfies ManagerSettingsNavigationSurfaceProvenanceV3

export const MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE_V11 = Object.freeze({
  kind: 'versioned',
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V11,
  schemaVersion: 11,
}) satisfies ManagerSettingsNavigationSurfaceProvenanceV3

export const MANAGER_SETTINGS_NAVIGATION_LEGACY_PROVENANCE = Object.freeze({
  kind: 'legacy-unversioned',
}) satisfies ManagerSettingsNavigationSurfaceProvenanceV3
