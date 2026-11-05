import { createRoot, type Root } from 'react-dom/client'
import { HostThemeProjection } from './host-theme.js'
import { ModelProviderSelector } from './model-provider-selector.js'
import type { ProviderSelectionSnapshot } from './model-provider-selector.js'
import type { ModelProviderRegistry } from './model-providers.js'
import { CodexDesktopNativeModelProviderTransport } from './native-model-provider-transport.js'
import {
  hideNativeModelProviderTrigger,
  locateNativeModelProviderMountSeat,
  nativeModelProviderComposers,
} from './adapter/native-model-provider-seat.js'
import {
  nativeModelProviderInteractionAllowed,
  nativeModelProviderObservedAttributes,
} from './adapter/native-model-provider-interaction.js'
import type {
  NativeProviderSelectionCommandChannel,
  NativeProviderSelectionOwner,
} from './native-provider-selection-client.js'

export function canReplaceNativeModelProviderTrigger(
  state: ProviderSelectionSnapshot,
  catalog: ReturnType<ModelProviderRegistry['snapshot']>,
): boolean {
  return catalog.startup !== undefined || state.available || catalog.providers.length > 0 || catalog.entries.length > 0
}

/** One independently owned selector per native composer, including side chats. */
export async function installModelProviderSelector(
  document: Document,
  registry: ModelProviderRegistry,
  locale: () => string,
  nativeManagedModelRoutingAvailable = false,
  rendererOwner?: NativeProviderSelectionOwner,
  commandChannel?: NativeProviderSelectionCommandChannel,
  navigateContinuation?: (threadId: string) => void | Promise<void>,
) {
  if (!nativeManagedModelRoutingAvailable) return () => {}
  const entries = new Map<HTMLElement, { disposed: boolean; cleanup?: () => void }>()
  let disposed = false
  let scheduled = false
  const reconcile = () => {
    scheduled = false
    if (disposed) return
    const composers = new Set(nativeModelProviderComposers(document))
    for (const [composer, entry] of entries) {
      if (composers.has(composer)) continue
      entry.disposed = true
      entry.cleanup?.()
      entries.delete(composer)
    }
    for (const composer of composers) {
      if (entries.has(composer)) continue
      const entry: { disposed: boolean; cleanup?: () => void } = { disposed: false }
      entries.set(composer, entry)
      void installComposerModelProviderSelector(
        document,
        composer,
        `composer-${crypto.randomUUID()}`,
        registry,
        locale,
        rendererOwner,
        commandChannel,
        navigateContinuation,
      ).then(cleanup => {
        if (entry.disposed || disposed) cleanup()
        else entry.cleanup = cleanup
      })
    }
  }
  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...nativeModelProviderObservedAttributes, 'data-composer-placement'],
  })
  const refresh = setInterval(() => {
    void registry.refresh()
  }, 5_000)
  void registry.refresh()
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    clearInterval(refresh)
    for (const entry of entries.values()) {
      entry.disposed = true
      entry.cleanup?.()
    }
    entries.clear()
  }
}

async function installComposerModelProviderSelector(
  document: Document,
  composer: HTMLElement,
  composerId: string,
  registry: ModelProviderRegistry,
  locale: () => string,
  rendererOwner?: NativeProviderSelectionOwner,
  commandChannel?: NativeProviderSelectionCommandChannel,
  navigateContinuation?: (threadId: string) => void | Promise<void>,
) {
  const transport = await CodexDesktopNativeModelProviderTransport.connect(
    true,
    rendererOwner,
    commandChannel,
    (providerId, modelId) => {
      const provider = registry.snapshot().providers.find(provider => provider.providerId === providerId)
      const model = provider?.models.find(model => model.id === modelId)
      return provider === undefined || model === undefined ? undefined : model.reasoningCapabilities ?? null
    },
    composer,
    composerId,
    navigateContinuation,
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
    const seat = locateNativeModelProviderMountSeat(document, composer)
    const catalog = registry.snapshot()
    if (!seat && root && (transport.hasActiveSubmission() || state.submissionError !== undefined)) {
      root.render(<ModelProviderSelector registry={registry} transport={transport} locale={locale()} suspended />)
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
      if (nativeModelProviderInteractionAllowed(seat.trigger)) focused?.focus({ preventScroll: true })
    }
    root!.render(
      <ModelProviderSelector
        registry={registry}
        transport={transport}
        locale={locale()}
        suspended={!nativeModelProviderInteractionAllowed(seat.trigger)}
      />,
    )
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
        || !record.target.closest(
          '[data-cordisx-model-provider-selector], [data-cordisx-page-outlet], .cxmp-menu, .cxmp-confirm',
        )
      )
    ) schedule()
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: nativeModelProviderObservedAttributes,
  })
  const stopCatalog = registry.subscribe(schedule)
  const stopSelection = transport.subscribe(schedule)
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    stopCatalog()
    stopSelection()
    unmount()
    theme.dispose()
    transport.dispose()
  }
}
