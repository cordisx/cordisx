import { createRoot, type Root } from 'react-dom/client'
import { HostThemeProjection } from './host-theme.js'
import { ModelProviderSelector } from './model-provider-selector.js'
import type { ProviderSelectionSnapshot } from './model-provider-selector.js'
import type { ModelProviderRegistry } from './model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from './native-model-provider-transport.js'
import { hideNativeModelProviderTrigger, locateNativeModelProviderSeat } from './adapter/native-model-provider-seat.js'
import type {
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionOwner,
} from './native-provider-selection-client.js'

export function canReplaceNativeModelProviderTrigger(
  state: ProviderSelectionSnapshot,
  catalog: ReturnType<ModelProviderRegistry['snapshot']>,
): boolean {
  return state.available || catalog.providers.length > 0 || catalog.entries.length > 0
}

/** One Host-owned seat; native controls are restored whenever this seat retires. */
export async function installModelProviderSelector(
  document: Document,
  registry: ModelProviderRegistry,
  locale: () => string,
  nativeManagedModelRoutingAvailable = false,
  rendererOwner?: NativeProviderSelectionOwner,
  commandChannel?: NativeProviderSelectionCommandChannel,
) {
  if (!nativeManagedModelRoutingAvailable) return () => {}
  const transport = await CodexDesktopNativeModelProviderTransport.connect(
    nativeManagedModelRoutingAvailable,
    rendererOwner,
    commandChannel,
  )
  if (!transport) return () => {}
  let root: Root | undefined
  let element: HTMLDivElement | undefined
  let trigger: HTMLElement | undefined
  let group: HTMLElement | undefined
  let restoreTrigger: (() => void) | undefined
  let scheduled = false
  let disposed = false
  let detachTheme: (() => void) | undefined
  const theme = new HostThemeProjection(document)
  const unmount = () => {
    root?.unmount()
    root = undefined
    detachTheme?.()
    detachTheme = undefined
    element?.remove()
    element = undefined
    restoreTrigger?.()
    restoreTrigger = undefined
    trigger = undefined
    group = undefined
  }
  const reconcile = () => {
    scheduled = false
    if (disposed) return
    const state = transport.getSnapshot()
    const seat = locateNativeModelProviderSeat(document)
    const catalog = registry.snapshot()
    if (!seat && root && (transport.hasActiveSubmission() || state.submissionError !== undefined)) {
      root.render(<ModelProviderSelector registry={registry} transport={transport} locale={locale()} />)
      return
    }
    if (!seat || (!root && !canReplaceNativeModelProviderTrigger(state, catalog))) {
      unmount()
      return
    }
    if (trigger !== seat.trigger || group !== seat.group) {
      unmount()
      trigger = seat.trigger
      group = seat.group
      const restoreGroup = hideNativeModelProviderTrigger(seat.group)
      const restoreButton = seat.group === trigger ? () => {} : hideNativeModelProviderTrigger(trigger)
      restoreTrigger = () => {
        restoreButton()
        restoreGroup()
      }
      element = document.createElement('div')
      element.dataset.cordisxModelProviderSelector = 'true'
      detachTheme = theme.attach(element)
      root = createRoot(element)
    }
    // Native React can insert context usage before its model group after installation.
    // Keep our sibling at that semantic seat without moving native-owned controls.
    if (element!.parentElement !== seat.parent || element!.nextSibling !== seat.group) {
      const focused = element!.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
      seat.parent.insertBefore(element!, seat.group)
      focused?.focus({ preventScroll: true })
    }
    root!.render(<ModelProviderSelector registry={registry} transport={transport} locale={locale()} />)
  }
  const schedule = () => {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const observer = new MutationObserver(records => {
    if (
      records.some(record =>
        !(record.target instanceof Element)
        || !record.target.closest('[data-cordisx-model-provider-selector],.cxmp-menu,.cxmp-confirm')
      )
    ) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
  const stopCatalog = registry.subscribe(schedule)
  const stopSelection = transport.subscribe(schedule)
  const refresh = setInterval(() => {
    void registry.refresh()
  }, 5_000)
  await registry.refresh()
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(refresh)
    observer.disconnect()
    stopCatalog()
    stopSelection()
    unmount()
    theme.dispose()
    transport.dispose()
  }
}
