import { nativeComposerPermissions } from './adapter/native-composer-permissions.js'
import { hideNativeModelProviderTrigger } from './adapter/native-model-provider-seat.js'
import { logComposerTiming } from './native-composer-diagnostics.js'

const prefix = 'cordisx.permission-display.v1:'
const validLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n]/u.test(value)

interface PermissionDisplayEntry {
  key: string
  label?: string | undefined
  startedAt?: number | undefined
  element?: HTMLElement | undefined
  restore?: (() => void) | undefined
  menuStartedAt?: number | undefined
  menuDeadline?: ReturnType<typeof setTimeout> | undefined
}

/** Cached permission names are read-only labels; native readiness still gates every action. */
export function installNativePermissionDisplay(document: Document): () => void {
  const entries = new Map<HTMLButtonElement, PermissionDisplayEntry>()
  let storage: Storage | undefined
  try {
    storage = document.defaultView?.localStorage
  } catch { /* Optional storage. */ }
  const read = (key: string): string | undefined => {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? 'null') as { label?: unknown } | null
      return validLabel(value?.label) ? value.label : undefined
    } catch {
      return undefined
    }
  }
  const clear = (entry: PermissionDisplayEntry) => {
    entry.element?.remove()
    entry.restore?.()
    entry.element = undefined
    entry.restore = undefined
  }
  const finishMenu = (entry: PermissionDisplayEntry, state: 'ready' | 'timeout' | 'disposed') => {
    if (entry.menuStartedAt === undefined) return
    clearTimeout(entry.menuDeadline)
    logComposerTiming('permissions/menu', state, entry.menuStartedAt)
    entry.menuStartedAt = undefined
    entry.menuDeadline = undefined
  }
  // Observe the native menu without changing focus, dispatch, or permission decisions.
  const observeClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target : undefined
    const trigger = target?.closest<HTMLButtonElement>('button[data-composer-navigation-target="permissions"]')
    const entry = trigger && entries.get(trigger)
    if (!trigger || !entry) {
      if (target?.closest('[data-cordisx-permission-display]')) logComposerTiming('permissions/menu', 'cached')
      return
    }
    if (trigger.getAttribute('aria-expanded') === 'true' || entry.menuStartedAt !== undefined) return
    entry.menuStartedAt = performance.now()
    logComposerTiming('permissions/menu', 'pending', entry.menuStartedAt)
    entry.menuDeadline = setTimeout(() => {
      finishMenu(entry, trigger.getAttribute('aria-expanded') === 'true' ? 'ready' : 'timeout')
    }, 2_000)
  }
  let scheduled = false
  let disposed = false
  const reconcile = () => {
    scheduled = false
    if (disposed) return
    const active = new Set<HTMLButtonElement>()
    for (const seat of nativeComposerPermissions(document)) {
      active.add(seat.trigger)
      const key = prefix + JSON.stringify([
        seat.hostId,
        seat.threadId ?? null,
        document.documentElement.lang || document.defaultView?.navigator.language,
      ])
      let entry = entries.get(seat.trigger)
      if (entry?.key !== key) {
        if (entry) {
          finishMenu(entry, 'disposed')
          clear(entry)
        }
        entry = { key, label: read(key) }
        entries.set(seat.trigger, entry)
      }
      if (seat.trigger.getAttribute('aria-expanded') === 'true') finishMenu(entry!, 'ready')
      // Loading presentation can lag native interaction readiness. Never cover an enabled trigger.
      if (!seat.loading || !seat.disabled) {
        clear(entry!)
        if (entry!.startedAt !== undefined) logComposerTiming('permissions', 'ready', entry!.startedAt)
        entry!.startedAt = undefined
        if (validLabel(seat.label) && entry!.label !== seat.label) {
          entry!.label = seat.label
          try {
            storage?.setItem(key, JSON.stringify({ label: seat.label, updatedAt: Date.now() }))
          } catch { /* Optional. */ }
        }
        continue
      }
      // Native aria-describedby can already expose the current label while policy/config is pending.
      const label = seat.label ?? entry!.label
      if (entry!.startedAt === undefined) {
        entry!.startedAt = performance.now()
        logComposerTiming('permissions', label ? 'cached' : 'pending', entry!.startedAt)
      }
      if (!label) continue
      if (entry!.element) {
        if (entry!.element.textContent !== label) entry!.element.textContent = label
        continue
      }
      const element = document.createElement('span')
      element.dataset.cordisxPermissionDisplay = 'true'
      element.className = `${seat.trigger.className} text-sm text-tertiary`
      element.textContent = label
      element.setAttribute('aria-disabled', 'true')
      element.title = seat.trigger.getAttribute('aria-label') ?? label
      entry!.element = element
      entry!.restore = hideNativeModelProviderTrigger(seat.trigger)
      seat.trigger.before(element)
    }
    for (const [trigger, entry] of entries) {
      if (active.has(trigger)) continue
      finishMenu(entry, 'disposed')
      clear(entry)
      entries.delete(trigger)
    }
  }
  const observer = new MutationObserver(records => {
    if (
      disposed || scheduled
      || records.every(record =>
        record.target instanceof Element && record.target.closest('[data-cordisx-permission-display]')
      )
    ) return
    scheduled = true
    queueMicrotask(reconcile)
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'aria-busy',
      'disabled',
      'aria-disabled',
      'aria-expanded',
      'aria-describedby',
      'data-above-composer-conversation-id',
      'lang',
    ],
  })
  document.addEventListener('click', observeClick, true)
  reconcile()
  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('click', observeClick, true)
    for (const entry of entries.values()) {
      finishMenu(entry, 'disposed')
      clear(entry)
    }
    entries.clear()
  }
}
