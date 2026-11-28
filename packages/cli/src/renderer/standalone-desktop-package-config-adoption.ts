import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import {
  equalStandaloneConfigJson,
  isStandaloneConfigOperations,
  type StandaloneDesktopConfigAdoption,
} from './standalone-desktop-package-config-binding.js'

/** Adopt another Manager's confirmed write without replacing this page or its draft. */
export async function adoptStandaloneDesktopPackageConfig(
  scope: RuntimeClosureScope,
  value: StandaloneDesktopConfigAdoption,
): Promise<boolean> {
  const metadata = scope.metadata()
  const bridge = scope.standaloneDesktopPackageConfigBridge()
  if (scope.disposed || metadata?.hostKind !== 'standalone' || !bridge) return false
  if (value.origin) return bridge.adopt(value)
  return await bridge.adoptPeer(value, async () => {
    if (
      !metadata.standaloneDesktopPackageConfig?.plugins.includes(value.pluginId)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
      || value.revision !== value.expectedRevision + 1 || !isStandaloneConfigOperations(value.operations)
    ) return false
    // Wait for already queued local work, while the bridge blocks new saves.
    for (;;) {
      const operation = scope.operation
      await operation
      if (scope.disposed || scope.metadata() !== metadata) return false
      if (scope.operation === operation) break
    }
    const registry = scope.configuration()
    const controller = scope.activeController()?.(value.pluginId)
    if (!registry || !controller) return false
    const descriptor = registry.descriptor(value.pluginId, scope.i18nService?.getSnapshot().locale ?? 'en')
    if (!descriptor.writable || descriptor.applies !== 'live' || descriptor.revision !== value.expectedRevision) {
      return false
    }
    const candidate = registry.stage(value.pluginId, value.expectedRevision, value.operations)
    if (!equalStandaloneConfigJson(candidate.raw, value.value)) return false
    registry.commit(value.pluginId, value.revision, candidate)
    scope.notify()?.()
    return true
  })
}
