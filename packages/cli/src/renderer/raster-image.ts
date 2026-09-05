import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'

const SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json' as const
const CONTRACT = 'cordisx.raster-image-snapshot/v1' as const
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const MAX_BASE64_LENGTH = 349_528
const MAX_DECODED_BYTES = 262_144
const MAX_DIMENSION = 256
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

function assertKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`)
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length < 4 || value.length > MAX_BASE64_LENGTH || !BASE64.test(value)) {
    throw new Error('raster image data is not bounded canonical base64')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('raster image data is not valid base64')
  }
  if (binary.length > MAX_DECODED_BYTES || btoa(binary) !== value) {
    throw new Error('raster image data is not bounded canonical base64')
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset]! * 0x100 + bytes[offset + 1]!) * 0x100 + bytes[offset + 2]!) * 0x100 + bytes[offset + 3]!) >>> 0
}

let crcTable: Uint32Array | undefined
function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let current = value
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    return current >>> 0
  })
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

function assertPng(bytes: Uint8Array, width: number, height: number): void {
  if (bytes.length < 57 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('raster image data is not a PNG')
  }
  let offset: number = PNG_SIGNATURE.length
  let chunkIndex = 0
  let sawIdat = false
  let sawIend = false
  while (offset < bytes.length) {
    if (sawIend || offset + 12 > bytes.length) throw new Error('raster image PNG has invalid chunk boundaries')
    const length = uint32(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const crcOffset = dataOffset + length
    const end = crcOffset + 4
    if (length > MAX_DECODED_BYTES || end > bytes.length) throw new Error('raster image PNG has invalid chunk boundaries')
    const type = chunkName(bytes, typeOffset)
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error('raster image PNG has an invalid chunk type')
    if (pngCrc(bytes, typeOffset, crcOffset) !== uint32(bytes, crcOffset)) throw new Error(`raster image PNG ${type} CRC is invalid`)
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('raster image PNG must begin with one IHDR')
      if (uint32(bytes, dataOffset) !== width || uint32(bytes, dataOffset + 4) !== height) {
        throw new Error('raster image PNG dimensions do not match the declaration')
      }
      if (bytes[dataOffset + 8] !== 8 || bytes[dataOffset + 9] !== 6) {
        throw new Error('raster image PNG must use 8-bit RGBA pixels')
      }
      if (bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || bytes[dataOffset + 12] !== 0) {
        throw new Error('raster image PNG uses an unsupported compression, filter, or interlace method')
      }
    } else if (type === 'IHDR') {
      throw new Error('raster image PNG has multiple IHDR chunks')
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('animated PNG is not supported')
    if (type === 'IDAT') sawIdat = true
    if ((bytes[typeOffset]! & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      throw new Error(`raster image PNG has unknown critical chunk ${type}`)
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || end !== bytes.length) throw new Error('raster image PNG has an invalid IEND')
      sawIend = true
    }
    offset = end
    chunkIndex += 1
  }
  if (!sawIend) throw new Error('raster image PNG is missing IEND')
}

export function cloneRasterImageSnapshot(input: RasterImageSnapshotV1, label = 'raster image'): RasterImageSnapshotV1 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be an object`)
  assertKeys(input, ['$schema', 'contract', 'schemaVersion', 'mediaType', 'encoding', 'data', 'width', 'height'], label)
  if (input.$schema !== SCHEMA || input.contract !== CONTRACT || input.schemaVersion !== 1
    || input.mediaType !== 'image/png' || input.encoding !== 'base64') throw new Error(`${label} has invalid contract identity`)
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > MAX_DIMENSION
    || !Number.isInteger(input.height) || input.height < 1 || input.height > MAX_DIMENSION
    || input.width * input.height > MAX_DIMENSION * MAX_DIMENSION) throw new Error(`${label} dimensions are invalid`)
  assertPng(decodeCanonicalBase64(input.data), input.width, input.height)
  return Object.freeze({
    $schema: SCHEMA,
    contract: CONTRACT,
    schemaVersion: 1,
    mediaType: 'image/png',
    encoding: 'base64',
    data: input.data,
    width: input.width,
    height: input.height,
  })
}

export function rasterImageDataUrl(image: RasterImageSnapshotV1): string {
  return `data:image/png;base64,${image.data}`
}
