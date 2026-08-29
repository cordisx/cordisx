export type HostAppTheme = 'light' | 'dark'

export type HostThemeSource = 'renderer-attribute' | 'renderer-color-scheme' | 'system-fallback'

export interface HostThemeSnapshot {
  readonly theme: HostAppTheme
  readonly source: HostThemeSource
}

const TOKEN_NAMES = [
  'surface', 'surface-raised', 'backdrop', 'text', 'muted', 'border', 'primary',
  'primary-text', 'danger', 'hover', 'pressed', 'focus', 'disabled', 'shadow',
] as const

const TOKENS: Readonly<Record<HostAppTheme, Readonly<Record<typeof TOKEN_NAMES[number], string>>>> = {
  dark: {
    surface: '#17191d', 'surface-raised': '#20242b', backdrop: 'rgb(5 7 12 / 66%)', text: '#eef0f3', muted: '#aeb5c3',
    border: 'rgb(255 255 255 / 12%)', primary: '#c7ccd4', 'primary-text': '#17191c', danger: '#ff9da5',
    hover: 'rgb(199 204 212 / 14%)', pressed: 'rgb(199 204 212 / 20%)', focus: '#c7ccd4', disabled: '0.42', shadow: 'rgb(0 0 0 / 55%)',
  },
  light: {
    surface: '#f8fafc', 'surface-raised': '#ffffff', backdrop: 'rgb(15 23 42 / 42%)', text: '#18212f', muted: '#526071',
    border: 'rgb(24 33 47 / 18%)', primary: '#3d4755', 'primary-text': '#ffffff', danger: '#bb3345',
    hover: 'rgb(61 71 85 / 10%)', pressed: 'rgb(61 71 85 / 16%)', focus: '#245fba', disabled: '0.48', shadow: 'rgb(15 23 42 / 24%)',
  },
}

function explicitTheme(element: Element | null): HostAppTheme | undefined {
  if (element === null) return undefined
  for (const name of ['data-theme', 'data-color-theme', 'data-color-scheme']) {
    const value = element.getAttribute(name)?.toLowerCase()
    if (value === 'dark' || value === 'light') return value
  }
  const classes = [...element.classList]
  if (classes.some(value => /(?:^|[-_])dark(?:$|[-_])/iu.test(value) || value === 'electron-dark')) return 'dark'
  if (classes.some(value => /(?:^|[-_])light(?:$|[-_])/iu.test(value) || value === 'electron-light')) return 'light'
  return undefined
}

function rendererTheme(document: Document): HostThemeSnapshot | undefined {
  const explicit = explicitTheme(document.documentElement) ?? explicitTheme(document.body)
  if (explicit !== undefined) return { theme: explicit, source: 'renderer-attribute' }
  const view = document.defaultView
  const scheme = view === null ? '' : view.getComputedStyle(document.documentElement).colorScheme.toLowerCase()
  if (scheme === 'dark' || scheme === 'light') return { theme: scheme, source: 'renderer-color-scheme' }
  return undefined
}

export function resolveHostTheme(document: Document): HostThemeSnapshot {
  const renderer = rendererTheme(document)
  if (renderer !== undefined) return renderer
  const dark = document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  return { theme: dark ? 'dark' : 'light', source: 'system-fallback' }
}

/**
 * The only theme seam for Host-owned portals. It projects the renderer's actual
 * application theme onto host roots; the OS media query is deliberately a last
 * resort when the renderer exposes no theme state.
 */
export class HostThemeProjection {
  private readonly roots = new Set<HTMLElement>()
  private observer: MutationObserver | undefined
  private media: MediaQueryList | undefined
  private snapshot: HostThemeSnapshot

  constructor(private readonly document: Document) {
    this.snapshot = this.read()
  }

  attach(root: HTMLElement): () => void {
    this.roots.add(root)
    // A projection may be created before any portal exists. Re-read the Host
    // when the first late-mounted page/dialog attaches instead of applying the
    // theme captured during runtime bootstrap.
    this.snapshot = this.read()
    this.apply(root)
    this.observe()
    return () => {
      this.roots.delete(root)
      root.removeAttribute('data-cordisx-app-theme')
      root.removeAttribute('data-cordisx-theme-source')
      for (const name of TOKEN_NAMES) root.style.removeProperty(`--cx-${name}`)
      if (this.roots.size === 0) this.stop()
    }
  }

  dispose(): void {
    for (const root of this.roots) {
      root.removeAttribute('data-cordisx-app-theme')
      root.removeAttribute('data-cordisx-theme-source')
      for (const name of TOKEN_NAMES) root.style.removeProperty(`--cx-${name}`)
    }
    this.roots.clear()
    this.stop()
  }

  current(): HostThemeSnapshot {
    return this.snapshot
  }

  private read(): HostThemeSnapshot {
    return resolveHostTheme(this.document)
  }

  private readonly reproject = (): void => {
    this.snapshot = this.read()
    for (const root of this.roots) this.apply(root)
  }

  private apply(root: HTMLElement): void {
    const { theme, source } = this.snapshot
    root.dataset.cordisxAppTheme = theme
    root.dataset.cordisxThemeSource = source
    for (const name of TOKEN_NAMES) root.style.setProperty(`--cx-${name}`, TOKENS[theme][name])
  }

  private observe(): void {
    if (this.observer === undefined) {
      const Observer = this.document.defaultView?.MutationObserver
      if (Observer !== undefined && this.document.documentElement !== null) {
        this.observer = new Observer(this.reproject)
        this.observer.observe(this.document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
        })
        if (this.document.body !== null) this.observer.observe(this.document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
        })
      }
    }
    if (this.media === undefined) {
      this.media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
      this.media?.addEventListener('change', this.reproject)
    }
  }

  private stop(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.media?.removeEventListener('change', this.reproject)
    this.media = undefined
  }
}
