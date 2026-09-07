import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownEditorHandle, MarkdownEditorProps } from '../packages/cli/src/ui.js'
import { PublicMarkdownEditor } from '../packages/cli/src/renderer/host-ui/PublicMarkdownEditor.js'
import { cordisXSharedModuleSource } from '../packages/cli/src/launcher/react-virtual-modules.js'

const shikitor = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@shikitor/core', () => ({ create: shikitor.create }))
vi.mock('@shikitor/core/index.css', () => ({ default: '.shikitor{position:relative}' }))
vi.mock(
  '../packages/cli/src/renderer/host-ui/public-markdown-editor.css',
  () => ({ default: '.cxr-markdown-editor{position:relative}' }),
)

const globals = new Map<string, unknown>()
let root: Root | undefined
let dom: JSDOM | undefined
const editors: Array<
  {
    value: string
    options: Record<string, unknown>
    element: HTMLElement
    dispose: ReturnType<typeof vi.fn>
    updateOptions: ReturnType<typeof vi.fn>
  }
> = []

async function mount(initial: Partial<MarkdownEditorProps> = {}) {
  dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="root"></div></body></html>', {
    url: 'https://host.invalid/',
  })
  const view = dom.window
  Object.defineProperties(view.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  })
  Object.defineProperties(view, {
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => view.setTimeout(() => callback(0), 0) },
    cancelAnimationFrame: { value: (id: number) => view.clearTimeout(id) },
    matchMedia: { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  })
  for (
    const [key, value] of Object.entries({
      window: view,
      document: view.document,
      HTMLElement: view.HTMLElement,
      HTMLTextAreaElement: view.HTMLTextAreaElement,
      Node: view.Node,
      Element: view.Element,
      MutationObserver: view.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
  ) {
    globals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  shikitor.create.mockImplementation(async (input: HTMLTextAreaElement, options: Record<string, unknown>) => {
    const element = view.document.createElement('div')
    element.className = 'shikitor shikitor--attached'
    input.before(element)
    const editor = {
      value: input.value,
      options,
      element,
      dispose: vi.fn(() => element.remove()),
      updateOptions: vi.fn((update: (options: Record<string, unknown>) => Record<string, unknown>) => {
        editor.options = update(editor.options)
        return Promise.resolve()
      }),
      [Symbol.dispose]() {
        editor.dispose()
      },
    }
    editors.push(editor)
    return editor
  })
  root = createRoot(view.document.getElementById('root')!)
  const ref = React.createRef<MarkdownEditorHandle>()
  let props: MarkdownEditorProps = { value: '', onValueChange: vi.fn(), 'aria-label': 'Message', ref, ...initial }
  const render = async (next: Partial<MarkdownEditorProps> = {}) => {
    props = { ...props, ...next }
    await act(async () => {
      root!.render(<PublicMarkdownEditor {...props} />)
    })
  }
  await render()
  return {
    ref,
    render,
    get props() {
      return props
    },
    view,
    input: view.document.querySelector('textarea')!,
  }
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount())
  root = undefined
  dom?.window.close()
  dom = undefined
  for (const [key, value] of globals) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key)
    else Reflect.set(globalThis, key, value)
  }
  globals.clear()
  editors.splice(0)
  vi.clearAllMocks()
})

describe('public Markdown editor', () => {
  it('is available in the launcher public virtual UI module', () => {
    expect(cordisXSharedModuleSource('cordisx/ui')).toContain(
      'export const MarkdownEditor = runtime.ui.MarkdownEditor;',
    )
  })

  it('creates a Markdown editor with baseline options and updates value/disabled without recreating', async () => {
    const ui = await mount({ value: '**hello**', placeholder: 'Write' })
    expect(shikitor.create).toHaveBeenCalledTimes(1)
    expect(editors[0].options).toMatchObject({
      language: 'markdown',
      theme: 'github-dark',
      lineNumbers: 'off',
      plugins: [],
      readOnly: false,
    })
    await ui.render({ value: 'changed', disabled: true, placeholder: 'Busy' })
    expect(ui.input.value).toBe('changed')
    expect(ui.input.disabled).toBe(true)
    expect(editors[0].value).toBe('changed')
    expect(editors[0].options).toMatchObject({ readOnly: true, placeholder: 'Busy' })
    expect(shikitor.create).toHaveBeenCalledTimes(1)
  })

  it('exposes focus/selection operations without an element handle', async () => {
    const selection = vi.fn()
    const ui = await mount({ value: 'hello world', onSelectionChange: selection })
    await act(async () => {
      ui.ref.current!.focus({ preventScroll: true })
      ui.ref.current!.setSelection(1, 5)
    })
    expect(ui.view.document.activeElement).toBe(ui.input)
    expect(ui.ref.current!.getSelection()).toEqual({ start: 1, end: 5 })
    expect(Object.keys(ui.ref.current!)).toEqual(['focus', 'getSelection', 'setSelection'])
    expect(selection).toHaveBeenCalledWith({ start: 1, end: 5 })
    await act(async () => ui.ref.current!.setSelection(-5, 999))
    expect(ui.ref.current!.getSelection()).toEqual({ start: 0, end: 11 })
  })

  it('publishes resident input once and forwards keyboard/IME handlers', async () => {
    const value = vi.fn()
    const key = vi.fn()
    const ui = await mount({
      onValueChange: value,
      onKeyDown: key,
      'aria-controls': 'members',
      'aria-activedescendant': 'alice',
    })
    await act(async () => {
      ui.input.value = 'typed'
      ui.input.dispatchEvent(new ui.view.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
      const callback = editors[0].options.onChange as (value: string) => void
      callback('typed')
      ui.input.dispatchEvent(new ui.view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    })
    expect(value).toHaveBeenCalledTimes(1)
    expect(value).toHaveBeenCalledWith('typed')
    expect(key).toHaveBeenCalledTimes(1)
    expect(key.mock.calls[0][0].nativeEvent.isComposing).toBe(true)
    expect(ui.input.getAttribute('aria-controls')).toBe('members')
    expect(ui.input.getAttribute('aria-activedescendant')).toBe('alice')
  })

  it('retains Shift+Enter line breaks and does not synthesize a submit command', async () => {
    const value = vi.fn()
    const key = vi.fn()
    const ui = await mount({ value: 'ab', onValueChange: value, onKeyDown: key })
    ui.input.setSelectionRange(1, 1)
    await act(async () =>
      ui.input.dispatchEvent(
        new ui.view.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
      )
    )
    expect(ui.input.value).toBe('a\nb')
    expect(value).toHaveBeenCalledWith('a\nb')
    expect(key).toHaveBeenCalledTimes(1)
  })

  it('lets the consumer prevent a default editing shortcut before the editor handles it', async () => {
    const value = vi.fn()
    const key = vi.fn(event => event.preventDefault())
    const ui = await mount({ value: 'ab', onValueChange: value, onKeyDown: key })
    ui.input.setSelectionRange(1, 1)
    await act(async () =>
      ui.input.dispatchEvent(
        new ui.view.KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    )
    expect(key).toHaveBeenCalledTimes(1)
    expect(ui.input.value).toBe('ab')
    expect(value).not.toHaveBeenCalled()
  })

  it('follows theme and rendering-mode changes without recreating the editor', async () => {
    const ui = await mount()
    await act(async () => {
      ui.view.document.documentElement.dataset.theme = 'light'
      editors[0].element.dataset.shikitorRenderMode = 'less-dom'
      await Promise.resolve()
    })
    expect(editors[0].options.theme).toBe('github-light')
    expect(ui.input.dataset.cordisxEditorNativeText).toBe('true')
    expect(shikitor.create).toHaveBeenCalledTimes(1)
  })

  it('disposes the editor and owned styles on unmount', async () => {
    const ui = await mount()
    const editor = editors[0]
    expect(ui.view.document.querySelector('style[data-cordisx-markdown-editor]')).not.toBeNull()
    await act(async () => root!.unmount())
    root = undefined
    expect(editor.dispose).toHaveBeenCalledTimes(1)
    expect(ui.view.document.querySelector('style[data-cordisx-markdown-editor]')).toBeNull()
    expect(ui.ref.current).toBeNull()
  })

  it('does not insert Shift+Enter during native composition', async () => {
    const value = vi.fn()
    const ui = await mount({ value: 'draft', onValueChange: value })
    await act(async () =>
      ui.input.dispatchEvent(
        new ui.view.KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    )
    expect(ui.input.value).toBe('draft')
    expect(value).not.toHaveBeenCalled()
  })

  it('keeps a readable resident input when editor initialization fails', async () => {
    const ui = await mount()
    await act(async () => root!.unmount())
    root = createRoot(ui.view.document.getElementById('root')!)
    shikitor.create.mockRejectedValueOnce(new Error('editor failed'))
    await act(async () =>
      root!.render(<PublicMarkdownEditor value="retained" onValueChange={() => {}} aria-label="Message" />)
    )
    const input = ui.view.document.querySelector('textarea')!
    expect(input.value).toBe('retained')
    expect(input.disabled).toBe(false)
    expect(input.dataset.cordisxEditorFallback).toBe('true')
  })

  it('releases an editor that resolves after unmount without reattaching resources', async () => {
    const ui = await mount()
    await act(async () => root!.unmount())
    root = createRoot(ui.view.document.getElementById('root')!)
    let resolve!: (editor: unknown) => void
    shikitor.create.mockImplementationOnce(() =>
      new Promise(done => {
        resolve = done
      })
    )
    await act(async () =>
      root!.render(<PublicMarkdownEditor value="draft" onValueChange={() => {}} aria-label="Message" />)
    )
    await act(async () => root!.unmount())
    root = undefined
    const dispose = vi.fn()
    await act(async () => resolve({ [Symbol.dispose]: dispose }))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(ui.view.document.querySelector('style[data-cordisx-markdown-editor]')).toBeNull()
  })

  it('keeps shared editor styles until the last mounted editor is gone', async () => {
    const ui = await mount()
    await act(async () =>
      root!.render(
        <>
          <PublicMarkdownEditor key="a" value="a" onValueChange={() => {}} aria-label="A" />
          <PublicMarkdownEditor key="b" value="b" onValueChange={() => {}} aria-label="B" />
        </>,
      )
    )
    expect(ui.view.document.querySelectorAll('style[data-cordisx-markdown-editor]')).toHaveLength(1)
    expect((ui.view.document.querySelector('style[data-cordisx-markdown-editor]') as HTMLElement).dataset.users).toBe(
      '2',
    )
    await act(async () =>
      root!.render(<PublicMarkdownEditor key="a" value="a" onValueChange={() => {}} aria-label="A" />)
    )
    expect(ui.view.document.querySelectorAll('style[data-cordisx-markdown-editor]')).toHaveLength(1)
    expect((ui.view.document.querySelector('style[data-cordisx-markdown-editor]') as HTMLElement).dataset.users).toBe(
      '1',
    )
  })

  it('caps the resident height at six lines and remeasures on window resize', async () => {
    const ui = await mount()
    ui.input.style.lineHeight = '20px'
    Object.defineProperty(ui.input, 'scrollHeight', { configurable: true, value: 200 })
    await act(async () => {
      ui.view.dispatchEvent(new ui.view.Event('resize'))
      await new Promise(resolve => ui.view.setTimeout(resolve, 5))
    })
    // CSS is mocked in this DOM lifecycle test, so there is no editor padding;
    // the default textarea border contributes four pixels.
    const border = Number.parseFloat(ui.view.getComputedStyle(ui.input).borderTopWidth) || 0
    const padding = Number.parseFloat(ui.view.getComputedStyle(ui.input).paddingTop) || 0
    expect(Number.parseFloat(ui.input.style.height)).toBe(120 + border * 2 + padding * 2)
    expect(ui.input.style.overflowY).toBe('auto')
  })
})
