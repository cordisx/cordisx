import { type ModuleNode, normalizePath, type ViteDevServer } from 'vite'

export const SHARED_MODULES = new Set([
  'cordisx/react',
  'cordisx/react/jsx-runtime',
  'cordisx/react/jsx-dev-runtime',
  'cordisx/ui',
])

export const COMMONJS_INTEROP_LEAVES = [
  'classnames',
  'dayjs',
  'debug',
  'extend',
  'hoist-non-react-statics',
  'prop-types',
  'raf',
  'react-fast-compare',
  'react-is',
  'style-to-js',
  'use-sync-external-store/shim',
  'use-sync-external-store/shim/index.js',
] as const

export const SHARED_REACT_INTEROP_LEAVES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
] as const

export const VITE_CLIENT_DISPOSER_SOURCE = `
const __cordisxDisposeViteHmr = async () => {
  for (const id of new Set([...sheetsMap.keys(), ...linkSheetsMap.keys()])) removeStyle(id);
  willUnload = true;
  await transport.connect().catch(() => undefined);
  await transport.disconnect();
  if (globalThis.__cordisxViteHmrDispose === __cordisxDisposeViteHmr) delete globalThis.__cordisxViteHmrDispose;
};
globalThis.__cordisxViteHmrDispose = __cordisxDisposeViteHmr;
`

/** Refresh plugin sources without invalidating shared React or Host importer identities. */
export function invalidateNativeVitePluginSources(
  graph: ViteDevServer['moduleGraph'],
  generation: { readonly realRoot: string; readonly realEntry: string },
  timestamp: number,
): void {
  const owned = new Set<ModuleNode>()
  const root = normalizePath(generation.realRoot).replace(/\/$/, '') + '/'
  const visit = (module: ModuleNode): void => {
    if (owned.has(module) || module.file === null) return
    const file = normalizePath(module.file)
    if (!file.startsWith(root) || file.includes('/node_modules/')) return
    owned.add(module)
    for (const dependency of module.importedModules) visit(dependency)
  }
  for (const entry of graph.getModulesByFile(generation.realEntry) ?? []) visit(entry)
  // Vite invalidation also walks importers. Stop that walk at the plugin boundary.
  const seen = new Set([...graph.idToModuleMap.values()].filter(module => !owned.has(module)))
  for (const module of owned) graph.invalidateModule(module, seen, timestamp, true)
}

/** Validate the complete plugin import graph before exposing its development generation. */
export async function validateNativeVitePlugin(
  server: ViteDevServer,
  virtualId: string,
  pluginId: string,
): Promise<void> {
  const validate = async (module: ModuleNode, seen = new Set<ModuleNode>()): Promise<void> => {
    if (seen.has(module)) return
    seen.add(module)
    await server.transformRequest(module.url)
    for (const dependency of module.importedModules) await validate(dependency, seen)
  }
  try {
    const request = '\0' + virtualId
    await server.transformRequest(request)
    const module = server.moduleGraph.getModuleById(request)
    if (module === undefined) throw new Error(`Vite did not create a module graph for plugin ${pluginId}`)
    await validate(module)
  } catch (error) {
    throw new Error(`Build failed for plugin ${pluginId}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}
