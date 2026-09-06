import type { CordisXConfigFieldSnapshot } from '../contracts.js'
import { createHostSurfaceIcon } from './icons.js'
import { tdesignPortalContainer } from './tdesign-form.js'
import { managerCopy } from './ui-copy.js'

import { type HostFormControl, validateHostFormValue } from './host-form-model.js'
import type { HostFormAdapter } from './host-form.js'
export function createHostObjectArrayControl(
  document: Document,
  portalHost: HTMLElement,
  locale: () => string,
  adapter: Pick<HostFormAdapter, 'button' | 'control'>,
  field: CordisXConfigFieldSnapshot,
  id: string,
  onDraft: (value: unknown, issue?: string) => void,
): HostFormControl {
  const root = document.createElement('div')
  root.className = 'cxf-array-editor'
  root.dataset.hostFormPrimitive = 'object-array'
  root.dataset.presenter = field.presenter?.kind ?? 'array.object-auto'
  const values = Array.isArray(field.value)
    ? field.value.filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
    )
    : []
  const ids = values.map(() => `cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`)
  const limit = field.max ?? 64
  const schema = field.arrayItemSchema
  const canReorder = field.presenter?.options?.allowReorder !== false
  let connectedOnce = root.isConnected
  let dismissActiveDialog: (() => void) | undefined
  const observer = document.defaultView === null
    ? undefined
    : new document.defaultView.MutationObserver(() => {
      if (root.isConnected) {
        connectedOnce = true
        return
      }
      if (connectedOnce) {
        dismissActiveDialog?.()
        observer?.disconnect()
      }
    })
  observer?.observe(document.documentElement, { childList: true, subtree: true })
  const emit = (next: readonly Record<string, unknown>[]): void =>
    onDraft(next, validateHostFormValue(field, next, locale()))
  const summary = (value: Record<string, unknown>): string =>
    schema?.fields?.map(({ key, schema }) => `${schema.label ?? key}: ${String(value[key] ?? '')}`).join(' · ')
    || managerCopy(locale(), 'form.array-item')
  const render = (): void => {
    root.replaceChildren()
    const toolbar = document.createElement('div')
    toolbar.className = 'cxf-array-editor-toolbar'
    const add = adapter.button(managerCopy(locale(), 'form.add-item'), { icon: 'host:save' })
    add.disabled = field.disabled || values.length >= limit
    add.addEventListener('click', () => {
      const item = Object.fromEntries(
        (schema?.fields ?? []).map(({ key, schema }) => [
          key,
          schema.type === 'boolean'
            ? false
            : schema.type === 'number' || schema.type === 'natural'
            ? schema.min ?? 0
            : '',
        ]),
      )
      values.push(item)
      ids.push(`cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`)
      emit(values)
      render()
      open(values.length - 1)
    })
    toolbar.append(add)
    root.append(toolbar)
    values.forEach((value, index) => {
      const row = document.createElement('div')
      row.className = 'cxf-array-row'
      row.dataset.hostArrayItemId = ids[index]!
      const handle = document.createElement('span')
      handle.className = 'cxf-array-row-drag-handle'
      handle.dataset.hostArrayDragHandle = 'true'
      handle.setAttribute('role', 'img')
      handle.setAttribute('aria-label', managerCopy(locale(), 'form.reorder-handle'))
      handle.setAttribute('title', managerCopy(locale(), 'form.reorder-handle'))
      const handleIcon = createHostSurfaceIcon(document, 'host:more')
      handleIcon.classList.add('cxf-form-icon')
      handleIcon.setAttribute('aria-hidden', 'true')
      handle.append(handleIcon)
      const text = document.createElement('span')
      text.className = 'cxf-array-row-summary'
      text.textContent = summary(value)
      const actions = document.createElement('div')
      actions.className = 'cxf-array-row-actions'
      const edit = adapter.button(managerCopy(locale(), 'form.edit-item'), {
        density: 'icon',
        icon: 'host:settings',
      })
      edit.disabled = field.disabled
      edit.addEventListener('click', () => open(index))
      const duplicate = adapter.button(managerCopy(locale(), 'form.duplicate-item'), {
        density: 'icon',
        icon: 'host:files',
      })
      duplicate.disabled = field.disabled || values.length >= limit
      duplicate.addEventListener('click', () => {
        values.splice(index + 1, 0, structuredClone(value))
        ids.splice(index + 1, 0, `cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`)
        emit(values)
        render()
      })
      const moveUp = adapter.button(managerCopy(locale(), 'form.move-item-up'), {
        density: 'icon',
        icon: 'host:back',
      })
      moveUp.classList.add('cxf-array-row-action-up')
      moveUp.disabled = field.disabled || !canReorder || index === 0
      moveUp.addEventListener('click', () => {
        ;[values[index - 1], values[index]] = [values[index]!, values[index - 1]!]
        ;[ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]
        emit(values)
        render()
      })
      const moveDown = adapter.button(managerCopy(locale(), 'form.move-item-down'), {
        density: 'icon',
        icon: 'host:back',
      })
      moveDown.classList.add('cxf-array-row-action-down')
      moveDown.disabled = field.disabled || !canReorder || index === values.length - 1
      moveDown.addEventListener('click', () => {
        ;[values[index + 1], values[index]] = [values[index]!, values[index + 1]!]
        ;[ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!]
        emit(values)
        render()
      })
      const remove = adapter.button(managerCopy(locale(), 'form.delete-item'), {
        density: 'icon',
        tone: 'danger',
        icon: 'host:reset',
      })
      remove.disabled = field.disabled || values.length <= (field.min ?? 0)
      remove.addEventListener('click', () => {
        values.splice(index, 1)
        ids.splice(index, 1)
        emit(values)
        render()
      })
      actions.append(edit, duplicate, moveUp, moveDown, remove)
      row.append(handle, text, actions)
      root.append(row)
    })
  }
  const open = (index: number): void => {
    dismissActiveDialog?.()
    const host = tdesignPortalContainer(portalHost)
    const rowId = ids[index]!
    const restore = root.querySelector<HTMLElement>(`[data-host-array-item-id="${rowId}"] button`)
    const dialog = document.createElement('section')
    dialog.className = 'cxf-array-editor-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.tabIndex = -1
    const head = document.createElement('div')
    head.className = 'cxf-array-editor-dialog-head'
    const title = document.createElement('strong')
    title.id = `${id}-${rowId}-title`
    title.textContent = field.label ?? managerCopy(locale(), 'form.edit-item')
    dialog.setAttribute('aria-labelledby', title.id)
    const close = adapter.button(managerCopy(locale(), 'form.close'), { density: 'icon', icon: 'host:reset' })
    close.setAttribute('aria-label', managerCopy(locale(), 'form.close'))
    let dismissed = false
    const dismiss = () => {
      if (dismissed) return
      dismissed = true
      document.removeEventListener('pointerdown', onPointerDown, true)
      dialog.removeEventListener('keydown', onKey)
      dialog.remove()
      if (dismissActiveDialog === dismiss) dismissActiveDialog = undefined
      restore?.focus()
    }
    close.addEventListener('click', dismiss)
    head.append(title, close)
    dialog.append(head)
    const fields = document.createElement('div')
    fields.className = 'cxf-array-editor-dialog-fields'
    dialog.append(fields)
    for (const child of schema?.fields ?? []) {
      const slot = document.createElement('div')
      slot.className = 'cxf-array-editor-dialog-field'
      const label = document.createElement('label')
      label.textContent = child.schema.label ?? child.key
      const childField: CordisXConfigFieldSnapshot = {
        namespace: field.namespace,
        path: [...field.path, rowId, child.key],
        type: child.schema.type,
        ...(child.schema.role === undefined ? {} : { role: child.schema.role }),
        ...(child.schema.choices === undefined ? {} : { choices: child.schema.choices }),
        ...(child.schema.presenter === undefined ? {} : { presenter: child.schema.presenter }),
        ...(child.schema.item === undefined ? {} : { arrayItemSchema: child.schema.item }),
        value: values[index]![child.key],
        disabled: field.disabled || child.schema.disabled,
        required: child.schema.required,
        ...(child.schema.min === undefined ? {} : { min: child.schema.min }),
        ...(child.schema.max === undefined ? {} : { max: child.schema.max }),
        ...(child.schema.step === undefined ? {} : { step: child.schema.step }),
        ...(child.schema.arrayItemType === undefined ? {} : { arrayItemType: child.schema.arrayItemType }),
      }
      const control = adapter.control(childField, `${id}-${rowId}-${child.key}`, next => {
        values[index] = { ...values[index], [child.key]: next }
        emit(values)
        render()
      })
      label.htmlFor = `${id}-${rowId}-${child.key}`
      slot.append(label, control.root)
      fields.append(slot)
    }
    const focusable = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')].filter(element =>
        !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
      )
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const active = document.activeElement
      const current = items.indexOf(active as HTMLElement)
      if (event.shiftKey && (current <= 0 || active === dialog)) {
        event.preventDefault()
        items.at(-1)?.focus()
      } else if (!event.shiftKey && current === items.length - 1) {
        event.preventDefault()
        items[0]?.focus()
      }
    }
    const onPointerDown = (event: Event) => {
      if (!event.composedPath().includes(dialog)) dismiss()
    }
    dialog.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    host.append(dialog)
    dismissActiveDialog = dismiss
    close.focus()
  }
  render()
  return {
    root,
    focusTarget: root,
    primitive: 'object-array',
    dispose: () => {
      dismissActiveDialog?.()
      observer?.disconnect()
    },
  }
}
