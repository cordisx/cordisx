import { describe, expect, it } from 'vitest'
import { selectPluginReadme } from '../packages/cli/src/renderer/readme.js'

describe('localized plugin README selection', () => {
  const plugin = {
    readme: 'Default README',
    readmes: {
      default: 'Default README',
      'zh-hans': '简体中文 README',
      'zh-hant': '繁體中文 README',
      fr: 'README français',
    },
  }

  it('maps regional Chinese Host locales to the matching script README', () => {
    expect(selectPluginReadme(plugin, 'zh-CN')).toBe('简体中文 README')
    expect(selectPluginReadme(plugin, 'zh-TW')).toBe('繁體中文 README')
  })

  it('prefers an exact locale, then language, then README.md', () => {
    expect(selectPluginReadme({ ...plugin, readmes: { ...plugin.readmes, 'fr-ca': 'README canadien' } }, 'fr-CA')).toBe('README canadien')
    expect(selectPluginReadme(plugin, 'fr-BE')).toBe('README français')
    expect(selectPluginReadme(plugin, 'de-DE')).toBe('Default README')
  })
})
