import { useSyncExternalStore } from 'react'
import { HostThemeProjection, resolveHostTheme, type HostAppTheme } from '../../renderer/host-theme.js'
import { DocumentLocaleAdapter } from '../../renderer/i18n.js'

export type PlaygroundThemePreference = 'system' | 'light' | 'dark'
export type PlaygroundLocale = 'zh-CN' | 'en'

export interface PlaygroundEnvironmentSnapshot {
  readonly themePreference: PlaygroundThemePreference
  readonly theme: HostAppTheme
  readonly locale: PlaygroundLocale
}

const THEME_KEY = 'cordisx.playground.theme'
const LOCALE_KEY = 'cordisx.playground.locale'

class PlaygroundEnvironmentService {
  private readonly listeners = new Set<() => void>()
  private readonly locale = new DocumentLocaleAdapter(document)
  private readonly theme = new HostThemeProjection(document)
  private readonly media = window.matchMedia?.('(prefers-color-scheme: dark)')
  private snapshot: PlaygroundEnvironmentSnapshot

  constructor() {
    const storedTheme = localStorage.getItem(THEME_KEY)
    const storedLocale = localStorage.getItem(LOCALE_KEY)
    const preference: PlaygroundThemePreference = storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system' ? storedTheme : 'system'
    const locale: PlaygroundLocale = storedLocale === 'en' ? 'en' : 'zh-CN'
    document.documentElement.dataset.pgThemePreference = preference
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
    this.applyTheme(preference)
    this.snapshot = this.read()
    this.locale.subscribe(this.publish)
    this.media?.addEventListener('change', this.onSystemTheme)
  }

  getSnapshot = (): PlaygroundEnvironmentSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  attachTheme(root: HTMLElement): () => void { return this.theme.attach(root) }

  setTheme(preference: PlaygroundThemePreference): void {
    localStorage.setItem(THEME_KEY, preference)
    document.documentElement.dataset.pgThemePreference = preference
    this.applyTheme(preference)
    this.publish()
  }

  setLocale(locale: PlaygroundLocale): void {
    localStorage.setItem(LOCALE_KEY, locale)
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
    this.publish()
  }

  resetPreferences(): void {
    localStorage.removeItem(THEME_KEY)
    localStorage.removeItem(LOCALE_KEY)
  }

  private applyTheme(preference: PlaygroundThemePreference): void {
    document.documentElement.dataset.theme = preference === 'system'
      ? (this.media?.matches === true ? 'dark' : 'light')
      : preference
  }

  private readonly onSystemTheme = (): void => {
    if (document.documentElement.dataset.pgThemePreference === 'system') {
      this.applyTheme('system')
      this.publish()
    }
  }

  private read(): PlaygroundEnvironmentSnapshot {
    const rawPreference = document.documentElement.dataset.pgThemePreference
    const themePreference: PlaygroundThemePreference = rawPreference === 'light' || rawPreference === 'dark' ? rawPreference : 'system'
    return Object.freeze({
      themePreference,
      theme: resolveHostTheme(document).theme,
      locale: this.locale.getSnapshot().locale === 'en' ? 'en' : 'zh-CN',
    })
  }

  private readonly publish = (): void => {
    const next = this.read()
    if (next.themePreference === this.snapshot.themePreference && next.theme === this.snapshot.theme && next.locale === this.snapshot.locale) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

export const playgroundEnvironment = new PlaygroundEnvironmentService()

export function usePlaygroundEnvironment(): PlaygroundEnvironmentSnapshot {
  return useSyncExternalStore(playgroundEnvironment.subscribe, playgroundEnvironment.getSnapshot)
}
