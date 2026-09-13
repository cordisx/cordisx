import { HostThemeProjection } from './host-theme.js'

/** Appearance belongs to the complete Host page, including chrome outside the React body. */
export function projectPageSurfaceTheme(content: HTMLElement): () => void {
  Object.assign(content.style, {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--color-background-surface-under, var(--cx-surface, #141414))',
    color: 'var(--color-text, var(--cx-text, #dfdfdf))',
    font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
    pointerEvents: 'auto',
  })
  return new HostThemeProjection(content.ownerDocument).attach(content)
}
