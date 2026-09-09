import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'tdesign-react'
import { HostDraftFields } from '../host-ui/HostDraftFields.js'
import { HOST_FORM_REACT_STYLES } from '../host-ui/HostForm.js'
import { HOST_TDESIGN_REACT_STYLES } from '../host-ui/tdesign-styles.js'
import { DialogCenter, type DialogEntry } from './model.js'

function FormBody({ entry, center, container }: { entry: DialogEntry; center: DialogCenter; container: HTMLElement }) {
  const form = entry.form!
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(
      form.fields.map(
        field => [
          field.id,
          field.initialValue ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : ''),
        ],
      ),
    )
  )
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    entry.handle.update({
      ...form,
      footer: {
        secondaryActions: [{
          id: 'cancel',
          label: center.copy.cancel,
          onAction: async () => {
            await entry.handle.close('cancel')
          },
        }],
        primaryAction: {
          id: 'submit',
          label: form.submitLabel,
          onAction: async signal => {
            const next = new Map<string, string>()
            for (const field of form.fields) {
              const value = values[field.id]
              const measure = typeof value === 'string' ? value.trim().length : value
              if (
                typeof value !== field.type || typeof value === 'number' && !Number.isFinite(value)
                || field.required && (value === '' || value === false || typeof value === 'string' && !value.trim())
                || typeof measure === 'number'
                  && (field.min !== undefined && measure < field.min || field.max !== undefined && measure > field.max)
              ) next.set(field.id, center.copy.cancel === '取消' ? '请检查此项' : 'Please check this value')
            }
            setErrors(next)
            if (next.size) return
            await form.submit(values, signal)
            if (!signal.aborted) center.finish(entry, { status: 'completed', actionId: 'submit' })
          },
        },
      },
    })
  }, [values, form, entry, center])
  const locale = center.copy.cancel === '取消' ? 'zh-CN' : 'en-US'
  return (
    <ConfigProvider notSet globalConfig={{ attach: () => container }}>
      <HostDraftFields
        locale={locale}
        errors={errors}
        definitions={form.fields.map(field => ({
          id: field.id,
          initialValue: field.initialValue ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : ''),
          fieldActions: 'static',
          field: {
            namespace: 'dialog',
            path: [field.id],
            type: field.type,
            label: field.label,
            value: values[field.id],
            disabled: false,
            required: field.required ?? false,
            ...(field.min === undefined ? {} : { min: field.min }),
            ...(field.max === undefined ? {} : { max: field.max }),
          },
          onChange: value => setValues(previous => ({ ...previous, [field.id]: value as string | number | boolean })),
        }))}
      />
    </ConfigProvider>
  )
}
export function mountDialogForm(container: HTMLElement, entry: DialogEntry, center: DialogCenter) {
  container.classList.add('cxh-tdesign-root')
  const style = container.ownerDocument.createElement('style')
  style.textContent = HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES
  container.append(style)
  const seat = container.ownerDocument.createElement('div')
  container.append(seat)
  const root = createRoot(seat)
  root.render(<FormBody entry={entry} center={center} container={container} />)
  return () => {
    root.unmount()
    style.remove()
    seat.remove()
  }
}
