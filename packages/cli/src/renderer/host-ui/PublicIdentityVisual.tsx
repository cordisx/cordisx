import type { IdentityVisualProps } from '../../ui.js'
import { AccountIdentityVisual } from './AccountIdentityVisual.js'
import { cloneRasterImageSnapshot } from '../raster-image.js'
import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'

/** Only bounded normalized image bytes are accepted; Host owns image error fallback and geometry. */
export function IdentityVisual({ icon, avatar, size = 40 }: IdentityVisualProps) {
  let image
  try {
    if (avatar) image = cloneRasterImageSnapshot(avatar)
  } catch { /* Use the platform icon. */ }
  const platform = cloneBrandIconV1(icon)
  return (
    <span className="cxr-ui-identity-visual" data-size={size}>
      <AccountIdentityVisual icon={platform} {...(image === undefined ? {} : { avatar: image })} />
    </span>
  )
}
