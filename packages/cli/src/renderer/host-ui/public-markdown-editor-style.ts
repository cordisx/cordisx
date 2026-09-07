import type { Shikitor } from '@shikitor/core'
import shikitorVendorCss from '@shikitor/core/index.css'
import markdownEditorCss from './public-markdown-editor.css'

const MARKER = '@shikitor/core@1.0.2/public-markdown-editor'

/** Per-document ownership survives two concurrently mounted plugin pages. */
export function acquireMarkdownEditorStyles(document: Document): () => void {
  let style = document.querySelector<HTMLStyleElement>(`style[data-cordisx-markdown-editor="${MARKER}"]`)
  if (style === null) {
    style = document.createElement('style')
    style.dataset.cordisxMarkdownEditor = MARKER
    style.textContent = `${shikitorVendorCss}\n${markdownEditorCss}`
    ;(document.head ?? document.documentElement).append(style)
  }
  const retained = style
  retained.dataset.users = String(Number(retained.dataset.users ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const users = Number(retained.dataset.users ?? 1) - 1
    if (users <= 0) retained.remove()
    else retained.dataset.users = String(users)
  }
}

export function syncMarkdownEditorMetrics(input: HTMLTextAreaElement, editor: Shikitor): void {
  const view = input.ownerDocument.defaultView
  if (view === null) return
  const source = view.getComputedStyle(input)
  const projection = editor.element.style
  projection.boxSizing = source.boxSizing
  projection.padding = source.padding
  projection.borderWidth = source.borderWidth
  projection.fontFamily = source.fontFamily
  projection.fontSize = source.fontSize
  projection.fontWeight = source.fontWeight
  projection.fontStyle = source.fontStyle
  projection.fontVariant = source.fontVariant
  projection.fontStretch = source.fontStretch
  projection.letterSpacing = source.letterSpacing
  projection.wordSpacing = source.wordSpacing
  projection.textAlign = source.textAlign
  projection.textTransform = source.textTransform
  projection.direction = source.direction
  projection.tabSize = source.tabSize
  projection.setProperty('--font-family', source.fontFamily)
  projection.setProperty('--line-height', source.lineHeight)
  projection.setProperty('--shikitor-white-space', source.whiteSpace)
  projection.setProperty('--shikitor-word-break', source.wordBreak)
  projection.setProperty('--shikitor-overflow-wrap', source.overflowWrap)
}
