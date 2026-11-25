import { parseManagerRendererGraph } from '../independent-manager/graph-stage-loader.js'
import { isManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'
import type { CordisXConfigPlugin } from './config.js'

type RuntimeGraph = NonNullable<CordisXConfigPlugin['runtimeGraph']>
const issued = new WeakMap<RuntimeGraph, Readonly<{ origin: string; pluginId: string; generation: string }>>()

/**
 * Build a composition fragment solely from a sidecar-projected, same-origin
 * graph descriptor. The result is a trusted Node-local value, never a
 * browser-supplied source string or a serialized owner lease.
 */
export function createStandaloneRuntimeGraph(descriptor: unknown, origin: string): RuntimeGraph {
  if (!isManagerBrowserOrigin(origin)) throw new Error('Standalone Manager graph origin is invalid')
  const graph = parseManagerRendererGraph(descriptor, origin)
  const registry = 'globalThis.__cordisxPluginGenerationResourcesV1'
  const stage = JSON.stringify({ id: graph.leaseId, baseUrl: graph.baseUrl, initialStyles: graph.initialStyleUrls })
  const id = JSON.stringify(graph.leaseId)
  const value: RuntimeGraph = Object.freeze({
    moduleGeneration: graph.moduleGeneration,
    loadSource:
      `(async () => { const registry = ${registry}; if (!registry) throw new Error('plugin graph registry unavailable'); const lease = registry.stage(${stage}); try { await lease.ready; return await import(${
        JSON.stringify(graph.entryUrl)
      }); } catch (error) { registry.retire(${id}); throw error; } })()`,
    publishSource:
      `(() => { const registry = ${registry}; if (!registry || registry.publish(${id}) !== true) throw new Error('plugin graph publication failed'); return true; })()`,
    retireSource:
      `(() => { const registry = ${registry}; if (!registry || registry.retire(${id}) !== true) throw new Error('plugin graph retirement failed'); return true; })()`,
  })
  issued.set(value, { origin, pluginId: graph.pluginId, generation: graph.moduleGeneration })
  return value
}

/** Check the exact in-process value and its owner-scoped identity. */
export function isStandaloneRuntimeGraph(
  value: RuntimeGraph | undefined,
  expected: { readonly origin: string; readonly pluginId: string; readonly generation: string },
): boolean {
  if (value === undefined) return false
  const item = issued.get(value)
  return item?.origin === expected.origin && item.pluginId === expected.pluginId
    && item.generation === expected.generation && value.moduleGeneration === expected.generation
}
