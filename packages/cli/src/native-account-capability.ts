export interface NativeAccountCapabilityDescriptor {
  readonly module: string
  readonly exportName: string
}

/** Serialized into the calling native context; never accepts a plugin-supplied module URL. */
export async function nativeAccountCapability(
  load: (url: string) => Promise<Record<string, unknown>> = url => import(/* @vite-ignore */ url),
  descriptor?: NativeAccountCapabilityDescriptor,
): Promise<{ module: string; native: { TW: { accessInputs: { readAccountInfo(): Promise<unknown> } } } }> {
  const urls = new Set<string>()
  for (const script of document.querySelectorAll('script[src]')) {
    const url = new URL(script.getAttribute('src')!, location.href)
    if (
      url.protocol === 'app:' && url.hostname === '-' && !url.username && !url.password && !url.search && !url.hash
      && /^\/assets\/app-initial-[^/]+\.js$/u.test(url.pathname)
    ) {
      urls.add(url.href)
    }
  }
  // The initial module can be dynamically loaded, so include the actual native resource timeline.
  for (const entry of performance.getEntriesByType('resource')) {
    const url = new URL(entry.name, location.href)
    if (
      url.protocol === 'app:' && url.hostname === '-' && !url.username && !url.password && !url.search && !url.hash
      && /^\/assets\/app-initial-[^/]+\.js$/u.test(url.pathname)
    ) {
      urls.add(url.href)
    }
  }
  if (urls.size !== 1) throw new Error('Native account capability: initial resource missing or ambiguous')
  const module = [...urls][0]!
  if (descriptor !== undefined && module !== descriptor.module) {
    throw new Error('Native account capability: resource changed')
  }
  const exports = await load(module)
  if (descriptor !== undefined) {
    const service = exports[descriptor.exportName] as
      | { accessInputs?: { readAccountInfo(): Promise<unknown> } }
      | undefined
    const inputs = service?.accessInputs
    if (typeof inputs?.readAccountInfo !== 'function') {
      throw new Error('Native account capability: typed reader missing')
    }
    return { module, native: { TW: { accessInputs: inputs } } }
  }
  const candidates: Array<{ accessInputs: { readAccountInfo(): Promise<unknown> } }> = []
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(exports))) {
    const value = descriptor.value
    if (!value || typeof value !== 'object') continue
    const inputs = Object.getOwnPropertyDescriptor(value, 'accessInputs')?.value
    if (inputs && typeof inputs.readAccountInfo === 'function') candidates.push(value)
  }
  if (candidates.length !== 1) throw new Error('Native account capability: typed reader missing or ambiguous')
  return { module, native: { TW: candidates[0]! } }
}
