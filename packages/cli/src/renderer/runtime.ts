import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type {
  CordisXBrowserPlugin,
  CordisXCommandReference,
  CordisXPermissionPolicy,
  CordisXPointPolicy,
  CordisXPlatformCapability,
  CordisXPluginIdentity,
  CordisXPluginManifestV1,
  CordisXPluginModule,
  CordisXRouteReference,
} from '../contracts.js'
import { installCodexAdapter, type CodexAdapterHandle } from './adapter.js'
import { UnavailableCodexHostAdapter } from '../adapters/codex-agent.js'
import { CordisXAgentService, CordisXHostAgentRuntime, CordisXSystemPromptService } from './agent.js'
import { CordisXAgentEventService } from './agent-events.js'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerPluginSnapshot,
  type ManagerPluginStatus,
  type ManagerSnapshot,
} from './manager.js'
import { CordisXCommandService } from './commands.js'
import { CordisXI18nService } from './i18n.js'
import { CordisXPageService, CordisXRouteService } from './navigation.js'
import {
  BrowserPermissionPolicyStore,
  BrowserPermissionPrompt,
  CordisXPlatformService,
  PermissionBroker,
  normalizePluginManifest,
  type PlatformPermissionSnapshot,
} from './platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE, CordisXSlotService } from './service.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import {
  BrowserExtensionPointPolicyStore,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  buildExtensionPointRuntimeSnapshot,
} from './extension-points.js'

const BLOCKED_PLUGINS_KEY = 'cordisx.manager.blockedPlugins.v1'

interface CordisXRuntimeMetadata {
  readonly version: string
}

interface PluginController {
  readonly item: CordisXBrowserPlugin
  readonly identity: CordisXPluginIdentity
  readonly manifest: CordisXPluginManifestV1
  unregisterPermissions?: () => void
  unregisterExtensionPoints?: () => void
  fiber?: Fiber
  status: ManagerPluginStatus
  error?: string
  blockedReason?: string
}

interface CordisXRuntimeHandle extends ManagerModel {
  readonly version: string
  readonly pluginIds: readonly string[]
  execute(owner: string, reference: CordisXCommandReference, invocationKey?: string): Promise<unknown>
  navigate(owner: string, reference: CordisXRouteReference): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: CordisXPointPolicy): Promise<void>
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
  const adapter = new UnavailableCodexHostAdapter()
  const broker = new PermissionBroker(new BrowserPermissionPolicyStore(), new BrowserPermissionPrompt())
  const generation = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const agentRuntime = new CordisXHostAgentRuntime({ adapter, broker, generation })
  const extensionPointDescriptors = new ExtensionPointDescriptorRegistry()
  const extensionPointBroker = new ExtensionPointPolicyBroker(extensionPointDescriptors, new BrowserExtensionPointPolicyStore(), generation)
  const controllers: PluginController[] = plugins.map(createController)
  for (const controller of controllers) {
    controller.unregisterPermissions = broker.register(controller.identity, controller.manifest)
    controller.unregisterExtensionPoints = extensionPointBroker.register(controller.identity)
    if (controller.status === 'active' && blockedPlugins.has(controller.item.id)) controller.status = 'blocked'
    const denied = broker.requiredDenied(controller.identity)
    if (controller.status === 'active' && denied.length > 0) {
      controller.status = 'permission-blocked'
      controller.blockedReason = `Required capability denied: ${denied.join(', ')}`
    }
  }
  const listeners = new Set<() => void>()
  const knownRegistrations = new Map<string, readonly SurfaceContributionSnapshot[]>()
  let slotService: CordisXSlotService | undefined
  let commandService: CordisXCommandService | undefined
  let pageService: CordisXPageService | undefined
  let routeService: CordisXRouteService | undefined
  let i18nService: CordisXI18nService | undefined
  let i18nFiber: Fiber | undefined
  let platformFiber: Fiber | undefined
  let agentEventFiber: Fiber | undefined
  let agentFiber: Fiber | undefined
  let systemPromptFiber: Fiber | undefined
  let commandFiber: Fiber | undefined
  let pageFiber: Fiber | undefined
  let routeFiber: Fiber | undefined
  let slotFiber: Fiber | undefined
  let disposeManager: (() => void) | undefined
  let adapterHandle: CodexAdapterHandle | undefined
  let disposeI18nSubscription: (() => void) | undefined
  let disposePermissionSubscription: (() => void) | undefined
  let disposeExtensionPointSubscription: (() => void) | undefined
  const disposeExtensionPointCatalogs: (() => void | Promise<void>)[] = []
  const registrySubscriptions: (() => void)[] = []
  let operation = Promise.resolve()
  let disposed = false

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const rememberRegistrations = (pluginId: string): void => {
    const registrations = slotService?.snapshot().filter(item => item.owner === pluginId) ?? []
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
    const livePluginIds = new Set(liveRegistrations.map(item => item.owner))
    const inactiveRegistrations = [...knownRegistrations]
      .filter(([pluginId]) => !livePluginIds.has(pluginId))
      .flatMap(([, registrations]) => registrations.map(item => ({
        ...item,
        visible: false,
        rendered: false,
        error: item.error ?? 'owning plugin is inactive',
      })))
    const navigation = routeService?.snapshot() ?? { routes: [], pages: pageService?.snapshot() ?? [], outlets: [] }
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
      commands: commandService?.snapshot() ?? [],
      navigation,
      localization: i18nService?.getSnapshot() ?? { locale: 'en', direction: 'ltr', version: 0 },
      localeCatalogs: i18nService?.catalogs() ?? [],
      localizationDiagnostics: i18nService?.diagnostics() ?? [],
      platform: adapter.status(),
      permissions: broker.snapshots().map((permission: PlatformPermissionSnapshot) => ({
        identity: permission.identity,
        capability: permission.capability,
        required: permission.required,
        reason: permission.reason,
        reasonText: i18nService?.resolveFor(
          permission.identity.id,
          permission.reason,
          `permission:${permission.identity.source}:${permission.identity.id}:${permission.capability}`,
        ).text
          ?? permission.reason.fallback
          ?? `[[${permission.identity.id}:${permission.reason.key}]]`,
        scope: permission.scope,
        policy: permission.policy,
        ...(permission.lastUsedAt === undefined ? {} : { lastUsedAt: permission.lastUsedAt }),
        ...(permission.lastDeniedAt === undefined ? {} : { lastDeniedAt: permission.lastDeniedAt }),
        denialCount: permission.denialCount,
        ...(permission.blockedReason === undefined ? {} : { blockedReason: permission.blockedReason }),
      })),
      extensionPoints: buildExtensionPointRuntimeSnapshot({
        descriptors: extensionPointDescriptors,
        broker: extensionPointBroker,
        i18n: i18nService!,
        plugins: controllers.map(controller => ({
          id: controller.item.id,
          source: controller.item.source,
          name: controller.manifest.name ?? controller.item.module?.name ?? controller.item.id,
          status: controller.status,
        })),
        registrations: [...liveRegistrations, ...inactiveRegistrations],
        commands: commandService?.snapshot() ?? [],
        navigation,
        surfaceAvailability: slotService?.registry.availabilitySnapshot() ?? [],
      }),
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
        await routeService?.settled()
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
        await routeService?.settled()
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

  const setExtensionPointPolicy = (
    source: string,
    pluginId: string,
    pointId: string,
    policy: CordisXPointPolicy,
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = controllers.find(item => item.item.id === pluginId && item.item.source === source)
      if (controller === undefined) throw new Error(`unknown CordisX plugin identity: ${source} / ${pluginId}`)
      extensionPointBroker.setPolicy(controller.identity, pointId, policy)
      slotService?.invalidatePointPolicies()
      await routeService?.invalidatePointPolicies()
      notify()
    })
    operation = task.catch(() => {})
    return task
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
    disposeExtensionPointSubscription?.()
    disposeExtensionPointSubscription = undefined
    for (const unsubscribe of registrySubscriptions.splice(0)) unsubscribe()
    await operation
    for (const controller of [...controllers].reverse()) {
      await controller.fiber?.dispose()
      delete controller.fiber
    }
    adapterHandle?.dispose()
    adapterHandle = undefined
    await slotFiber?.dispose()
    slotFiber = undefined
    await routeFiber?.dispose()
    routeFiber = undefined
    await pageFiber?.dispose()
    pageFiber = undefined
    await commandFiber?.dispose()
    commandFiber = undefined
    await platformFiber?.dispose()
    platformFiber = undefined
    await systemPromptFiber?.dispose()
    systemPromptFiber = undefined
    await agentFiber?.dispose()
    agentFiber = undefined
    await agentEventFiber?.dispose()
    agentEventFiber = undefined
    await agentRuntime.dispose()
    for (const remove of disposeExtensionPointCatalogs.splice(0).reverse()) await remove()
    await i18nFiber?.dispose()
    i18nFiber = undefined
    listeners.clear()
    for (const controller of controllers) controller.unregisterPermissions?.()
    for (const controller of controllers) controller.unregisterExtensionPoints?.()
    broker.dispose()
    extensionPointBroker.dispose()
    extensionPointDescriptors.dispose()
    if (globalThis.__cordisxRuntime === handle) globalThis.__cordisxRuntime = undefined
    document.documentElement.removeAttribute('data-cordisx-ready')
  }

  const handle: CordisXRuntimeHandle = {
    version: metadata.version,
    pluginIds: plugins.map(plugin => plugin.id),
    execute: (owner, reference, invocationKey) => {
      if (commandService === undefined) return Promise.reject(new Error('CordisX commands are not ready'))
      return commandService.executeFor(owner, reference, invocationKey)
    },
    navigate: (owner, reference) => {
      if (routeService === undefined) return Promise.reject(new Error('CordisX routes are not ready'))
      return routeService.navigateFor(owner, reference)
    },
    setExtensionPointPolicy,
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
    for (const catalog of CORDISX_EXTENSION_POINT_LOCALE_CATALOGS) {
      disposeExtensionPointCatalogs.push(i18nService.define(catalog))
    }
    disposeI18nSubscription = i18nService.subscribeInternal(notify)
    disposePermissionSubscription = broker.subscribe(notify)
    disposeExtensionPointSubscription = extensionPointBroker.subscribe(notify)
    platformFiber = ctx.plugin(CordisXPlatformService, { adapter, broker })
    await platformFiber
    agentEventFiber = ctx.plugin(CordisXAgentEventService, {
      ledger: agentRuntime.ledger,
      broker,
      status: () => agentRuntime.status(),
    })
    await agentEventFiber
    agentFiber = ctx.plugin(CordisXAgentService, agentRuntime)
    await agentFiber
    systemPromptFiber = ctx.plugin(CordisXSystemPromptService, agentRuntime)
    await systemPromptFiber
    commandFiber = ctx.plugin(CordisXCommandService)
    await commandFiber
    commandService = ctx.commands as CordisXCommandService
    pageFiber = ctx.plugin(CordisXPageService)
    await pageFiber
    pageService = ctx.pages as CordisXPageService
    routeFiber = ctx.plugin(CordisXRouteService)
    await routeFiber
    routeService = ctx.routes as CordisXRouteService
    slotFiber = ctx.plugin(CordisXSlotService)
    await slotFiber
    slotService = ctx.slots as CordisXSlotService
    slotService.setResolvers({
      command: (owner, reference) => commandService?.hasFor(owner, reference) ?? false,
      route: (owner, id) => routeService?.hasFor(owner, id) ?? false,
    })
    commandService.setAccessResolver(extensionPointBroker)
    routeService.setAccessResolver(extensionPointBroker)
    slotService.setAccessResolver(extensionPointBroker)
    registrySubscriptions.push(
      extensionPointDescriptors.subscribe(notify),
      commandService.subscribeInternal(notify),
      pageService.registry.subscribe(notify),
      routeService.subscribeInternal(notify),
      slotService.subscribeInternal(notify),
    )
    adapterHandle = installCodexAdapter(document, slotService, commandService, routeService, i18nService, extensionPointDescriptors, {
      generation,
      adapterVersion: metadata.version,
    })
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
