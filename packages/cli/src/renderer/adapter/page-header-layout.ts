/** Codex-version-specific layout probes stay in the adapter, never in plugin CSS. */
export function projectNativePageHeaderLayout(document: Document, anchor: HTMLElement, layer: HTMLElement): void {
  const view = document.defaultView
  if (view === null) return
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('[data-testid="app-shell-header-context-menu-surface"]'),
  ]
    .filter(element => element.getBoundingClientRect().width > 0 && !element.closest('[data-cordisx-page-outlet]'))
  const pageHeaders = candidates.filter(element => !element.hasAttribute('data-app-shell-main-titlebar'))
  const header = pageHeaders.length === 1 ? pageHeaders[0] : candidates.length === 1 ? candidates[0] : undefined
  if (header === undefined) return
  const box = header.getBoundingClientRect()
  const style = view.getComputedStyle(header)
  // The native title group persists while a plugin route has no selected thread.
  const titleGroup = header.querySelector<HTMLElement>('.text-base')
  const title = header.querySelector<HTMLElement>('button.text-start.text-base')
  const titleStyle = view.getComputedStyle(title ?? titleGroup ?? header)
  const toolbarButton = [...header.querySelectorAll<HTMLButtonElement>('button')]
    .find(button =>
      button.getBoundingClientRect().width === button.getBoundingClientRect().height
      && button.getBoundingClientRect().height > 0
    )
    ?? document.querySelector<HTMLButtonElement>(
      'header[data-app-shell-application-menu-bar] [data-app-shell-sidebar-trigger]',
    )
  const actionStyle = view.getComputedStyle(toolbarButton ?? header)
  const target = toolbarButton?.getBoundingClientRect().height || 28
  const icon = toolbarButton?.querySelector('svg')
  const iconSize = icon?.getBoundingClientRect().width || 16
  const gap = Number.parseFloat(style.columnGap) || 6
  const left = box.left - anchor.getBoundingClientRect().left + (Number.parseFloat(style.paddingLeft) || 0)
  // Native title control text starts after the 28px leading seat and its 6px inner inset.
  const titleInset = title ? Number.parseFloat(view.getComputedStyle(title).paddingLeft) || gap : gap
  const values: Record<string, string> = {
    '--cordisx-page-chrome-leading-inset': `${Math.max(0, left)}px`,
    '--cordisx-page-chrome-leading-size': `${target}px`,
    '--cordisx-page-chrome-action-size': `${target}px`,
    '--cordisx-page-chrome-action-font-size': actionStyle.fontSize,
    '--cordisx-page-chrome-action-font-weight': actionStyle.fontWeight,
    '--cordisx-page-chrome-action-line-height': actionStyle.lineHeight,
    '--cordisx-page-chrome-icon-size': `${iconSize}px`,
    '--cordisx-page-chrome-title-gap': `${titleInset}px`,
    '--cordisx-page-chrome-height': `${box.height}px`,
    '--cordisx-page-chrome-title-font-family': titleStyle.fontFamily,
    '--cordisx-page-chrome-title-font-size': titleGroup ? titleStyle.fontSize : '14px',
    '--cordisx-page-chrome-title-font-weight': titleGroup ? titleStyle.fontWeight : '500',
    '--cordisx-page-chrome-title-line-height': title ? titleStyle.lineHeight : style.lineHeight,
  }
  for (const [name, value] of Object.entries(values)) {
    if (layer.style.getPropertyValue(name) !== value) {
      layer.style.setProperty(name, value)
    }
  }
}
