import type { CordisXSessionBackdropPresentation } from '../../contracts.js'
import { create } from './dom.js'
import { rangeProgress } from './reasoning.js'

/** @internal Host-owned, pointer-inert backdrop driven by the native reasoning value. */
export class SessionBackdropProjection {
  private readonly root: HTMLElement
  private readonly host: HTMLElement
  private readonly hostIsolation: string
  private readonly architecture: HTMLElement
  private readonly glow: HTMLElement
  private readonly portraits: readonly [HTMLImageElement, HTMLImageElement]
  private activePortrait = 0
  private portraitSource = ''
  private native: HTMLInputElement | undefined
  private presentation: CordisXSessionBackdropPresentation | undefined
  private portraitLabels: readonly string[] = []
  private sessionId: string | undefined
  private progress = 0
  private portraitVisible: boolean | undefined
  private effectsVisible: boolean | undefined

  constructor(private readonly document: Document) {
    const mainLayout = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout="thread-edge-scroll"]')
      ?? document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')
    this.host = mainLayout?.closest<HTMLElement>('main')
      ?? document.getElementById('root')
      ?? document.body
      ?? document.documentElement
    this.hostIsolation = this.host.style.isolation
    this.host.style.isolation = 'isolate'
    this.root = create(document, 'div', 'cordisx-session-backdrop')
    this.root.dataset.cordisxSurfaceHost = 'session.backdrop'
    this.root.setAttribute('aria-hidden', 'true')
    this.architecture = create(document, 'span', 'cordisx-session-backdrop-architecture')
    this.glow = create(document, 'span', 'cordisx-session-backdrop-glow')
    this.portraits = [document.createElement('img'), document.createElement('img')]
    for (const [index, portrait] of this.portraits.entries()) {
      portrait.className = 'cordisx-session-backdrop-portrait'
      portrait.alt = ''
      portrait.decoding = 'async'
      portrait.dataset.active = index === this.activePortrait ? 'true' : 'false'
    }
    this.host.prepend(this.root)
  }

  update(
    sessionId: string,
    native: HTMLInputElement | undefined,
    presentation: CordisXSessionBackdropPresentation,
    portraitLabels: readonly string[],
  ): void {
    if (this.sessionId !== sessionId) this.progress = native === undefined ? 0 : rangeProgress(native)
    this.sessionId = sessionId
    this.presentation = presentation
    this.portraitLabels = portraitLabels
    if (this.native !== native) this.connect(native)
    this.root.dataset.motion = presentation.motion ?? 'smooth'
    this.syncLayers(presentation)
    this.sync()
  }

  dispose(): void {
    this.connect(undefined)
    this.root.remove()
    if (this.host.style.isolation === 'isolate') this.host.style.isolation = this.hostIsolation
  }

  private readonly onInput = (): void => {
    if (this.native !== undefined) this.progress = rangeProgress(this.native)
    this.sync()
  }

  private connect(native: HTMLInputElement | undefined): void {
    this.native?.removeEventListener('input', this.onInput)
    this.native?.removeEventListener('change', this.onInput)
    this.native = native
    if (native === undefined) return
    this.progress = rangeProgress(native)
    native.addEventListener('input', this.onInput)
    native.addEventListener('change', this.onInput)
  }

  private syncLayers(presentation: CordisXSessionBackdropPresentation): void {
    const portraitVisible = presentation.layers?.portrait !== false
    const effectsVisible = presentation.layers?.effects !== false
    if (this.portraitVisible === portraitVisible && this.effectsVisible === effectsVisible) return
    this.portraitVisible = portraitVisible
    this.effectsVisible = effectsVisible
    this.root.dataset.portrait = String(portraitVisible)
    this.root.dataset.effects = String(effectsVisible)
    this.root.replaceChildren(
      ...(effectsVisible ? [this.architecture, this.glow] : []),
      ...(portraitVisible ? this.portraits : []),
    )
  }

  private sync(): void {
    const presentation = this.presentation
    if (presentation === undefined) return
    const index = Math.round(this.progress * (presentation.stages.length - 1))
    const stage = presentation.stages[index] ?? presentation.stages[0]!
    const source = `data:${stage.portrait.mediaType};base64,${stage.portrait.data}`
    if (this.portraitVisible && this.portraitSource !== source) {
      const previous = this.portraits[this.activePortrait]!
      this.activePortrait = this.activePortrait === 0 ? 1 : 0
      const next = this.portraits[this.activePortrait]!
      next.src = source
      next.dataset.active = 'true'
      previous.dataset.active = 'false'
      this.portraitSource = source
    }
    this.root.dataset.material = stage.material
    this.root.dataset.ambience = stage.ambience
    this.root.dataset.stage = String(index)
    this.root.dataset.peak = index === presentation.stages.length - 1 ? 'true' : 'false'
    if (this.portraitVisible) this.root.dataset.portraitLabel = this.portraitLabels[index] ?? ''
    else delete this.root.dataset.portraitLabel
    this.root.style.setProperty('--cordisx-backdrop-progress', String(this.progress))
  }
}
