import type { CordisXManagerSettingsNavigationGroup } from '../contracts.js'

export type ManagerSettingsNavigationGroup = CordisXManagerSettingsNavigationGroup

/**
 * Pure input shape for the Manager navigation projection.
 * `id` is the owner-qualified contribution id, never the local plugin id.
 */
export interface ManagerSettingsNavigationSortable {
  readonly group: ManagerSettingsNavigationGroup
  readonly order: number
  readonly owner: string
  readonly id: string
}

const GROUP_RANK: Readonly<Record<ManagerSettingsNavigationGroup, number>> = Object.freeze({
  'before-settings': 0,
  'after-settings': 1,
})

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Fixed-group, deterministic comparison; locale and registration time never participate. */
export function compareManagerSettingsNavigationItems(
  left: ManagerSettingsNavigationSortable,
  right: ManagerSettingsNavigationSortable,
): number {
  return GROUP_RANK[left.group] - GROUP_RANK[right.group]
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
