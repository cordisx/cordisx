import { BreadcrumbProjection } from './model.js'

/** Keep breadcrumb identity explicit when constrained instead of clipping ancestors. */
export function projectManagerBreadcrumbs(
  itemWidths: readonly number[],
  availableWidth: number,
  overflowWidth = 42,
): BreadcrumbProjection {
  const all = itemWidths.map((_, index) => index)
  if (itemWidths.length <= 2 || availableWidth <= 0) return { visible: all, overflow: [] }
  const total = itemWidths.reduce((sum, width) => sum + Math.max(0, width), 0)
  if (total <= availableWidth) return { visible: all, overflow: [] }

  const visible = new Set<number>([0, itemWidths.length - 1])
  let used = Math.max(0, itemWidths[0] ?? 0)
    + Math.max(0, itemWidths.at(-1) ?? 0)
    + Math.max(0, overflowWidth)
  for (let index = itemWidths.length - 2; index >= 1; index -= 1) {
    const width = Math.max(0, itemWidths[index] ?? 0)
    if (used + width > availableWidth) break
    visible.add(index)
    used += width
  }
  return {
    visible: all.filter(index => visible.has(index)),
    overflow: all.filter(index => index > 0 && index < itemWidths.length - 1 && !visible.has(index)),
  }
}
