export interface NativeAccountCapabilityDescriptor {
  readonly module: string
  readonly exportName: string
  readonly readerProperty?: 'accessInputs' | 'accountInfo'
  readonly rspack?: { readonly moduleId: string; readonly definitionModule: string }
}

/** Serialized into the calling native context; never accepts a plugin-supplied module URL. */
export async function nativeAccountCapability(
  load: (url: string) => Promise<Record<string, unknown>> = url => import(/* @vite-ignore */ url),
  descriptor?: NativeAccountCapabilityDescriptor,
): Promise<{ module: string; native: { TW: { accessInputs: { readAccountInfo(): Promise<unknown> } } } }> {
  const rspack = descriptor?.rspack
  if (descriptor !== undefined) {
    const target = new URL(descriptor.module)
    const pathAllowed = rspack
      ? /^\/assets\/[A-Za-z0-9_-]+\.[a-f0-9]{8,64}\.js$/u.test(target.pathname)
      : /^\/assets\/app-(?:initial|shared)-[^/]+\.js$/u.test(target.pathname)
    if (
      target.protocol !== 'app:' || target.hostname !== '-' || target.username || target.password || target.search
      || target.hash || !pathAllowed
    ) {
      throw new Error('Native account capability: invalid resource')
    }
    if (rspack) {
      const definition = new URL(rspack.definitionModule)
      if (
        descriptor.exportName !== '__webpack_require__' || descriptor.readerProperty !== 'accountInfo'
        || !/^[A-Za-z0-9_$-]{1,64}$/u.test(rspack.moduleId)
        || definition.protocol !== 'app:' || definition.hostname !== '-' || definition.username
        || definition.password || definition.search || definition.hash
        || !/^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.[a-f0-9]{8,64}\.js$/u.test(definition.pathname)
      ) throw new Error('Native account capability: invalid resource')
    }
  }
  const urls = new Set<string>()
  for (const script of document.querySelectorAll('script[src]')) {
    const url = new URL(script.getAttribute('src')!, location.href)
    if (
      url.protocol === 'app:' && url.hostname === '-' && !url.username && !url.password && !url.search && !url.hash
      && (descriptor !== undefined
        ? url.href === descriptor.module
        : /^\/assets\/app-initial-[^/]+\.js$/u.test(url.pathname))
    ) {
      urls.add(url.href)
    }
  }
  // The initial module can be dynamically loaded, so include the actual native resource timeline.
  for (const entry of performance.getEntriesByType('resource')) {
    const url = new URL(entry.name, location.href)
    if (
      url.protocol === 'app:' && url.hostname === '-' && !url.username && !url.password && !url.search && !url.hash
      && (descriptor !== undefined
        ? url.href === descriptor.module
        : /^\/assets\/app-initial-[^/]+\.js$/u.test(url.pathname))
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
    let selected: unknown = exports[descriptor.exportName]
    if (rspack) {
      if (typeof selected !== 'function') throw new Error('Native account capability: typed reader missing')
      const require = selected as { readonly c?: Record<string, { readonly exports?: object }> } | undefined
      const cached = require?.c && Object.getOwnPropertyDescriptor(require.c, rspack.moduleId)?.value as
        | { readonly exports?: object }
        | undefined
      const serviceExport = cached?.exports && Object.getOwnPropertyDescriptor(cached.exports, 'appServices')
      selected = serviceExport?.get ? serviceExport.get.call(cached!.exports) : serviceExport?.value
    }
    const service = selected as
      | {
        accessInputs?: { readAccountInfo(): Promise<unknown> }
        accountInfo?: { readAccountInfo(): Promise<unknown> }
      }
      | undefined
    const property = descriptor.readerProperty ?? 'accessInputs'
    if (property !== 'accessInputs' && property !== 'accountInfo') {
      throw new Error('Native account capability: invalid reader')
    }
    const inputs = rspack && service
      ? Object.getOwnPropertyDescriptor(service, property)?.value as { readAccountInfo(): Promise<unknown> } | undefined
      : service?.[property]
    if (typeof inputs?.readAccountInfo !== 'function') {
      throw new Error('Native account capability: typed reader missing')
    }
    return { module, native: { TW: { accessInputs: inputs } } }
  }
  const candidates: Array<{ readAccountInfo(): Promise<unknown> }> = []
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(exports))) {
    const value = descriptor.value
    if (!value || typeof value !== 'object') continue
    for (const property of ['accessInputs', 'accountInfo']) {
      const inputs = Object.getOwnPropertyDescriptor(value, property)?.value
      if (inputs && typeof inputs.readAccountInfo === 'function') candidates.push(inputs)
    }
  }
  if (candidates.length !== 1) throw new Error('Native account capability: typed reader missing or ambiguous')
  return { module, native: { TW: { accessInputs: candidates[0]! } } }
}
