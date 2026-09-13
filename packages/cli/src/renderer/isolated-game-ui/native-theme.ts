import { resolveHostTheme } from '../host-theme.js'
export function gameUiTheme(document: Document) {
  return {
    read: () => resolveHostTheme(document).theme,
    subscribe(update: () => void) {
      const observer = new MutationObserver(update)
      const options = {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
      }
      observer.observe(document.documentElement, options)
      if (document.body) observer.observe(document.body, options)
      const media = document.defaultView?.matchMedia('(prefers-color-scheme: dark)')
      media?.addEventListener('change', update)
      return () => {
        observer.disconnect()
        media?.removeEventListener('change', update)
      }
    },
  }
}
