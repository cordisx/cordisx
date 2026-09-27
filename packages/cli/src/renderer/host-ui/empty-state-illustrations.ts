import svg0 from '../../../assets/illustrations/empty-state/v4-flat/plugins.svg?raw'
import css0 from '../../../assets/illustrations/empty-state/v4-flat/plugins.css?inline'
import svg1 from '../../../assets/illustrations/empty-state/v4-flat/model-services.svg?raw'
import css1 from '../../../assets/illustrations/empty-state/v4-flat/model-services.css?inline'
import svg2 from '../../../assets/illustrations/empty-state/v4-flat/marketplace.svg?raw'
import css2 from '../../../assets/illustrations/empty-state/v4-flat/marketplace.css?inline'
import svg3 from '../../../assets/illustrations/empty-state/v4-flat/marketplace-sources.svg?raw'
import css3 from '../../../assets/illustrations/empty-state/v4-flat/marketplace-sources.css?inline'
import svg4 from '../../../assets/illustrations/empty-state/v4-flat/plugin-bundles.svg?raw'
import css4 from '../../../assets/illustrations/empty-state/v4-flat/plugin-bundles.css?inline'
import svg5 from '../../../assets/illustrations/empty-state/v4-flat/hidden-marketplace-plugins.svg?raw'
import css5 from '../../../assets/illustrations/empty-state/v4-flat/hidden-marketplace-plugins.css?inline'
import svg6 from '../../../assets/illustrations/empty-state/v4-flat/extension-points.svg?raw'
import css6 from '../../../assets/illustrations/empty-state/v4-flat/extension-points.css?inline'
import svg7 from '../../../assets/illustrations/empty-state/v4-flat/routes.svg?raw'
import css7 from '../../../assets/illustrations/empty-state/v4-flat/routes.css?inline'
import svg8 from '../../../assets/illustrations/empty-state/v4-flat/notification-rules.svg?raw'
import css8 from '../../../assets/illustrations/empty-state/v4-flat/notification-rules.css?inline'
import svg9 from '../../../assets/illustrations/empty-state/v4-flat/acknowledgements.svg?raw'
import css9 from '../../../assets/illustrations/empty-state/v4-flat/acknowledgements.css?inline'

/** Immutable, trusted Host artwork approved as V4-flat. No runtime or remote SVG input. */
export const emptyStateIllustrations = {
  'plugins': { markup: svg0, styles: css0 },
  'model-services': { markup: svg1, styles: css1 },
  'marketplace': { markup: svg2, styles: css2 },
  'marketplace-sources': { markup: svg3, styles: css3 },
  'plugin-bundles': { markup: svg4, styles: css4 },
  'hidden-marketplace-plugins': { markup: svg5, styles: css5 },
  'extension-points': { markup: svg6, styles: css6 },
  'routes': { markup: svg7, styles: css7 },
  'notification-rules': { markup: svg8, styles: css8 },
  'acknowledgements': { markup: svg9, styles: css9 },
} as const

export type EmptyStateFamily = keyof typeof emptyStateIllustrations
