import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { modelBrandAssetUrl } from '../packages/cli/src/renderer/host-ui/ModelBrandIcon.js'

describe('modelBrandAssetUrl', () => {
  it('encodes trusted SVG text with optional BOM, whitespace, and XML declaration', () => {
    const source = '\uFEFF \n<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 1 1"></svg>'
    const encoded = modelBrandAssetUrl(source)
    expect(decodeURIComponent(encoded.slice(encoded.indexOf(',') + 1))).toBe('<svg viewBox="0 0 1 1"></svg>')
  })

  it.each(['zai-light.svg', 'zai-dark.svg'])('encodes the real %s asset as valid SVG markup', async file => {
    const source = await readFile(new URL(`../packages/cli/assets/model-brands/${file}`, import.meta.url), 'utf8')
    const encoded = modelBrandAssetUrl(source)
    const markup = decodeURIComponent(encoded.slice(encoded.indexOf(',') + 1))
    expect(encoded).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u)
    expect(markup).toMatch(/^<svg[\s>]/u)
    expect(markup).toMatch(/<\/svg>\s*$/u)
  })

  it.each([
    'https://example.test/icon.svg',
    'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E',
  ])('leaves an existing asset URL unchanged: %s', source => {
    expect(modelBrandAssetUrl(source)).toBe(source)
  })
})
