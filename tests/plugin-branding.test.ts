import { describe, expect, it } from 'vitest'
import { pluginBrandIconDataUrl } from '../packages/cli/src/renderer/plugin-branding.js'

describe('local plugin brand icon projection', () => {
  it('turns supported inline artwork into a Host-renderable data URL', () => {
    const data = 'a'.repeat(32)
    expect(pluginBrandIconDataUrl({ mediaType: 'image/png', data }))
      .toBe(`data:image/png;base64,${data}`)
  })

  it('falls back instead of accepting arbitrary URLs, SVG, or malformed metadata', () => {
    expect(pluginBrandIconDataUrl('https://example.com/icon.png')).toBeUndefined()
    expect(pluginBrandIconDataUrl({ mediaType: 'image/svg+xml', data: 'a'.repeat(32) })).toBeUndefined()
    expect(pluginBrandIconDataUrl({ mediaType: 'image/png', data: 'not base64', href: 'https://example.com' }))
      .toBeUndefined()
  })
})
