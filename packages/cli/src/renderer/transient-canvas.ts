import type { TransientCanvasRegistrationV1 } from '@cordisx/protocol/transient-canvas/v1'
import type { CordisXContributionHandle, CordisXTransientCanvasPresentation } from '../contracts.js'
import type { PluginGenerationEffectIdentity, PluginGenerationView } from './generation-visibility.js'
import type { SurfaceRegistry } from './surfaces.js'

export const CORDISX_TRANSIENT_CANVAS_REGISTRATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json' as const

export interface TransientCanvasStart {
  readonly sessionId: string
  readonly registrationId: string
  readonly canvas: OffscreenCanvas
  readonly width: number
  readonly height: number
  readonly pixelRatio: number
  readonly reducedMotion: boolean
  readonly startedAt: number
}

export interface TransientCanvasWorkerSink {
  start(input: TransientCanvasStart): void
  stop(sessionId: string): void
}

interface Registration {
  readonly key: string
  readonly owner: string
  readonly declaration: TransientCanvasRegistrationV1
  readonly sink: TransientCanvasWorkerSink
  readonly surface: CordisXContributionHandle<CordisXTransientCanvasPresentation>
}

interface ActivePresentation {
  readonly key: string
  readonly sessionId: string
  readonly canvas: HTMLCanvasElement
  readonly sink: TransientCanvasWorkerSink
  readonly timer: number
}

function assertRegistration(value: unknown): asserts value is TransientCanvasRegistrationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('transient canvas registration must be an object')
  const item = value as Record<string, unknown>
  const allowed = ['$schema', 'schemaVersion', 'id', 'pointId', 'durationMs', 'reducedMotion']
  if (Object.keys(item).some(key => !allowed.includes(key)) || Object.keys(item).length !== allowed.length) {
    throw new Error('transient canvas registration fields are invalid')
  }
  if (item.$schema !== CORDISX_TRANSIENT_CANVAS_REGISTRATION_SCHEMA_V1 || item.schemaVersion !== 1) {
    throw new Error('transient canvas registration schema is unsupported')
  }
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(item.id)) {
    throw new Error('transient canvas registration id is invalid')
  }
  if (item.pointId !== 'composer.submit.effects') throw new Error('transient canvas extension point is unsupported')
  if (!Number.isInteger(item.durationMs) || (item.durationMs as number) < 100 || (item.durationMs as number) > 5000) {
    throw new Error('transient canvas durationMs must be an integer from 100 to 5000')
  }
  if (item.reducedMotion !== 'skip' && item.reducedMotion !== 'static') {
    throw new Error('transient canvas reducedMotion is invalid')
  }
}

/** Host-owned lifecycle for pointer-inert transparent canvases painted only by isolated workers. */
export class TransientCanvasCoordinator {
  private readonly registrations = new Map<string, Registration>()
  private readonly unsubscribe: () => void
  private active: ActivePresentation | undefined
  private submitButton: HTMLButtonElement | undefined
  private submitForm: HTMLFormElement | undefined
  private nextSession = 0
  private disposed = false

  constructor(private readonly document: Document, private readonly surfaces: SurfaceRegistry) {
    this.unsubscribe = surfaces.subscribe(() => this.reconcile())
    document.defaultView?.addEventListener('resize', this.onResize)
  }

  available(): boolean {
    const prototype = this.document.defaultView?.HTMLCanvasElement.prototype as (HTMLCanvasElement & {
      transferControlToOffscreen?: () => OffscreenCanvas
    }) | undefined
    return typeof prototype?.transferControlToOffscreen === 'function'
  }

  bind(input: Readonly<{
    owner: string
    source: string
    moduleGeneration: string
    generation: PluginGenerationEffectIdentity
    candidateView?: PluginGenerationView
    sink: TransientCanvasWorkerSink
  }>): Readonly<{
    register(declaration: TransientCanvasRegistrationV1): Promise<void>
    unregister(id: string): Promise<void>
    dispose(): void
  }> {
    const owned = new Set<string>()
    return Object.freeze({
      register: async declaration => {
        if (this.disposed) throw new Error('transient canvas coordinator is disposed')
        assertRegistration(declaration)
        const key = `${input.owner}\u0000${input.moduleGeneration}\u0000${declaration.id}`
        if (this.registrations.has(key)) throw new Error(`transient canvas registration ${declaration.id} already exists`)
        const surface = this.surfaces.register(input.owner, {
          name: 'composer.submit.effects',
          id: declaration.id,
        }, {
          kind: 'isolated-canvas',
          durationMs: declaration.durationMs,
          reducedMotion: declaration.reducedMotion,
        }, {
          generation: input.generation,
          ...(input.candidateView === undefined ? {} : { candidateView: input.candidateView }),
          source: input.source,
          moduleGeneration: input.moduleGeneration,
        })
        this.registrations.set(key, { key, owner: input.owner, declaration: structuredClone(declaration), sink: input.sink, surface })
        owned.add(key)
        this.reconcile()
      },
      unregister: async id => {
        const key = `${input.owner}\u0000${input.moduleGeneration}\u0000${id}`
        if (!owned.has(key)) return
        owned.delete(key)
        this.removeRegistration(key)
      },
      dispose: () => {
        for (const key of owned) this.removeRegistration(key)
        owned.clear()
      },
    })
  }

  updateSubmitButton(button: HTMLButtonElement | undefined): void {
    const form = button?.form ?? undefined
    if (this.submitButton === button && this.submitForm === form) return
    this.submitButton?.removeEventListener('click', this.onButtonClick)
    this.submitForm?.removeEventListener('submit', this.onFormSubmit)
    this.submitButton = button
    this.submitForm = form
    if (form !== undefined) form.addEventListener('submit', this.onFormSubmit)
    else button?.addEventListener('click', this.onButtonClick)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.updateSubmitButton(undefined)
    this.document.defaultView?.removeEventListener('resize', this.onResize)
    this.dismiss()
    this.unsubscribe()
    for (const registration of this.registrations.values()) registration.surface.dispose()
    this.registrations.clear()
  }

  private readonly onFormSubmit = (event: SubmitEvent): void => {
    const submitter = event.submitter
    if (submitter !== null && submitter !== this.submitButton) return
    queueMicrotask(() => { if (!event.defaultPrevented) this.present() })
  }

  private readonly onButtonClick = (event: MouseEvent): void => {
    const button = this.submitButton
    if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    queueMicrotask(() => { if (!event.defaultPrevented) this.present() })
  }

  private readonly onResize = (): void => this.dismiss()

  private winner(): Registration | undefined {
    const snapshot = this.surfaces.snapshot().find(item => item.surface === 'composer.submit.effects'
      && item.visible && item.authorized && item.valid && !item.pending && !item.disabled && item.currentContext === 'active')
    if (snapshot === undefined) return undefined
    return [...this.registrations.values()].find(item => item.owner === snapshot.owner && item.declaration.id === snapshot.id)
  }

  private reconcile(): void {
    const winner = this.winner()
    for (const registration of this.registrations.values()) {
      const token = this.surfaces.renderToken('composer.submit.effects', `${registration.owner}:${registration.declaration.id}`)
      if (token !== undefined) this.surfaces.markRendered('composer.submit.effects', `${registration.owner}:${registration.declaration.id}`, token, registration === winner)
    }
    if (this.active !== undefined && this.active.key !== winner?.key) this.dismiss()
  }

  private present(): void {
    const winner = this.winner()
    const view = this.document.defaultView
    if (winner === undefined || view === null) return
    const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    if (reducedMotion && winner.declaration.reducedMotion === 'skip') return
    const canvas = this.document.createElement('canvas')
    const transfer = (canvas as HTMLCanvasElement & { transferControlToOffscreen?: () => OffscreenCanvas }).transferControlToOffscreen
    if (typeof transfer !== 'function') return
    this.dismiss()
    const pixelRatio = Math.min(2, Math.max(1, view.devicePixelRatio || 1))
    const width = Math.max(1, Math.min(4096, Math.round(view.innerWidth * pixelRatio)))
    const height = Math.max(1, Math.min(4096, Math.round(view.innerHeight * pixelRatio)))
    canvas.width = width
    canvas.height = height
    canvas.dataset.cordisxTransientCanvas = winner.declaration.id
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.position = 'fixed'
    canvas.style.inset = '0'
    canvas.style.width = '100vw'
    canvas.style.height = '100vh'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '2147482000'
    canvas.style.background = 'transparent'
    ;(this.document.body ?? this.document.documentElement).append(canvas)
    const sessionId = `canvas:${Date.now().toString(36)}:${(++this.nextSession).toString(36)}`
    const timer = view.setTimeout(() => {
      if (this.active?.sessionId === sessionId) this.dismiss()
    }, winner.declaration.durationMs)
    this.active = { key: winner.key, sessionId, canvas, sink: winner.sink, timer }
    try {
      winner.sink.start({
        sessionId,
        registrationId: winner.declaration.id,
        canvas: transfer.call(canvas),
        width,
        height,
        pixelRatio,
        reducedMotion,
        startedAt: view.performance.now(),
      })
    } catch {
      this.dismiss()
    }
  }

  private dismiss(): void {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    this.document.defaultView?.clearTimeout(active.timer)
    active.canvas.remove()
    try { active.sink.stop(active.sessionId) } catch {}
  }

  private removeRegistration(key: string): void {
    const registration = this.registrations.get(key)
    if (registration === undefined) return
    if (this.active?.key === key) this.dismiss()
    registration.surface.dispose()
    this.registrations.delete(key)
    this.reconcile()
  }
}
