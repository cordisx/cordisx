import type { CordisXRouteService, OutletController } from './navigation.js'
import { CORDISX_BUILTIN_EXTENSION_POINT_CATALOG, type ExtensionPointDescriptorRegistry } from './extension-points.js'
import type { CordisXSlotService } from './surfaces.js'
import {
  CORDISX_CODEX_CONTROL_CATALOG,
  REASONING_CONTROL_POINT,
  ReasoningIntensityControlBinding,
} from './adapter/reasoning.js'
import { ControlledSurfaceCoordinator } from './controlled-surfaces.js'

/**
 * A Manager-only renderer owns no Codex or Playground seats. Declare the
 * standard outlets as unavailable so plugin routes remain attributable while
 * the corresponding application adapter is absent.
 */
export function installStandaloneManagerAdapter(
  routes: CordisXRouteService,
  extensionPoints: ExtensionPointDescriptorRegistry,
  slots: CordisXSlotService,
  generation: string,
): { dispose(): void } {
  const unregisterCatalog = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  // The Manager has no native composer. Keep the real control contract in a
  // not-mounted state so plugin registration does not invent a native seat.
  const reasoning = new ReasoningIntensityControlBinding()
  const controls = new ControlledSurfaceCoordinator(
    CORDISX_CODEX_CONTROL_CATALOG,
    { [REASONING_CONTROL_POINT]: reasoning },
    generation,
    undefined,
    (candidate, view) => slots.controlGenerationVisible(candidate, view),
    candidate => slots.controlGenerationCallable(candidate),
  )
  reasoning.connect(controls)
  const undeclare: Array<() => void> = []
  const outlets = [
    {
      id: 'app',
      scope: 'renderer',
      placement: 'fixed',
      path: (value: string) => !/^\/(?:main|sessions)(?:\/|$)/u.test(value),
    },
    {
      id: 'main',
      scope: 'main',
      placement: 'portal',
      path: (value: string) => value.startsWith('/main/') && value.length > 6,
    },
    {
      id: 'session.content',
      scope: 'session',
      placement: 'absolute',
      path: (value: string) => value.startsWith('/sessions/:sessionId/') && value.length > 21,
    },
  ] as const
  try {
    for (const outlet of outlets) {
      const controller: OutletController = {
        getSnapshot: () => ({ available: false, placement: outlet.placement }),
        subscribe: () => () => {},
        show: () => {},
        hide: () => {},
      }
      undeclare.push(routes.outlets.declare(
        {
          schemaVersion: 1,
          id: outlet.id,
          authority: 'host-adapter',
          scope: outlet.scope,
          preferredPlacement: outlet.placement,
          contextPolicy: outlet.id === 'app' ? 'generation' : 'semantic',
          presentationGroup: 'primary',
        },
        controller,
        outlet.path,
      ))
    }
    slots.setControlCoordinator(controls)
  } catch (error) {
    reasoning.dispose()
    controls.dispose()
    for (const remove of undeclare.reverse()) remove()
    unregisterCatalog()
    throw error
  }
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      reasoning.dispose()
      for (const remove of undeclare.reverse()) remove()
      unregisterCatalog()
    },
  }
}
