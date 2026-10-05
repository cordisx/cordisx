/** Keep a plugin and its context-service dependency component in one cleanup boundary. */
export function managedServiceStartupGroups<T>(
  states: readonly T[],
  pluginKey: (state: T) => string,
  dependencies: (state: T) => readonly T[],
): readonly (readonly T[])[] {
  const neighbors = new Map(states.map(state => [state, new Set<T>()]))
  const owners = new Map<string, T>()
  for (const state of states) {
    const key = pluginKey(state)
    const sibling = owners.get(key)
    owners.set(key, state)
    for (const dependency of [...dependencies(state), ...(sibling === undefined ? [] : [sibling])]) {
      neighbors.get(state)!.add(dependency)
      neighbors.get(dependency)!.add(state)
    }
  }
  const remaining = new Set(states)
  const groups: T[][] = []
  for (const state of states) {
    if (!remaining.has(state)) continue
    const component = new Set<T>()
    const pending = [state]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (!remaining.delete(current)) continue
      component.add(current)
      pending.push(...neighbors.get(current)!)
    }
    groups.push(states.filter(item => component.has(item)))
  }
  return groups
}
