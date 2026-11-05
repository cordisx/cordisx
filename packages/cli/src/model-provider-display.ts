import { type BrandIconV1, cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import { isProviderBrandChoice, type ProviderBrandChoice } from './model-selector-branding.js'

/** Effective, read-only selector presentation. This never conveys service ownership. */
export interface ModelProviderDisplay {
  readonly providerId: string
  readonly title: string
  readonly icon: BrandIconV1
  readonly selectorBrand?: ProviderBrandChoice
}

export function cloneModelProviderDisplay(value: unknown): ModelProviderDisplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider display')
  const item = value as Record<string, unknown>
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
  if (
    Object.keys(item).some(key => !['providerId', 'title', 'icon', 'selectorBrand'].includes(key))
    || !text(item.providerId) || !text(item.title)
    || item.selectorBrand !== undefined && !isProviderBrandChoice(item.selectorBrand)
  ) throw new Error('Invalid provider display')
  return Object.freeze({
    providerId: item.providerId,
    title: item.title,
    icon: cloneBrandIconV1(item.icon),
    ...(item.selectorBrand === undefined ? {} : { selectorBrand: item.selectorBrand as ProviderBrandChoice }),
  })
}

/** Bad or ambiguous presentation must not make a healthy model service disappear. */
export function modelProviderDisplays(value: unknown): readonly ModelProviderDisplay[] {
  if (!Array.isArray(value) || value.length > 128) return []
  const rows = new Map<string, ModelProviderDisplay>()
  const duplicates = new Set<string>()
  for (const input of value) {
    try {
      const row = cloneModelProviderDisplay(input)
      if (rows.has(row.providerId)) duplicates.add(row.providerId)
      rows.set(row.providerId, row)
    } catch { /* Presentation is optional; retain the provider's normal fallback. */ }
  }
  return Object.freeze([...rows.values()].filter(row => !duplicates.has(row.providerId)))
}
