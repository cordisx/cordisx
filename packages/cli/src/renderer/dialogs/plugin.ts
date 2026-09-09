import type { Context } from '@deepseek-ai/cordis'
import type { NotificationsV1 } from '../../contracts.js'
import { dialogCenterForDocument } from './host.js'
import type { DialogOwner } from './model.js'

/** Install the owner-bound service and keep its feedback on the notification path. */
export function installPluginDialogs(
  context: Context,
  document: Document,
  owner: Omit<DialogOwner, 'report'>,
  notifications?: NotificationsV1,
): () => void {
  const binding = dialogCenterForDocument(document)?.bind({
    ...owner,
    report: () => {
      notifications?.show({
        kind: 'dialog.operation-failed',
        type: 'error',
        message: document.documentElement.lang.startsWith('zh')
          ? '操作未完成，请重试。'
          : 'Operation failed. Please retry.',
      })
    },
  })
  if (!binding) return () => {}
  const release = context.reflect.provide('dialogs', binding.api)
  return () => {
    release()
    binding.dispose()
  }
}
