import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  decodeManagerRendererBundle,
  encodeManagerRendererBundle,
  MANAGER_BUNDLE_ENVELOPE_LIMIT,
  MANAGER_BUNDLE_OUTPUT_LIMIT,
  MANAGER_BUNDLE_RPC_LIMIT,
} from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'

it('round trips bounded bytes and fits the actual management RPC envelope', async () => {
  for (const input of [Buffer.from(''), Buffer.from('fixture bundle\n'.repeat(10_000))]) {
    const envelope = await encodeManagerRendererBundle(input)
    expect(envelope.contract).toBe('cordisx.manager-renderer-bundle/v1')
    const wrapped = `${
      JSON.stringify({ requestId: 'x'.repeat(128), ok: true, value: { status: 'ok', value: envelope } })
    }\n`
    expect(Buffer.byteLength(wrapped)).toBeLessThanOrEqual(MANAGER_BUNDLE_RPC_LIMIT)
    expect(Buffer.compare(await decodeManagerRendererBundle(envelope), input)).toBe(0)
  }
})

it('rejects malformed, noncanonical, oversized, and unrecognized envelopes', async () => {
  const envelope = await encodeManagerRendererBundle(Buffer.from('fixture'))
  const invalid: unknown[] = [
    null,
    { ...envelope, unknown: 'not-accepted' },
    { ...envelope, contract: 'other' },
    { ...envelope, encoding: 'gzip-base64' },
    { ...envelope, byteLength: -1 },
    { ...envelope, sha256: 'z'.repeat(64) },
    { ...envelope, payload: 'not base64!' },
    { ...envelope, payload: 'AB==' },
  ]
  for (const candidate of invalid) {
    await expect(decodeManagerRendererBundle(candidate)).rejects.toThrow('MANAGER_BUNDLE_INVALID')
  }
  await expect(decodeManagerRendererBundle({ ...envelope, byteLength: MANAGER_BUNDLE_OUTPUT_LIMIT + 1 }))
    .rejects.toThrow('MANAGER_BUNDLE_TOO_LARGE')
  await expect(decodeManagerRendererBundle({ ...envelope, payload: 'A'.repeat(MANAGER_BUNDLE_ENVELOPE_LIMIT + 4) }))
    .rejects.toThrow('MANAGER_BUNDLE_TOO_LARGE')
  // Even base64 that fits alone must leave room for the full JSON envelope.
  await expect(decodeManagerRendererBundle({ ...envelope, payload: 'A'.repeat(MANAGER_BUNDLE_ENVELOPE_LIMIT) }))
    .rejects.toThrow('MANAGER_BUNDLE_TOO_LARGE')
  await expect(encodeManagerRendererBundle(Buffer.alloc(MANAGER_BUNDLE_OUTPUT_LIMIT + 1)))
    .rejects.toThrow('MANAGER_BUNDLE_TOO_LARGE')
})

it('snapshots mutable caller bytes before compression without modifying the input', async () => {
  const input = Buffer.from('expected')
  const pending = encodeManagerRendererBundle(input)
  input.fill(0)
  expect((await decodeManagerRendererBundle(await pending)).toString()).toBe('expected')
  const second = Buffer.from('unchanged')
  await encodeManagerRendererBundle(second)
  expect(second.toString()).toBe('unchanged')
})

it('rejects corrupt, truncated, concatenated, digest-mismatched, and expanding data', async () => {
  const envelope = await encodeManagerRendererBundle(Buffer.from('fixture output '.repeat(10_000)))
  const compressed = Buffer.from(envelope.payload, 'base64')
  const changed = Buffer.from(compressed)
  changed[Math.floor(changed.length / 2)]! ^= 0x80
  const invalid = [
    { ...envelope, payload: changed.toString('base64') },
    { ...envelope, payload: compressed.subarray(0, compressed.length - 1).toString('base64') },
    { ...envelope, payload: Buffer.concat([compressed, Buffer.from([0x00, 0xff])]).toString('base64') },
    { ...envelope, sha256: '0'.repeat(64) },
    { ...envelope, byteLength: 1 },
  ]
  for (const candidate of invalid) {
    await expect(decodeManagerRendererBundle(candidate)).rejects.toThrow('MANAGER_BUNDLE_INTEGRITY')
  }
})

it('fails closed when a valid bundle cannot fit in the management response', async () => {
  const input = randomBytes(6_300_000)
  await expect(encodeManagerRendererBundle(input)).rejects.toThrow('MANAGER_BUNDLE_TOO_LARGE')
}, 30_000)
