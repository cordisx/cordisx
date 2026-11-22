import { createHash, randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'

interface Grant {
  source: string
  target: { providerId: string; model: string }
  event?: ChannelEventRef
  mode?: 'linked'
  expires: number
}
const digest = (code: string) => createHash('sha256').update(code).digest('hex')

/** A direct Channel actor approves one Desktop migration, not a lasting identity mapping. */
export class DesktopChannelGrants {
  private readonly pending = new Map<string, Grant>()
  begin(source: string, target: Grant['target']) {
    this.expire()
    if (this.pending.size >= 32) throw new Error('GRANT_LIMIT')
    const code = randomBytes(24).toString('base64url')
    this.pending.set(digest(code), {
      source,
      target: structuredClone(target),
      expires: Date.now() + 300_000,
    })
    return code
  }
  authorize(code: string, source: string, target: Grant['target'], event: ChannelEventRef, mode: 'linked') {
    this.expire()
    if (mode !== 'linked' || !/^[A-Za-z0-9_-]{32}$/u.test(code)) return false
    const grant = this.pending.get(digest(code))
    if (
      !grant || grant.event || grant.source !== source || grant.target.providerId !== target.providerId
      || grant.target.model !== target.model
    ) return false
    grant.event = structuredClone(event)
    grant.mode = mode
    return true
  }
  consume(code: string, source: string, target: Grant['target'], mode: 'linked') {
    this.expire()
    if (mode !== 'linked' || !/^[A-Za-z0-9_-]{32}$/u.test(code)) return undefined
    const key = digest(code), grant = this.pending.get(key)
    if (
      !grant?.event || grant.mode !== mode || grant.source !== source || grant.target.providerId !== target.providerId
      || grant.target.model !== target.model
    ) return undefined
    this.pending.delete(key)
    return structuredClone(grant.event)
  }
  clear() {
    this.pending.clear()
  }
  private expire() {
    const now = Date.now()
    for (const [key, grant] of this.pending) if (grant.expires <= now) this.pending.delete(key)
  }
}
