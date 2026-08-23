import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type {
  CordisXBrowserPlugin,
  CordisXPermissionPolicy,
  CordisXPlatformCapability,
  CordisXPluginIdentity,
  CordisXPluginManifestV1,
  CordisXPluginModule,
} from '../contracts.js'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerPluginSnapshot,
  type ManagerPluginStatus,
  type ManagerSnapshot,
} from './manager.js'
import { CordisXI18nService } from './i18n.js'
import {
  BrowserPermissionPolicyStore,
  BrowserPermissionPrompt,
  CordisXPlatformService,
  PermissionBroker,
  UnavailablePlatformAdapter,
  normalizePluginManifest,
  type PlatformPermissionSnapshot,
} from './platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE, CordisXSlotService } from './service.js'
import type { SlotRegistrationSnapshot } from './slots.js'

const BLOCKED_PLUGINS_KEY = 'cordisx.manager.blockedPlugins.v1'

interface CordisXRuntimeMetadata {
  readonly version: string
}

interface PluginController {
  readonly item: CordisXBrowserPlugin
  readonly identity: CordisXPluginIdentity
  readonly manifest: CordisXPluginManifestV1
  unregisterPermissions?: () => void
  fiber?: Fiber
  status: ManagerPluginStatus
  error?: string
  blockedReason?: string
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

function createController(item: CordisXBrowserPlugin): PluginController {
  const identity = Object.freeze({ source: item.source, id: item.id })
  try {
    return {
      item,
      identity,
      manifest: normalizePluginManifest(item.module?.manifest, item.id),
      status: !item.enabled || item.module === undefined ? 'configured-disabled' : 'active',
    }
  } catch (error) {
    return {
      item,
      identity,
      manifest: normalizePluginManifest(undefined, item.id),
      status: 'failed',
      error: errorMessage(error),
    }
  }
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
  const adapter = new UnavailablePlatformAdapter()
  const broker = new PermissionBroker(new BrowserPermissionPolicyStore(), new BrowserPermissionPrompt())
  const controllers: PluginController[] = plugins.map(createController)
  for (const controller of controllers) {
    controller.unregisterPermissions = broker.register(controller.identity, controller.manifest)
    if (controller.status === 'active' && blockedPlugins.has(controller.item.id)) controller.status = 'blocked'
    const denied = broker.requiredDenied(controller.identity)
    if (controller.status === 'active' && denied.length > 0) {
      controller.status = 'permission-blocked'
      controller.blockedReason = `Required capability denied: ${denied.join(', ')}`
    }
  }
  const listeners = new Set<() => void>()
  const knownRegistrations = new Map<string, readonly SlotRegistrationSnapshot[]>()
  let slotService: CordisXSlotService | undefined
  let i18nService: CordisXI18nService | undefined
  let i18nFiber: Fiber | undefined
  let platformFiber: Fiber | undefined
  let slotFiber: Fiber | undefined
  let disposeManager: (() => void) | undefined
  let disposeI18nSubscription: (() => void) | undefined
  let disposePermissionSubscription: (() => void) | undefined
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
    const denied = broker.requiredDenied(controller.identity)
    if (denied.length > 0) {
      controller.status = 'permission-blocked'
      controller.blockedReason = `Required capability denied: ${denied.join(', ')}`
      return
    }
    const pluginContext = ctx.extend({
      [CORDISX_PLUGIN_ID]: controller.item.id,
      [CORDISX_PLUGIN_SOURCE]: controller.item.source,
    })
    const fiber = pluginContext.plugin(pluginFromModule(module), controller.item.config)
    controller.fiber = fiber
    try {
      await fiber
      controller.status = 'active'
      delete controller.error
      delete controller.blockedReason
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
        source: controller.item.source,
        name: controller.manifest.name ?? controller.item.module?.name ?? controller.item.id,
        inject: pluginInject(controller.item.module),
        config: controller.item.config,
        ...(controller.item.readme === undefined ? {} : { readme: controller.item.readme }),
        status: controller.status,
        ...(controller.error === undefined ? {} : { error: controller.error }),
        ...(controller.blockedReason === undefined ? {} : { blockedReason: controller.blockedReason }),
      })),
      registrations: [...liveRegistrations, ...inactiveRegistrations],
      localization: i18nService?.getSnapshot() ?? { locale: 'en', direction: 'ltr', version: 0 },
      localeCatalogs: i18nService?.catalogs() ?? [],
      localizationDiagnostics: i18nService?.diagnostics() ?? [],
      platform: adapter.status(),
      permissions: broker.snapshots().map((permission: PlatformPermissionSnapshot) => ({
        identity: permission.identity,
        capability: permission.capability,
        required: permission.required,
        reason: permission.reason,
        reasonText: i18nService?.resolveFor(permission.identity.id, permission.reason).text
          ?? permission.reason.fallback
          ?? `[[${permission.identity.id}:${permission.reason.key}]]`,
        scope: permission.scope,
        policy: permission.policy,
        ...(permission.lastUsedAt === undefined ? {} : { lastUsedAt: permission.lastUsedAt }),
        ...(permission.lastDeniedAt === undefined ? {} : { lastDeniedAt: permission.lastDeniedAt }),
        denialCount: permission.denialCount,
        ...(permission.blockedReason === undefined ? {} : { blockedReason: permission.blockedReason }),
      })),
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
      const denied = broker.requiredDenied(controller.identity)
      if (denied.length > 0) {
        controller.status = 'permission-blocked'
        controller.blockedReason = `Required capability denied: ${denied.join(', ')}`
        notify()
        return
      }
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

  const setPermissionPolicy = (
    id: string,
    capability: CordisXPlatformCapability,
    policy: CordisXPermissionPolicy,
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = controllers.find(item => item.item.id === id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      broker.setPolicy(controller.identity, capability, policy)
      const denied = broker.requiredDenied(controller.identity)
      if (denied.length > 0) {
        rememberRegistrations(id)
        await controller.fiber?.dispose()
        delete controller.fiber
        controller.status = 'permission-blocked'
        controller.blockedReason = `Required capability denied: ${denied.join(', ')}`
        notify()
        return
      }
      if (controller.status === 'permission-blocked') {
        delete controller.blockedReason
        if (blockedPlugins.has(id)) {
          controller.status = 'blocked'
        } else if (controller.item.enabled && controller.item.module !== undefined) {
          await mountPlugin(controller)
        } else {
          controller.status = 'configured-disabled'
        }
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
    disposeI18nSubscription?.()
    disposeI18nSubscription = undefined
    disposePermissionSubscription?.()
    disposePermissionSubscription = undefined
    await operation
    for (const controller of [...controllers].reverse()) {
      await controller.fiber?.dispose()
      delete controller.fiber
    }
    await slotFiber?.dispose()
    slotFiber = undefined
    await platformFiber?.dispose()
    platformFiber = undefined
    await i18nFiber?.dispose()
    i18nFiber = undefined
    listeners.clear()
    for (const controller of controllers) controller.unregisterPermissions?.()
    broker.dispose()
    if (globalThis.__cordisxRuntime === handle) globalThis.__cordisxRuntime = undefined
    document.documentElement.removeAttribute('data-cordisx-ready')
  }

  const handle: CordisXRuntimeHandle = {
    version: metadata.version,
    pluginIds: plugins.map(plugin => plugin.id),
    snapshot,
    setPluginBlocked,
    setPermissionPolicy,
    subscribe,
    dispose,
  }

  try {
    i18nFiber = ctx.plugin(CordisXI18nService)
    await i18nFiber
    i18nService = ctx.i18n as CordisXI18nService
    disposeI18nSubscription = i18nService.subscribeInternal(notify)
    disposePermissionSubscription = broker.subscribe(notify)
    platformFiber = ctx.plugin(CordisXPlatformService, { adapter, broker })
    await platformFiber
    slotFiber = ctx.plugin(CordisXSlotService)
    await slotFiber
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
