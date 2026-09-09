import { type ReactNode, useEffect, useState } from 'react'
import { Dialog } from './react.js'
import { dialogCenterForDocument } from './host.js'
import type { DialogBinding } from './model.js'
import { notificationCenterForDocument } from '../notifications/host.js'

/** Compatibility adapter for Host's existing structured editor dialogs. */
export function HostEditorDialog({ visible, header, children, confirmBtn, cancelBtn, onClose, onConfirm }: {
  readonly visible: boolean
  readonly header: string
  readonly children: ReactNode
  readonly dialogClassName?: string
  readonly confirmBtn: string | {
    readonly tag?: string
    readonly content: string
    readonly theme?: string
    readonly disabled?: boolean
  }
  readonly cancelBtn: string
  readonly onClose: () => void
  readonly onConfirm: () => void | Promise<void>
}) {
  const [binding, setBinding] = useState<{ dialogs: DialogBinding } | undefined>(undefined)
  useEffect(() => {
    const center = dialogCenterForDocument(document)
    if (!center) return undefined
    const notifications = notificationCenterForDocument(document)?.bind({
      key: 'host/dialogs',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    })
    const dialogs = center.bind({
      key: 'host/editors',
      name: () => 'CordisX',
      active: () => true,
      report: () => {
        notifications?.api.show({
          kind: 'dialog.operation-failed',
          type: 'error',
          message: 'Operation failed / 操作未完成',
        })
      },
    })
    setBinding({ dialogs })
    return () => {
      dialogs.dispose()
      notifications?.dispose()
    }
  }, [])
  if (!binding) return null
  return (
    <Dialog
      service={binding.dialogs.api}
      open={visible}
      onOpenChange={() => onClose()}
      title={header}
      footer={{
        secondaryActions: [{ id: 'cancel', label: cancelBtn, onAction: onClose }],
        primaryAction: {
          id: 'confirm',
          label: typeof confirmBtn === 'string' ? confirmBtn : confirmBtn.content,
          disabled: typeof confirmBtn === 'string' ? false : confirmBtn.disabled ?? false,
          onAction: onConfirm,
        },
      }}
    >
      {children}
    </Dialog>
  )
}
