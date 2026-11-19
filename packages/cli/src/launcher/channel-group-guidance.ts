import { createHash } from 'node:crypto'
import { mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelTenantRef } from '@cordisx/channel-runtime'

/** Atomic, content-free reservations shared by launches using one profile directory. */
export class ChannelGroupGuidance {
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  async reserve(account: ChannelTenantRef, conversationId: string): Promise<boolean> {
    if (!conversationId || conversationId.length > 512 || /[\u0000-\u0020\u007f]/u.test(conversationId)) return false
    const day = Math.floor(this.now() / 86_400_000)
    if (!Number.isSafeInteger(day) || day < 0) return false
    const hash = createHash('sha256')
      .update(JSON.stringify([account.adapterId, account.accountId, account.tenantId, conversationId])).digest('hex')
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const entries = await readdir(this.directory)
      for (const entry of entries) {
        const match = /^[a-f0-9]{64}-(\d+)$/u.exec(entry)
        if (match && Number(match[1]) < day) await unlink(path.join(this.directory, entry)).catch(() => undefined)
      }
      if (entries.length >= 8192) return false
      // Reserving both UTC day buckets ensures no second send within 24 hours,
      // including across midnight, concurrent local processes and restarts.
      // An incomplete reservation fails closed and may suppress a future hint.
      for (const bucket of [day, day + 1]) {
        const handle = await open(path.join(this.directory, `${hash}-${bucket}`), 'wx', 0o600)
        await handle.close()
      }
      return true
    } catch {
      return false
    }
  }
}
