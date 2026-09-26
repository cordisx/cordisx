import React, { act, useState } from 'react'
import Schema from '@deepseek-ai/schemastery'
import { beforeEach, expect, it } from 'vitest'
import { dom, edit, input, root } from './helpers/host-react-form.js'
let SchemaForm: typeof import('../packages/cli/src/renderer/host-ui/SchemaForm.js').SchemaForm
let schemaFormSnapshot: typeof import('../packages/cli/src/renderer/host-ui/SchemaForm.js').schemaFormSnapshot

// TDesign detects browser event support at import time; initialize the DOM first.
beforeEach(async () => {
  ;({ SchemaForm, schemaFormSnapshot } = await import('../packages/cli/src/renderer/host-ui/SchemaForm.js'))
})

it('uses configuration field rows and validates bounds without losing invalid drafts', async () => {
  const schema = Schema.object({ size: Schema.number().min(9).max(19).required() })
  const invalid = schemaFormSnapshot(schema, { size: 30 }, 'en-US')
  expect(invalid.valid).toBe(false)
  expect(invalid.value.size).toBe(30)
  expect(schemaFormSnapshot(schema, { size: 15 }, 'en-US').valid).toBe(true)
  await act(async () =>
    root.render(<SchemaForm identity="board" schema={schema} value={{ size: 15 }} onChange={() => {}} />)
  )
  expect(dom.window.document.querySelector('.cxf-item')).not.toBeNull()
  expect(dom.window.document.querySelector('input')).not.toBeNull()
})

it('revalidates against replaced choices and rejects asynchronous sources', () => {
  const schema = Schema.object({ mode: Schema.union(['score', 'token']).required() })
  expect(schemaFormSnapshot(schema, { mode: 'gone' }, 'en-US').valid).toBe(false)
  expect(
    schemaFormSnapshot(
      { type: 'object', '~standard': { version: 1, vendor: 'schemastery', validate: async () => ({ value: {} }) } },
      {},
      'en-US',
    ).valid,
  ).toBe(false)
})

it('reports external validation once per value change even with inline callbacks', async () => {
  const schema = Schema.object({ name: Schema.string().required() })
  const value = { name: 'room' }
  let reports = 0
  const render = () =>
    root.render(
      <SchemaForm
        identity="room"
        schema={schema}
        value={value}
        onChange={() => {}}
        onValidationChange={() => {
          reports++
        }}
      />,
    )
  await act(async () => render())
  await act(async () => render())
  expect(reports).toBe(1)
  await act(async () =>
    root.render(
      <SchemaForm
        identity="room"
        schema={schema}
        value={{ name: 'new' }}
        onChange={() => {}}
        onValidationChange={() => {
          reports++
        }}
      />,
    )
  )
  expect(reports).toBe(2)
})

it('emits a controlled draft through the shared boolean presenter', async () => {
  const schema = Schema.object({ enabled: Schema.boolean().default(false) })
  let received: unknown
  await act(async () =>
    root.render(
      <SchemaForm
        identity="switch"
        schema={schema}
        value={{ enabled: false }}
        onChange={snapshot => {
          received = snapshot
        }}
      />,
    )
  )
  const control = dom.window.document.querySelector<HTMLElement>('input[type="checkbox"]')!
  expect(control).not.toBeNull()
  await act(async () => control.click())
  expect(received).toMatchObject({ value: { enabled: true }, valid: true, issues: [] })
})

it('preserves allowed field icons into canonical object-array subpages without accepting unknown tokens', async () => {
  const schema = Schema.object({
    models: Schema.array(Schema.object({
      id: Schema.string().required().extra('extra', { label: 'Exact ID', cordisxForm: { icon: 'host:key' } }),
      label: Schema.string().extra('extra', { label: 'Name', cordisxForm: { icon: 'host:tags' } }),
      unsupported: Schema.string().extra('extra', { label: 'Unsupported', cordisxForm: { icon: 'host:open' } }),
    })).default([]).extra('extra', { cordisxForm: { presenter: { version: 1, kind: 'array.object-page' } } }),
  })
  await act(async () =>
    root.render(<SchemaForm identity="nested-icons" schema={schema} value={{ models: [] }} onChange={() => {}} />)
  )
  await act(async () =>
    dom.window.document.querySelector<HTMLButtonElement>('.cxf-array-editor-toolbar button')!.click()
  )
  const page = dom.window.document.querySelector('.cxf-form-subpage')!
  expect(page).not.toBeNull()
  expect(page.querySelector('[data-config-path$=".id"] .cxf-field-icon [data-host-icon="host:key"] svg')).not.toBeNull()
  expect(page.querySelector('[data-config-path$=".label"] .cxf-field-icon [data-host-icon="host:tags"] svg')).not
    .toBeNull()
  expect(page.querySelector('[data-config-path$=".unsupported"] .cxf-field-icon')).toBeNull()
})

it('keeps validation live while showing field errors only after leaving the field', async () => {
  const schema = Schema.object({ name: Schema.string().required() })
  const reports: boolean[] = []
  function Draft() {
    const [value, setValue] = useState<Record<string, unknown>>({ name: '' })
    return (
      <SchemaForm
        identity="required-draft"
        schema={schema}
        value={value}
        onChange={snapshot => setValue(snapshot.value)}
        onValidationChange={snapshot => reports.push(snapshot.valid)}
      />
    )
  }
  const error = () => dom.window.document.querySelector('[data-config-path="name"] .cxf-error')!
  await act(async () => root.render(<Draft />))
  expect(reports).toEqual([false])
  expect(input('name').getAttribute('aria-invalid')).toBe('false')
  expect(error().textContent).toBe('')

  await edit('name', 'Room')
  expect(reports.at(-1)).toBe(true)
  await edit('name', '')
  expect(reports.at(-1)).toBe(false)
  expect(input('name').getAttribute('aria-invalid')).toBe('false')
  expect(error().textContent).toBe('')

  await act(async () => input('name').blur())
  expect(input('name').getAttribute('aria-invalid')).toBe('true')
  expect(error().textContent).toBe('Required')
  expect(reports).toEqual([false, true, false])

  await edit('name', 'Room')
  expect(reports.at(-1)).toBe(true)
  expect(input('name').getAttribute('aria-invalid')).toBe('false')
  expect(error().textContent).toBe('')
  await edit('name', '')
  expect(reports.at(-1)).toBe(false)
  expect(dom.window.document.activeElement).toBe(input('name'))
  expect(input('name').getAttribute('aria-invalid')).toBe('true')
  expect(error().textContent).toBe('Required')
})

it('resets field error visibility when the form identity changes', async () => {
  const schema = Schema.object({ name: Schema.string().required() })
  const value = { name: '' }
  const render = (identity: string) =>
    root.render(<SchemaForm identity={identity} schema={schema} value={value} onChange={() => {}} />)
  await act(async () => render('first-draft'))
  await act(async () => {
    input('name').focus()
    input('name').blur()
  })
  expect(input('name').getAttribute('aria-invalid')).toBe('true')

  await act(async () => render('second-draft'))
  expect(input('name').getAttribute('aria-invalid')).toBe('false')
  expect(dom.window.document.querySelector('[data-config-path="name"] .cxf-error')?.textContent).toBe('')
  await act(async () => {
    input('name').focus()
    input('name').blur()
  })
  expect(input('name').getAttribute('aria-invalid')).toBe('true')
})

it('waits for focus to leave the entire field before exposing a multi-control error', async () => {
  const schema = Schema.object({
    mode: Schema.union(['score', 'token']).required().extra('extra', {
      cordisxForm: { presenter: { version: 1, kind: 'choice.segmented' } },
    }),
    name: Schema.string(),
  })
  await act(async () =>
    root.render(<SchemaForm identity="segmented-draft" schema={schema} value={{}} onChange={() => {}} />)
  )
  const controls = dom.window.document.querySelectorAll<HTMLInputElement>('[data-config-path="mode"] input')
  expect(controls).toHaveLength(2)
  const error = () => dom.window.document.querySelector('[data-config-path="mode"] .cxf-error')!
  await act(async () => controls[0]!.focus())
  await act(async () => controls[1]!.focus())
  expect(dom.window.document.activeElement).toBe(controls[1])
  expect([...controls].map(control => control.getAttribute('aria-invalid'))).toEqual(['false', 'false'])
  expect(error().textContent).toBe('')

  await act(async () => input('name').focus())
  expect([...controls].map(control => control.getAttribute('aria-invalid'))).toEqual(['true', 'true'])
  expect(error().textContent).toBe('Required')
  expect(input('name').getAttribute('aria-invalid')).toBe('false')
})

it('keeps a new object-array item invalid without exposing untouched child errors or committing its draft', async () => {
  const schema = Schema.object({
    name: Schema.string(),
    models: Schema.array(Schema.object({ id: Schema.string().required() })).default([]).extra('extra', {
      cordisxForm: { presenter: { version: 1, kind: 'array.object-page' } },
    }),
  })
  const value = { name: 'parent draft', models: [] }
  const changes: unknown[] = []
  await act(async () =>
    root.render(
      <SchemaForm identity="new-model" schema={schema} value={value} onChange={snapshot => changes.push(snapshot)} />,
    )
  )
  await act(async () =>
    dom.window.document.querySelector<HTMLButtonElement>('[data-config-path="models"] [data-array-action="add"]')!
      .click()
  )
  const page = dom.window.document.querySelector('.cxf-form-page-layer:not([hidden])')!
  const child = page.querySelector<HTMLInputElement>('[data-config-path$=".id"] input')!
  const error = page.querySelector('[data-config-path$=".id"] .cxf-error')!
  const confirm = page.querySelector<HTMLButtonElement>('.cxf-form-action-buttons button:last-child')!
  expect(child).not.toBeNull()
  expect(child.getAttribute('aria-invalid')).toBe('false')
  expect(error.textContent).toBe('')
  expect(confirm.disabled).toBe(true)
  expect(changes).toEqual([])

  await act(async () => {
    child.focus()
    child.blur()
  })
  expect(child.getAttribute('aria-invalid')).toBe('true')
  expect(error.textContent).toBe('Required')
  expect(confirm.disabled).toBe(true)
  await act(async () => confirm.click())
  expect(changes).toEqual([])
  expect(value).toEqual({ name: 'parent draft', models: [] })

  await act(async () => page.querySelector<HTMLButtonElement>('.cxf-form-action-buttons button:first-child')!.click())
  expect(dom.window.document.querySelector('.cxf-form-page-layer')).toBeNull()
  expect(input('name').value).toBe('parent draft')
  expect(changes).toEqual([])
})
