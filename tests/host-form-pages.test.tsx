import React, { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { dom, edit, HostForm, model, plugin, root, submit } from './helpers/host-react-form.js'
import { formPageFields, formPageSchema, formPageValue } from './fixtures/form-page-schema.js'

const active = () => dom.window.document.querySelector<HTMLElement>('.cxf-form-page-layer:not([hidden])')!
const open = async (parent: Element, path: string) => {
  await act(async () =>
    parent.querySelector<HTMLButtonElement>(`[data-config-path${path}] [data-array-action="add"]`)!.click()
  )
}
const childName = () => active().querySelector<HTMLInputElement>('[data-config-path$=".name"] input')!
const typeChild = async (value: string) => {
  const control = childName()
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const finish = async (confirm: boolean) => {
  await act(async () =>
    active().querySelector<HTMLButtonElement>(`.cxf-form-action-buttons button:${confirm ? 'last' : 'first'}-child`)!
      .click()
  )
}

it('isolates nested drafts and active actions, blocks hidden root saves, and resets the shell identity', async () => {
  const { HostSchemaFormPage, SchemaForm } = await import('../packages/cli/src/renderer/host-ui/SchemaForm.js')
  const save = vi.fn()
  let draft: Record<string, unknown> = formPageValue
  function Surface({ identity }: { identity: string }) {
    const [value, setValue] = useState<Record<string, unknown>>(formPageValue)
    draft = value
    return (
      <HostSchemaFormPage
        form={{ identity, schema: formPageSchema, value, onChange: next => setValue(next.value) }}
        footer={<button onClick={save}>Root save</button>}
      >
        <p role="status">root status</p>
      </HostSchemaFormPage>
    )
  }
  await act(async () => root.render(<Surface identity="one" />))
  await edit('name', 'parent draft')
  const rootLayer = dom.window.document.querySelector<HTMLElement>('.cxf-form-page-root')!
  const rootSave = rootLayer.querySelector<HTMLButtonElement>('footer button')!
  await open(rootLayer, '="items"')
  await typeChild('item draft')
  const first = active()
  await open(first, '$=".children"')
  await typeChild('cancelled child')
  await act(async () => rootSave.click())
  expect(save).not.toHaveBeenCalled()
  expect(rootLayer.hidden).toBe(true)
  expect(first.hidden).toBe(true)
  await act(async () => first.querySelector<HTMLButtonElement>('.cxf-form-action-buttons button:last-child')!.click())
  expect(first.hidden).toBe(true)
  expect(active().querySelector('footer')).not.toBeNull()
  expect(active().textContent).not.toContain('root status')
  expect(draft).toEqual({ name: 'parent draft', items: [] })
  await finish(false)
  expect(childName().value).toBe('item draft')
  await open(active(), '$=".children"')
  await typeChild('confirmed child')
  await open(active(), '$=".children"')
  await typeChild('deepest draft')
  await finish(true)
  expect(childName().value).toBe('confirmed child')
  await finish(true)
  expect(childName().value).toBe('item draft')
  expect(draft.items).toEqual([])
  await finish(true)
  expect(draft).toMatchObject({
    name: 'parent draft',
    items: [{ name: 'item draft', children: [{ name: 'confirmed child', children: [{ name: 'deepest draft' }] }] }],
  })
  await act(async () => rootSave.click())
  expect(save).toHaveBeenCalledTimes(1)
  await open(rootLayer, '="items"')
  await typeChild('discard on new identity')
  await act(async () => root.render(<Surface identity="two" />))
  expect(dom.window.document.querySelector('.cxf-form-page-layer')).toBeNull()
  expect(rootLayer.hidden).toBe(false)
  await act(async () =>
    root.render(
      <>
        <SchemaForm identity="a" schema={formPageSchema} value={formPageValue} onChange={() => {}} />
        <SchemaForm identity="b" schema={formPageSchema} value={formPageValue} onChange={() => {}} />
      </>,
    )
  )
  expect(dom.window.document.querySelectorAll('.cxf-form-page-stack')).toHaveLength(2)
  expect(
    [...dom.window.document.querySelectorAll('.cxf-form-page-stack')].every(stack =>
      stack.getAttribute('data-form-layout') === 'embedded'
    ),
  ).toBe(true)
})

it('keeps the plugin root Form outside child pages and blocks direct root submit until children close', async () => {
  const update = vi.fn(async () => undefined)
  await act(async () => root.render(<HostForm model={model(update)} plugin={plugin(formPageFields())} />))
  await edit('name', 'root draft')
  const form = dom.window.document.querySelector('form')!
  await open(form, '="items"')
  await typeChild('local item')
  expect(childName().closest('form')).toBeNull()
  await act(async () =>
    childName().dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  )
  await submit()
  expect(update).not.toHaveBeenCalled()
  await finish(false)
  await submit()
  expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'set', path: ['name'], value: 'root draft' }])
})
