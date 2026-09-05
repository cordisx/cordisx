import type { CordisXRouteReference } from '../../../contracts.js'
import type { ManagerContentPresentation } from '../../navigation.js'

export interface ManagerContentBreadcrumbSegment {
  readonly label: string
  readonly reference: CordisXRouteReference
}

function referenceKey(reference: CordisXRouteReference): string {
  return `${reference.id}\u0000${
    JSON.stringify(Object.entries(reference.params ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  }`
}

/** Projects plugin-declared parent routes into Host-owned breadcrumb segments. */
export function projectManagerContentBreadcrumbs(options: {
  readonly current: CordisXRouteReference
  readonly root?: CordisXRouteReference
  readonly rootLabel: string
  readonly presentation: (reference: CordisXRouteReference) => ManagerContentPresentation | undefined
}): readonly ManagerContentBreadcrumbSegment[] {
  const rootKey = options.root === undefined ? undefined : referenceKey(options.root)
  const segments: ManagerContentBreadcrumbSegment[] = []
  const visited = new Set<string>()
  let reference = options.current
  while (true) {
    const key = referenceKey(reference)
    if (visited.has(key)) break
    visited.add(key)
    const presentation = options.presentation(reference)
    if (presentation === undefined) break
    segments.unshift({
      label: key === rootKey ? options.rootLabel : presentation.title,
      reference,
    })
    if (presentation.parent === undefined) break
    reference = presentation.parent
  }
  return segments
}
