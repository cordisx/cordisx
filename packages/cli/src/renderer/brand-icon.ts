import type { BrandIconV1 } from '@cordisx/protocol/brand-icon/v1'

import { createHostSurfaceIcon, type HostIconRenderOptions } from './icons.js'
import { rasterImageDataUrl } from './raster-image.js'

export function createHostBrandIcon(
  document: Document,
  icon: BrandIconV1,
  options: HostIconRenderOptions = {},
): HTMLSpanElement {
  if (typeof icon === 'string') return createHostSurfaceIcon(document, icon, options)

  const container = document.createElement('span')
  container.className = 'cordisx-host-icon cordisx-brand-icon'
  container.dataset.brandIconKind = icon.kind
  container.setAttribute('aria-hidden', 'true')
  container.draggable = false

  const image = document.createElement('img')
  image.src = rasterImageDataUrl(icon.image)
  image.alt = ''
  image.setAttribute('aria-hidden', 'true')
  image.draggable = false
  container.append(image)
  return container
}
