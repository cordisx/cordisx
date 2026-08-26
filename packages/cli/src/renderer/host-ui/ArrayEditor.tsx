import { useMemo, useState } from 'react'
import { Button, Dialog, Input, InputNumber, Switch } from 'tdesign-react'
import { CopyIcon, DeleteIcon, EditIcon, MoveIcon, AddIcon } from 'tdesign-icons-react'
import type { CordisXConfigFieldSnapshot, CordisXConfigFormSchemaNode, CordisXJsonValue } from '../../contracts.js'

export interface ArrayEditorProps {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: readonly Record<string, unknown>[]
  readonly onChange: (value: CordisXJsonValue) => void
}

function stableId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `array-${Math.random().toString(36).slice(2)}`
}

function summary(value: Record<string, unknown>, schema: CordisXConfigFormSchemaNode | undefined): string {
  return schema?.fields?.map(field => `${field.schema.label ?? field.key}: ${String(value[field.key] ?? '')}`).join(' · ') || '数组项'
}

function numericProps(schema: Pick<CordisXConfigFormSchemaNode, 'min' | 'max' | 'step'>) {
  return {
    ...(schema.min === undefined ? {} : { min: schema.min }),
    ...(schema.max === undefined ? {} : { max: schema.max }),
    ...(schema.step === undefined ? {} : { step: schema.step }),
  }
}

function EditorField({ schema, value, onChange }: { readonly schema: CordisXConfigFormSchemaNode; readonly value: unknown; readonly onChange: (value: unknown) => void }) {
  if (schema.type === 'boolean') return <Switch value={value === true} onChange={onChange} />
  if (['number', 'natural'].includes(schema.type)) return <InputNumber {...(typeof value === 'number' ? { value } : {})} {...numericProps(schema)} onChange={onChange} />
  return <Input value={typeof value === 'string' ? value : ''} onChange={onChange} />
}

export function ArrayEditor({ field, value, onChange }: ArrayEditorProps) {
  const [ids, setIds] = useState(() => value.map(stableId))
  const [editing, setEditing] = useState<number>()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const limit = field.max ?? 64
  const canReorder = field.presenter?.options?.allowReorder !== false
  const rows = useMemo(() => value.map((item, index) => ({ id: ids[index] ?? stableId(), item })), [ids, value])
  const commit = (next: readonly Record<string, unknown>[], nextIds = ids) => {
    setIds([...nextIds])
    onChange(next as CordisXJsonValue)
  }
  const open = (index: number) => { setEditing(index); setDraft(structuredClone(value[index] ?? {})) }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = [...value]
    const nextIds = [...ids]
    const [item] = next.splice(from, 1)
    const [id] = nextIds.splice(from, 1)
    if (item === undefined || id === undefined) return
    next.splice(to, 0, item)
    nextIds.splice(to, 0, id)
    commit(next, nextIds)
  }
  return (
    <div className="cxf-array-editor" data-host-form-primitive="object-array">
      <div className="cxf-array-editor-toolbar"><Button size="small" shape="square" variant="text" aria-label="添加" title="添加" data-array-action="add" icon={<AddIcon />} disabled={field.disabled || value.length >= limit} onClick={() => {
        const next = [...value, structuredClone((field.arrayItemDefault ?? {}) as Record<string, unknown>)]
        const nextIds = [...ids, stableId()]
        commit(next, nextIds)
        open(next.length - 1)
      }} /></div>
      {rows.map(({ id, item }, index) => (
        <div key={id} className="cxf-array-row" data-host-array-item-id={id}
          draggable={canReorder && !field.disabled}
          onDragStart={event => event.dataTransfer.setData('text/x-cordisx-array-index', String(index))}
          onDragOver={event => { if (canReorder) event.preventDefault() }}
          onDrop={event => { event.preventDefault(); move(Number(event.dataTransfer.getData('text/x-cordisx-array-index')), index) }}>
          <button type="button" className="cxf-array-row-drag-handle" aria-label="拖拽或使用方向键排序" disabled={!canReorder || field.disabled}
            onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)) } }}><MoveIcon /></button>
          <span className="cxf-array-row-summary">{summary(item, field.arrayItemSchema)}</span>
          <span className="cxf-array-row-actions">
            <Button shape="square" variant="text" aria-label="编辑" title="编辑" icon={<EditIcon />} disabled={field.disabled} onClick={() => open(index)} />
            <Button shape="square" variant="text" aria-label="复制" title="复制" icon={<CopyIcon />} disabled={field.disabled || value.length >= limit} onClick={() => { const next = [...value]; next.splice(index + 1, 0, structuredClone(item)); const nextIds = [...ids]; nextIds.splice(index + 1, 0, stableId()); commit(next, nextIds) }} />
            <Button className="cxf-array-delete" shape="square" variant="text" theme="danger" aria-label="删除" title="删除" icon={<DeleteIcon />} disabled={field.disabled || value.length <= (field.min ?? 0)} onClick={() => commit(value.filter((_, itemIndex) => itemIndex !== index), ids.filter((_, itemIndex) => itemIndex !== index))} />
          </span>
        </div>
      ))}
      <Dialog visible={editing !== undefined} header="编辑数组项" onClose={() => setEditing(undefined)}
        confirmBtn="保存" cancelBtn="取消" onConfirm={() => { if (editing === undefined) return; const next = [...value]; next[editing] = draft; commit(next); setEditing(undefined) }}>
        <div className="cxf-array-dialog-fields">
          {field.arrayItemSchema?.fields?.map(child => <label key={child.key}><span>{child.schema.label ?? child.key}</span><EditorField schema={child.schema} value={draft[child.key]} onChange={next => setDraft(current => ({ ...current, [child.key]: next }))} /></label>)}
        </div>
      </Dialog>
    </div>
  )
}
