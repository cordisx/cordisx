import { HostTooltipController } from '../tooltips.js'
import type { NativeActionSeat, NavigationLeadingVisualMount } from './types.js'
import {
  ReasoningIntensityControlBinding,
  ReasoningIntensityNativeVisibility,
  ReasoningIntensityProjection,
} from './reasoning.js'
import { SessionBackdropProjection } from './backdrop.js'
import type { CordisXSlotService } from '../surfaces.js'
import type { CordisXCommandService } from '../commands.js'
import type { CordisXRouteService } from '../navigation.js'
import type { CordisXI18nService } from '../i18n.js'
import type { TransientCanvasCoordinator } from '../transient-canvas.js'

abstract class StructuredSurfaceRendererBase {
  protected readonly roots = new Map<string, HTMLElement>()

  protected readonly sites = new Set<string>()

  protected readonly observer?: MutationObserver

  protected readonly tooltips: HostTooltipController

  protected readonly unsubscribers: (() => void)[]

  protected toolbarSlot: { element: HTMLElement; width: string; minWidth: string } | undefined

  protected scheduled = false

  protected scheduledFrame: number | undefined

  protected environmentRetryTimer: number | undefined

  protected environmentRetryAttempts = 0

  protected rebuildScheduled = false

  protected controlBindingUpdate = false

  protected disposed = false

  protected nextContext = 0

  protected readonly routeProjectors = new Map<HTMLButtonElement, () => void>()

  protected readonly navigationLeadingVisualMounts = new Map<string, NavigationLeadingVisualMount>()

  protected navigationRenderSignature: string | undefined

  protected navigationActionDisposers: (() => void)[] = []

  protected reasoningProjection: ReasoningIntensityProjection | undefined

  protected readonly reasoningNativeVisibility = new ReasoningIntensityNativeVisibility()

  protected sessionBackdropProjection: SessionBackdropProjection | undefined

  constructor(
    protected readonly document: Document,
    protected readonly slots: CordisXSlotService,
    protected readonly commands: CordisXCommandService,
    protected readonly routes: CordisXRouteService,
    protected readonly i18n: CordisXI18nService,
    protected readonly reasoningControl: ReasoningIntensityControlBinding,
    protected readonly transientCanvas: TransientCanvasCoordinator | undefined,
    protected readonly adapterIdentity: Readonly<{
      generation: string
      adapterVersion: string
      hostId: string
      mode?: 'codex' | 'playground'
    }>,
  ) {
    this.tooltips = new HostTooltipController(document)
    this.unsubscribers = [
      slots.subscribeInternal(() => this.schedule(!this.controlBindingUpdate)),
      commands.subscribeInternal(() => this.schedule(true)),
      routes.subscribeInternal(() => this.schedule(false)),
      i18n.subscribeInternal(() => this.schedule(true)),
    ]
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer((records) => {
        const nativeMutation = records.some((record) => {
          const target = record.target.nodeType === 1
            ? record.target as Element
            : record.target.parentElement
          if (record.type === 'attributes' && target?.matches('[data-cordisx-manager-modal]') === true) return true
          return target?.closest(
            '[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]',
          ) === null
        })
        if (nativeMutation) {
          this.resetEnvironmentRetry()
          this.schedule(false)
          this.scheduleAfterNativeMutation()
        }
      })
      this.observer.observe(document.documentElement, {
        childList: true,
        attributes: true,
        attributeFilter: [
          'hidden',
          'aria-hidden',
          'aria-expanded',
          'data-state',
          'data-app-action-sidebar-thread-selected',
          'data-pip-home-surface',
          'data-pip-obstacle',
        ],
        subtree: true,
      })
    }
    this.schedule(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    if (this.scheduledFrame !== undefined) this.document.defaultView?.cancelAnimationFrame(this.scheduledFrame)
    if (this.environmentRetryTimer !== undefined) this.document.defaultView?.clearTimeout(this.environmentRetryTimer)
    this.restoreToolbarSlot()
    this.reasoningProjection?.dispose()
    this.reasoningProjection = undefined
    this.reasoningNativeVisibility.dispose()
    this.reasoningControl.update(undefined)
    this.transientCanvas?.updateSubmitButton(undefined)
    this.sessionBackdropProjection?.dispose()
    this.sessionBackdropProjection = undefined
    this.tooltips.dispose()
    this.disposeNavigationLeadingVisuals()
    this.disposeNavigationActions()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    for (const root of this.roots.values()) root.remove()
    this.roots.clear()
    this.routeProjectors.clear()
    for (const site of this.sites) {
      const [owner, ...rest] = site.split('\u0000')
      this.i18n.clearDiagnosticSite(owner!, rest.join('\u0000'))
    }
    this.sites.clear()
  }

  protected schedule(rebuild: boolean): void {
    if (this.disposed) return
    this.rebuildScheduled ||= rebuild
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const shouldRebuild = this.rebuildScheduled
      this.rebuildScheduled = false
      this.render(shouldRebuild)
    })
  }

  protected scheduleAfterNativeMutation(): void {
    const view = this.document.defaultView
    if (view === null || this.scheduledFrame !== undefined || this.disposed) return
    this.scheduledFrame = view.requestAnimationFrame(() => {
      this.scheduledFrame = undefined
      this.schedule(false)
    })
  }

  protected resetEnvironmentRetry(): void {
    if (this.environmentRetryTimer !== undefined) this.document.defaultView?.clearTimeout(this.environmentRetryTimer)
    this.environmentRetryTimer = undefined
    this.environmentRetryAttempts = 0
  }

  protected reconcileEnvironmentRetry(pending: boolean): void {
    const view = this.document.defaultView
    if (!pending || view === null || this.disposed) {
      this.resetEnvironmentRetry()
      return
    }
    if (this.environmentRetryTimer !== undefined || this.environmentRetryAttempts >= 3) return
    // Thread switches temporarily expose both summary motion shells. The outgoing
    // shell is later hidden through an inline `style` update, which is intentionally
    // not observed because Host motion writes it every frame. Retry a bounded number
    // of times while the semantic marker exists, preserving fail-closed behavior.
    this.environmentRetryTimer = view.setTimeout(() => {
      this.environmentRetryTimer = undefined
      this.environmentRetryAttempts += 1
      this.schedule(false)
    }, 400)
  }

  protected playgroundSurface(name: string): HTMLElement | undefined {
    return this.document.querySelector<HTMLElement>(`[data-cordisx-playground-surface="${name}"]`) ?? undefined
  }

  protected playgroundTemplate(name: string): HTMLButtonElement | undefined {
    return this.document.querySelector<HTMLButtonElement>(`button[data-cordisx-playground-template="${name}"]`)
      ?? undefined
  }

  protected playgroundActionSeat(
    name: string,
    templateName: string,
    key: string,
    className: string,
  ): NativeActionSeat | undefined {
    const parent = this.playgroundSurface(name)
    const template = this.playgroundTemplate(templateName)
    if (parent === undefined || template === undefined || template.parentElement !== parent) return undefined
    return { key, parent, before: template, className, template }
  }
  protected abstract render(rebuild: boolean): void
  protected abstract restoreToolbarSlot(): void
  protected abstract disposeNavigationLeadingVisuals(): void
  protected abstract disposeNavigationActions(): void
}

export { StructuredSurfaceRendererBase }
