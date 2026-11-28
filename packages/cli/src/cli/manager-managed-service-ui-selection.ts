type Identity = { readonly pluginId: string; readonly pluginGeneration: string }
type Capability = Identity & { readonly token: string; readonly startup?: true }

/** Select only owner-approved graphs and reject a stale generation. */
export function selectManagedServiceCapabilities<T extends Identity>(
  capabilities: readonly T[],
  allowedOwners?: ReadonlyMap<string, string>,
): readonly T[] {
  if (allowedOwners === undefined) return capabilities
  const selected = capabilities.filter(item => allowedOwners.has(item.pluginId))
  if (selected.some(item => allowedOwners.get(item.pluginId) !== item.pluginGeneration)) {
    throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
  }
  return selected
}

export function sameManagedServiceIdentities(left: readonly Identity[], right: readonly Identity[]): boolean {
  return left.length === right.length
    && left.every(a => right.some(b => a.pluginId === b.pluginId && a.pluginGeneration === b.pluginGeneration))
}

export function sameCapabilities(left: readonly Capability[], right: readonly Capability[]): boolean {
  return left.length === right.length
    && left.every(a =>
      right.some(b =>
        a.pluginId === b.pluginId && a.pluginGeneration === b.pluginGeneration && a.token === b.token
        && a.startup === b.startup
      )
    )
}
