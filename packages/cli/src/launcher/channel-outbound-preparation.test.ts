import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import type { ChannelThreadRef } from '@cordisx/channel-runtime'
import {
  type ChannelOutboundPreparationMetadata,
  type ChannelOutboundPreparationOptions,
  ChannelOutboundPreparationStore,
} from './channel-outbound-preparation.js'

const target: ChannelThreadRef = {
  adapterId: 'adapter',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'conversation',
  kind: 'group',
  threadId: 'thread',
  semantics: 'topic',
}
const stores: ChannelOutboundPreparationStore[] = []
function store(options: ChannelOutboundPreparationOptions = {}) {
  const instance = new ChannelOutboundPreparationStore(options)
  stores.push(instance)
  return instance
}
function metadata(bytes: Buffer, extra: Partial<ChannelOutboundPreparationMetadata> = {}) {
  return {
    type: 'file' as const,
    format: 'binary' as const,
    filename: 'sample.bin',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...extra,
  }
}
afterEach(() => {
  stores.splice(0).forEach(instance => instance.dispose())
})

it.each([
  { type: 'file' as const, format: 'binary' as const },
  { type: 'video' as const, format: 'mp4' as const },
])('requires filename for $type without reserving capacity', extra => {
  const instance = store({ maximumCount: 1 })
  const bytes = Buffer.from('hello')
  const { filename: omitted, ...input } = metadata(bytes, extra)
  expect(omitted).toBe('sample.bin')
  expect(() => instance.begin('scope', target, input, 'operation')).toThrow()
  expect(() => instance.begin('scope', target, metadata(bytes), 'operation')).not.toThrow()
})

it('rejects invalid limits, scope, operation, target and resolver bounds', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity]) {
    expect(() => store({ maximumCount: value })).toThrow('LIMIT_INVALID')
    expect(() => store({ maximumBytes: value })).toThrow('LIMIT_INVALID')
  }
  const instance = store({ maximumCount: 1 })
  const bytes = Buffer.from('hello')
  expect(() => instance.begin('', target, metadata(bytes), 'operation')).toThrow('SCOPE_INVALID')
  expect(() => instance.begin('scope', target, metadata(bytes), '')).toThrow('SCOPE_INVALID')
  expect(() => instance.begin('scope', { ...target, tenantId: '' }, metadata(bytes), 'operation')).toThrow(
    'TARGET_INVALID',
  )
  const upload = instance.begin('scope', target, metadata(bytes), 'operation')
  instance.append('scope', upload, 0, bytes.toString('base64'))
  const media = instance.commit('scope', upload)
  for (const maximum of [0, -1, 0.5, NaN, Infinity]) {
    expect(() => instance.resolve(media.handle, target, maximum)).toThrow('SIZE_DENIED')
  }
})

it.each([
  { type: 'image' as const, format: 'png' as const, filename: 'image.png' },
  { type: 'image' as const, format: 'jpeg' as const, filename: 'image.jpeg' },
  { type: 'audio' as const, format: 'opus' as const, durationMs: 10 },
  { type: 'video' as const, format: 'mp4' as const, filename: 'clip.mp4', durationMs: 20 },
  { type: 'file' as const, format: 'pdf' as const, filename: 'report.pdf' },
  { type: 'file' as const, format: 'binary' as const, filename: 'sample.bin' },
])('prepares $type/$format and seals defensive descriptors and bytes', extra => {
  const instance = store()
  const bytes = Buffer.alloc(65537, 42)
  if (extra.format === 'png') Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  if (extra.format === 'jpeg') Buffer.from([255, 216, 255]).copy(bytes)
  if (extra.format === 'pdf') bytes.write('%PDF-')
  if (extra.format === 'mp4') {
    bytes.writeUInt32BE(20)
    bytes.write('ftyp', 4)
    bytes.write('isom', 8)
  }
  if (extra.format === 'opus') {
    bytes.write('OggS')
    bytes[4] = 0
    bytes[5] = 2
    bytes[26] = 1
    bytes[27] = 19
    bytes.write('OpusHead', 28)
  }
  const upload = instance.begin('scope', target, metadata(bytes, extra), 'operation')
  expect(instance.begin('scope', { ...target }, metadata(bytes, extra), 'operation')).toBe(upload)
  instance.append('scope', upload, 0, bytes.subarray(0, 65536).toString('base64'))
  instance.append('scope', upload, 0, bytes.subarray(0, 65536).toString('base64'))
  instance.append('scope', upload, 65536, bytes.subarray(65536).toString('base64'))
  const media = instance.commit('scope', upload)
  expect(media.handle).toMatch(/^media:/u)
  expect(media).toMatchObject(metadata(bytes, extra))
  expect(instance.commit('scope', upload)).toEqual(media)
  expect(instance.descriptor('scope', media.handle, target)).toEqual(media)
  const resolved = instance.resolve(media.handle, target, bytes.length)
  expect(Buffer.from(resolved)).toEqual(bytes)
  resolved.fill(0)
  Object.assign(media, { size: 1 })
  expect(Buffer.from(instance.resolve(media.handle, target, bytes.length))).toEqual(bytes)
  expect(instance.descriptor('scope', media.handle, target).size).toBe(bytes.length)
  expect(() => instance.append('scope', upload, 0, 'Kg==')).toThrow('SEALED')
  expect(() => instance.resolve(media.handle, target, bytes.length - 1)).toThrow('SIZE_DENIED')
})

it.each(['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind', 'threadId', 'semantics'] as const)(
  'isolates target %s and scope without revoking valid uploads',
  field => {
    const instance = store()
    const bytes = Buffer.from('hello')
    const upload = instance.begin('scope', target, metadata(bytes), 'operation')
    expect(() => instance.append('other', upload, 0, bytes.toString('base64'))).toThrow('SOURCE_DENIED')
    expect(() => instance.commit('other', upload)).toThrow('SOURCE_DENIED')
    instance.append('scope', upload, 0, bytes.toString('base64'))
    const media = instance.commit('scope', upload)
    const other = { ...target, [field]: field === 'kind' ? 'direct' : field === 'semantics' ? 'conversation' : 'other' }
    expect(() => instance.resolve(media.handle, other, 100)).toThrow('SOURCE_DENIED')
    expect(() => instance.descriptor('scope', media.handle, other)).toThrow('SOURCE_DENIED')
    expect(() => instance.descriptor('other', media.handle, target)).toThrow('SOURCE_DENIED')
    expect(() => store().resolve(media.handle, target, 100)).toThrow('SOURCE_DENIED')
    expect(instance.resolve(media.handle, target, 100)).toEqual(Uint8Array.from(bytes))
  },
)

it.each([
  [0, ''],
  [0, 'Zg'],
  [0, 'Zh=='],
  [0, 'Zg==\n'],
  [0, '-g=='],
  [0, '!!!!'],
  [-1, 'Zg=='],
  [0.5, 'Zg=='],
  [NaN, 'Zg=='],
  [1, 'Zg=='],
  [5, 'Zg=='],
  [0, Buffer.alloc(65537).toString('base64')],
  [0, Buffer.alloc(6).toString('base64')],
])('aborts invalid chunk at %s and releases capacity', (offset, encoded) => {
  const instance = store({ maximumCount: 1, maximumBytes: 5 })
  const bytes = Buffer.from('hello')
  const upload = instance.begin('scope', target, metadata(bytes), 'operation')
  expect(() => instance.append('scope', upload, offset as number, encoded as string)).toThrow()
  expect(() => instance.append('scope', upload, 0, bytes.toString('base64'))).toThrow('SOURCE_DENIED')
  expect(() => instance.commit('scope', upload)).toThrow('SOURCE_DENIED')
  expect(instance.begin('scope', target, metadata(bytes), 'operation')).not.toBe(upload)
})

it('aborts mismatched duplicates, incomplete commits and final digest mismatches', () => {
  for (const failure of ['duplicate', 'length', 'digest']) {
    const instance = store({ maximumCount: 1 })
    const bytes = Buffer.from('hello')
    const upload = instance.begin('scope', target, metadata(bytes), 'operation')
    instance.append(
      'scope',
      upload,
      0,
      (failure === 'digest' ? Buffer.from('world') : bytes.subarray(0, 2)).toString('base64'),
    )
    if (failure === 'duplicate') {
      expect(() => instance.append('scope', upload, 0, Buffer.from('xx').toString('base64'))).toThrow('CONFLICT')
    } else expect(() => instance.commit('scope', upload)).toThrow('INTEGRITY_INVALID')
    expect(() => instance.commit('scope', upload)).toThrow('SOURCE_DENIED')
    expect(() => instance.begin('scope', target, metadata(bytes), 'new')).not.toThrow()
  }
})

it('reserves count and total bytes before upload and rejects starts without capacity side effects', () => {
  const instance = store({ maximumCount: 2, maximumBytes: 10 })
  const bytes = Buffer.from('hello')
  expect(() => instance.begin('scope', target, metadata(bytes, { filename: '../bad' }), 'bad')).toThrow()
  const first = instance.begin('scope', target, metadata(bytes), 'first')
  expect(() => instance.begin('scope', target, metadata(Buffer.alloc(6)), 'oversize')).toThrow('CAPACITY')
  expect(() => instance.begin('scope', target, metadata(bytes, { filename: 'changed' }), 'first')).toThrow('CONFLICT')
  instance.begin('other', target, metadata(bytes), 'first')
  expect(() => instance.begin('scope', target, metadata(bytes), 'third')).toThrow('CAPACITY')
  expect(instance.begin('scope', target, metadata(bytes), 'first')).toBe(first)
})

it('expires pending and sealed uploads at ten minutes without extending TTL on retries', () => {
  let now = 0
  const instance = store({ now: () => now, maximumCount: 2, maximumBytes: 10 })
  const bytes = Buffer.from('hello')
  const pending = instance.begin('scope', target, metadata(bytes), 'pending')
  const upload = instance.begin('scope', target, metadata(bytes), 'sealed')
  instance.append('scope', upload, 0, bytes.toString('base64'))
  const media = instance.commit('scope', upload)
  now = 599999
  expect(instance.begin('scope', target, metadata(bytes), 'pending')).toBe(pending)
  expect(instance.resolve(media.handle, target, 5)).toHaveLength(5)
  now = 600000
  expect(() => instance.commit('scope', pending)).toThrow('SOURCE_DENIED')
  expect(() => instance.resolve(media.handle, target, 5)).toThrow('SOURCE_DENIED')
  expect(() => instance.begin('scope', target, metadata(bytes), 'fresh')).not.toThrow()
})

it('disposes all capabilities and rejects subsequent operations', () => {
  const instance = store()
  const bytes = Buffer.from('hello')
  const upload = instance.begin('scope', target, metadata(bytes), 'operation')
  instance.append('scope', upload, 0, bytes.toString('base64'))
  const media = instance.commit('scope', upload)
  instance.dispose()
  instance.dispose()
  expect(() => instance.begin('scope', target, metadata(bytes), 'operation')).toThrow('DISPOSED')
  expect(() => instance.append('scope', upload, 0, 'Zg==')).toThrow('DISPOSED')
  expect(() => instance.commit('scope', upload)).toThrow('DISPOSED')
  expect(() => instance.resolve(media.handle, target, 5)).toThrow('DISPOSED')
  expect(() => instance.descriptor('scope', media.handle, target)).toThrow('DISPOSED')
})

it.each([
  { type: 'image' as const, format: 'png' as const, filename: 'image.png' },
  { type: 'image' as const, format: 'jpeg' as const, filename: 'image.jpeg' },
  { type: 'audio' as const, format: 'opus' as const },
  { type: 'video' as const, format: 'mp4' as const, filename: 'clip.mp4' },
  { type: 'file' as const, format: 'pdf' as const, filename: 'report.pdf' },
])('rejects matching hash and size with a false $format signature before sealing', extra => {
  const instance = store({ maximumCount: 1 })
  const bytes = Buffer.alloc(50)
  const upload = instance.begin('scope', target, metadata(bytes, extra), 'bad')
  instance.append('scope', upload, 0, bytes.toString('base64'))
  expect(() => instance.commit('scope', upload)).toThrow('INTEGRITY_INVALID')
  expect(() => instance.commit('scope', upload)).toThrow('SOURCE_DENIED')
  expect(() => instance.begin('scope', target, metadata(bytes), 'next')).not.toThrow()
})
