import { createHash, timingSafeEqual } from 'node:crypto'
import { brotliCompress, brotliDecompress, constants } from 'node:zlib'

/** Management RPC currently limits its complete UTF-8 response to 8 MiB. */
export const MANAGER_BUNDLE_RPC_LIMIT = 8 * 1024 * 1024
/** Reserve room for the owner's authenticated RPC/result envelopes. */
export const MANAGER_BUNDLE_ENVELOPE_LIMIT = MANAGER_BUNDLE_RPC_LIMIT - 64 * 1024
/** Matches the standalone resource worker's largest supported response. */
export const MANAGER_BUNDLE_OUTPUT_LIMIT = 64 * 1024 * 1024

export interface ManagerRendererBundleEnvelope {
  readonly contract: 'cordisx.manager-renderer-bundle/v1'
  readonly encoding: 'brotli-base64'
  readonly byteLength: number
  readonly sha256: string
  readonly payload: string
}

function invalid(): Error {
  return new Error('MANAGER_BUNDLE_INVALID')
}

function tooLarge(): Error {
  return new Error('MANAGER_BUNDLE_TOO_LARGE')
}

function integrity(): Error {
  return new Error('MANAGER_BUNDLE_INTEGRITY')
}

async function compress(input: Buffer): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    brotliCompress(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

async function decompress(input: Buffer, limit: number): Promise<{ bytes: Buffer; consumed: number }> {
  return await new Promise((resolve, reject) => {
    brotliDecompress(input, { maxOutputLength: Math.max(1, limit), info: true }, (error, result) => {
      if (error) return reject(error)
      // Node's info option returns both the decompressed buffer and the stream
      // engine; the Node declaration still types this overload as just Buffer.
      const info = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      resolve({ bytes: info.buffer, consumed: info.engine.bytesWritten })
    })
  })
}

/** Encode only an owner-selected renderer bundle; never log or persist it. */
export async function encodeManagerRendererBundle(input: Uint8Array): Promise<ManagerRendererBundleEnvelope> {
  if (!(input instanceof Uint8Array)) throw invalid()
  if (input.byteLength > MANAGER_BUNDLE_OUTPUT_LIMIT) throw tooLarge()
  // Snapshot the caller's mutable bytes before asynchronous compression.
  const bytes = Buffer.from(input)
  let compressed: Buffer | undefined
  try {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    compressed = await compress(bytes)
    const envelope: ManagerRendererBundleEnvelope = {
      contract: 'cordisx.manager-renderer-bundle/v1',
      encoding: 'brotli-base64',
      byteLength: bytes.byteLength,
      sha256,
      payload: compressed.toString('base64'),
    }
    if (Buffer.byteLength(JSON.stringify(envelope)) > MANAGER_BUNDLE_ENVELOPE_LIMIT) throw tooLarge()
    return Object.freeze(envelope)
  } finally {
    bytes.fill(0)
    compressed?.fill(0)
  }
}

/**
 * Decode a private owner response into bounded bytes. Call only after checking
 * renderer session/generation; a checksum is not sender authentication. The
 * caller owns both returned buffers and must clear them on session retirement.
 */
export async function decodeManagerRendererBundleForTransport(
  value: unknown,
): Promise<{ readonly bundle: Buffer; readonly brotli: Buffer }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const envelope = value as Record<string, unknown>
  const { contract, encoding, byteLength, sha256, payload } = envelope
  if (
    Object.keys(envelope).length !== 5
    || Object.keys(envelope).some(key => !['contract', 'encoding', 'byteLength', 'sha256', 'payload'].includes(key))
    || contract !== 'cordisx.manager-renderer-bundle/v1' || encoding !== 'brotli-base64'
    || !Number.isSafeInteger(byteLength) || (byteLength as number) < 0
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
    || typeof payload !== 'string'
  ) throw invalid()
  if ((byteLength as number) > MANAGER_BUNDLE_OUTPUT_LIMIT) throw tooLarge()
  if (payload.length > MANAGER_BUNDLE_ENVELOPE_LIMIT) throw tooLarge()
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) throw invalid()
  if (
    Buffer.byteLength(JSON.stringify({ contract, encoding, byteLength, sha256, payload }))
      > MANAGER_BUNDLE_ENVELOPE_LIMIT
  ) {
    throw tooLarge()
  }
  const compressed = Buffer.from(payload, 'base64')
  if (compressed.toString('base64') !== payload) {
    compressed.fill(0)
    throw invalid()
  }
  let decoded: Buffer | undefined
  try {
    const result = await decompress(compressed, byteLength as number)
    decoded = result.bytes
    if (result.consumed !== compressed.byteLength || decoded.byteLength !== byteLength) throw integrity()
    const actual = createHash('sha256').update(decoded).digest()
    if (!timingSafeEqual(actual, Buffer.from(sha256, 'hex'))) throw integrity()
    return { bundle: decoded, brotli: compressed }
  } catch {
    decoded?.fill(0)
    compressed.fill(0)
    throw integrity()
  }
}

/** Decode without retaining a transport copy of the compressed bytes. */
export async function decodeManagerRendererBundle(value: unknown): Promise<Buffer> {
  const decoded = await decodeManagerRendererBundleForTransport(value)
  decoded.brotli.fill(0)
  return decoded.bundle
}
