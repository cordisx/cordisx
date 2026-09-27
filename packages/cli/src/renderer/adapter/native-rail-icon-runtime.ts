/** Private native React seam. Every probe is structural; a changed bundle fails closed. */
export const MINIMUM_NATIVE_RAIL_ICON_APP_VERSION = '26.924.22138'

export interface NativeRailReact {
  readonly version: string
  createElement(type: unknown): unknown
  isValidElement(value: unknown): boolean
}

export interface NativeRailReactRoot {
  render(element: unknown): void
  unmount(): void
}

export interface NativeRailReactDOM {
  createRoot(container: Element, options?: { onUncaughtError(error: unknown): void }): NativeRailReactRoot
}

export interface NativeRailRuntime {
  readonly react: NativeRailReact
  readonly reactDOM: NativeRailReactDOM
  readonly assetUrl: string
}

export interface NativeRailRuntimeIO {
  readSource(url: string): Promise<string>
  importModule(url: string): Promise<Record<string, unknown>>
}

function versionParts(version: string): number[] | undefined {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) return undefined
  const parts = version.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

export function nativeRailIconVersionAllowed(version: string): boolean {
  const actual = versionParts(version)
  const minimum = versionParts(MINIMUM_NATIVE_RAIL_ICON_APP_VERSION)!
  if (actual === undefined) return false
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! !== minimum[index]!) return actual[index]! > minimum[index]!
  }
  return true
}

/** Find the two already-loaded CommonJS wrappers from this bundle's own ESM export table. */
export function nativeRailReactExportNames(source: string): { react: string; reactDOM: string } | undefined {
  if (source.length < 100 || source.length > 12_000_000) return undefined
  const factory = source.match(/var ([\w$]+)=i\(\(e=>\{var t=Symbol\.for\(`react\.transitional\.element`\)/u)?.[1]
  const domAnchor = source.indexOf('rendererPackageName:`react-dom`')
  if (factory === undefined || domAnchor < 0 || source.indexOf('rendererPackageName:`react-dom`', domAnchor + 1) >= 0) {
    return undefined
  }
  const reactPattern = new RegExp(`,\\s*([\\w$]+)=i\\(\\(\\(e,t\\)=>\\{t\\.exports=${factory}\\(\\)\\}\\)\\)`, 'u')
  const reactLocal = reactPattern.exec(source.slice(0, 20_000))?.[1]
  const domSection = source.slice(domAnchor, domAnchor + 3_000)
  if (!domSection.includes('e.createRoot=function')) return undefined
  const domLocal = /,\s*([\w$]+)=i\(\(\(e,t\)=>\{[\s\S]{0,700}?t\.exports=[\w$]+\(\)\}\)\)/u.exec(domSection)?.[1]
  const table = source.slice(source.lastIndexOf('export{'))
  if (reactLocal === undefined || domLocal === undefined || !table.startsWith('export{')) return undefined
  const exports = new Map([...table.matchAll(/([\w$]+) as ([\w$]+)/gu)].map(match => [match[1]!, match[2]!]))
  const react = exports.get(reactLocal)
  const reactDOM = exports.get(domLocal)
  return react !== undefined && reactDOM !== undefined && react !== reactDOM ? { react, reactDOM } : undefined
}

function appSharedAsset(document: Document): string | undefined {
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[href]')]
    .map(link => {
      try {
        return new URL(link.href, document.baseURI)
      } catch {
        return undefined
      }
    })
    .filter((url): url is URL =>
      url !== undefined && url.protocol === 'app:' && url.hostname === '-'
      && /^\/assets\/app-shared-[0-9a-f]+\.js$/u.test(url.pathname)
    )
  return links.length === 1 ? links[0]!.href : undefined
}

const defaultIO: NativeRailRuntimeIO = {
  readSource: async url => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('native module source unavailable')
    return await response.text()
  },
  importModule: async url => await import(/* @vite-ignore */ url) as Record<string, unknown>,
}

const runtimeCache = new WeakMap<Document, NativeRailRuntime>()

/** A minimum tested build is required; higher builds run the same strict capability checks. */
export async function loadNativeRailRuntime(
  document: Document,
  appVersion: string,
  io: NativeRailRuntimeIO = defaultIO,
): Promise<NativeRailRuntime | undefined> {
  if (!nativeRailIconVersionAllowed(appVersion) || document.defaultView?.location.href !== 'app://-/index.html') {
    return undefined
  }
  const assetUrl = appSharedAsset(document)
  if (assetUrl === undefined) return undefined
  const cached = runtimeCache.get(document)
  if (cached?.assetUrl === assetUrl) return cached
  try {
    const names = nativeRailReactExportNames(await io.readSource(assetUrl))
    if (names === undefined) return undefined
    const namespace = await io.importModule(assetUrl)
    const reactFactory = namespace[names.react]
    const domFactory = namespace[names.reactDOM]
    if (typeof reactFactory !== 'function' || typeof domFactory !== 'function') return undefined
    const react = (reactFactory as () => unknown)()
    const reactDOM = (domFactory as () => unknown)()
    if (
      react === null || typeof react !== 'object' || reactDOM === null || typeof reactDOM !== 'object'
      || typeof (react as NativeRailReact).createElement !== 'function'
      || typeof (react as NativeRailReact).isValidElement !== 'function'
      || typeof (react as NativeRailReact).version !== 'string'
      || typeof (reactDOM as NativeRailReactDOM).createRoot !== 'function'
    ) return undefined
    const runtime = { react: react as NativeRailReact, reactDOM: reactDOM as NativeRailReactDOM, assetUrl }
    if (io === defaultIO) runtimeCache.set(document, runtime)
    return runtime
  } catch {
    return undefined
  }
}
