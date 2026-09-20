export interface MarketplaceSourceReference {
  readonly url: string
  readonly enabled: boolean
  readonly local?: { readonly name?: string }
}

export class MarketplaceSourceReferenceError extends Error {
  constructor(readonly code: 'not-found' | 'ambiguous-selection' | 'source-disabled', message: string) {
    super(message)
    this.name = 'MarketplaceSourceReferenceError'
  }
}

/** Resolve a CLI source selector only from the selected profile's Host-owned projection. */
export function resolveMarketplaceSourceReference(
  sources: readonly MarketplaceSourceReference[],
  reference: string,
): string {
  try {
    const url = new URL(reference)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch { /* non-URL values are resolved as configured local names */ }
  const matches = sources.filter(source => source.local?.name === reference)
  if (matches.length === 0) {
    throw new MarketplaceSourceReferenceError('not-found', `marketplace source name was not found: ${reference}`)
  }
  if (matches.length > 1) {
    throw new MarketplaceSourceReferenceError(
      'ambiguous-selection',
      `marketplace source name is ambiguous; use its URL: ${reference}`,
    )
  }
  const source = matches[0]!
  if (!source.enabled) {
    throw new MarketplaceSourceReferenceError('source-disabled', `marketplace source is disabled: ${reference}`)
  }
  return source.url
}
