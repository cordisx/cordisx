import { type RefObject, useCallback, useEffect, useRef } from 'react'
import type { NotificationHandleV1, NotificationsV1 } from '../notification-contracts.js'
import type { NativeSubmissionRejection } from './native-provider-selection-client.js'
import { modelProviderCopy, nativeSubmissionFeedback } from './model-provider-copy.js'
import { notificationCenterForDocument } from './notifications/host.js'
import { managerCopy } from './ui-copy.js'

type Notice =
  | 'selection.pending'
  | 'selection.synchronizing'
  | 'selection.queued'
  | 'selection.busy'
  | 'selection.failed'
  | 'reasoning.updated'
  | 'intent.pending'
  | 'submission.rejected'
  | 'catalog.failed'
  | 'routing.unavailable'
type Channel = 'selection' | 'submission' | 'catalog' | 'availability'

/**
 * Model menus contain choices and controls, never operation messages.
 * This boundary returns no renderable content and has no inline fallback.
 * Readiness belongs to the provider object; opening a menu must not toast it.
 */
export function useModelProviderNotifications(
  anchor: RefObject<HTMLElement | null>,
  locale: string,
  threadId: string | undefined,
) {
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  const notices = useRef(new Map<Channel, { key: string; handle: NotificationHandleV1 }>())
  useEffect(() => {
    const document = anchor.current?.ownerDocument
    let active = true
    const binding = document && notificationCenterForDocument(document)?.bind({
      key: 'host/model-provider-selector',
      pluginId: 'cordisx',
      active: () => active,
      presentation: () => ({ name: 'CordisX' }),
    })
    notifications.current = binding?.api
    return () => {
      active = false
      notifications.current = undefined
      notices.current.clear()
      binding?.dispose()
    }
  }, [anchor, threadId])

  const clear = useCallback((channel: Channel) => {
    notices.current.get(channel)?.handle.dismiss()
    notices.current.delete(channel)
  }, [])
  const show = useCallback((notice: Notice, rejection?: NativeSubmissionRejection) => {
    const api = notifications.current
    if (!api) return
    const channel: Channel = notice === 'catalog.failed'
      ? 'catalog'
      : notice === 'routing.unavailable'
      ? 'availability'
      : notice === 'submission.rejected'
      ? 'submission'
      : 'selection'
    const key = `${notice}:${rejection ?? ''}`
    // Reconciliations and repeated catalog polls do not repeat the same notice.
    if (notices.current.get(channel)?.key === key) return
    clear(channel)
    const copy = modelProviderCopy(locale)
    const messages: Record<Notice, string> = {
      'selection.pending': copy.switching,
      'selection.synchronizing': copy.accepted,
      'selection.queued': copy.nextSend,
      'selection.busy': copy.busy,
      'selection.failed': copy.failed,
      'reasoning.updated': copy.updated,
      'intent.pending': managerCopy(locale, 'catalog.startup.intent'),
      'submission.rejected': nativeSubmissionFeedback(copy, rejection),
      'catalog.failed': copy.loadFailed,
      'routing.unavailable': copy.unavailable,
    }
    const handle = api.show({
      kind: `model.provider.${notice}`,
      type: notice.endsWith('.failed') || notice === 'submission.rejected'
        ? 'error'
        : notice === 'selection.busy' || notice === 'routing.unavailable'
        ? 'warning'
        : notice === 'reasoning.updated'
        ? 'success'
        : 'info',
      message: messages[notice],
    })
    notices.current.set(channel, { key, handle })
  }, [clear, locale])
  return { show, clear }
}
