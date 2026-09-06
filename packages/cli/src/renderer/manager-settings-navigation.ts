import type {
  ManagerSettingsNavigationGroupCatalogV1,
  ManagerSettingsNavigationGroupId,
  ManagerSettingsNavigationProjectionV2,
  ManagerSettingsNavigationSurfaceProvenanceV2,
} from '@cordisx/protocol/manager-settings-navigation/v2'
import { CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9 } from '../contracts.js'
import type { CordisXManagerSettingsNavigationGroup } from '../contracts.js'

export type ManagerSettingsNavigationGroup = CordisXManagerSettingsNavigationGroup
export type ManagerNavigationVisualGroup = ManagerSettingsNavigationGroupId

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUPS_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-groups.v1.schema.json' as const

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_PROJECTION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-projection.v2.schema.json' as const

export const CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG = Object.freeze({
  $schema: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUPS_SCHEMA_V1,
  contract: 'cordisx.manager-settings-navigation-groups/v1',
  schemaVersion: 1,
  groups: Object.freeze([
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
      id: 'other',
      label: Object.freeze({
        namespace: 'cordisx.manager.extension-points',
        key: 'manager.settings.navigation-group.other',
        fallback: 'Other',
      }),
      order: 1000,
    }),
  ] as const),
  fallbackGroup: 'other',
}) satisfies ManagerSettingsNavigationGroupCatalogV1

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
  readonly surfaceProvenance: ManagerSettingsNavigationSurfaceProvenanceV2
}

/** Host-generated public diagnostic projection; runtime provenance is never inferred. */
export function projectManagerSettingsNavigation(
  inputs: readonly ManagerSettingsNavigationProjectionInput[],
): ManagerSettingsNavigationProjectionV2 {
  return Object.freeze({
    $schema: CORDISX_MANAGER_SETTINGS_NAVIGATION_PROJECTION_SCHEMA_V2,
    contract: 'cordisx.manager-settings-navigation-projection/v2',
    schemaVersion: 2,
    catalog: CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG,
    contributions: Object.freeze(inputs.map(input => {
      const declaredGroup = input.navigationGroup
      const versioned = input.surfaceProvenance.kind === 'versioned'
      return Object.freeze({
        owner: input.owner,
        id: input.id,
        surfaceProvenance: input.surfaceProvenance,
        insertionGroup: input.group,
        ...(declaredGroup === undefined ? {} : { declaredGroup }),
        effectiveGroup: declaredGroup ?? CORDISX_MANAGER_SETTINGS_NAVIGATION_GROUP_CATALOG.fallbackGroup,
        assignment: declaredGroup === undefined
          ? versioned ? 'unassigned-fallback' as const : 'legacy-fallback' as const
          : 'declared' as const,
        order: input.order,
      })
    })),
  })
}

export const MANAGER_SETTINGS_NAVIGATION_VERSIONED_PROVENANCE = Object.freeze({
  kind: 'versioned',
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
  schemaVersion: 9,
}) satisfies ManagerSettingsNavigationSurfaceProvenanceV2

export const MANAGER_SETTINGS_NAVIGATION_LEGACY_PROVENANCE = Object.freeze({
  kind: 'legacy-unversioned',
}) satisfies ManagerSettingsNavigationSurfaceProvenanceV2
