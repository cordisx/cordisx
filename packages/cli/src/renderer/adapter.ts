import type { TransientCanvasCoordinator } from './transient-canvas.js'
import type { CordisXSlotService } from './surfaces.js'
import type { CordisXCommandService } from './commands.js'
import type { CordisXRouteService } from './navigation.js'
import type { CordisXI18nService } from './i18n.js'
import type { ExtensionPointDescriptorRegistry } from './extension-points.js'
import { assertStructuredStyleOwnership, installStyles } from './adapter/styles.js'
import { CORDISX_BUILTIN_EXTENSION_POINT_CATALOG } from './extension-points.js'
import { DomOutletController } from './adapter/outlets.js'
import { currentSessionId, pageChromeSafeLeft, sessionContentAnchor, uniqueVisible } from './adapter/dom.js'
import {
  CORDISX_CODEX_CONTROL_CATALOG,
  REASONING_CONTROL_POINT,
  ReasoningIntensityControlBinding,
} from './adapter/reasoning.js'
import {
  BrowserControlledSurfacePolicyStore,
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
} from './controlled-surfaces.js'
import { StructuredSurfaceRenderer } from './adapter/renderer-layout.js'
import type { SelectedNavigationActionRegistry } from './selected-navigation-actions.js'

export interface CodexAdapterHandle {
  dispose(): void
}

export interface CodexAdapterOptions {
  readonly generation?: string
  readonly adapterVersion?: string
  readonly hostId?: string
  readonly profileId?: string
  readonly transientCanvas?: TransientCanvasCoordinator
  readonly selectedNavigationActions?: SelectedNavigationActionRegistry
}

export function installCodexAdapter(
  document: Document,
  slots: CordisXSlotService,
  commands: CordisXCommandService,
  routes: CordisXRouteService,
  i18n: CordisXI18nService,
  extensionPoints: ExtensionPointDescriptorRegistry,
  options: CodexAdapterOptions = {},
): CodexAdapterHandle {
  assertStructuredStyleOwnership(document)
  const unregisterExtensionPoints = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  let lastProjectKey: string | undefined
  const app = new DomOutletController(document, 'app', 'fixed', () => {
    if (document.body === null) return undefined
    return {
      anchor: document.body,
      contextKey: 'renderer',
      pageChromeSafeLeft: pageChromeSafeLeft(document, document.body),
    }
  })
  const main = new DomOutletController(document, 'main', 'portal', () => {
    const anchor = uniqueVisible(document, '[data-app-shell-main-content-layout="thread-edge-scroll"]')
      ?? uniqueVisible(document, '[data-app-shell-main-content-layout]')
    if (anchor === undefined) return undefined
    const selected = uniqueVisible(document, '[data-app-action-sidebar-thread-selected="true"]')
    const project = selected?.closest('[data-app-action-sidebar-project-list-id]')?.getAttribute(
      'data-app-action-sidebar-project-list-id',
    )
    if (project !== null && project !== undefined) lastProjectKey = project
    return {
      anchor,
      contextKey: `main:${lastProjectKey ?? 'default'}`,
      pageChromeSafeLeft: pageChromeSafeLeft(document, anchor),
    }
  })
  const session = new DomOutletController(document, 'session.content', 'absolute', () => {
    const sessionId = currentSessionId(document)
    const anchor = sessionId === undefined ? undefined : sessionContentAnchor(document, sessionId)
    if (anchor === undefined || sessionId === undefined) return undefined
    return { anchor, contextKey: `session:${sessionId}`, nativeSessionId: sessionId }
  })
  const undeclare = [
    routes.outlets.declare(
      {
        schemaVersion: 1,
        id: 'app',
        authority: 'host-adapter',
        scope: 'renderer',
        preferredPlacement: 'fixed',
        contextPolicy: 'generation',
        presentationGroup: 'primary',
      },
      app,
      path => path !== '/main' && !path.startsWith('/main/') && path !== '/sessions' && !path.startsWith('/sessions/'),
    ),
    routes.outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'portal',
        contextPolicy: 'semantic',
        presentationGroup: 'primary',
      },
      main,
      path => path.startsWith('/main/') && path.length > '/main/'.length,
    ),
    routes.outlets.declare(
      {
        schemaVersion: 1,
        id: 'session.content',
        authority: 'host-adapter',
        scope: 'session',
        preferredPlacement: 'absolute',
        contextPolicy: 'semantic',
        presentationGroup: 'primary',
      },
      session,
      path => path.startsWith('/sessions/:sessionId/') && path.length > '/sessions/:sessionId/'.length,
    ),
  ]
  const removeStyles = installStyles(document)
  const generation = options.generation ?? (typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const reasoningControl = new ReasoningIntensityControlBinding()
  const controls = new ControlledSurfaceCoordinator(
    CORDISX_CODEX_CONTROL_CATALOG,
    {
      [REASONING_CONTROL_POINT]: reasoningControl,
    },
    generation,
    new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore(options.profileId ?? 'default')),
    (candidate, view) => slots.controlGenerationVisible(candidate, view),
    candidate => slots.controlGenerationCallable(candidate),
  )
  reasoningControl.connect(controls)
  slots.setControlCoordinator(controls)
  const surfaces = new StructuredSurfaceRenderer(
    document,
    slots,
    commands,
    routes,
    i18n,
    reasoningControl,
    options.transientCanvas,
    options.selectedNavigationActions,
    {
      generation,
      adapterVersion: options.adapterVersion ?? 'ui-catalog-v2',
      hostId: options.hostId ?? 'com.openai.codex',
    },
  )
  return {
    dispose() {
      surfaces.dispose()
      reasoningControl.dispose()
      removeStyles()
      for (const dispose of undeclare.reverse()) dispose()
      session.dispose()
      main.dispose()
      app.dispose()
      unregisterExtensionPoints()
    },
  }
}

/**
 * Explicit local-development seats.  Unlike the Codex adapter this path never
 * queries Codex DOM, selectors, sessions, or native controls.  It deliberately
 * exposes only explicit Host-owned development seats. Structured contributions
 * use the production Host renderer but never query or imitate Codex selectors.
 */
export function installPlaygroundAdapter(
  document: Document,
  slots: CordisXSlotService,
  commands: CordisXCommandService,
  routes: CordisXRouteService,
  i18n: CordisXI18nService,
  extensionPoints: ExtensionPointDescriptorRegistry,
  options: CodexAdapterOptions = {},
): CodexAdapterHandle {
  assertStructuredStyleOwnership(document)
  const unregisterExtensionPoints = extensionPoints.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  const generation = options.generation ?? (typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `playground-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const reasoningControl = new ReasoningIntensityControlBinding()
  const controls = new ControlledSurfaceCoordinator(
    CORDISX_CODEX_CONTROL_CATALOG,
    {
      [REASONING_CONTROL_POINT]: reasoningControl,
    },
    generation,
    new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore(options.profileId ?? 'playground')),
    (candidate, view) => slots.controlGenerationVisible(candidate, view),
    candidate => slots.controlGenerationCallable(candidate),
  )
  reasoningControl.connect(controls)
  const seat = (name: string): HTMLElement | undefined =>
    document.querySelector<HTMLElement>(`[data-cordisx-playground-seat="${name}"]`) ?? undefined
  const controllers = [
    ['app', 'fixed', () => seat('app')],
    ['main', 'portal', () => seat('main')],
    ['session.content', 'absolute', () => seat('session.content')],
  ] as const
  let removeStyles: (() => void) | undefined
  const declared: Array<{ readonly controller: DomOutletController; readonly dispose: () => void }> = []
  let surfaces: StructuredSurfaceRenderer | undefined
  try {
    removeStyles = installStyles(document)
    for (const [id, placement, resolve] of controllers) {
      const controller = new DomOutletController(document, id, placement, () => {
        const anchor = resolve()
        return anchor === undefined ? undefined : { anchor, contextKey: `playground:${id}` }
      })
      const path = id === 'app'
        ? (value: string) =>
          value !== '/main' && !value.startsWith('/main/') && value !== '/sessions' && !value.startsWith('/sessions/')
        : id === 'main'
        ? (value: string) => value.startsWith('/main/') && value.length > '/main/'.length
        : (value: string) => value.startsWith('/sessions/:sessionId/') && value.length > '/sessions/:sessionId/'.length
      try {
        const dispose = routes.outlets.declare(
          {
            schemaVersion: 1,
            id,
            authority: 'host-adapter',
            scope: 'playground',
            preferredPlacement: placement,
            contextPolicy: 'generation',
            presentationGroup: 'primary',
          },
          controller,
          path,
        )
        declared.push({ controller, dispose })
      } catch (error) {
        controller.dispose()
        throw error
      }
    }
    surfaces = new StructuredSurfaceRenderer(
      document,
      slots,
      commands,
      routes,
      i18n,
      reasoningControl,
      options.transientCanvas,
      options.selectedNavigationActions,
      {
        generation,
        adapterVersion: options.adapterVersion ?? 'ui-playground-v1',
        hostId: options.hostId ?? 'cordisx.playground',
        mode: 'playground',
      },
    )
    slots.setControlCoordinator(controls)
    return {
      dispose() {
        surfaces?.dispose()
        reasoningControl.dispose()
        removeStyles?.()
        for (const item of declared.reverse()) {
          item.dispose()
          item.controller.dispose()
        }
        unregisterExtensionPoints()
      },
    }
  } catch (error) {
    surfaces?.dispose()
    reasoningControl.dispose()
    removeStyles?.()
    for (const item of declared.reverse()) {
      item.dispose()
      item.controller.dispose()
    }
    unregisterExtensionPoints()
    throw error
  }
}
export { DomOutletController } from './adapter/outlets.js'
export { partitionDirectActions } from './adapter/renderer-interactions.js'
export { resolveReasoningIntensityRange } from './adapter/reasoning.js'
export { ReasoningIntensityProjection } from './adapter/reasoning.js'
export { ReasoningIntensityNativeVisibility } from './adapter/reasoning.js'
export { CORDISX_CODEX_CONTROL_CATALOG } from './adapter/reasoning.js'
export { SessionBackdropProjection } from './adapter/backdrop.js'
