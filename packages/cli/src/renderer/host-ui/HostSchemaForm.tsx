import * as React from 'react'
import { Button, Form } from 'tdesign-react'
import { FormDraft } from '@cordisx/schemastery-ui'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import { HOST_FORM_REACT_STYLES, HostFieldRow, hostFormValidationIssueText } from './HostForm.js'

type FormState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'error'

export interface HostSchemaFormProps {
  /** Renderer-safe fields from a Host-owned structured schema mapping. */
  readonly fields: readonly CordisXConfigFieldSnapshot[]
  readonly locale: string
  readonly id: string
  readonly resetKey: string
  readonly submitLabel: string
  readonly savingLabel: string
  readonly onSubmit: (values: Readonly<Record<string, unknown>>) => Promise<void>
  readonly onSubmitted?: () => void
  readonly onError?: (error: unknown) => void
}

function fieldKey(field: CordisXConfigFieldSnapshot): string { return field.path.join('.') }

/**
 * Host-owned adapter for a small structured schema. It deliberately reuses the
 * manager's FormDraft, HostFieldRow, validation, TDesign controls, disabled
 * state, and submit/error contract instead of making a surface-specific form.
 */
export function HostSchemaForm({
  fields, locale, id, resetKey, submitLabel, savingLabel, onSubmit, onSubmitted, onError,
}: HostSchemaFormProps) {
  const [interactive, setInteractive] = React.useState(false)
  const [operations, setOperations] = React.useState<ReadonlyMap<string, unknown>>(() => new Map())
  const [issues, setIssues] = React.useState<ReadonlyMap<string, string>>(() => new Map())
  const [state, setState] = React.useState<FormState>('pristine')
  const [message, setMessage] = React.useState<string>()
  React.useEffect(() => {
    setOperations(new Map())
    setIssues(new Map())
    setState('pristine')
    setMessage(undefined)
  }, [resetKey])
  // TDesign field controls own their post-mount focus/measurement lifecycle.
  // Mount them after the inspector shell commits so the same components work
  // in a split pane, drawer, and an independently mounted settings page.
  React.useEffect(() => { setInteractive(true) }, [])

  const draft = React.useMemo(() => {
    const next = new FormDraft(Object.fromEntries(fields.map(field => [fieldKey(field), field.value])))
    for (const field of fields) {
      const value = operations.get(fieldKey(field))
      if (value !== undefined || operations.has(fieldKey(field))) next.set(field.path, value)
    }
    return next
  }, [fields, operations])
  const valueFor = React.useCallback((field: CordisXConfigFieldSnapshot) => draft.value(field.path, field.defaultValue), [draft])
  const dirty = operations.size > 0
  const saving = state === 'saving'
  const change = React.useCallback((field: CordisXConfigFieldSnapshot, value: unknown) => {
    const key = fieldKey(field)
    setOperations(current => {
      const next = new Map(current)
      if (Object.is(value, field.value)) next.delete(key)
      else next.set(key, value)
      return next
    })
    setIssues(current => {
      if (!current.has(key)) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
    setState('dirty')
    setMessage(undefined)
  }, [])
  const submit = React.useCallback(async () => {
    if (!dirty || saving) return
    const nextIssues = new Map<string, string>()
    const values: Record<string, unknown> = {}
    for (const field of fields) {
      const value = valueFor(field)
      values[fieldKey(field)] = value
      const issue = hostFormValidationIssueText(field, value, locale)
      if (issue !== undefined) nextIssues.set(fieldKey(field), issue)
    }
    if (nextIssues.size > 0) {
      setIssues(nextIssues)
      setState('error')
      setMessage([...nextIssues.values()][0])
      return
    }
    setIssues(new Map())
    setMessage(undefined)
    setState('saving')
    try {
      await onSubmit(Object.freeze(values))
      setState('saved')
      onSubmitted?.()
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setState('error')
      setMessage(text)
      onError?.(error)
    }
  }, [dirty, fields, locale, onError, onSubmit, onSubmitted, saving, valueFor])

  return <div className="cxf-react-form-shell" data-host-schema-form={id} data-state={state}>
    <style data-host-schema-form-styles="true">{HOST_FORM_REACT_STYLES}</style>
    {interactive ? <Form className="cxf-react-form" onSubmit={event => { event.e?.preventDefault(); void submit() }}>
      <div className="cxf-form-body">
        <div className="cxf-form-grid">{fields.map((field, index) => {
          const key = fieldKey(field)
          const value = valueFor(field)
          const issueText = issues.get(key)
          const disabledField = saving && !field.disabled ? { ...field, disabled: true } : field
          return <HostFieldRow
            key={key}
            field={disabledField}
            value={value}
            changed={operations.has(key)}
            locale={locale}
            idPrefix={id}
            controlId={`cx-schema-${id}-${index}`}
            fieldActions="static"
            {...(issueText === undefined ? {} : { issueText })}
            onChange={next => change(field, next)}
          />
        })}</div>
        {message === undefined ? null : <div className="cxr-notice cxf-alert" data-tone="error" role="status">{message}</div>}
      </div>
      <div className="cxf-form-actions">
        <span className="cxf-status" data-state={state} role="status">{saving ? savingLabel : ''}</span>
        <div className="cxf-form-action-buttons"><Button type="button" theme="primary" loading={saving} disabled={!dirty || saving} onClick={() => { void submit() }}>{saving ? savingLabel : submitLabel}</Button></div>
      </div>
    </Form> : null}
  </div>
}
