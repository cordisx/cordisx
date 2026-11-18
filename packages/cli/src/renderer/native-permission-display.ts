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
        if (entry) clear(entry)
        entry = { key, label: read(key) }
        entries.set(seat.trigger, entry)
      }
      if (!seat.loading) {
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
    attributeFilter: ['aria-busy', 'aria-describedby', 'data-above-composer-conversation-id', 'lang'],
  })
  reconcile()
  return () => {
    disposed = true
    observer.disconnect()
    for (const entry of entries.values()) clear(entry)
    entries.clear()
  }
}
