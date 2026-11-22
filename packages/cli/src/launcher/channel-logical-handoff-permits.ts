import { randomBytes } from 'node:crypto'

/** A one-write association for a Channel checkpoint; it grants no Channel operations. */
export class ChannelLogicalHandoffPermits {
  private readonly pending = new Map<string, { threadId: string; marker: string; used: boolean }>()

  issue(jobId: string, threadId: string): string | undefined {
    if (!jobId || !threadId || this.pending.has(jobId) || this.pending.size >= 128) return undefined
    const marker = `CordisX handoff delivery marker: ${randomBytes(24).toString('hex')}`
    this.pending.set(jobId, { threadId, marker, used: false })
    return marker
  }

  peek(jobId: string, threadId: string): string | undefined {
    const permit = this.pending.get(jobId)
    return permit && !permit.used && permit.threadId === threadId ? permit.marker : undefined
  }

  consume(jobId: string, threadId: string, marker: string): boolean {
    const permit = this.pending.get(jobId)
    if (!permit || permit.used || permit.threadId !== threadId || permit.marker !== marker) return false
    permit.used = true
    return true
  }

  release(jobId: string): void {
    this.pending.delete(jobId)
  }
}
