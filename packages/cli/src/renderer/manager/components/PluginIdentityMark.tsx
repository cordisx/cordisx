import cordisxMarkDark from '../../../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../../assets/brand/cordisx-mark-light.svg'

type Accent = 'spectral' | 'polar' | 'solar' | 'violet' | 'ember' | 'jade'
type Appearance = 'dark' | 'light'
type Rgb = readonly [number, number, number]

interface InternalBadgePreset {
  readonly accent: Accent
}

const INTERNAL_BADGE_PRESETS: Readonly<Record<string, InternalBadgePreset>> = {
  'slot-showcase': { accent: 'spectral' },
  'hello-toolbar': { accent: 'solar' },
  'form-schema-gallery': { accent: 'violet' },
  'settings-tab-demo': { accent: 'polar' },
  'console-showcase': { accent: 'ember' },
  channel: { accent: 'jade' },
}

const PALETTES: Readonly<Record<Accent, readonly [Rgb, Rgb, Rgb]>> = {
  spectral: [[91, 124, 250], [67, 198, 239], [101, 230, 167]],
  polar: [[37, 99, 235], [34, 211, 238], [167, 243, 208]],
  solar: [[251, 113, 133], [251, 191, 36], [244, 114, 182]],
  violet: [[124, 58, 237], [167, 139, 250], [96, 165, 250]],
  ember: [[239, 68, 68], [249, 115, 22], [250, 204, 21]],
  jade: [[5, 150, 105], [45, 212, 191], [56, 189, 248]],
}

const badgeUriCache = new Map<string, string>()

function stablePhase(value: string): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return hash % 100
}

function numericAttribute(tag: string, name: string): number {
  const value = tag.match(new RegExp(`${name}="([\\d.]+)"`))?.[1]
  if (value === undefined) throw new Error(`CordisX mark is missing ${name}`)
  return Number(value)
}

function strokeColor(tag: string): Rgb {
  const value = tag.match(/stroke="#([\da-f]{6})"/i)?.[1]
  if (value === undefined) throw new Error('CordisX mark is missing stroke')
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function mix(left: Rgb, right: Rgb, amount: number): Rgb {
  return left.map((channel, index) => Math.round(channel + (right[index]! - channel) * amount)) as unknown as Rgb
}

function scale(color: Rgb, amount: number): Rgb {
  return color.map(channel => Math.round(channel * amount)) as unknown as Rgb
}

function paletteColor(palette: readonly [Rgb, Rgb, Rgb], position: number): Rgb {
  return position <= .5
    ? mix(palette[0], palette[1], position * 2)
    : mix(palette[1], palette[2], (position - .5) * 2)
}

function toHex(color: Rgb): string {
  return `#${color.map(channel => clamp(channel, 0, 255).toString(16).padStart(2, '0')).join('')}`
}

/** Recolors the approved 1,440-segment mark while retaining its exact geometry, widths, ordering, and depth shading. */
function derivedMarkUri(id: string, preset: InternalBadgePreset, appearance: Appearance): string {
  const cacheKey = `${id}:${preset.accent}:${appearance}`
  const cached = badgeUriCache.get(cacheKey)
  if (cached !== undefined) return cached
  const source = appearance === 'dark' ? cordisxMarkDark : cordisxMarkLight
  const palette = PALETTES[preset.accent]
  const angle = stablePhase(id) / 100 * Math.PI * 2
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const recolored = source.replace(/<line\b[^>]*\/>/g, tag => {
    const x = (numericAttribute(tag, 'x1') + numericAttribute(tag, 'x2')) / 2 - 512
    const y = (numericAttribute(tag, 'y1') + numericAttribute(tag, 'y2')) / 2 - 512
    const position = clamp(.5 + (x * cosine + y * sine) / 1448)
    const sourceRgb = strokeColor(tag)
    const gray = (sourceRgb[0] + sourceRgb[1] + sourceRgb[2]) / 3
    const depth = appearance === 'dark' ? clamp((gray - 123) / 129) : clamp((139 - gray) / 136)
    const base = paletteColor(palette, position)
    const shaded = appearance === 'dark'
      ? mix(scale(base, .56), mix(base, [255, 255, 255], .18), depth)
      : mix(mix(base, [255, 255, 255], .22), scale(base, .56), depth)
    return tag.replace(/stroke="#[\da-f]{6}"/i, `stroke="${toHex(shaded)}"`)
  })
    .replace(/<title[^>]*>.*?<\/title>/, `<title>CordisX ${id} mark</title>`)
    .replace(/<desc[^>]*>.*?<\/desc>/, '<desc>CordisX official three-ring geometry with plugin-specific segment shading.</desc>')
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(recolored)}`
  badgeUriCache.set(cacheKey, uri)
  return uri
}

/** Host-owned plugin mark with official CordisX geometry, stable color variants, and external image support. */
export function PluginIdentityMark({ pluginId, name, icon }: {
  readonly pluginId: string
  readonly name: string
  readonly icon?: string | undefined
}) {
  if (icon !== undefined) return <img src={icon} alt="" />
  const preset = INTERNAL_BADGE_PRESETS[pluginId]
  if (preset === undefined) return <>{name.slice(0, 2).toLocaleUpperCase()}</>
  return <span className="cxr-plugin-badge" data-accent={preset.accent} data-brand-geometry="official-1440-segments" data-gradient-mode="segment-depth" data-gradient-phase={stablePhase(pluginId)} data-internal-plugin-badge={pluginId} aria-hidden="true">
    <img className="cxr-plugin-badge-dark" src={derivedMarkUri(pluginId, preset, 'dark')} alt="" draggable={false} />
    <img className="cxr-plugin-badge-light" src={derivedMarkUri(pluginId, preset, 'light')} alt="" draggable={false} />
  </span>
}
