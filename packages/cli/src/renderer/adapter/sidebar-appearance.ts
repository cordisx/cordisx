import { nativeToolbarCornerRadius } from './dom.js'

/** Project geometry only: a hovered/selected template must not become the idle fill. */
export function projectSidebarAppearance(
  root: HTMLElement,
  identity: Readonly<{ hostId: string; mode?: 'codex' | 'playground' }>,
  template: HTMLButtonElement | undefined,
): void {
  const appearance = identity.mode === 'playground'
    ? 'playground'
    : identity.hostId === 'com.openai.codex'
    ? 'codex'
    : 'default'
  if (root.dataset.cordisxSidebarAppearance !== appearance) root.dataset.cordisxSidebarAppearance = appearance
  const style = appearance === 'codex' && template !== undefined
    ? root.ownerDocument.defaultView?.getComputedStyle(template)
    : undefined
  const values: Record<string, string | undefined> = {
    radius: style === undefined || template === undefined ? undefined : nativeToolbarCornerRadius(template),
    'font-family': style?.fontFamily,
    'font-size': style?.fontSize,
    'font-weight': style?.fontWeight,
    'line-height': style?.lineHeight,
    'content-gutter': style?.paddingInlineStart,
    'content-gap': style?.columnGap === 'normal' ? undefined : style?.columnGap,
    'single-height': style === undefined || template === undefined
      ? undefined
      : `${template.getBoundingClientRect().height}px`,
  }
  for (const [name, sampled] of Object.entries(values)) {
    const property = `--cordisx-nav-${name}`
    const value = sampled === '0px' && name === 'single-height' ? '' : sampled ?? ''
    if (root.style.getPropertyValue(property) === value) continue
    if (value === '') root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }
}
