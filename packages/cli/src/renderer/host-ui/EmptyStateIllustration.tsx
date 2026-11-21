import { useMemo } from 'react'
import { type EmptyStateFamily, emptyStateIllustrations } from './empty-state-illustrations.js'
import { EMPTY_STATE_ILLUSTRATION_STYLES } from './empty-state-styles.js'

export function EmptyStateIllustration({ family, compact = false, search = false }: {
  readonly family: EmptyStateFamily
  readonly compact?: boolean
  readonly search?: boolean
}) {
  const asset = emptyStateIllustrations[family]
  // Memoize the trusted DOM, not the component export: native HMR calls function exports.
  const scene = useMemo(
    () => <span className="cxh-empty-illustration-scene" dangerouslySetInnerHTML={{ __html: asset.markup }} />,
    [asset.markup],
  )
  return (
    <span
      className="cxh-empty-illustration"
      data-empty-family={family}
      data-empty-size={compact ? 'compact' : 'hero'}
      data-empty-search={search || undefined}
      aria-hidden="true"
    >
      {scene}
    </span>
  )
}

/** Keep stylesheet text outside status/count seats, with the same real CSS inline imports. */
export function EmptyStateIllustrationStyles() {
  return <style>{EMPTY_STATE_ILLUSTRATION_STYLES}</style>
}
