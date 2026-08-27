import type { CordisXBrowserPlugin } from '../contracts.js'

function localeKey(value: string): string {
  return value.trim().replaceAll('_', '-').toLocaleLowerCase()
}

function localeCandidates(locale: string): readonly string[] {
  const candidates: string[] = []
  const append = (value: string | undefined) => {
    if (value === undefined) return
    const normalized = localeKey(value)
    if (normalized !== '' && !candidates.includes(normalized)) candidates.push(normalized)
  }
  append(locale)
  try {
    const parsed = new Intl.Locale(locale)
    const maximized = parsed.maximize()
    append(`${parsed.language}-${maximized.script}`)
    append(`${parsed.language}-${parsed.region ?? maximized.region}`)
    append(parsed.language)
  } catch {
    append(locale.split('-')[0])
  }
  return candidates
}

/** Select the most specific README for the current Host locale, then fall back to README.md. */
export function selectPluginReadme(
  plugin: Pick<CordisXBrowserPlugin, 'readme' | 'readmes'>,
  locale: string,
): string | undefined {
  if (plugin.readmes !== undefined) {
    const normalized = new Map(Object.entries(plugin.readmes).map(([key, value]) => [localeKey(key), value]))
    for (const candidate of localeCandidates(locale)) {
      const readme = normalized.get(candidate)
      if (readme !== undefined) return readme
    }
    const fallback = normalized.get('default')
    if (fallback !== undefined) return fallback
  }
  return plugin.readme
}
