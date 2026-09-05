import { Fragment, type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog } from 'tdesign-react'
import type { CordisXConfigFieldSnapshot, CordisXConfigFormSchemaNode, CordisXJsonValue } from '../../contracts.js'
import { formSchemaDefaultValue } from '../form-schema-defaults.js'
import { managerCopy } from '../ui-copy.js'
import { HostFormSubpage, useHostFormPageNavigation } from './HostFormPages.js'
import { HostIcon } from './HostIcon.js'

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

export interface ArrayEditorFieldRowRenderProps {
  readonly field: CordisXConfigFieldSnapshot
  readonly controlId: string
  readonly issueText?: string
  readonly onChange: (value: unknown) => void
}

export interface ArrayEditorProps {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: readonly Record<string, unknown>[]
  readonly onChange: (value: CordisXJsonValue) => void
  readonly locale: string
  readonly validateField: (field: CordisXConfigFieldSnapshot) => string | undefined
  readonly renderFieldRow: (props: ArrayEditorFieldRowRenderProps) => ReactElement
}

type ArrayEditorTarget =
  | { readonly kind: 'create'; readonly rowId: string }
  | { readonly kind: 'edit'; readonly index: number; readonly rowId: string }

function stableId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `array-${Math.random().toString(36).slice(2)}`
}

function sameItem(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
}

function reconcileIds(
  previousValue: readonly Record<string, unknown>[],
  previousIds: readonly string[],
  nextValue: readonly Record<string, unknown>[],
): readonly string[] {
  const available = new Set(previousValue.map((_, index) => index))
  return nextValue.map(item => {
    const match = [...available].find(index => sameItem(previousValue[index]!, item))
    if (match === undefined) return stableId()
    available.delete(match)
    return previousIds[match] ?? stableId()
  })
}

function targetTitle(locale: string, target: ArrayEditorTarget | undefined): string {
  if (target?.kind !== 'edit') return managerCopy(locale, 'form.create-array-item')
  return managerCopy(locale, 'form.edit-array-item-position').replace('{position}', String(target.index + 1))
}

function schemaContainsSensitiveField(schema: CordisXConfigFormSchemaNode): boolean {
  return schema.role !== undefined && SENSITIVE_ROLES.has(schema.role)
    || schema.fields?.some(field => schemaContainsSensitiveField(field.schema)) === true
    || schema.item !== undefined && schemaContainsSensitiveField(schema.item)
}

function summary(
  value: Record<string, unknown>,
  schema: CordisXConfigFormSchemaNode | undefined,
  locale: string,
): string {
  return schema?.fields
    ?.filter(field => !schemaContainsSensitiveField(field.schema))
    .map(field => `${field.schema.label ?? field.key}: ${String(value[field.key] ?? '')}`).join(' · ')
    || managerCopy(locale, 'form.array-item')
}

function childField(
  parent: CordisXConfigFieldSnapshot,
  rowId: string,
  child: NonNullable<CordisXConfigFormSchemaNode['fields']>[number],
  value: unknown,
): CordisXConfigFieldSnapshot {
  const schema = child.schema
  const nestedItemDefault = schema.type === 'array' && schema.item?.type === 'object'
    ? formSchemaDefaultValue(schema.item)
    : undefined
  return {
    namespace: parent.namespace,
    path: [...parent.path, rowId, child.key],
    type: schema.type,
    ...(schema.role === undefined ? {} : { role: schema.role }),
    ...(schema.label === undefined ? {} : { label: schema.label }),
    ...(schema.description === undefined ? {} : { description: schema.description }),
    value,
    disabled: parent.disabled || schema.disabled,
    required: schema.required,
    ...(schema.min === undefined ? {} : { min: schema.min }),
    ...(schema.max === undefined ? {} : { max: schema.max }),
    ...(schema.step === undefined ? {} : { step: schema.step }),
    ...(schema.choices === undefined ? {} : { choices: schema.choices }),
    ...(schema.arrayItemType === undefined ? {} : { arrayItemType: schema.arrayItemType }),
    ...(schema.presenter === undefined ? {} : { presenter: schema.presenter }),
    ...(schema.type === 'array' && schema.item?.type === 'object'
      ? {
        arrayItemSchema: schema.item,
        ...(nestedItemDefault === undefined ? {} : { arrayItemDefault: nestedItemDefault }),
      }
      : {}),
  }
}

interface ArrayItemProjectedField {
  readonly key: string
  readonly field: CordisXConfigFieldSnapshot
  readonly controlId: string
}

function projectItemFields(
  field: CordisXConfigFieldSnapshot,
  rowId: string,
  draft: Readonly<Record<string, unknown>>,
): readonly ArrayItemProjectedField[] {
  return field.arrayItemSchema?.fields?.map(child => ({
    key: child.key,
    field: childField(field, rowId, child, draft[child.key]),
    controlId: `cxf-array-${encodeURIComponent(field.path.join('.'))}-${encodeURIComponent(rowId)}-${
      encodeURIComponent(child.key)
    }`,
  })) ?? []
}

function ArrayItemFields({ fields, setDraft, validateField, renderFieldRow }: {
  readonly fields: readonly ArrayItemProjectedField[]
  readonly setDraft: (update: (current: Record<string, unknown>) => Record<string, unknown>) => void
  readonly validateField: ArrayEditorProps['validateField']
  readonly renderFieldRow: ArrayEditorProps['renderFieldRow']
}) {
  return (
    <div className="cxf-form-grid cxf-array-item-fields">
      {fields.map(item => {
        const issueText = validateField(item.field)
        return (
          <Fragment key={item.controlId}>
            {renderFieldRow({
              field: item.field,
              controlId: item.controlId,
              ...(issueText === undefined ? {} : { issueText }),
              onChange: next => setDraft(current => ({ ...current, [item.key]: next })),
            })}
          </Fragment>
        )
      })}
    </div>
  )
}

function ArrayItemSubpage(
  { pageId, field, rowId, mode, initialValue, locale, validateField, renderFieldRow, onConfirm }: {
    readonly pageId: string
    readonly field: CordisXConfigFieldSnapshot
    readonly rowId: string
    readonly mode: ArrayEditorTarget['kind']
    readonly initialValue: Readonly<Record<string, unknown>>
    readonly locale: string
    readonly validateField: ArrayEditorProps['validateField']
    readonly renderFieldRow: ArrayEditorProps['renderFieldRow']
    readonly onConfirm: (draft: Record<string, unknown>) => void
  },
) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => structuredClone(initialValue))
  const content = useRef<HTMLDivElement>(null)
  const navigation = useHostFormPageNavigation()
  useEffect(() => {
    const fieldControl = content.current?.querySelector<HTMLElement>(
      'input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex="-1"])',
    )
    const back = content.current?.closest('.cxf-form-subpage')?.querySelector<HTMLElement>(
      '.cxf-form-subpage-header button:not(:disabled)',
    )
    ;(fieldControl ?? back)?.focus()
  }, [])
  if (navigation === undefined) throw new Error('ArrayItemSubpage must be rendered inside HostFormPageStack')
  const fields = projectItemFields(field, rowId, draft)
  const invalid = fields.some(item => validateField(item.field) !== undefined)
  return (
    <HostFormSubpage
      pageId={pageId}
      breadcrumbLabel={managerCopy(locale, 'form.breadcrumbs')}
      backLabel={managerCopy(locale, 'form.back')}
      actions={
        <>
          <div className="cxf-status" data-state={invalid ? 'invalid' : 'draft'}>
            {managerCopy(locale, invalid ? 'form.fix-invalid-fields' : 'form.item-draft-hint')}
          </div>
          <div className="cxf-form-action-buttons">
            <Button type="button" variant="outline" onClick={navigation.back}>
              {managerCopy(locale, 'form.cancel')}
            </Button>
            <Button
              tag="button"
              type="button"
              theme="primary"
              disabled={invalid}
              onClick={() => {
                if (invalid) return
                onConfirm(structuredClone(draft))
                navigation.back()
              }}
            >
              {managerCopy(locale, mode === 'create' ? 'form.create-item' : 'form.save-item')}
            </Button>
          </div>
        </>
      }
    >
      <div ref={content}>
        <ArrayItemFields
          fields={fields}
          setDraft={setDraft}
          validateField={validateField}
          renderFieldRow={renderFieldRow}
        />
      </div>
    </HostFormSubpage>
  )
}

export function ArrayEditor({ field, value, onChange, locale, validateField, renderFieldRow }: ArrayEditorProps) {
  const [ids, setIds] = useState(() => value.map(stableId))
  const identity = useRef<{ value: readonly Record<string, unknown>[]; ids: readonly string[] }>({ value, ids })
  const [target, setTarget] = useState<ArrayEditorTarget>()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const navigation = useHostFormPageNavigation()
  const limit = field.max ?? 64
  const canReorder = field.presenter?.options?.allowReorder !== false
  const resolvedIds = useMemo(() => reconcileIds(identity.current.value, identity.current.ids, value), [ids, value])
  useEffect(() => {
    identity.current = { value, ids: resolvedIds }
    setIds(current =>
      current.length === resolvedIds.length && current.every((id, index) => id === resolvedIds[index])
        ? current
        : [...resolvedIds]
    )
  }, [resolvedIds, value])
  const rows = useMemo(() => value.map((item, index) => ({ id: resolvedIds[index]!, item })), [resolvedIds, value])
  const dialogFields = target === undefined ? [] : projectItemFields(field, target.rowId, draft)
  const dialogInvalid = dialogFields.some(item => validateField(item.field) !== undefined)
  const commit = (next: readonly Record<string, unknown>[], nextIds = resolvedIds) => {
    identity.current = { value: next, ids: [...nextIds] }
    setIds([...nextIds])
    onChange(next as CordisXJsonValue)
  }
  const openPage = (
    nextTarget: ArrayEditorTarget,
    initialValue: Readonly<Record<string, unknown>>,
    returnFocus: HTMLElement,
  ) => {
    if (navigation === undefined) return false
    const pageId = `array-item:${field.path.join('.')}:${nextTarget.rowId}:${nextTarget.kind}`
    const title = targetTitle(locale, nextTarget)
    navigation.push({
      id: pageId,
      breadcrumbLabel: field.label ?? field.path.at(-1) ?? managerCopy(locale, 'form.array-item'),
      title,
      returnFocus,
      content: (
        <ArrayItemSubpage
          pageId={pageId}
          field={field}
          rowId={nextTarget.rowId}
          mode={nextTarget.kind}
          initialValue={initialValue}
          locale={locale}
          validateField={validateField}
          renderFieldRow={renderFieldRow}
          onConfirm={next => {
            if (nextTarget.kind === 'create') {
              if (value.length >= limit) return
              commit([...value, next], [...resolvedIds, nextTarget.rowId])
              return
            }
            const nextValue = [...value]
            nextValue[nextTarget.index] = next
            commit(nextValue)
          }}
        />
      ),
    })
    return true
  }
  const openCreate = (returnFocus: HTMLElement) => {
    const nextTarget: ArrayEditorTarget = { kind: 'create', rowId: stableId() }
    const initialValue = structuredClone((field.arrayItemDefault ?? {}) as Record<string, unknown>)
    if (field.presenter?.kind === 'array.object-page' && openPage(nextTarget, initialValue, returnFocus)) return
    setDraft(initialValue)
    setTarget(nextTarget)
  }
  const openEdit = (index: number, returnFocus: HTMLElement) => {
    const nextTarget: ArrayEditorTarget = { kind: 'edit', index, rowId: resolvedIds[index] ?? stableId() }
    const initialValue = structuredClone(value[index] ?? {})
    if (field.presenter?.kind === 'array.object-page' && openPage(nextTarget, initialValue, returnFocus)) return
    setDraft(initialValue)
    setTarget(nextTarget)
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = [...value]
    const nextIds = [...resolvedIds]
    const [item] = next.splice(from, 1)
    const [id] = nextIds.splice(from, 1)
    if (item === undefined || id === undefined) return
    next.splice(to, 0, item)
    nextIds.splice(to, 0, id)
    commit(next, nextIds)
  }
  return (
    <div className="cxf-array-editor" data-host-form-primitive="object-array">
      <div className="cxf-array-editor-toolbar">
        <Button
          tag="button"
          size="small"
          shape="square"
          variant="text"
          aria-label={managerCopy(locale, 'form.add-item')}
          title={managerCopy(locale, 'form.add-item')}
          data-array-action="add"
          icon={<HostIcon token="add" />}
          disabled={field.disabled || value.length >= limit}
          onClick={event => openCreate(event.currentTarget)}
        />
      </div>
      {rows.map(({ id, item }, index) => (
        <div
          key={id}
          className="cxf-array-row"
          data-host-array-item-id={id}
          draggable={canReorder && !field.disabled}
          onDragStart={event => event.dataTransfer.setData('text/x-cordisx-array-index', String(index))}
          onDragOver={event => {
            if (canReorder) event.preventDefault()
          }}
          onDrop={event => {
            event.preventDefault()
            move(Number(event.dataTransfer.getData('text/x-cordisx-array-index')), index)
          }}
        >
          <button
            type="button"
            className="cxf-array-row-drag-handle"
            aria-label={managerCopy(locale, 'form.reorder-handle')}
            disabled={!canReorder || field.disabled}
            onKeyDown={event => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault()
                move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
              }
            }}
          >
            <HostIcon token="move" />
          </button>
          <span className="cxf-array-row-summary">{summary(item, field.arrayItemSchema, locale)}</span>
          <span className="cxf-array-row-actions">
            <Button
              tag="button"
              shape="square"
              variant="text"
              aria-label={managerCopy(locale, 'form.edit-item')}
              title={managerCopy(locale, 'form.edit-item')}
              icon={<HostIcon token="edit" />}
              disabled={field.disabled}
              onClick={event => openEdit(index, event.currentTarget)}
            />
            <Button
              tag="button"
              shape="square"
              variant="text"
              aria-label={managerCopy(locale, 'form.duplicate-item')}
              title={managerCopy(locale, 'form.duplicate-item')}
              icon={<HostIcon token="copy" />}
              disabled={field.disabled || value.length >= limit}
              onClick={() => {
                const next = [...value]
                next.splice(index + 1, 0, structuredClone(item))
                const nextIds = [...resolvedIds]
                nextIds.splice(index + 1, 0, stableId())
                commit(next, nextIds)
              }}
            />
            <Button
              tag="button"
              className="cxf-array-delete"
              shape="square"
              variant="text"
              theme="danger"
              aria-label={managerCopy(locale, 'form.delete-item')}
              title={managerCopy(locale, 'form.delete-item')}
              icon={<HostIcon token="delete" />}
              disabled={field.disabled || value.length <= (field.min ?? 0)}
              onClick={() =>
                commit(
                  value.filter((_, itemIndex) => itemIndex !== index),
                  resolvedIds.filter((_, itemIndex) => itemIndex !== index),
                )}
            />
          </span>
        </div>
      ))}
      <Dialog
        visible={target !== undefined}
        dialogClassName="cxf-array-item-dialog"
        header={targetTitle(locale, target)}
        onClose={() => setTarget(undefined)}
        confirmBtn={{
          tag: 'button',
          content: managerCopy(locale, target?.kind === 'create' ? 'form.create-item' : 'form.save-item'),
          theme: 'primary',
          disabled: dialogInvalid,
        }}
        cancelBtn={managerCopy(locale, 'form.cancel')}
        onConfirm={() => {
          if (target === undefined || dialogInvalid) return
          if (target.kind === 'create') {
            if (value.length >= limit) return
            commit([...value, structuredClone(draft)], [...resolvedIds, target.rowId])
          } else {
            const next = [...value]
            next[target.index] = draft
            commit(next)
          }
          setTarget(undefined)
        }}
      >
        <ArrayItemFields
          fields={dialogFields}
          setDraft={setDraft}
          validateField={validateField}
          renderFieldRow={renderFieldRow}
        />
      </Dialog>
    </div>
  )
}
