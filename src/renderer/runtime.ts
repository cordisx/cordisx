import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { CordisXBrowserPlugin, CordisXPluginModule } from '../contracts.js'
import { CordisXService } from './service.js'

interface CordisXRuntimeHandle {
  readonly pluginIds: readonly string[]
  dispose(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxRuntime: CordisXRuntimeHandle | undefined
  // eslint-disable-next-line no-var
  var __cordisxBoot: Promise<CordisXRuntimeHandle> | undefined
}

function pluginFromModule(module: CordisXPluginModule): Plugin {
  if (typeof module.apply === 'function') return module as Plugin.Object
  const fallback = module.default
  if (typeof fallback === 'function') return fallback as Plugin
  if (fallback !== null && typeof fallback === 'object' && typeof (fallback as { apply?: unknown }).apply === 'function') {
    return fallback as Plugin.Object
  }
  throw new Error('CordisX plugin module must export apply() or a default Cordis plugin')
}

async function start(plugins: readonly CordisXBrowserPlugin[]): Promise<CordisXRuntimeHandle> {
  await globalThis.__cordisxRuntime?.dispose()

  const ctx = new Context()
  const fibers: Fiber[] = []
  const dispose = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    fibers.length = 0
    if (globalThis.__cordisxRuntime === handle) globalThis.__cordisxRuntime = undefined
    document.documentElement.removeAttribute('data-cordisx-ready')
  }
  const handle: CordisXRuntimeHandle = { pluginIds: plugins.map(plugin => plugin.id), dispose }

  try {
    const service = ctx.plugin(CordisXService)
    fibers.push(service)
    await service
    for (const item of plugins) {
      const fiber = ctx.plugin(pluginFromModule(item.module), item.config)
      fibers.push(fiber)
      await fiber
    }
  } catch (error) {
    await dispose()
    throw error
  }

  globalThis.__cordisxRuntime = handle
  document.documentElement.dataset.cordisxReady = 'true'
  console.info(`[cordisx] mounted ${plugins.length} plugin(s): ${plugins.map(plugin => plugin.id).join(', ')}`)
  return handle
}

/** Serialize repeated CDP injections so a newer generation disposes the previous one first. */
export function installCordisX(plugins: readonly CordisXBrowserPlugin[]): Promise<CordisXRuntimeHandle> {
  const previous = globalThis.__cordisxBoot ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(() => start(plugins))
  globalThis.__cordisxBoot = next
  return next
}
