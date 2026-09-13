/** Host chrome uses adapter-projected geometry; consumers only read the public title inset. */
export function createPageHeaderChrome(content: HTMLElement): {
  readonly chrome: HTMLElement
  readonly leading: HTMLElement
  readonly title: HTMLElement
} {
  content.style.setProperty(
    '--cordisx-page-title-inset',
    'calc(max(var(--cordisx-page-chrome-leading-inset, 8px), var(--cordisx-page-chrome-safe-left, 0px)) + var(--cordisx-page-chrome-leading-size, 28px) + var(--cordisx-page-chrome-title-gap, 6px))',
  )
  const chrome = content.ownerDocument.createElement('header')
  chrome.dataset.cordisxPageChrome = 'true'
  chrome.dataset.cordisxDrag = 'true'
  Object.assign(chrome.style, {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--cordisx-page-chrome-title-gap, 6px)',
    minHeight: 'var(--cordisx-page-chrome-height, 46px)',
    padding: '0 12px',
    boxShadow: 'inset 0 -1px var(--color-border, var(--cx-border, rgba(255,255,255,.084)))',
    background: 'var(--color-background-surface, var(--cx-surface, #181818))',
    flex: '0 0 auto',
  })
  chrome.style.paddingLeft =
    'max(var(--cordisx-page-chrome-leading-inset, 8px), var(--cordisx-page-chrome-safe-left, 0px))'
  chrome.style.setProperty('-webkit-app-region', 'drag')
  const leading = content.ownerDocument.createElement('div')
  leading.dataset.cordisxPageLeading = 'true'
  leading.style.cssText =
    'display:flex;width:var(--cordisx-page-chrome-leading-size,28px);height:var(--cordisx-page-chrome-leading-size,28px);flex:0 0 var(--cordisx-page-chrome-leading-size,28px);align-items:center;justify-content:center'
  const titleGroup = content.ownerDocument.createElement('div')
  titleGroup.dataset.cordisxPageTitle = 'true'
  titleGroup.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;flex:1'
  const title = content.ownerDocument.createElement('strong')
  title.style.cssText =
    'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--cordisx-page-chrome-title-font-family,-apple-system,system-ui,Segoe UI,sans-serif);font-size:var(--cordisx-page-chrome-title-font-size,14px);font-weight:var(--cordisx-page-chrome-title-font-weight,500);line-height:var(--cordisx-page-chrome-title-line-height,24px)'
  titleGroup.append(title)
  chrome.append(leading, titleGroup)
  return { chrome, leading, title }
}
