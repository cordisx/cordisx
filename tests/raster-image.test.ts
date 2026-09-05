import { describe, expect, it } from 'vitest'
import type { RasterImageSnapshotV1 } from '../packages/cli/src/contracts.js'
import { cloneRasterImageSnapshot, rasterImageDataUrl } from '../packages/cli/src/renderer/raster-image.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const image = (overrides: Partial<RasterImageSnapshotV1> = {}): RasterImageSnapshotV1 => ({
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
})

describe('bounded raster images', () => {
  it('detaches and freezes one validated RGBA PNG snapshot', () => {
    const input = image()
    const accepted = cloneRasterImageSnapshot(input)
    expect(accepted).toEqual(input)
    expect(accepted).not.toBe(input)
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(rasterImageDataUrl(accepted)).toBe(`data:image/png;base64,${PNG}`)
  })

  it.each([
    ['URL-shaped payload', image({ data: 'https://example.test/image.png' })],
    ['SVG payload', image({ data: 'PHN2Zy8+' })],
    ['declared dimension mismatch', image({ width: 2 })],
    ['oversized dimension', image({ width: 257 })],
    ['non-canonical base64', image({ data: `${PNG}\n` })],
    ['invalid CRC', image({ data: `${PNG.slice(0, 50)}A${PNG.slice(51)}` })],
    ['unknown field', { ...image(), url: 'https://example.test/image.png' } as RasterImageSnapshotV1],
  ])('rejects %s', (_label, candidate) => {
    expect(() => cloneRasterImageSnapshot(candidate)).toThrow()
  })
})
