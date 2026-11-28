import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'

// The private owner RPC already accepts 64 hex characters. A tagged ID lets a
// newer owner expire replay tombstones while remaining usable with older owners.
const marker = 'c0d157a9e1'
const timestampLength = 9
const bodyLength = 32
const maxTimestamp = 0xfffffffff
const maxOpenAgeSeconds = 8 * 60 * 60
const futureSkewSeconds = 60
const legacyLimit = 4096
const timedLimit = 65_536
const idPattern = /^[a-f0-9]{64}$/u

function signature(gateway: ManagerRendererGatewayProof, body: string): string | undefined {
  if (
    !gateway || !Number.isSafeInteger(gateway.pid) || gateway.pid <= 0
    || typeof gateway.processStartedAt !== 'string' || gateway.processStartedAt.length === 0
    || gateway.processStartedAt.length > 256 || typeof gateway.instanceToken !== 'string'
    || !/^[a-f0-9]{64}$/u.test(gateway.instanceToken)
  ) return undefined
  return createHmac('sha256', Buffer.from(gateway.instanceToken, 'hex'))
    .update(JSON.stringify([gateway.pid, gateway.processStartedAt, body]))
    .digest('hex').slice(0, 32)
}

function timestamp(now: number): number {
  const seconds = Math.floor(now / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxTimestamp) {
    throw new Error('manager-session-clock-unavailable')
  }
  return seconds
}

/** Issue private, gateway-bound session IDs; browser bearer tokens stay separate. */
export function createManagerBrowserSessionIdIssuer(gateway: ManagerRendererGatewayProof | undefined, now = Date.now) {
  const identity = gateway === undefined ? undefined : { ...gateway }
  let previous = 0
  return (): string => {
    if (identity === undefined) return randomBytes(32).toString('hex')
    const issued = Math.max(previous, timestamp(now()))
    previous = issued
    const body = marker + issued.toString(16).padStart(timestampLength, '0')
      + randomBytes(7).toString('hex').slice(0, 13)
    const mac = signature(identity, body)
    if (!mac) throw new Error('manager-session-gateway-unavailable')
    return body + mac
  }
}

type Parsed =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'timed'; readonly issued: number; readonly expires: number }

function parse(gateway: ManagerRendererGatewayProof, id: string): Parsed {
  if (!idPattern.test(id)) return { kind: 'invalid' }
  if (!id.startsWith(marker)) return { kind: 'legacy' }
  const body = id.slice(0, bodyLength)
  const mac = signature(gateway, body)
  if (!mac || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(id.slice(bodyLength), 'hex'))) {
    return { kind: 'invalid' }
  }
  const issued = Number.parseInt(id.slice(marker.length, marker.length + timestampLength), 16)
  if (!Number.isSafeInteger(issued) || issued < 1) return { kind: 'invalid' }
  return { kind: 'timed', issued, expires: issued + maxOpenAgeSeconds }
}

/** Bound replay memory without letting a late open outlive its revocation. */
export class ManagerBrowserSessionTombstones {
  private readonly legacy = new Set<string>()
  private readonly timed = new Map<string, number>()
  private readonly expirations = new Map<number, Set<string>>()
  private highWater = 0
  private blockedUntil = 0

  constructor(private readonly now = Date.now, private readonly limit = timedLimit) {}

  private currentTime(): number {
    // Once an ID has expired, a backwards wall-clock adjustment must not make
    // it usable again after its tombstone has been removed.
    this.highWater = Math.max(this.highWater, timestamp(this.now()))
    for (const [expires, ids] of this.expirations) {
      if (expires > this.highWater) continue
      for (const id of ids) this.timed.delete(id)
      this.expirations.delete(expires)
    }
    return this.highWater
  }

  private remember(id: string, expires: number): void {
    this.timed.set(id, expires)
    // A minute bucket keeps cleanup bounded even for a busy long-lived owner.
    const bucket = Math.ceil(expires / 60) * 60
    let ids = this.expirations.get(bucket)
    if (!ids) this.expirations.set(bucket, ids = new Set())
    ids.add(id)
  }

  canOpen(gateway: ManagerRendererGatewayProof, id: string): boolean {
    const value = parse(gateway, id)
    if (value.kind === 'invalid') return false
    if (value.kind === 'legacy') return !this.legacy.has(id) && this.legacy.size < legacyLimit
    const now = this.currentTime()
    return now >= this.blockedUntil && value.issued <= now + futureSkewSeconds && value.expires > now
      && !this.timed.has(id) && this.timed.size < this.limit
  }

  /** Called synchronously after the last admission check. */
  consume(gateway: ManagerRendererGatewayProof, id: string): boolean {
    if (!this.canOpen(gateway, id)) return false
    const value = parse(gateway, id)
    if (value.kind === 'legacy') this.legacy.add(id)
    else if (value.kind === 'timed') this.remember(id, value.expires)
    else return false
    return true
  }

  /** Revocation can precede open; failed capacity must also fence delayed opens. */
  revoke(gateway: ManagerRendererGatewayProof, id: string): boolean {
    const value = parse(gateway, id)
    if (value.kind === 'invalid') return false
    if (value.kind === 'legacy') {
      if (!this.legacy.has(id) && this.legacy.size >= legacyLimit) return false
      this.legacy.add(id)
      return true
    }
    const now = this.currentTime()
    if (value.expires <= now || this.timed.has(id)) return true
    if (this.timed.size >= this.limit) {
      this.blockedUntil = Math.max(this.blockedUntil, value.expires)
      return false
    }
    this.remember(id, value.expires)
    return true
  }

  isTimed(gateway: ManagerRendererGatewayProof, id: string): boolean {
    return parse(gateway, id).kind === 'timed'
  }
}
