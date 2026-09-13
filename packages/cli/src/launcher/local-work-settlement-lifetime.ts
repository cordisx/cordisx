import type { PluginHttpClientLifetime } from './plugin-http-client-lifetime.js'
import type { LocalWalletHttpResultV4 } from '@cordisx/protocol/plugin-http/v4'
interface Attempt {
  readonly deadline: number
  active: boolean
  cancelled: boolean
}
/** Private per-attempt cancellation; retiring work never retires a balance connection. */
export class LocalWorkSettlementLifetimes {
  private readonly attempts = new Map<string, Attempt>()
  private key(client: PluginHttpClientLifetime, id: unknown) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(id)) throw new Error('invalid settlement attempt')
    return JSON.stringify([client.key, id])
  }
  private prune() {
    for (const [key, attempt] of this.attempts) if (attempt.deadline <= Date.now()) this.attempts.delete(key)
  }
  cancel(client: PluginHttpClientLifetime, id: unknown) {
    const key = this.key(client, id)
    this.prune()
    const attempt = this.attempts.get(key)
    if (attempt) {
      attempt.active = false
      attempt.cancelled = true
    } else {
      if (this.attempts.size >= 4096) throw new Error('settlement attempt limit')
      // A cancellation may reach Launcher before the original bridge request.
      this.attempts.set(key, { deadline: Date.now() + 15_000, active: false, cancelled: true })
    }
  }
  publicationLive(client: PluginHttpClientLifetime, id: unknown) {
    const attempt = this.attempts.get(this.key(client, id))
    return !!attempt && !attempt.cancelled && client.active && Date.now() < attempt.deadline
  }
  async run(
    client: PluginHttpClientLifetime,
    id: unknown,
    deadline: number,
    execute: (live: () => boolean) => Promise<LocalWalletHttpResultV4<unknown>>,
  ): Promise<LocalWalletHttpResultV4<unknown>> {
    const key = this.key(client, id)
    if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 15_000) {
      throw new Error('invalid settlement deadline')
    }
    if (deadline <= Date.now()) return { status: 'unavailable', code: 'deadline-exceeded' }
    this.prune()
    const old = this.attempts.get(key)
    if (old) return { status: 'unavailable', code: 'aborted' }
    if (this.attempts.size >= 4096) throw new Error('settlement attempt limit')
    const attempt = { deadline, active: true, cancelled: false }
    this.attempts.set(key, attempt)
    const live = () => attempt.active && client.active && Date.now() < deadline
    try {
      const result = await execute(live)
      return live() ? result : { status: 'unavailable', code: 'aborted' }
    } finally {
      // Preserve retirement until its original deadline; reuse never revives it.
      attempt.active = false
    }
  }
}
