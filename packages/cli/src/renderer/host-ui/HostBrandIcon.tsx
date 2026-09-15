import type { BrandIconV1 } from '@cordisx/protocol/brand-icon/v1'

import type { HostIconState } from '../icons.js'
import { rasterImageDataUrl } from '../raster-image.js'
import { HostSurfaceIcon } from './HostSurfaceIcon.js'

export function HostBrandIcon(
  { icon, state }: { readonly icon: BrandIconV1; readonly state?: HostIconState },
) {
  if (typeof icon === 'string') {
    return <HostSurfaceIcon token={icon} {...(state === undefined ? {} : { state })} />
  }
  return (
    <span className="cordisx-host-icon cordisx-brand-icon" data-brand-icon-kind={icon.kind} aria-hidden="true">
      <img src={rasterImageDataUrl(icon.image)} alt="" aria-hidden="true" draggable={false} />
    </span>
  )
}
