export interface NativeModelProviderSeat {
  readonly trigger: HTMLElement
  readonly group: HTMLElement
  readonly parent: HTMLElement
}

export interface NativeModelSelectionControl {
  readonly model: string
  readonly modelLabel?: string
  readonly models: readonly {
    readonly id: string
    readonly label: string
    readonly disabled: boolean
    readonly supportsFastMode: boolean
  }[]
  readonly reasoningEffort: string
  readonly reasoningEfforts: readonly string[]
  readonly serviceTier: 'priority' | null
  selectModel(model: string, reasoningEffort: string): Promise<void>
}

interface ReactFiber {
  readonly return?: ReactFiber | null
  readonly memoizedProps?: unknown
}

const record = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
)

function reactFiber(element: HTMLElement): ReactFiber | undefined {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'))
  return key === undefined ? undefined : (element as unknown as Record<string, unknown>)[key] as ReactFiber | undefined
}

function visible(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView
  if (
    view === null || !element.isConnected
    || (element.hidden && element.dataset.cordisxModelProviderHidden !== 'true')
    || element.closest('[inert]') !== null
  ) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.getAttribute('aria-hidden') === 'true' && ancestor.dataset.cordisxModelProviderHidden !== 'true') {
      return false
    }
  }
  const bounds = element.getBoundingClientRect()
  const style = view.getComputedStyle(element)
  if (element.closest('[data-cordisx-model-provider-hidden="true"]')) return true
  return bounds.width > 0 && bounds.height > 0
    && style.display !== 'none' && style.visibility !== 'hidden'
    && bounds.right > 0 && bounds.bottom > 0 && bounds.left < view.innerWidth && bounds.top < view.innerHeight
}

function reasoningEfforts(props: Record<string, unknown>, model: string): readonly string[] {
  const modelOptions = Array.isArray(props.models) ? props.models : []
  const current = modelOptions
    .map(record)
    .find(option => option?.model === model)
  const supported = Array.isArray(current?.supportedReasoningEfforts)
    ? current.supportedReasoningEfforts
    : Array.isArray(props.powerSelections)
    ? props.powerSelections
    : []
  return Object.freeze([
    ...new Set(
      supported.map(record).map(option => option?.reasoningEffort).filter(
        (effort): effort is string => typeof effort === 'string' && effort !== '',
      ),
    ),
  ])
}

function supportsFastMode(model: Record<string, unknown> | undefined): boolean {
  const additional = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : []
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : []
  return additional.includes('fast') || tiers.some(value => {
    const tier = record(value)
    return tier?.id === 'priority' || tier?.id === 'fast' || tier?.name === 'Fast'
  })
}

/**
 * Exact native Composer model trigger audited in Desktop 26.901.51231 (build 8109).
 * The stable semantic attributes are emitted directly by the native renderer;
 * ambiguous or detached layouts fail closed.
 */
export function locateNativeModelProviderSeat(document: Document): NativeModelProviderSeat | undefined {
  const composers = [...document.querySelectorAll<HTMLElement>(
    '[data-codex-composer-root][data-composer-placement]',
  )].filter(visible)
  if (composers.length !== 1) return undefined
  const composer = composers[0]!
  const footers = [...composer.querySelectorAll<HTMLElement>('[data-composer-footer-responsive]')].filter(visible)
  if (footers.length !== 1) return undefined
  const footer = footers[0]!
  const triggers = [...footer.querySelectorAll<HTMLElement>(
    'button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"]',
  )].filter(visible)
  if (triggers.length !== 1) return undefined
  const trigger = triggers[0]!
  // build8109 wraps the button in an interactive Radix span and a ref-only span.
  // Own their entire group, never insert under the native event handlers.
  let group = trigger
  for (let depth = 0; depth < 3 && group.parentElement?.tagName === 'SPAN'; depth++) {
    const wrapper = group.parentElement
    if (wrapper.children.length !== 1) return undefined
    group = wrapper
  }
  const parent = group.parentElement
  if (parent === null || !footer.contains(parent) || parent.closest('[data-cordisx-surface-host]') !== null) {
    return undefined
  }
  if (parent.closest('button,[role="button"],[aria-haspopup="menu"]')) return undefined
  return { trigger, group, parent }
}

/** Exact React owner contract audited in Desktop 26.901.51231 (build 8109). */
export function locateNativeModelSelectionControl(trigger: HTMLElement): NativeModelSelectionControl | undefined {
  let fiber: ReactFiber | null | undefined = reactFiber(trigger)
  for (let depth = 0; fiber !== undefined && fiber !== null && depth < 40; depth += 1, fiber = fiber.return) {
    const props = record(fiber.memoizedProps)
    const model = props?.model
    const reasoningEffort = props?.reasoningEffort
    const selectModel = props?.onSelectModel
    if (
      props?.showReasoningEffortControls === true
      && props.menuView === 'simple'
      && typeof props.open === 'boolean'
      && typeof model === 'string' && model !== ''
      && typeof reasoningEffort === 'string' && reasoningEffort !== ''
      && Array.isArray(props.models)
      && Array.isArray(props.modelOptions)
      && Array.isArray(props.powerSelections)
      && typeof selectModel === 'function'
      && typeof props.onSelectModelOption === 'function'
      && typeof props.onSelectReasoningEffort === 'function'
      && typeof props.onToggleMenuView === 'function'
    ) {
      return {
        model,
        ...modelPresentation(props.models, model),
        models: props.modelOptions.map(record).flatMap(option => {
          const item = record(option?.model)
          if (typeof item?.model !== 'string' || item.hidden === true) return []
          const label = modelPresentation([item], item.model).modelLabel
          return label
            ? [{
              id: item.model,
              label,
              disabled: props.modelOptionsDisabled === true || option?.disabledReason != null,
              supportsFastMode: supportsFastMode(item),
            }]
            : []
        }),
        reasoningEffort,
        reasoningEfforts: reasoningEfforts(props, model),
        serviceTier: props.selectedServiceTier === 'priority' ? 'priority' : null,
        selectModel: async (nextModel, nextReasoningEffort) => {
          if (await selectModel(nextModel, nextReasoningEffort) === false) {
            throw new Error('Native model update was rejected')
          }
        },
      }
    }
  }
  return undefined
}

function modelPresentation(models: readonly unknown[], model: string): { readonly modelLabel?: string } {
  const label = models.map(record).find(option => option?.model === model)?.displayName
  return typeof label === 'string' && label.trim() !== '' && label !== model
    ? { modelLabel: friendlyModelLabel(label) }
    : {}
}

export function friendlyModelLabel(label: string): string {
  return label.replace(/\s*\[[^\]]*\]/g, '').trim()
}

/** Native utility classes can override the UA hidden rule; restore the exact inline declaration on retirement. */
export function hideNativeModelProviderTrigger(trigger: HTMLElement): () => void {
  const hidden = trigger.hidden
  const display = trigger.style.getPropertyValue('display')
  const priority = trigger.style.getPropertyPriority('display')
  const visibility = trigger.style.getPropertyValue('visibility')
  const visibilityPriority = trigger.style.getPropertyPriority('visibility')
  const pointerEvents = trigger.style.getPropertyValue('pointer-events')
  const pointerPriority = trigger.style.getPropertyPriority('pointer-events')
  const ariaHidden = trigger.getAttribute('aria-hidden')
  trigger.dataset.cordisxModelProviderHidden = 'true'
  trigger.hidden = true
  trigger.style.setProperty('display', 'none', 'important')
  trigger.style.setProperty('visibility', 'hidden', 'important')
  trigger.style.setProperty('pointer-events', 'none', 'important')
  trigger.setAttribute('aria-hidden', 'true')
  return () => {
    trigger.hidden = hidden
    if (display) trigger.style.setProperty('display', display, priority)
    else trigger.style.removeProperty('display')
    if (visibility) trigger.style.setProperty('visibility', visibility, visibilityPriority)
    else trigger.style.removeProperty('visibility')
    if (pointerEvents) trigger.style.setProperty('pointer-events', pointerEvents, pointerPriority)
    else trigger.style.removeProperty('pointer-events')
    if (ariaHidden === null) trigger.removeAttribute('aria-hidden')
    else trigger.setAttribute('aria-hidden', ariaHidden)
    delete trigger.dataset.cordisxModelProviderHidden
  }
}
