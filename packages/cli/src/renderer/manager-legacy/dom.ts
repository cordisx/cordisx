import { resolveHostTheme } from '.././host-theme.js'
import { CORDISX_MARK_DARK_URI, CORDISX_MARK_LIGHT_URI } from './presentation.js'

export function create<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function markDecorative<T extends HTMLElement>(element: T): T {
  element.setAttribute('aria-hidden', 'true')
  element.draggable = false
  return element
}

export function hostBrandBackground(document: Document): 'dark' | 'light' {
  return resolveHostTheme(document).theme
}

export function syncAdaptiveBrandMark(document: Document, mark: HTMLImageElement): void {
  const background = hostBrandBackground(document)
  const source = background === 'dark' ? CORDISX_MARK_DARK_URI : CORDISX_MARK_LIGHT_URI
  if (mark.src !== source) mark.src = source
  mark.dataset.hostBackground = background
}

export function syncAdaptiveBrandMarks(document: Document): void {
  for (const mark of document.querySelectorAll<HTMLImageElement>('img[data-brand-rendering="direct-host"]')) {
    syncAdaptiveBrandMark(document, mark)
  }
}

export function createAdaptiveBrandMark(document: Document): HTMLImageElement {
  const mark = create(document, 'img', 'cxm-brand-mark')
  mark.dataset.cordisxBrandMark = 'true'
  mark.dataset.brandRendering = 'direct-host'
  mark.alt = ''
  markDecorative(mark)
  syncAdaptiveBrandMark(document, mark)
  return mark
}
