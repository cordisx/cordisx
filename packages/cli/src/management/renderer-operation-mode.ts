/** Operations the owner exposes as read-only to an independent renderer. */
export function isRendererManagementRead(kind: unknown): boolean {
  return kind === 'query' || kind === 'query-catalog' || kind === 'plugin-info'
}

/** Invalid envelopes are not dispatched; all other operations retain write uncertainty. */
export function rendererManagementWrite(payload: string): boolean | undefined {
  try {
    const value: unknown = JSON.parse(payload)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const operation = (value as { operation?: unknown }).operation
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined
    const kind = (operation as { kind?: unknown }).kind
    return typeof kind === 'string' ? !isRendererManagementRead(kind) : undefined
  } catch {
    return undefined
  }
}
