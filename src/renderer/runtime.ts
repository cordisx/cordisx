import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { CordisXBrowserPlugin, CordisXPluginModule } from '../contracts.js'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerPluginSnapshot,
  type ManagerPluginStatus,
  type ManagerSnapshot,
} from './manager.js'
import { CORDISX_PLUGIN_ID, CordisXSlotService } from './service.js'
import type { SlotRegistrationSnapshot } from './slots.js'

const BLOCKED_PLUGINS_KEY = 'cordisx.manager.blockedPlugins.v1'

interface CordisXRuntimeMetadata {
  readonly version: string
}

interface PluginController {
  readonly item: CordisXBrowserPlugin
  fiber?: Fiber
  status: ManagerPluginStatus
  error?: string
}

interface CordisXRuntimeHandle extends ManagerModel {
  readonly version: string
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

function pluginInject(module: CordisXPluginModule | undefined): readonly string[] {
  if (module === undefined || module.inject === undefined) return []
  if (Array.isArray(module.inject)) return module.inject.filter((value): value is string => typeof value === 'string')
  return Object.keys(module.inject)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBlockedPlugins(): Set<string> {
  try {
    const value = localStorage.getItem(BLOCKED_PLUGINS_KEY)
    if (value === null) return new Set()
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function writeBlockedPlugins(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLOCKED_PLUGINS_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // Storage may be unavailable in hardened profiles; runtime blocking still works.
  }
}

async function start(
  plugins: readonly CordisXBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
): Promise<CordisXRuntimeHandle> {
  await globalThis.__cordisxRuntime?.dispose()

  const ctx = new Context()
  const blockedPlugins = readBlockedPlugins()
  const controllers: PluginController[] = plugins.map(item => ({
    item,
    status: !item.enabled || item.module === undefined
      ? 'configured-disabled'
      : blockedPlugins.has(item.id) ? 'blocked' : 'active',
  }))
  const listeners = new Set<() => void>()
  const knownRegistrations = new Map<string, readonly SlotRegistrationSnapshot[]>()
  let slotService: CordisXSlotService | undefined
  let serviceFiber: Fiber | undefined
  let disposeManager: (() => void) | undefined
  let operation = Promise.resolve()
  let disposed = false

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const rememberRegistrations = (pluginId: string): void => {
    const registrations = slotService?.snapshot().filter(item => item.pluginId === pluginId) ?? []
    if (registrations.length > 0) knownRegistrations.set(pluginId, registrations)
  }

  const mountPlugin = async (controller: PluginController): Promise<void> => {
    const module = controller.item.module
    if (module === undefined) throw new Error(`plugin ${controller.item.id} is not bundled because it is disabled in configuration`)
    const pluginContext = ctx.extend({ [CORDISX_PLUGIN_ID]: controller.item.id })
    const fiber = pluginContext.plugin(pluginFromModule(module), controller.item.config)
    controller.fiber = fiber
    try {
      await fiber
      controller.status = 'active'
      delete controller.error
      rememberRegistrations(controller.item.id)
    } catch (error) {
      controller.status = 'failed'
      controller.error = errorMessage(error)
      await fiber.dispose()
      delete controller.fiber
      throw error
    }
  }

  const snapshot = (): ManagerSnapshot => {
    const liveRegistrations = slotService?.snapshot() ?? []
    const livePluginIds = new Set(liveRegistrations.map(item => item.pluginId))
    const inactiveRegistrations = [...knownRegistrations]
      .filter(([pluginId]) => !livePluginIds.has(pluginId))
      .flatMap(([, registrations]) => registrations.map(item => ({ ...item, active: false, mounted: false })))
    return {
      version: metadata.version,
      plugins: controllers.map((controller): ManagerPluginSnapshot => ({
        id: controller.item.id,
        name: controller.item.module?.name ?? controller.item.id,
        inject: pluginInject(controller.item.module),
        config: controller.item.config,
        status: controller.status,
        ...(controller.error === undefined ? {} : { error: controller.error }),
      })),
      registrations: [...liveRegistrations, ...inactiveRegistrations],
    }
  }

  const setPluginBlocked = (id: string, blocked: boolean): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = controllers.find(item => item.item.id === id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      if (!controller.item.enabled || controller.item.module === undefined) {
        throw new Error(`plugin ${id} is disabled in cordisx.config.json and is not bundled`)
      }

      if (blocked) {
        blockedPlugins.add(id)
        writeBlockedPlugins(blockedPlugins)
        rememberRegistrations(id)
        await controller.fiber?.dispose()
        delete controller.fiber
        controller.status = 'blocked'
        delete controller.error
        notify()
        return
      }

      if (controller.status === 'active') return
      blockedPlugins.delete(id)
      writeBlockedPlugins(blockedPlugins)
      try {
        await mountPlugin(controller)
      } catch (error) {
        blockedPlugins.add(id)
        writeBlockedPlugins(blockedPlugins)
        notify()
        throw error
      }
      notify()
    })
    operation = task.catch(() => {})
    return task
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    disposeManager?.()
    disposeManager = undefined
    await operation
    for (const controller of [...controllers].reverse()) {
      await controller.fiber?.dispose()
      delete controller.fiber
    }
    await serviceFiber?.dispose()
    serviceFiber = undefined
    listeners.clear()
    if (globalThis.__cordisxRuntime === handle) globalThis.__cordisxRuntime = undefined
    document.documentElement.removeAttribute('data-cordisx-ready')
  }

  const handle: CordisXRuntimeHandle = {
    version: metadata.version,
    pluginIds: plugins.map(plugin => plugin.id),
    snapshot,
    setPluginBlocked,
    subscribe,
    dispose,
  }

  try {
    serviceFiber = ctx.plugin(CordisXSlotService)
    await serviceFiber
    slotService = ctx.slots as CordisXSlotService
    for (const controller of controllers) {
      if (controller.status !== 'active') continue
      await mountPlugin(controller)
    }
    disposeManager = installCordisXManager(document, handle)
  } catch (error) {
    await dispose()
    throw error
  }

  globalThis.__cordisxRuntime = handle
  document.documentElement.dataset.cordisxReady = 'true'
  const activeIds = controllers.filter(controller => controller.status === 'active').map(controller => controller.item.id)
  console.info(`[cordisx] mounted ${activeIds.length} plugin(s): ${activeIds.join(', ')}`)
  return handle
}

/** Serialize repeated CDP injections so a newer generation disposes the previous one first. */
export function installCordisX(
  plugins: readonly CordisXBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
): Promise<CordisXRuntimeHandle> {
  const previous = globalThis.__cordisxBoot ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(() => start(plugins, metadata))
  globalThis.__cordisxBoot = next
  return next
}
