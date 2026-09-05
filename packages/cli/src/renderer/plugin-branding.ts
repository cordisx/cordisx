import type { CordisXPluginBrandIcon } from '../contracts.js'

const MAX_BRAND_ICON_BASE64_LENGTH = 400_000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Project trusted local-plugin metadata into an image URL that Host chrome can render safely. */
export function pluginBrandIconDataUrl(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const icon = value as Partial<CordisXPluginBrandIcon> & Record<string, unknown>
  if (Object.keys(icon).some(key => key !== 'mediaType' && key !== 'data')) return undefined
  if (icon.mediaType !== 'image/png' && icon.mediaType !== 'image/webp') return undefined
  if (
    typeof icon.data !== 'string'
    || icon.data.length < 32
    || icon.data.length > MAX_BRAND_ICON_BASE64_LENGTH
    || icon.data.length % 4 !== 0
    || !BASE64.test(icon.data)
  ) return undefined
  return `data:${icon.mediaType};base64,${icon.data}`
}
