import { create, strictlyVisible } from './dom.js'
import type {
  CordisXHostExtensionPointControlCatalogV1,
  CordisXReasoningIntensityPresentation,
} from '../../contracts.js'
import { CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1 } from '../../contracts.js'
import type { ControlledSurfacePointBinding } from '../controlled-surfaces.js'
import { ControlledSurfaceCoordinator } from '../controlled-surfaces.js'

const reasoningMenuCleanup = new WeakMap<HTMLInputElement, () => void>()

function reasoningPowerSliderRange(document: Document): HTMLInputElement | undefined {
  const nativeSliders = [
    ...document.querySelectorAll<HTMLElement>('[data-model-picker-power-slider] [role="slider"][aria-valuenow]'),
  ]
    .filter(strictlyVisible)
    .filter(slider => slider.closest<HTMLElement>('[data-active]')?.dataset.active !== 'false')
  if (nativeSliders.length !== 1) return undefined
  const nativeSlider = nativeSliders[0]!
  const container = nativeSlider.closest<HTMLElement>('[data-model-picker-power-slider]')
  const visualRoot = container?.querySelector<HTMLElement>(':scope > [data-orientation="horizontal"]')
  const menu = container?.closest<HTMLElement>('[role="menu"]')
  if (
    container === null || container === undefined || visualRoot === null || visualRoot === undefined || menu === null
    || menu === undefined
  ) return undefined
  const existing = container.querySelector<HTMLInputElement>(':scope > input[data-cordisx-reasoning-proxy="true"]')
  if (existing !== null) return existing
  for (const stale of document.querySelectorAll<HTMLInputElement>('input[data-cordisx-reasoning-proxy="true"]')) {
    reasoningMenuCleanup.get(stale)?.()
  }

  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'cordisx-reasoning-native-menu-range'
  input.dataset.cordisxReasoningProxy = 'true'
  input.min = nativeSlider.getAttribute('aria-valuemin') ?? '0'
  input.max = nativeSlider.getAttribute('aria-valuemax') ?? '4'
  input.step = '1'
  input.value = nativeSlider.getAttribute('aria-valuenow') ?? input.min
  input.setAttribute('aria-label', nativeSlider.getAttribute('aria-label') ?? 'Reasoning intensity')

  const containerPosition = container.style.position
  const containerHeight = container.style.height
  const visualOpacity = visualRoot.style.opacity
  const menuWidth = menu.style.width
  const menuMinWidth = menu.style.minWidth
  container.dataset.cordisxSurfaceHost = 'composer.reasoning-intensity'
  container.style.position = 'relative'
  container.style.height = '32px'
  visualRoot.style.opacity = '0'
  menu.style.width = '300px'
  menu.style.minWidth = '300px'
  container.append(input)

  const commit = (): void => {
    const current = Number(nativeSlider.getAttribute('aria-valuenow') ?? input.min)
    const target = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(input.valueAsNumber)))
    const key = target >= current ? 'ArrowRight' : 'ArrowLeft'
    const Keyboard = document.defaultView?.KeyboardEvent
    if (Keyboard === undefined) return
    nativeSlider.focus()
    for (let value = current; value !== target; value += target > current ? 1 : -1) {
      nativeSlider.dispatchEvent(new Keyboard('keydown', { key, code: key, bubbles: true }))
      nativeSlider.dispatchEvent(new Keyboard('keyup', { key, code: key, bubbles: true }))
    }
  }
  const syncFromNative = (): void => {
    const value = nativeSlider.getAttribute('aria-valuenow')
    if (value !== null) input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const Observer = document.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(syncFromNative)
  observer?.observe(nativeSlider, { attributes: true, attributeFilter: ['aria-valuenow'] })
  input.addEventListener('change', commit)
  reasoningMenuCleanup.set(input, () => {
    observer?.disconnect()
    input.removeEventListener('change', commit)
    input.remove()
    container.style.position = containerPosition
    container.style.height = containerHeight
    visualRoot.style.opacity = visualOpacity
    menu.style.width = menuWidth
    menu.style.minWidth = menuMinWidth
    delete container.dataset.cordisxSurfaceHost
    reasoningMenuCleanup.delete(input)
  })
  return input
}

function reasoningMenuRange(document: Document): HTMLInputElement | undefined {
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
    .filter(strictlyVisible)
    .filter(menu => menu.dataset.cordisxReasoningMenu !== 'true')
    .flatMap(menu => {
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .filter(item => item.closest('[role="menu"]') === menu)
        .filter(strictlyVisible)
      if (items.length < 4 || items.length > 8) return []
      const parent = items[0]?.parentElement
      if (parent === null || parent === undefined || items.some(item => item.parentElement !== parent)) return []
      const selectedIndex = items.findIndex(item => item.querySelector('svg') !== null)
      if (selectedIndex < 0) return []
      return [{ menu, items, parent, selectedIndex }]
    })
  if (menus.length !== 1) return undefined
  const candidate = menus[0]
  if (candidate === undefined) return undefined
  const { menu, items, parent, selectedIndex } = candidate
  const shell = create(document, 'div', 'cordisx-reasoning-native-menu-shell')
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'cordisx-reasoning-native-menu-range'
  input.min = '0'
  input.max = String(items.length - 1)
  input.step = '1'
  input.value = String(selectedIndex)
  const heading = [...parent.children].find(child => !items.includes(child as HTMLElement))
  input.setAttribute('aria-label', heading?.textContent?.trim() || 'Reasoning intensity')
  shell.append(input)

  const menuWidth = menu.style.width
  const menuMinWidth = menu.style.minWidth
  const displays = items.map(item => item.style.display)
  menu.dataset.cordisxReasoningMenu = 'true'
  menu.style.width = '300px'
  menu.style.minWidth = '300px'
  for (const item of items) item.style.display = 'none'
  parent.append(shell)

  const commit = (): void => {
    const index = Math.max(0, Math.min(items.length - 1, Math.round(input.valueAsNumber)))
    items[index]?.click()
  }
  input.addEventListener('change', commit)
  reasoningMenuCleanup.set(input, () => {
    input.removeEventListener('change', commit)
    shell.remove()
    items.forEach((item, index) => {
      item.style.display = displays[index] ?? ''
    })
    menu.style.width = menuWidth
    menu.style.minWidth = menuMinWidth
    delete menu.dataset.cordisxReasoningMenu
    reasoningMenuCleanup.delete(input)
  })
  return input
}

/** @internal Resolve either the historical native range or the current native menu-backed control. */
export function resolveReasoningIntensityRange(
  document: Document,
  sessionId: string | undefined,
): HTMLInputElement | undefined {
  if (sessionId === undefined) return undefined
  const Input = document.defaultView?.HTMLInputElement
  if (Input === undefined) return undefined
  const ranges = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')]
    .filter((candidate): candidate is HTMLInputElement => candidate instanceof Input && strictlyVisible(candidate))
  const connected = ranges.filter(candidate => candidate.dataset.cordisxReasoningNative === 'true')
  if (connected.length === 1) return connected[0]
  const candidates = ranges
    .filter(candidate => candidate.dataset.cordisxReasoningNative !== 'true')
    .filter((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.width >= 120 && rect.height <= 96 && Number.isFinite(candidate.valueAsNumber)
    })
  if (candidates.length === 1) return candidates[0]
  return candidates.length === 0 ? reasoningPowerSliderRange(document) ?? reasoningMenuRange(document) : undefined
}

/** @internal Host-owned projection used by the Codex adapter and focused renderer tests. */
export class ReasoningIntensityProjection {
  private readonly root: HTMLElement
  private readonly fill: HTMLElement
  private readonly thumb: HTMLElement
  private readonly ticks: HTMLElement
  private readonly particles: HTMLElement
  private native: HTMLInputElement | undefined
  private nativeOpacity = ''
  private nativeAccentColor = ''
  private resizeObserver: ResizeObserver | undefined
  private dragging = false
  private pointerX = 0
  private presentation: CordisXReasoningIntensityPresentation | undefined
  private title = ''
  private labels: readonly string[] = []
  private nativeHidden = true

  constructor(private readonly document: Document) {
    this.root = create(document, 'div', 'cordisx-reasoning-intensity')
    this.root.dataset.cordisxSurfaceHost = 'composer.reasoning-intensity'
    this.root.dataset.cordisxNoDrag = 'true'
    this.root.setAttribute('aria-hidden', 'true')
    this.fill = create(document, 'span', 'cordisx-reasoning-fill')
    this.ticks = create(document, 'span', 'cordisx-reasoning-ticks')
    this.particles = create(document, 'span', 'cordisx-reasoning-particles')
    this.thumb = create(document, 'span', 'cordisx-reasoning-thumb')
    this.thumb.append(create(document, 'i'), create(document, 'i'))
    for (let index = 0; index < 14; index += 1) {
      const particle = create(document, 'i')
      particle.style.setProperty('--particle-index', String(index))
      particle.style.setProperty('--particle-y', `${12 + ((index * 37) % 76)}%`)
      particle.style.setProperty('--particle-delay', `${-((index * 173) % 1100)}ms`)
      this.particles.append(particle)
    }
    this.root.append(this.fill, this.ticks, this.particles, this.thumb)
    Object.assign(this.root.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483190' })
    ;(document.body ?? document.documentElement).append(this.root)
  }

  update(
    native: HTMLInputElement,
    presentation: CordisXReasoningIntensityPresentation,
    title: string,
    stageLabels: readonly string[],
    nativeHidden = true,
  ): void {
    if (this.native !== native) this.connect(native)
    this.nativeHidden = nativeHidden
    this.applyNativeVisibility()
    this.presentation = presentation
    this.title = title
    this.labels = stageLabels
    this.root.dataset.motion = presentation.motion ?? 'smooth'
    this.ticks.replaceChildren(...presentation.stages.map(() => create(this.document, 'i')))
    this.sync(presentation, title, stageLabels)
    this.align()
    const view = this.document.defaultView
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(this.align)
    view?.setTimeout(this.align, 120)
    view?.setTimeout(this.align, 360)
  }

  dispose(): void {
    this.disconnect()
    this.root.remove()
  }

  private readonly onInput = (): void => {
    if (this.presentation !== undefined) this.sync(this.presentation, this.title, this.labels)
    this.align()
    const view = this.document.defaultView
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(this.align)
  }
  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerX = event.clientX
    this.dragging = false
  }
  private readonly onPointerMove = (event: PointerEvent): void => {
    if ((event.buttons & 1) === 0 || Math.abs(event.clientX - this.pointerX) < 4) return
    this.dragging = true
    this.root.dataset.dragging = 'true'
  }
  private readonly onPointerUp = (): void => {
    this.dragging = false
    delete this.root.dataset.dragging
  }
  private readonly align = (): void => {
    if (this.native === undefined || !this.native.isConnected) return
    const rect = this.native.getBoundingClientRect()
    Object.assign(this.root.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
    if (this.presentation !== undefined) this.positionThumb(rangeProgress(this.native), rect.width)
  }

  private connect(native: HTMLInputElement): void {
    this.disconnect()
    this.native = native
    this.nativeOpacity = native.style.opacity
    this.nativeAccentColor = native.style.accentColor
    native.dataset.cordisxReasoningNative = 'true'
    this.applyNativeVisibility()
    native.addEventListener('input', this.onInput)
    native.addEventListener('change', this.onInput)
    native.addEventListener('pointerdown', this.onPointerDown)
    native.addEventListener('pointermove', this.onPointerMove)
    native.addEventListener('pointerup', this.onPointerUp)
    const Resize = this.document.defaultView?.ResizeObserver
    if (Resize !== undefined) {
      this.resizeObserver = new Resize(this.align)
      this.resizeObserver.observe(native)
    }
    this.document.defaultView?.addEventListener('resize', this.align)
    this.document.defaultView?.addEventListener('scroll', this.align, true)
  }

  private applyNativeVisibility(): void {
    if (this.native === undefined) return
    this.native.style.opacity = this.nativeHidden ? '0' : this.nativeOpacity
    this.native.style.accentColor = this.nativeHidden ? 'transparent' : this.nativeAccentColor
  }

  private disconnect(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    this.document.defaultView?.removeEventListener('resize', this.align)
    this.document.defaultView?.removeEventListener('scroll', this.align, true)
    if (this.native === undefined) return
    this.native.removeEventListener('input', this.onInput)
    this.native.removeEventListener('change', this.onInput)
    this.native.removeEventListener('pointerdown', this.onPointerDown)
    this.native.removeEventListener('pointermove', this.onPointerMove)
    this.native.removeEventListener('pointerup', this.onPointerUp)
    this.native.style.opacity = this.nativeOpacity
    this.native.style.accentColor = this.nativeAccentColor
    delete this.native.dataset.cordisxReasoningNative
    reasoningMenuCleanup.get(this.native)?.()
    this.native = undefined
  }

  private sync(
    presentation: CordisXReasoningIntensityPresentation,
    title: string,
    stageLabels: readonly string[],
  ): void {
    if (this.native === undefined) return
    this.root.dataset.title = title
    const progress = rangeProgress(this.native)
    const index = Math.round(progress * (presentation.stages.length - 1))
    const stage = presentation.stages[index] ?? presentation.stages[0]!
    const label = stageLabels[index] ?? title
    this.root.dataset.material = stage.material
    this.root.title = `${title}: ${label}`
    this.root.style.setProperty('--cordisx-reasoning-progress', `${progress * 100}%`)
    this.fill.style.width = `${progress * 100}%`
    this.positionThumb(progress, this.native.getBoundingClientRect().width)
    this.root.dataset.peak = index === presentation.stages.length - 1 ? 'true' : 'false'
  }

  private positionThumb(progress: number, width: number): void {
    const thumbWidth = 42
    const trackInset = 3
    this.thumb.style.left = `${
      trackInset + thumbWidth / 2 + progress * Math.max(0, width - thumbWidth - trackInset * 2)
    }px`
  }
}

/** @internal Host-owned and fully reversible native visibility effect. */
export class ReasoningIntensityNativeVisibility {
  private native: HTMLInputElement | undefined
  private opacity = ''
  private accentColor = ''

  update(native: HTMLInputElement | undefined, hidden: boolean): void {
    if (this.native !== native) {
      this.restore()
      if (native !== undefined) {
        this.native = native
        this.opacity = native.style.opacity
        this.accentColor = native.style.accentColor
      }
    }
    if (this.native === undefined) return
    this.native.dataset.cordisxReasoningNative = 'true'
    this.native.style.opacity = hidden ? '0' : this.opacity
    this.native.style.accentColor = hidden ? 'transparent' : this.accentColor
  }

  dispose(): void {
    this.restore()
  }

  private restore(): void {
    if (this.native === undefined) return
    this.native.style.opacity = this.opacity
    this.native.style.accentColor = this.accentColor
    delete this.native.dataset.cordisxReasoningNative
    reasoningMenuCleanup.get(this.native)?.()
    this.native = undefined
  }
}

const REASONING_CONTROL_POINT = 'composer.reasoning-intensity'

export const CORDISX_CODEX_CONTROL_CATALOG = {
  $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  schemaVersion: 1,
  points: [{
    id: REASONING_CONTROL_POINT,
    modes: [
      { id: 'compose', stacking: 'ordered', coexistsWith: ['proxy'], defaultAuthorization: 'allow' },
      {
        id: 'replace',
        stacking: 'exclusive',
        exclusiveGroup: 'renderer',
        coexistsWith: ['proxy'],
        defaultAuthorization: 'deny',
      },
      {
        id: 'overlay',
        stacking: 'exclusive',
        exclusiveGroup: 'renderer',
        coexistsWith: ['proxy'],
        defaultAuthorization: 'deny',
      },
      {
        id: 'proxy',
        stacking: 'ordered',
        coexistsWith: ['compose', 'replace', 'overlay', 'hide-native'],
        defaultAuthorization: 'deny',
      },
      {
        id: 'hide-native',
        stacking: 'exclusive',
        exclusiveGroup: 'renderer',
        coexistsWith: ['proxy'],
        defaultAuthorization: 'deny',
      },
    ],
    exclusiveGroups: [{
      id: 'renderer',
      modes: ['replace', 'overlay', 'hide-native'],
      cardinality: 'one',
      selection: 'user',
      nativeFallback: true,
    }],
    safeProperties: [{
      id: 'reasoningIntensity',
      schema: { type: 'string' },
      visibility: 'renderer-safe',
      mutable: false,
    }],
    safeCommands: [{
      id: 'setReasoningIntensity',
      dispatch: 'host-brokered',
      arguments: [{ id: 'value', schema: { type: 'string' }, required: true }],
    }],
    safeEvents: [{
      id: 'reasoningIntensityChanged',
      delivery: 'host-projected',
      payload: [{ id: 'value', schema: { type: 'string' }, required: true }],
    }],
    ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
  }],
} as const satisfies CordisXHostExtensionPointControlCatalogV1

class ReasoningIntensityControlBinding implements ControlledSurfacePointBinding {
  private native: HTMLInputElement | undefined
  private coordinator: ControlledSurfaceCoordinator | undefined
  private readonly onValueChange = (): void => {
    this.coordinator?.invalidate()
    if (this.native !== undefined) {
      this.coordinator?.publishEvent(REASONING_CONTROL_POINT, 'reasoningIntensityChanged', { value: this.native.value })
    }
  }

  connect(coordinator: ControlledSurfaceCoordinator): void {
    this.coordinator = coordinator
  }

  update(native: HTMLInputElement | undefined): void {
    if (this.native === native) return
    this.native?.removeEventListener('input', this.onValueChange)
    this.native?.removeEventListener('change', this.onValueChange)
    this.native = native
    this.native?.addEventListener('input', this.onValueChange)
    this.native?.addEventListener('change', this.onValueChange)
    this.coordinator?.invalidate()
  }

  currentState(): Readonly<{ state: 'active' | 'not-mounted'; reason: string }> {
    return this.native?.isConnected === true
      ? { state: 'active', reason: 'point.mounted' }
      : { state: 'not-mounted', reason: 'point.not-mounted' }
  }

  readProperty(id: string): string {
    if (id !== 'reasoningIntensity' || this.native === undefined) throw new Error('reasoning property is unavailable')
    return this.native.value
  }

  commandAvailability(id: string): Readonly<{ available: boolean; reason?: string }> {
    return id === 'setReasoningIntensity' && this.native?.isConnected === true
      ? { available: true }
      : { available: false, reason: 'point.not-mounted' }
  }

  eventAvailability(id: string): Readonly<{ available: boolean; reason?: string }> {
    return id === 'reasoningIntensityChanged' && this.native?.isConnected === true
      ? { available: true }
      : { available: false, reason: 'point.not-mounted' }
  }

  dispatch(id: string, arguments_: Readonly<Record<string, string | number | boolean | null>>): void {
    if (id !== 'setReasoningIntensity' || this.native === undefined) throw new Error('reasoning command is unavailable')
    const value = String(arguments_.value)
    const numeric = Number(value)
    const min = Number(this.native.min || 0)
    const max = Number(this.native.max || 100)
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) throw new Error('reasoning value is out of range')
    this.native.value = value
    const EventClass = this.native.ownerDocument.defaultView?.Event
    if (EventClass !== undefined) {
      this.native.dispatchEvent(new EventClass('input', { bubbles: true }))
      this.native.dispatchEvent(new EventClass('change', { bubbles: true }))
    }
  }

  dispose(): void {
    this.update(undefined)
    this.coordinator = undefined
  }
}

function rangeProgress(native: HTMLInputElement): number {
  const min = Number(native.min || 0)
  const max = Number(native.max || 100)
  const value = Number.isFinite(native.valueAsNumber) ? native.valueAsNumber : Number(native.value)
  return max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
}

export { rangeProgress, REASONING_CONTROL_POINT, ReasoningIntensityControlBinding }
