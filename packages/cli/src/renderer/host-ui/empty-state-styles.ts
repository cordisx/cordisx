import emptyStateCss from './empty-state.css?inline'
import themeCss from './empty-state-illustration-theme.css?inline'
import { emptyStateIllustrations } from './empty-state-illustrations.js'

/** Reuse the Host's existing artwork and status styles in both presentations. */
export const EMPTY_STATE_STYLES = emptyStateCss
export const EMPTY_STATE_ILLUSTRATION_STYLES = themeCss + '\n'
  + Object.values(emptyStateIllustrations).map(asset => asset.styles).join('\n')
