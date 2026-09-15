import { normalizePluginManifest } from './platform.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import type { PluginController } from './runtime-shared.js'

export const createRuntimeRenewPrincipal = (runtimeScope: RuntimeClosureScope, controller: PluginController): void => {
  if (controller.principalLive) return
  controller.activation += 1
  controller.principal = runtimeScope.pluginConsole()!.issue(
    controller.identity,
    runtimeScope.moduleGenerationOf()!(controller),
  )
  controller.principalLive = true
  const module = controller.item.isolatedArtifactSource === undefined
    ? controller.item.moduleFactory?.(runtimeScope.pluginConsole()!.consoleFacade(controller.principal))
      ?? controller.item.module
    : undefined
  controller.item = module === undefined || module === controller.item.module
    ? controller.item
    : { ...controller.item, module }
  controller.manifest = normalizePluginManifest(controller.item.manifest ?? module?.manifest, controller.item.id)
}

export const createRuntimeRetirePrincipal = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  message: string,
): void => {
  if (!controller.principalLive) return
  runtimeScope.pluginConsole()!.deactivate(controller.principal, message)
  controller.principalLive = false
}
