import React, { act } from 'react'
import Schema from '@deepseek-ai/schemastery'
import { beforeEach, expect, it } from 'vitest'
import { dom, root } from './helpers/host-react-form.js'
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
