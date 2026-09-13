import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSharedReactRuntime, type SharedReactRuntime } from '../packages/cli/src/renderer/react-runtime.js'
import type { SearchFieldProps } from '../packages/cli/src/ui.js'

const previous = {
  document: globalThis.document,
  window: globalThis.window,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}
let dom: JSDOM
let runtime: SharedReactRuntime
let root: ReturnType<typeof createRoot>

afterEach(async () => {
  if (root !== undefined) await act(async () => root.unmount())
  runtime?.dispose()
  dom?.window.close()
  Object.assign(globalThis, previous)
})

async function render(props: Partial<SearchFieldProps> = {}) {
  dom = new JSDOM('<!doctype html><html data-theme="light"><head></head><body><div id="root"></div></body></html>', {
    url: 'https://host.invalid/',
  })
  // React was imported before this Node fixture had a document, so its legacy
  // input feature detection requires the same no-op hooks as other DOM suites.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  })
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  runtime = installSharedReactRuntime(dom.window.document)
  root = createRoot(dom.window.document.getElementById('root')!)
  const onChange = vi.fn()
  const SearchField = runtime.ui.SearchField
  await act(async () =>
    root.render(<SearchField aria-label="Search rooms" value="chess" onChange={onChange} {...props} />)
  )
  return {
    onChange,
    input: dom.window.document.querySelector('input')!,
    row: dom.window.document.querySelector<HTMLElement>('.cxr-ui-filter-search')!,
    button: dom.window.document.querySelector('button'),
    SearchField,
  }
}

describe('public SearchField clear action', () => {
  it('preserves native search behavior by default and focuses from the icon or row', async () => {
    const { input, row, button, onChange } = await render()
    expect(input.type).toBe('search')
    expect(input.getAttribute('aria-label')).toBe('Search rooms')
    expect(button).toBeNull()
    expect(row.hasAttribute('data-clearable')).toBe(false)
    row.click()
    expect(dom.window.document.activeElement).toBe(input)
    input.blur()
    row.querySelector<HTMLElement>('[data-host-icon-key="search"]')!.click()
    expect(dom.window.document.activeElement).toBe(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears once through the controlled callback and focuses the existing input', async () => {
    const { input, row, button, onChange } = await render({ clearable: true, clearLabel: '清空搜索' })
    expect(row.tagName).toBe('SPAN')
    expect(button!.type).toBe('button')
    expect(button!.getAttribute('aria-label')).toBe('清空搜索')
    expect(button!.getAttribute('title')).toBe('清空搜索')
    expect(button!.querySelector('[data-host-icon="host:close"] svg')?.getAttribute('data-host-icon-provider'))
      .toBe('builtin:reicon')
    expect(button!.classList.contains('cxr-ui-button')).toBe(true)
    await act(async () => button!.click())
    expect(onChange.mock.calls).toEqual([['']])
    expect(dom.window.document.activeElement).toBe(input)
    expect(input.value).toBe('chess')
    expect(input.hasAttribute('clearable')).toBe(false)
    expect(input.hasAttribute('clearLabel')).toBe(false)
  })

  it('hides the action when the owner updates the value to empty and defaults the label', async () => {
    const { button, SearchField } = await render({ clearable: true })
    expect(button!.getAttribute('aria-label')).toBe('Clear search')
    await act(async () => root.render(<SearchField value="" onChange={() => {}} clearable />))
    expect(dom.window.document.querySelector('button')).toBeNull()
    expect(dom.window.document.querySelector('input')!.value).toBe('')
  })

  it.each([{ disabled: true }, { readOnly: true }])('does not mutate a protected field: %j', async props => {
    const { button, onChange } = await render({ clearable: true, ...props })
    expect(button!.disabled).toBe(true)
    await act(async () => button!.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('publishes scoped native cancel suppression and keeps standard button hover/focus rules', async () => {
    await render({ clearable: true, clearLabel: '   ' })
    expect(dom.window.document.querySelector('button')!.getAttribute('aria-label')).toBe('Clear search')
    const css = dom.window.document.querySelector<HTMLStyleElement>('style[data-cordisx-shared-react]')!.textContent!
    expect(css).toContain('.cxr-ui-filter-search[data-clearable="true"] input::-webkit-search-cancel-button')
    expect(css).toContain('.cxr-ui-button:focus-visible')
    expect(css).toContain('.cxr-ui-button:not(:disabled):hover')
    expect(css).toContain('.cxr-ui-filter-search__clear.cxr-ui-button')
  })
})
