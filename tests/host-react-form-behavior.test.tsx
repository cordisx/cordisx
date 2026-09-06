import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { dom, edit, field, HostForm, input, model, plugin, root, submit } from './helpers/host-react-form.js'

describe('Host React form behavior through TDesign controls', () => {
  it('validates the actual Input draft, preserves labels, resets, commits once and reopens the saved revision', async () => {
    let finish!: () => void
    const update = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const manager = model(update)
    const fields = [
      field('name', { required: true, description: 'Public display name' }),
      field('count', { type: 'natural', value: 2, min: 0 }),
    ]
    await act(async () => root.render(<HostForm model={manager} plugin={plugin(fields)} />))
    expect(input('name').closest('.t-input')).not.toBeNull()
    expect(input('name').getAttribute('aria-required')).toBe('true')
    const label = dom.window.document.getElementById(input('name').getAttribute('aria-labelledby')!)
    expect(label?.textContent).toContain('name')
    const descriptionIds = input('name').getAttribute('aria-describedby')!.split(' ')
    expect(descriptionIds.map(id => dom.window.document.getElementById(id)?.textContent)).toEqual([
      'Public display name',
      '',
    ])
    await edit('name', '')
    await submit()
    expect(update).not.toHaveBeenCalled()
    expect(dom.window.document.activeElement).toBe(input('name'))
    expect(input('name').getAttribute('aria-invalid')).toBe('true')
    expect(dom.window.document.getElementById(descriptionIds[1]!)?.textContent).toBe(
      'Required',
    )
    await edit('name', 'temporary')
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[type="reset"]')!.click())
    expect(input('name').value).toBe('initial')
    await edit('name', 'saved')
    await edit('count', '7')
    await submit()
    expect(update).toHaveBeenCalledWith('fixture', 1, [
      { op: 'set', path: ['name'], value: 'saved' },
      { op: 'set', path: ['count'], value: 7 },
    ])
    expect(input('name').disabled).toBe(true)
    expect(input('count').disabled).toBe(true)
    await submit()
    expect(update).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(input('name').value).toBe('saved')
    await act(async () =>
      root.render(
        <HostForm
          model={manager}
          plugin={plugin([
            field('name', { required: true, value: 'saved' }),
            field('count', { type: 'natural', value: 7 }),
          ], 2)}
        />,
      )
    )
    expect(input('name').value).toBe('saved')
    expect(input('count').value).toBe('7')
    expect(dom.window.document.querySelector('[data-plugin-config-form]')?.getAttribute('data-state')).toBe('pristine')
    await act(async () => root.render(<HostForm model={manager} plugin={plugin(fields, 3, false)} />))
    expect(input('name').disabled).toBe(false)
    await edit('name', 'local preview draft')
    await submit()
    expect(update).toHaveBeenCalledTimes(1)
    expect(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    await act(async () =>
      root.render(<HostForm model={manager} plugin={plugin([field('name', { disabled: true })], 4)} />)
    )
    expect(input('name').disabled).toBe(true)
  })

  it('commits typed Select options from the real popup and disposes the popup on unmount', async () => {
    const update = vi.fn(async () => undefined)
    await act(async () =>
      root.render(
        <HostForm
          model={model(update)}
          plugin={plugin([
            field('choice', {
              type: 'number',
              value: 1,
              choices: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }, { label: 'Nothing', value: null }],
            }),
          ])}
        />,
      )
    )
    const control = input('choice')
    await act(async () => {
      control.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
      control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const option = [...dom.window.document.querySelectorAll<HTMLElement>('.t-select-option')].find(item =>
      item.textContent === 'Two'
    )
    expect(option).toBeDefined()
    await act(async () => option!.click())
    expect(input('choice').value).toBe('Two')
    await submit()
    expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'set', path: ['choice'], value: 2 }])
    await act(async () => {
      input('choice').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const empty = [...dom.window.document.querySelectorAll<HTMLElement>('.t-select-option')].find(item =>
      item.textContent === 'Nothing'
    )
    expect(empty).toBeDefined()
    await act(async () => empty!.click())
    expect(input('choice').value).toBe('Nothing')
    await submit()
    expect(update).toHaveBeenLastCalledWith('fixture', 1, [{ op: 'set', path: ['choice'], value: null }])
    await act(async () => root.render(null))
    expect(dom.window.document.querySelector('.t-select-option')).toBeNull()
  })

  it('retains a conflicted draft, clears an optional number, and restores its committed value on reset', async () => {
    const update = vi.fn(async () => {
      throw new Error('revision conflict')
    })
    await act(async () =>
      root.render(
        <HostForm
          model={model(update)}
          plugin={plugin([
            field('count', { type: 'number', value: 5 }),
          ])}
        />,
      )
    )
    await edit('count', '')
    await submit()
    expect(update).toHaveBeenCalledWith('fixture', 1, [{ op: 'unset', path: ['count'] }])
    expect(input('count').value).toBe('')
    expect(input('count').disabled).toBe(false)
    expect(dom.window.document.querySelector('[data-plugin-config-form]')?.getAttribute('data-state')).toBe('conflict')
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[type="reset"]')!.click())
    expect(input('count').value).toBe('5')
  })

  it('retains validation semantics for required arrays, natural numbers, role formats and optional clears', async () => {
    const { hostFormValidationIssueText: validate } = await import(
      '../packages/cli/src/renderer/host-ui/HostFormValidation.js'
    )
    expect(validate(field('tags', { type: 'array', required: true }), [], 'en')).toBe('Required')
    expect(validate(field('count', { type: 'natural' }), -1, 'en')).toBe('Enter a non-negative integer')
    expect(validate(field('count', { type: 'natural' }), 1.5, 'en')).toBe('Enter a non-negative integer')
    expect(validate(field('count', { type: 'number', step: 2 }), 3, 'en')).toBe('Use increments of 2')
    expect(validate(field('count', { type: 'number', min: 3 }), 2, 'en')).toBe('Must be at least 3')
    expect(validate(field('time', { role: 'time' }), '12:30', 'en')).toBeUndefined()
    expect(validate(field('time', { role: 'time' }), '25:30', 'en')).toBe('Enter a valid time')
    expect(validate(field('date', { role: 'datetime' }), 'bad', 'en')).toBe('Enter a valid date and time')
    expect(validate(field('color', { role: 'color' }), '#112233', 'en')).toBeUndefined()
    expect(validate(field('choice', { choices: [{ label: 'One', value: 1 }] }), undefined, 'en')).toBeUndefined()
  })
})
