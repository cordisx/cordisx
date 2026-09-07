/** @jsxImportSource react */
import * as React from 'react'
import type { MarkdownEditorHandle, MarkdownEditorProps, MarkdownEditorSelection } from '../../ui.js'
import { usePublicMarkdownEditor } from './usePublicMarkdownEditor.js'

/** Controlled public editor; it knows nothing about rooms, commands or attachment actions. */
export function PublicMarkdownEditor({ ref, className, style, ...props }: MarkdownEditorProps) {
  const latest = React.useRef(props)
  latest.current = props
  const selection = React.useRef<MarkdownEditorSelection>({ start: 0, end: 0 })
  const publishSelection = React.useCallback((input: HTMLTextAreaElement) => {
    const next = { start: input.selectionStart, end: input.selectionEnd }
    if (next.start === selection.current.start && next.end === selection.current.end) return
    selection.current = next
    latest.current.onSelectionChange?.(next)
  }, [])
  const { inputRef, publishValue } = usePublicMarkdownEditor(props)
  React.useImperativeHandle(ref, (): MarkdownEditorHandle => ({
    focus(options) {
      inputRef.current?.focus(options)
    },
    getSelection() {
      const input = inputRef.current
      return input === null ? { start: 0, end: 0 } : { start: input.selectionStart, end: input.selectionEnd }
    },
    setSelection(start, end) {
      const input = inputRef.current
      if (input === null) return
      const clamp = (value: number) =>
        Math.max(0, Math.min(input.value.length, Number.isFinite(value) ? Math.trunc(value) : 0))
      input.setSelectionRange(clamp(start), clamp(end))
      publishSelection(input)
    },
  }), [inputRef, publishSelection])
  return (
    <div className={['cxr-markdown-editor', className].filter(Boolean).join(' ')} style={style}>
      <textarea
        ref={inputRef}
        className="cxr-markdown-editor__input"
        value={props.value}
        rows={1}
        disabled={props.disabled}
        placeholder={props.placeholder}
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        aria-controls={props['aria-controls']}
        aria-activedescendant={props['aria-activedescendant']}
        onInput={event => publishValue(event.currentTarget.value)}
        onChange={event => publishValue(event.currentTarget.value)}
        onSelect={event => publishSelection(event.currentTarget)}
        onKeyDown={props.onKeyDown}
        onCompositionStart={props.onCompositionStart}
        onCompositionEnd={props.onCompositionEnd}
      />
    </div>
  )
}
