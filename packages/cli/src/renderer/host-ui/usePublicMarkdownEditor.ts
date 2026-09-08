import { create, type Shikitor } from '@shikitor/core'
import * as React from 'react'
import type { MarkdownEditorProps } from '../../ui.js'
import { resolveHostTheme } from '../host-theme.js'
import { acquireMarkdownEditorStyles, syncMarkdownEditorMetrics } from './public-markdown-editor-style.js'

/** Retain the resident textarea's native editing/IME while Shikitor paints Markdown. */
export function usePublicMarkdownEditor(props: MarkdownEditorProps) {
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const editorRef = React.useRef<Shikitor | undefined>(undefined)
  const latest = React.useRef(props)
  const reported = React.useRef(props.value)
  const measureRef = React.useRef<(() => void) | undefined>(undefined)
  latest.current = props
  const publishValue = React.useCallback((value: string) => {
    if (latest.current.disabled || reported.current === value) return
    reported.current = value
    latest.current.onValueChange(value)
    measureRef.current?.()
  }, [])

  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (input === null) return
    const document = input.ownerDocument
    const view = document.defaultView
    const releaseStyles = acquireMarkdownEditorStyles(document)
    const abort = new AbortController()
    let active = true
    let editor: Shikitor | undefined
    let renderModeObserver: MutationObserver | undefined
    let frame: number | undefined
    const theme = () => {
      const override = input.closest<HTMLElement>('[data-cordisx-app-theme]')?.dataset.cordisxAppTheme
      return (override === 'dark' || override === 'light' ? override : resolveHostTheme(document).theme) === 'dark'
        ? 'github-dark' as const
        : 'github-light' as const
    }
    const nativeText = () => {
      if (editor?.element.dataset.shikitorRenderMode === 'less-dom') input.dataset.cordisxEditorNativeText = 'true'
      else delete input.dataset.cordisxEditorNativeText
    }
    const measure = () => {
      if (!active || view === null) return
      const metrics = view.getComputedStyle(input)
      const lineHeight = Number.parseFloat(metrics.lineHeight) || 22
      const number = (value: string) => Number.parseFloat(value) || 0
      const padding = number(metrics.paddingTop) + number(metrics.paddingBottom)
      const borders = number(metrics.borderTopWidth) + number(metrics.borderBottomWidth)
      input.style.height = 'auto'
      const content = input.scrollHeight
      const maximum = lineHeight * 6 + padding + borders
      input.style.height = `${
        Math.ceil(Math.min(Math.max(content + borders, lineHeight + padding + borders), maximum))
      }px`
      input.style.overflowY = content + borders > maximum + 1 ? 'auto' : 'hidden'
      if (editor !== undefined) syncMarkdownEditorMetrics(input, editor)
    }
    const queueMeasure = () => {
      if (!active || view === null) return
      if (frame !== undefined) view.cancelAnimationFrame(frame)
      frame = view.requestAnimationFrame(() => {
        frame = undefined
        measure()
      })
    }
    measureRef.current = queueMeasure
    const markUnavailable = () => {
      if (active) input.dataset.cordisxEditorFallback = 'true'
    }
    const updateOptions = () => {
      if (editor === undefined) return
      void editor.updateOptions(current => ({
        ...current,
        placeholder: latest.current.placeholder ?? '',
        readOnly: latest.current.disabled === true,
        theme: theme(),
      })).catch(markUnavailable)
      nativeText()
      queueMeasure()
    }
    // Preserve the old adapter's explicit Shift+Enter line-break behavior before
    // Shikitor/native listeners; this layer does not own any submit shortcut.
    const insertLineBreak = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.key !== 'Enter' || !event.shiftKey || event.isComposing || event.keyCode === 229
        || input.disabled
      ) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end')
      publishValue(input.value)
      if (view !== null) {
        input.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }))
        document.dispatchEvent(new view.Event('selectionchange'))
      }
      queueMeasure()
    }
    input.addEventListener('keydown', insertLineBreak, true)
    const Observer = view?.MutationObserver
    const themeObserver = Observer === undefined ? undefined : new Observer(updateOptions)
    const observeTheme = (element: Element | null) => {
      if (element !== null) {
        themeObserver?.observe(element, {
          attributes: true,
          attributeFilter: [
            'data-cordisx-app-theme',
            'data-theme',
            'data-color-theme',
            'data-color-scheme',
            'class',
            'style',
          ],
        })
      }
    }
    observeTheme(document.documentElement)
    observeTheme(document.body)
    const themeRoot = input.closest('[data-cordisx-app-theme]')
    if (themeRoot !== document.documentElement && themeRoot !== document.body) observeTheme(themeRoot)
    const media = view?.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', updateOptions)
    const Resize = view?.ResizeObserver
    const resizeObserver = Resize === undefined ? undefined : new Resize(queueMeasure)
    if (input.parentElement !== null) resizeObserver?.observe(input.parentElement)
    view?.addEventListener('resize', queueMeasure)
    measure()
    void create(input, {
      value: latest.current.value,
      language: 'markdown',
      theme: theme(),
      lineNumbers: 'off',
      highlightCurrentLine: false,
      hideSelfCursorUsername: true,
      placeholder: latest.current.placeholder ?? '',
      readOnly: latest.current.disabled === true,
      plugins: [],
      onChange: value => {
        queueMicrotask(() => {
          // Reject late values from a previous render of the same editor.
          if (active && input.value === value) publishValue(value)
        })
      },
    }, { abort: abort.signal }).then(created => {
      if (!active) {
        created[Symbol.dispose]()
        return
      }
      editor = created
      editorRef.current = created
      delete input.dataset.cordisxEditorFallback
      if (created.value !== latest.current.value) created.value = latest.current.value
      if (Observer !== undefined) {
        renderModeObserver = new Observer(nativeText)
        renderModeObserver.observe(created.element, {
          attributes: true,
          attributeFilter: ['data-shikitor-render-mode'],
        })
      }
      updateOptions()
    }).catch(markUnavailable)
    return () => {
      active = false
      measureRef.current = undefined
      themeObserver?.disconnect()
      renderModeObserver?.disconnect()
      resizeObserver?.disconnect()
      media?.removeEventListener?.('change', updateOptions)
      view?.removeEventListener('resize', queueMeasure)
      if (frame !== undefined) view?.cancelAnimationFrame(frame)
      input.removeEventListener('keydown', insertLineBreak, true)
      abort.abort()
      editor?.[Symbol.dispose]()
      if (editorRef.current === editor) editorRef.current = undefined
      releaseStyles()
    }
  }, [publishValue])

  React.useLayoutEffect(() => {
    reported.current = props.value
    const editor = editorRef.current
    if (editor !== undefined && editor.value !== props.value) editor.value = props.value
    measureRef.current?.()
  }, [props.value])
  React.useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined) return
    void editor.updateOptions(current => ({
      ...current,
      placeholder: props.placeholder ?? '',
      readOnly: props.disabled === true,
    }))
      .catch(() => {
        if (inputRef.current !== null) inputRef.current.dataset.cordisxEditorFallback = 'true'
      })
  }, [props.disabled, props.placeholder])
  return { inputRef, publishValue }
}
