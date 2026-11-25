/** Normalize an explicitly configured browser origin without accepting a URL path or credentials. */
export function canonicalManagerBrowserOrigin(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw new Error()
    const url = new URL(value)
    if (
      url.protocol !== 'http:' && url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.origin === 'null'
    ) throw new Error()
    return url.origin
  } catch {
    throw new Error('MANAGER_ORIGIN_INVALID')
  }
}

/** Already-projected origins must use their canonical browser representation. */
export function isManagerBrowserOrigin(value: string): boolean {
  try {
    return canonicalManagerBrowserOrigin(value) === value
  } catch {
    return false
  }
}
