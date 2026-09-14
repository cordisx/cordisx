import { createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const WALLET_SPEND_MAX_FRAME = 524_288
export function spendCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(spendCanonical).join(',') + ']'
  if (typeof value !== 'object' || !value) throw new Error('invalid JSON')
  return '{'
    + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + spendCanonical((value as Record<string, unknown>)[key])
    ).join(',') + '}'
}
/** Deployment-owned bytes. This function never creates, rotates or logs a credential. */
export function readSpendSecret(file: string): Buffer {
  if (!path.isAbsolute(file)) throw new Error('invalid secret path')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())
    ) throw new Error('unsafe secret file')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function checkSpendSocket(file: string, existing: boolean): void {
  if (!path.isAbsolute(file) || Buffer.byteLength(file) > 100) throw new Error('invalid socket path')
  const parent = path.dirname(file), directory = lstatSync(parent)
  if (
    !directory.isDirectory() || realpathSync(parent) !== parent || (directory.mode & 0o077) !== 0
    || (process.getuid && directory.uid !== process.getuid())
  ) throw new Error('unsafe socket directory')
  if (existing) {
    const stat = lstatSync(file)
    if (
      !stat.isSocket() || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())
    ) throw new Error('unsafe socket')
  }
}
export interface SpendFrame {
  readonly session: string
  readonly sequence: number
  readonly operation: string
  readonly payload: unknown
}
export function encodeSpendFrame(secret: Buffer, frame: SpendFrame): string {
  const bytes = spendCanonical(frame)
  const mac = createHmac('sha256', secret).update('cordisx.wallet-spend-ipc/v1\0' + bytes).digest('hex')
  const encoded = JSON.stringify({ ...frame, mac }) + '\n'
  if (Buffer.byteLength(encoded) > WALLET_SPEND_MAX_FRAME) throw new Error('frame too large')
  return encoded
}
export function decodeSpendFrame(secret: Buffer, line: string): SpendFrame {
  if (Buffer.byteLength(line) > WALLET_SPEND_MAX_FRAME) throw new Error('frame too large')
  const value = JSON.parse(line)
  if (
    !value || Object.keys(value).sort().join(',') !== 'mac,operation,payload,sequence,session'
    || !/^[a-f0-9]{64}$/.test(value.session) || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0 || value.sequence > 16 || typeof value.operation !== 'string'
    || typeof value.mac !== 'string' || !/^[a-f0-9]{64}$/.test(value.mac)
  ) throw new Error('invalid frame')
  const { mac, ...frame } = value
  const expected = createHmac('sha256', secret).update('cordisx.wallet-spend-ipc/v1\0' + spendCanonical(frame)).digest()
  if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw new Error('invalid frame MAC')
  return frame
}
