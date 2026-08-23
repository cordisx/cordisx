export type HostTooltipPlacement = 'top' | 'bottom'

const NATIVE_TOOLTIP_CLASS = [
  'w-fit', 'select-none', 'text-sm', 'whitespace-normal', 'break-words', 'z-50',
  'rounded-lg', 'border', 'border-text', 'bg-primary-solid', 'text-primary-solid',
  'px-2', 'py-1.5', 'cordisx-host-tooltip',
].join(' ')

let tooltipSequence = 0
const DISMISS_EVENT = 'cordisx:host-tooltips-dismiss'

export function dismissHostTooltips(document: Document): void {
  const EventClass = document.defaultView?.Event
  if (EventClass !== undefined) document.dispatchEvent(new EventClass(DISMISS_EVENT))
}

export class HostTooltipController {
  private activeTarget: HTMLElement | undefined
  private activeTooltip: HTMLElement | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly document: Document) {
    document.addEventListener(DISMISS_EVENT, this.dismiss)
  }

  attach(
    target: HTMLElement,
    label: () => string | undefined,
    preferredPlacement: HostTooltipPlacement,
  ): () => void {
    const schedule = (): void => {
      this.hide()
      this.activeTarget = target
      this.timer = setTimeout(() => this.show(target, label, preferredPlacement), 650)
    }
    const hide = (): void => {
      if (this.activeTarget === target) this.hide()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    target.addEventListener('pointerenter', schedule)
    target.addEventListener('pointerleave', hide)
    target.addEventListener('focus', schedule)
    target.addEventListener('blur', hide)
    target.addEventListener('keydown', escape)
    return () => {
      target.removeEventListener('pointerenter', schedule)
      target.removeEventListener('pointerleave', hide)
      target.removeEventListener('focus', schedule)
      target.removeEventListener('blur', hide)
      target.removeEventListener('keydown', escape)
      hide()
    }
  }

  hide(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.activeTarget !== undefined && this.activeTooltip !== undefined) {
      const describedBy = this.activeTarget.getAttribute('aria-describedby')
      if (describedBy === this.activeTooltip.id) this.activeTarget.removeAttribute('aria-describedby')
    }
    this.activeTooltip?.remove()
    this.activeTooltip = undefined
    this.activeTarget = undefined
  }

  dispose(): void {
    this.document.removeEventListener(DISMISS_EVENT, this.dismiss)
    this.hide()
  }

  private readonly dismiss = (): void => this.hide()

  private show(
    target: HTMLElement,
    label: () => string | undefined,
    preferredPlacement: HostTooltipPlacement,
  ): void {
    this.timer = undefined
    if (this.activeTarget !== target || !target.isConnected || this.document.body === null) return
    const text = label()?.trim()
    if (text === undefined || text === '') return
    const tooltip = this.document.createElement('div')
    tooltip.id = `cordisx-host-tooltip-${++tooltipSequence}`
    tooltip.role = 'tooltip'
    tooltip.className = NATIVE_TOOLTIP_CLASS
    tooltip.dataset.side = preferredPlacement
    tooltip.textContent = text
    Object.assign(tooltip.style, {
      position: 'fixed', left: '0', top: '0', maxWidth: 'min(20rem, calc(100vw - 16px))',
      pointerEvents: 'none', zIndex: '2147483600',
    })
    this.document.body.append(tooltip)
    const triggerRect = target.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const viewportWidth = this.document.defaultView?.innerWidth ?? this.document.documentElement.clientWidth
    const viewportHeight = this.document.defaultView?.innerHeight ?? this.document.documentElement.clientHeight
    const gap = 8
    const edge = 8
    const topFits = triggerRect.top - tooltipRect.height - gap >= edge
    const bottomFits = triggerRect.bottom + tooltipRect.height + gap <= viewportHeight - edge
    const placement = preferredPlacement === 'top'
      ? (topFits || !bottomFits ? 'top' : 'bottom')
      : (bottomFits || !topFits ? 'bottom' : 'top')
    const desiredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
    const left = Math.min(
      Math.max(edge, desiredLeft),
      Math.max(edge, viewportWidth - tooltipRect.width - edge),
    )
    const top = placement === 'top'
      ? triggerRect.top - tooltipRect.height - gap
      : triggerRect.bottom + gap
    tooltip.dataset.side = placement
    tooltip.style.left = `${Math.round(left * 2) / 2}px`
    tooltip.style.top = `${Math.round(Math.max(edge, top) * 2) / 2}px`
    target.setAttribute('aria-describedby', tooltip.id)
    this.activeTooltip = tooltip
  }
}
