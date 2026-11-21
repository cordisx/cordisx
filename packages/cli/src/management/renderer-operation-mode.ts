/** Operations the owner exposes as read-only to an independent renderer. */
export function isRendererManagementRead(kind: unknown): boolean {
  return kind === 'query' || kind === 'query-catalog' || kind === 'plugin-info'
}
