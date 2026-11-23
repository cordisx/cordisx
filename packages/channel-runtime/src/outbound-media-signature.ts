import type { ChannelOutboundMedia } from './outbound-media.js'

export function validPreparedMediaSignature(format: ChannelOutboundMedia['format'], bytes: Buffer): boolean {
  if (format === 'binary') return true
  if (format === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (format === 'jpeg') return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (format === 'pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
  if (format === 'opus') {
    return bytes.length >= 47 && bytes.toString('ascii', 0, 4) === 'OggS' && bytes[4] === 0
      && (bytes[5]! & 2) !== 0 && bytes[26] === 1 && bytes[27]! >= 19
      && bytes.toString('ascii', 28, 36) === 'OpusHead'
  }
  if (bytes.length < 20 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false
  const boxSize = bytes.readUInt32BE(0)
  if (boxSize < 20 || boxSize > bytes.length || boxSize % 4 !== 0) return false
  const brands = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '])
  if (brands.has(bytes.toString('ascii', 8, 12))) return true
  for (let offset = 16; offset < boxSize; offset += 4) {
    if (brands.has(bytes.toString('ascii', offset, offset + 4))) return true
  }
  return false
}
