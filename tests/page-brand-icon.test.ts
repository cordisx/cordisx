import type { BrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PAGE_SCHEMA_V4,
  type CordisXPageMetadata,
  type CordisXPageMetadataV4,
} from '../packages/cli/src/contracts.js'
import { createHostBrandIcon } from '../packages/cli/src/renderer/brand-icon.js'
import { PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { JSDOM } from 'jsdom'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

function raster(overrides: Record<string, unknown> = {}): BrandIconV1 {
  return {
    kind: 'raster-image',
    image: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
      contract: 'cordisx.raster-image-snapshot/v1',
      schemaVersion: 1,
      mediaType: 'image/png',
      encoding: 'base64',
      data: PNG,
      width: 1,
      height: 1,
      ...overrides,
    },
  } as BrandIconV1
}

function page(icon: unknown): CordisXPageMetadataV4 {
  return {
    $schema: CORDISX_PAGE_SCHEMA_V4,
    schemaVersion: 4,
    id: 'brand',
    title: { key: 'brand.title', fallback: 'Brand' },
    description: { key: 'brand.description', fallback: 'Brand page' },
    icon,
  } as CordisXPageMetadataV4
}

describe('Host page brand icons', () => {
  it('validates, detaches, freezes, and renders structured PNG artwork', () => {
    const input = raster()
    const pages = new PageRegistry()
    pages.register('demo', page(input), () => undefined)
    const accepted = pages.snapshot()[0]!.metadata.icon

    expect(accepted).toEqual(input)
    expect(accepted).not.toBe(input)
    expect(typeof accepted === 'object' && Object.isFrozen(accepted)).toBe(true)
    expect(typeof accepted === 'object' && Object.isFrozen(accepted.image)).toBe(true)

    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const rendered = createHostBrandIcon(dom.window.document, accepted!)
    expect(rendered.dataset.brandIconKind).toBe('raster-image')
    expect(rendered.querySelector('svg')).toBeNull()
    expect(rendered.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(rendered.querySelector('img')?.getAttribute('alt')).toBe('')
    expect(rendered.querySelector('img')?.getAttribute('aria-hidden')).toBe('true')
    dom.window.close()
  })

  it('keeps semantic host icons on the existing renderer and rejects unknown tokens', () => {
    const pages = new PageRegistry()
    pages.register('demo', page('host:info'), () => undefined)
    expect(pages.snapshot()[0]!.metadata.icon).toBe('host:info')

    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const rendered = createHostBrandIcon(dom.window.document, 'host:info')
    expect(rendered.dataset.hostIcon).toBe('host:info')
    expect(rendered.querySelector('svg')).not.toBeNull()
    expect(() => new PageRegistry().register('demo', page('host:not-public'), () => undefined)).toThrow(
      /unknown host icon token/,
    )
    dom.window.close()
  })

  it.each([
    ['URL string', 'https://example.test/icon.png'],
    ['data URL string', `data:image/png;base64,${PNG}`],
    ['bare Base64 string', PNG],
    ['SVG bytes', raster({ data: 'PHN2Zy8+' })],
    ['oversized dimensions', raster({ width: 257 })],
    ['malformed Base64', raster({ data: 'not base64' })],
    ['unknown raster field', { ...raster(), url: 'https://example.test/icon.png' }],
  ])('rejects %s', (_label, icon) => {
    expect(() => new PageRegistry().register('demo', page(icon), () => undefined)).toThrow()
  })

  it('keeps structured artwork unavailable to pre-v4 page contracts', () => {
    const legacy = {
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'legacy',
      title: { key: 'legacy.title' },
      description: { key: 'legacy.description' },
      icon: raster(),
    } as unknown as CordisXPageMetadata
    expect(() => new PageRegistry().register('demo', legacy, () => undefined)).toThrow(/unknown host icon token/)
  })
})
