import { useState } from 'react'
import type { BrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import { rasterImageDataUrl } from '../raster-image.js'
import { HostBrandIcon } from './HostBrandIcon.js'

/** One shared decorative identity: account image first, platform badge lower-right. */
export function AccountIdentityVisual(
  { icon, avatar }: { readonly icon: BrandIconV1; readonly avatar?: RasterImageSnapshotV1 },
) {
  const [failedImage, setFailedImage] = useState<string>()
  const showAvatar = avatar !== undefined && failedImage !== avatar.data
  return (
    <span className="cxr-account-identity" data-has-avatar={showAvatar || undefined} aria-hidden="true">
      {showAvatar
        ? (
          <img
            className="cxr-account-identity-avatar"
            src={rasterImageDataUrl(avatar)}
            alt=""
            draggable={false}
            onError={() => setFailedImage(avatar.data)}
          />
        )
        : (
          <span className="cxr-account-identity-platform">
            <HostBrandIcon icon={icon} />
          </span>
        )}
      {showAvatar
        ? (
          <span className="cxr-account-identity-badge">
            <HostBrandIcon icon={icon} />
          </span>
        )
        : null}
    </span>
  )
}
