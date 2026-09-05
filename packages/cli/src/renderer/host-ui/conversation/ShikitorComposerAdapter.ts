import { create, type Shikitor, type ShikitorOptions } from '@shikitor/core'
import shikitorVendorCss from '@shikitor/core/index.css'
import * as React from 'react'

const STYLE_MARKER = '@shikitor/core@1.0.2/host-conversation-composer'
const STYLE_USER_ATTRIBUTE = 'cordisxShikitorComposerStyleUsers'
const COMPACT_COLUMN_GAP = 8
const COMPACT_INLINE_PADDING = 8
const MAX_COMPOSER_ROWS = 6

const HOST_COMPOSER_OVERRIDES = `
.cxa-composer[data-cordisx-shikitor-layout]{grid-template-rows:auto auto}
.cxa-composer[data-cordisx-shikitor-layout]>.cxa-draft{min-height:0!important;max-height:none!important;resize:none!important;overflow-x:hidden!important}
.cxa-composer[data-cordisx-shikitor-layout="compact"]{grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto;align-items:center;column-gap:8px;row-gap:0;padding:8px}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-draft{grid-column:2;grid-row:1;align-self:center}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer{display:contents}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer>.cxa-attachment-placeholder{grid-column:1;grid-row:1;align-self:center}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer>.cxa-composer-notice{grid-column:1/-1;grid-row:2}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer>.cxa-composer-notice:empty{display:none}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer>.cxa-composer-notice:not(:empty){margin-top:4px}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.cxa-composer-footer>.cxa-send{grid-column:3;grid-row:1;align-self:center}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.shikitor.shikitor--attached{inset:8px 46px auto;width:auto;height:30px}
.cxa-composer[data-cordisx-shikitor-layout="expanded"]{grid-template-columns:minmax(0,1fr);align-items:stretch}
.cxa-composer[data-cordisx-shikitor-layout="expanded"]>.cxa-draft{grid-column:1;grid-row:1}
.cxa-composer[data-cordisx-shikitor-layout="expanded"]>.cxa-composer-footer{grid-column:1;grid-row:2}
.cxa-composer:has(>.shikitor--attached){position:relative;isolation:isolate}
.cxa-composer>.shikitor.shikitor--attached{position:absolute;inset:0;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;flex:none;contain:layout paint;z-index:0;overflow:hidden;pointer-events:none;background:transparent!important;color:var(--cx-text)!important;--shikitor-caret-color:var(--cx-text)!important}
.cxa-composer>.shikitor--attached>.shikitor-lines{display:none!important;width:0!important;min-width:0!important;flex:0 0 0!important;overflow:hidden!important;margin:0!important;padding:0!important}
.cxa-composer>.shikitor--attached .shikitor-gutter-viewport,.cxa-composer>.shikitor--attached .shikitor-gutter-line,.cxa-composer>.shikitor--attached .shikitor-gutter-line-number{display:none!important;width:0!important;min-width:0!important;flex:0 0 0!important;overflow:hidden!important;margin:0!important;padding:0!important}
.cxa-composer>.shikitor--attached .shikitor-container,.cxa-composer>.shikitor--attached .shikitor-output,.cxa-composer>.shikitor--attached .shikitor-output>pre,.cxa-composer>.shikitor--attached .shikitor-output>pre>code,.cxa-composer>.shikitor--attached .shikitor-output-line,.cxa-composer>.shikitor--attached .shikitor-output-line *,.cxa-composer>.shikitor--attached .shikitor-placeholder{font-family:inherit!important;font-size:inherit!important;font-stretch:inherit!important;font-style:inherit!important;font-variant:inherit!important;font-weight:inherit!important;letter-spacing:inherit!important;line-height:inherit!important;word-spacing:inherit!important}
.cxa-composer>.shikitor--attached .shikitor-container{min-width:0;width:100%}
.cxa-composer>.shikitor--attached:before{display:none!important;content:none!important}
.cxa-composer>.shikitor--attached .shikitor-gutter-line-highlighted,.cxa-composer>.shikitor--attached .shikitor-output-line-highlighted,.cxa-composer>.shikitor--attached .shikitor-line-highlighted{background:none!important}
.cxa-composer>.shikitor--attached .shikitor-cursor__username--you{display:none!important}
.cxa-composer>.shikitor--attached,.cxa-composer>.shikitor--attached .shikitor-output,.cxa-composer>.shikitor--attached .shikitor-output>pre{background:transparent!important}
.cxa-composer>.shikitor--attached .shikitor-placeholder{color:var(--cx-muted)}
.cxa-composer[data-cordisx-shikitor-layout="compact"]>.shikitor--attached .shikitor-placeholder{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap!important}
.cxa-composer>.shikitor--attached:has(+textarea[data-cordisx-shikitor-fallback]){display:none!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback]){position:relative;z-index:1;background:transparent;color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback]):focus,.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback]):focus-visible{border-color:transparent!important;outline:0!important;outline-offset:0!important;box-shadow:none!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback])::placeholder{color:transparent;-webkit-text-fill-color:transparent}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback])::selection{color:transparent;-webkit-text-fill-color:transparent;background:color-mix(in srgb,var(--cx-primary) 28%,transparent)}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached[data-cordisx-shikitor-native-text="true"]:not([data-cordisx-shikitor-fallback]){color:var(--cx-text)!important;-webkit-text-fill-color:var(--cx-text)!important;caret-color:var(--cx-text)!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached[data-cordisx-shikitor-native-text="true"]:not([data-cordisx-shikitor-fallback])::placeholder{color:var(--cx-muted)!important;-webkit-text-fill-color:var(--cx-muted)!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached[data-cordisx-shikitor-native-text="true"]:not([data-cordisx-shikitor-fallback])::selection{color:var(--cx-text)!important;-webkit-text-fill-color:var(--cx-text)!important;background:color-mix(in srgb,var(--cx-primary) 28%,transparent)}
@media (forced-colors:active){
.cxa-composer>.shikitor.shikitor--attached{display:none!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback]){color:CanvasText!important;-webkit-text-fill-color:CanvasText!important;caret-color:CanvasText!important;forced-color-adjust:auto}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback])::placeholder{color:GrayText!important;-webkit-text-fill-color:GrayText!important}
.cxa-composer>.shikitor--attached+textarea.cxa-draft.shikitor-input--attached:not([data-cordisx-shikitor-fallback])::selection{color:HighlightText!important;-webkit-text-fill-color:HighlightText!important;background:Highlight!important}
}
`

function acquireComposerStyles(document: Document): () => void {
  if (shikitorVendorCss.trim() === '') return () => undefined
  let style = document.querySelector<HTMLStyleElement>(`style[data-cordisx-shikitor-composer-style="${STYLE_MARKER}"]`)
  if (style === null) {
    style = document.createElement('style')
    style.dataset.cordisxShikitorComposerStyle = STYLE_MARKER
    style.textContent = `${shikitorVendorCss}\n${HOST_COMPOSER_OVERRIDES}`
    ;(document.head ?? document.documentElement).append(style)
  }
  const users = Number.parseInt(style.dataset[STYLE_USER_ATTRIBUTE] ?? '0', 10)
  style.dataset[STYLE_USER_ATTRIBUTE] = String(Number.isSafeInteger(users) && users >= 0 ? users + 1 : 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = Number.parseInt(style.dataset[STYLE_USER_ATTRIBUTE] ?? '1', 10)
    if (!Number.isSafeInteger(current) || current <= 1) style.remove()
    else style.dataset[STYLE_USER_ATTRIBUTE] = String(current - 1)
  }
}

function resolveTheme(input: HTMLTextAreaElement): 'github-dark' | 'github-light' {
  const hostTheme = input.closest<HTMLElement>('[data-cordisx-app-theme]')?.dataset.cordisxAppTheme
    ?? input.ownerDocument.documentElement.dataset.theme
  if (hostTheme === 'dark') return 'github-dark'
  if (hostTheme === 'light') return 'github-light'
  return input.ownerDocument.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches === true
    ? 'github-dark'
    : 'github-light'
}

function syncProjectionMetrics(input: HTMLTextAreaElement, editor: Shikitor): void {
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

/**
 * Shikitor's less-dom backend paints through the resident textarea instead of
 * its projection DOM. Keep the input transparent only while a projection is
 * actually responsible for glyphs.
 */
export function syncNativeTextRendering(input: HTMLTextAreaElement, editor: Shikitor): void {
  if (editor.element.dataset.shikitorRenderMode === 'less-dom') input.dataset.cordisxShikitorNativeText = 'true'
  else delete input.dataset.cordisxShikitorNativeText
}

function syncMeasurementMetrics(input: HTMLTextAreaElement, measurement: HTMLTextAreaElement): void {
  const view = input.ownerDocument.defaultView
  if (view === null) return
  const source = view.getComputedStyle(input)
  const target = measurement.style
  target.boxSizing = source.boxSizing
  target.paddingTop = source.paddingTop
  target.paddingRight = source.paddingRight
  target.paddingBottom = source.paddingBottom
  target.paddingLeft = source.paddingLeft
  target.borderTopWidth = source.borderTopWidth
  target.borderRightWidth = source.borderRightWidth
  target.borderBottomWidth = source.borderBottomWidth
  target.borderLeftWidth = source.borderLeftWidth
  target.fontFamily = source.fontFamily
  target.fontSize = source.fontSize
  target.fontWeight = source.fontWeight
  target.fontStyle = source.fontStyle
  target.fontVariant = source.fontVariant
  target.fontStretch = source.fontStretch
  target.lineHeight = source.lineHeight
  target.letterSpacing = source.letterSpacing
  target.wordSpacing = source.wordSpacing
  target.textAlign = source.textAlign
  target.textTransform = source.textTransform
  target.direction = source.direction
  target.tabSize = source.tabSize
  target.whiteSpace = 'pre-wrap'
  target.wordBreak = source.wordBreak
  target.overflowWrap = source.overflowWrap
}

function measuredHeight(measurement: HTMLTextAreaElement, value: string): number {
  measurement.value = value.endsWith('\n') ? `${value}M` : value || 'M'
  return measurement.scrollHeight
}

function editorOptions(
  input: HTMLTextAreaElement,
  placeholder: string,
  unavailable: boolean,
): ShikitorOptions {
  return {
    value: input.value,
    language: 'markdown',
    theme: resolveTheme(input),
    lineNumbers: 'off',
    highlightCurrentLine: false,
    hideSelfCursorUsername: true,
    placeholder,
    readOnly: unavailable,
    plugins: [],
  }
}

export interface HostShikitorComposerOptions {
  readonly draft: string
  readonly instanceKey: string
  readonly placeholder: string
  readonly unavailable: boolean
  readonly onDraftChange: (value: string) => void
}

/**
 * Adds Shikitor's rendering layer to the resident Host textarea. The Host keeps
 * draft, keyboard, submission, accessibility and command-controller authority.
 */
export function useHostShikitorComposer({
  draft,
  instanceKey,
  placeholder,
  unavailable,
  onDraftChange,
}: HostShikitorComposerOptions): React.RefObject<HTMLTextAreaElement | null> {
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const editorRef = React.useRef<Shikitor | undefined>(undefined)
  const draftRef = React.useRef(draft)
  const onDraftChangeRef = React.useRef(onDraftChange)
  const optionsRef = React.useRef({ placeholder, unavailable })

  draftRef.current = draft
  onDraftChangeRef.current = onDraftChange
  optionsRef.current = { placeholder, unavailable }

  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (input === null) return

    const releaseStyles = acquireComposerStyles(input.ownerDocument)
    const abort = new AbortController()
    const composer = input.closest<HTMLFormElement>('form.cxa-composer')
    const view = input.ownerDocument.defaultView
    const measurement = composer === null ? undefined : input.ownerDocument.createElement('textarea')
    const previousLayout = composer?.dataset.cordisxShikitorLayout
    const previousHeight = input.style.height
    const previousOverflowY = input.style.overflowY
    const previousPaddingTop = input.style.paddingTop
    const previousPaddingBottom = input.style.paddingBottom
    const previousNativeText = input.dataset.cordisxShikitorNativeText
    let mounted: Shikitor | undefined
    let active = true
    let observer: MutationObserver | undefined
    let renderModeObserver: MutationObserver | undefined
    let layoutObserver: ResizeObserver | undefined
    let layoutFrame: number | undefined

    if (measurement !== undefined) {
      measurement.rows = 1
      measurement.tabIndex = -1
      measurement.setAttribute('aria-hidden', 'true')
      measurement.style.position = 'fixed'
      measurement.style.inset = '0 auto auto -10000px'
      measurement.style.height = '0'
      measurement.style.minHeight = '0'
      measurement.style.maxHeight = 'none'
      measurement.style.margin = '0'
      measurement.style.overflow = 'hidden'
      measurement.style.pointerEvents = 'none'
      measurement.style.resize = 'none'
      measurement.style.visibility = 'hidden'
      measurement.style.contain = 'layout paint style'
      measurement.style.clipPath = 'inset(50%)'
      input.ownerDocument.body.append(measurement)
    }

    const measureLayout = (): void => {
      if (!active || composer === null || measurement === undefined || view === null) return
      const composerWidth = composer.clientWidth
      if (composerWidth <= 0) return
      syncMeasurementMetrics(input, measurement)
      const sendRect = composer.querySelector<HTMLElement>('.cxa-send')?.getBoundingClientRect()
      const attachmentRect = composer.querySelector<HTMLElement>('.cxa-attachment-placeholder')?.getBoundingClientRect()
      const sendWidth = sendRect?.width ?? 30
      const attachmentWidth = attachmentRect?.width ?? 30
      const sendHeight = sendRect?.height ?? 30
      const compactWidth = Math.max(
        1,
        composerWidth - COMPACT_INLINE_PADDING * 2 - COMPACT_COLUMN_GAP * 2 - attachmentWidth - sendWidth,
      )
      measurement.style.width = `${compactWidth}px`
      const singleRowHeight = measuredHeight(measurement, 'M')
      const rowHeight = Math.max(1, measuredHeight(measurement, 'M\nM') - singleRowHeight)
      const compactContentHeight = measuredHeight(measurement, draftRef.current)
      const expanded = draftRef.current !== '' && compactContentHeight > singleRowHeight + 1
      const layout = expanded ? 'expanded' : 'compact'
      if (composer.dataset.cordisxShikitorLayout !== layout) {
        composer.dataset.cordisxShikitorLayout = layout
      }

      if (expanded) {
        input.style.paddingTop = previousPaddingTop
        input.style.paddingBottom = previousPaddingBottom
      } else {
        const lineHeight = Number.parseFloat(view.getComputedStyle(input).lineHeight)
        const compactPadding = Number.isFinite(lineHeight)
          ? Math.max(0, (sendHeight - lineHeight) / 2)
          : 0
        input.style.paddingTop = `${compactPadding}px`
        input.style.paddingBottom = `${compactPadding}px`
      }

      const composerStyle = view.getComputedStyle(composer)
      const expandedWidth = Math.max(
        1,
        composer.clientWidth
          - Number.parseFloat(composerStyle.paddingLeft)
          - Number.parseFloat(composerStyle.paddingRight),
      )
      syncMeasurementMetrics(input, measurement)
      measurement.style.width = `${expanded ? expandedWidth : compactWidth}px`
      const resolvedSingleRowHeight = measuredHeight(measurement, 'M')
      const resolvedRowHeight = Math.max(
        1,
        measuredHeight(measurement, 'M\nM') - resolvedSingleRowHeight,
      )
      const contentHeight = expanded
        ? measuredHeight(measurement, draftRef.current)
        : Math.max(resolvedSingleRowHeight, sendHeight)
      const maxHeight = resolvedSingleRowHeight + resolvedRowHeight * (MAX_COMPOSER_ROWS - 1)
      const nextHeight = Math.min(Math.max(resolvedSingleRowHeight, contentHeight), maxHeight)
      const height = `${Math.ceil(nextHeight)}px`
      const overflowY = contentHeight > maxHeight + 1 ? 'auto' : 'hidden'
      if (input.style.height !== height) input.style.height = height
      if (input.style.overflowY !== overflowY) input.style.overflowY = overflowY
      if (overflowY === 'hidden' && input.scrollTop !== 0) {
        input.scrollTop = 0
        input.dispatchEvent(new view.Event('scroll'))
      }
    }
    const queueLayoutMeasurement = (): void => {
      if (view === null) return
      if (layoutFrame !== undefined) view.cancelAnimationFrame(layoutFrame)
      layoutFrame = view.requestAnimationFrame(() => {
        layoutFrame = undefined
        measureLayout()
      })
    }
    const requestLayoutMeasurement = (): void => queueLayoutMeasurement()
    input.addEventListener('cordisx-shikitor-measure-layout', requestLayoutMeasurement)
    const insertResidentLineBreak = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !event.shiftKey || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end')
      const InputEvent = view?.InputEvent
      if (InputEvent !== undefined) {
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: null,
          inputType: 'insertLineBreak',
        }))
      } else {
        const inputEvent = input.ownerDocument.createEvent('Event')
        inputEvent.initEvent('input', true, false)
        input.dispatchEvent(inputEvent)
      }
      const selectionEvent = input.ownerDocument.createEvent('Event')
      selectionEvent.initEvent('selectionchange', false, false)
      input.ownerDocument.dispatchEvent(selectionEvent)
      queueLayoutMeasurement()
    }
    input.addEventListener('keydown', insertResidentLineBreak, true)
    measureLayout()

    const LayoutResizeObserver = view?.ResizeObserver
    if (LayoutResizeObserver !== undefined && composer !== null) {
      layoutObserver = new LayoutResizeObserver(() => {
        if (mounted !== undefined) syncProjectionMetrics(input, mounted)
        queueLayoutMeasurement()
      })
      layoutObserver.observe(composer)
      layoutObserver.observe(input)
      const send = composer.querySelector<HTMLElement>('.cxa-send')
      if (send !== null) layoutObserver.observe(send)
      const attachment = composer.querySelector<HTMLElement>('.cxa-attachment-placeholder')
      if (attachment !== null) layoutObserver.observe(attachment)
    }

    const updateTheme = (): void => {
      if (mounted === undefined) return
      syncProjectionMetrics(input, mounted)
      syncNativeTextRendering(input, mounted)
      queueLayoutMeasurement()
      void mounted.updateOptions(current => ({
        ...current,
        theme: resolveTheme(input),
      })).catch(error => {
        if (active) console.warn('[cordisx] failed to update Shikitor composer theme', error)
      })
    }
    const Observer = input.ownerDocument.defaultView?.MutationObserver
    if (Observer !== undefined) {
      observer = new Observer(updateTheme)
      observer.observe(input.ownerDocument.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-cordisx-app-theme', 'data-theme'],
      })
    }

    void create(input, {
      ...editorOptions(
        input,
        optionsRef.current.placeholder,
        optionsRef.current.unavailable,
      ),
      onChange: value => {
        queueMicrotask(() => {
          if (active && draftRef.current !== value) onDraftChangeRef.current(value)
        })
      },
    }, { abort: abort.signal }).then(editor => {
      if (!active) {
        editor[Symbol.dispose]()
        return
      }
      delete input.dataset.cordisxShikitorFallback
      mounted = editor
      editorRef.current = editor
      syncProjectionMetrics(input, editor)
      syncNativeTextRendering(input, editor)
      const RenderModeObserver = input.ownerDocument.defaultView?.MutationObserver
      if (RenderModeObserver !== undefined) {
        renderModeObserver = new RenderModeObserver(() => syncNativeTextRendering(input, editor))
        renderModeObserver.observe(editor.element, { attributes: true, attributeFilter: ['data-shikitor-render-mode'] })
      }
      queueLayoutMeasurement()
      if (editor.value !== draftRef.current) editor.value = draftRef.current
      void editor.updateOptions(current => ({
        ...current,
        placeholder: optionsRef.current.placeholder,
        readOnly: optionsRef.current.unavailable,
        theme: resolveTheme(input),
      })).catch(error => {
        if (active) console.warn('[cordisx] failed to update Shikitor composer', error)
      })
    }).catch(error => {
      if (!abort.signal.aborted) {
        input.dataset.cordisxShikitorFallback = 'true'
        console.warn('[cordisx] Shikitor composer unavailable; using native textarea', error)
      }
    })

    return () => {
      active = false
      observer?.disconnect()
      renderModeObserver?.disconnect()
      layoutObserver?.disconnect()
      if (layoutFrame !== undefined) view?.cancelAnimationFrame(layoutFrame)
      abort.abort()
      mounted?.[Symbol.dispose]()
      if (editorRef.current === mounted) editorRef.current = undefined
      input.removeEventListener('cordisx-shikitor-measure-layout', requestLayoutMeasurement)
      input.removeEventListener('keydown', insertResidentLineBreak, true)
      measurement?.remove()
      input.style.height = previousHeight
      input.style.overflowY = previousOverflowY
      input.style.paddingTop = previousPaddingTop
      input.style.paddingBottom = previousPaddingBottom
      if (previousNativeText === undefined) delete input.dataset.cordisxShikitorNativeText
      else input.dataset.cordisxShikitorNativeText = previousNativeText
      if (composer !== null) {
        if (previousLayout === undefined) delete composer.dataset.cordisxShikitorLayout
        else composer.dataset.cordisxShikitorLayout = previousLayout
      }
      delete input.dataset.cordisxShikitorFallback
      releaseStyles()
    }
  }, [instanceKey])

  React.useEffect(() => {
    const input = inputRef.current
    const Event = input?.ownerDocument.defaultView?.Event
    if (input !== null && input !== undefined && Event !== undefined) {
      input.dispatchEvent(new Event('cordisx-shikitor-measure-layout'))
    }
    const editor = editorRef.current
    if (editor === undefined) return
    if (editor.value !== draft) editor.value = draft
  }, [draft])

  React.useEffect(() => {
    const editor = editorRef.current
    if (editor === undefined) return
    void editor.updateOptions(current => ({
      ...current,
      placeholder,
      readOnly: unavailable,
    })).catch(error => {
      console.warn('[cordisx] failed to update Shikitor composer state', error)
    })
  }, [placeholder, unavailable])

  return inputRef
}
