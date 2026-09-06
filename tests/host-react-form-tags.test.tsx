import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerModel } from '../packages/cli/src/renderer/manager.js'
import { dom, edit, field, HostForm, input, model, plugin, root, submit } from './helpers/host-react-form.js'

async function addTag(path: string, value: string): Promise<void> {
  await edit(path, value)
  await act(async () =>
    input(path).dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    )
  )
}

function tags(path: string): string[] {
  return [...dom.window.document.querySelectorAll(`[data-config-path="${path}"] .t-tag`)].map(tag =>
    tag.textContent ?? ''
  )
}

async function removeTag(path: string, index: number): Promise<void> {
  const remove = dom.window.document.querySelectorAll(`[data-config-path="${path}"] .t-tag__icon-close`)[index]!
  await act(async () => remove.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
}

describe('Host React tag drafts and custom control lifecycle', () => {
  it('retains boolean tags as booleans and rejects a visible invalid boolean draft until corrected', async () => {
    const update = vi.fn(async () => undefined)
    await act(async () =>
      root.render(
        <HostForm
          model={model(update)}
          plugin={plugin([
            field('flags', { type: 'array', arrayItemType: 'boolean', value: [true] }),
          ])}
        />,
      )
    )
    await addTag('flags', 'false')
    expect(tags('flags')).toEqual(['true', 'false'])
    await addTag('flags', 'maybe')
    await submit()
    expect(update).not.toHaveBeenCalled()
    expect(tags('flags')).toEqual(['true', 'false', 'maybe'])
    expect(input('flags').getAttribute('aria-invalid')).toBe('true')
    await removeTag('flags', 2)
    await submit()
    expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'set', path: ['flags'], value: [true, false] }])
  })

  it('preserves invalid numeric text and excess tags, enforcing item types and array bounds before commit', async () => {
    const update = vi.fn(async () => undefined)
    await act(async () =>
      root.render(
        <HostForm
          model={model(update)}
          plugin={plugin([
            field('numbers', { type: 'array', arrayItemType: 'number', value: [], min: 2, max: 2 }),
          ])}
        />,
      )
    )
    await addTag('numbers', '1')
    await submit()
    expect(update).not.toHaveBeenCalled()
    expect(dom.window.document.querySelector('.cxf-error')?.textContent).toBe('Choose at least 2')
    await addTag('numbers', 'invalid')
    await submit()
    expect(tags('numbers')).toEqual(['1', 'invalid'])
    expect(update).not.toHaveBeenCalled()
    await removeTag('numbers', 1)
    await addTag('numbers', '2.5')
    await addTag('numbers', '3')
    await submit()
    expect(tags('numbers')).toEqual(['1', '2.5', '3'])
    expect(dom.window.document.querySelector('.cxf-error')?.textContent).toBe('Choose at most 2')
    expect(update).not.toHaveBeenCalled()
    await removeTag('numbers', 2)
    await submit()
    expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'set', path: ['numbers'], value: [1, 2.5] }])
  })

  it('keeps one custom renderer and its draft through saving, blocks changes while inert, then disposes once', async () => {
    let finish!: () => void
    const update = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const dispose = vi.fn(async () => undefined)
    const mountConfigRenderer: NonNullable<ManagerModel['mountConfigRenderer']> = vi.fn(
      async (_plugin, descriptor, container, onChange) => {
        const custom = dom.window.document.createElement('input')
        custom.dataset.customControl = 'true'
        custom.value = String(descriptor.value)
        custom.addEventListener('input', () => onChange(custom.value))
        container.append(custom)
        return { mounted: true, dispose }
      },
    )
    const manager: ManagerModel = { ...model(update), mountConfigRenderer }
    const fields = [field('name', { description: 'Custom field help' })]
    await act(async () => root.render(<HostForm model={manager} plugin={plugin(fields)} />))
    const custom = dom.window.document.querySelector<HTMLInputElement>('[data-custom-control]')!
    expect(
      custom.getAttribute('aria-describedby')?.split(' ').map(id =>
        dom.window.document.getElementById(id)?.textContent
      ),
    ).toEqual(['Custom field help', ''])
    await act(async () => {
      custom.value = 'custom draft'
      custom.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await submit()
    const seat = custom.closest('.cxm-config-renderer')!
    expect(seat.hasAttribute('inert')).toBe(true)
    expect(mountConfigRenderer).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    await act(async () => {
      custom.value = 'blocked change'
      custom.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => finish())
    expect(seat.hasAttribute('inert')).toBe(false)
    expect(mountConfigRenderer).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'set', path: ['name'], value: 'custom draft' }])
    await act(async () => root.render(<HostForm model={manager} plugin={plugin(fields, 1, false)} />))
    expect(seat.hasAttribute('inert')).toBe(false)
    expect(mountConfigRenderer).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
