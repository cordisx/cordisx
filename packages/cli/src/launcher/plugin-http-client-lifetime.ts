import { PluginHttpInvalidRequestError } from './plugin-http-diagnostics.js'
export interface PluginHttpClientLifetime {
  readonly key: string
  readonly owner: string
  active: boolean
  epoch: number
  reportedUnavailable: boolean
  readonly reportedInvalidReasons: Set<string>
  readonly reportedNativeReasons: Set<string>
}

/** Transport lifetimes do not change canonical plugin or persistent session ownership. */
export class PluginHttpClientLifetimes {
  private readonly clients = new Map<string, PluginHttpClientLifetime>()

  open(owner: string, id: unknown): PluginHttpClientLifetime {
    if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(id))) {
      throw new PluginHttpInvalidRequestError('client-id-invalid')
    }
    const key = JSON.stringify([owner, id ?? null])
    let client = this.clients.get(key)
    // Older private bridge callers had one implicit lifetime and could reconnect after logout.
    if (client === undefined || (id === undefined && !client.active)) {
      if (client === undefined && this.clients.size >= 4096) throw new PluginHttpInvalidRequestError('client-limit')
      client = {
        key,
        owner,
        active: true,
        epoch: 0,
        reportedUnavailable: false,
        reportedInvalidReasons: new Set(),
        reportedNativeReasons: new Set(),
      }
      this.clients.set(key, client)
    }
    return client
  }

  find(owner: string, id: unknown): PluginHttpClientLifetime | undefined {
    return this.clients.get(JSON.stringify([owner, id ?? null]))
  }

  hasSibling(client: PluginHttpClientLifetime): boolean {
    return [...this.clients.values()].some(value => value !== client && value.active && value.owner === client.owner)
  }

  close(client: PluginHttpClientLifetime): void {
    client.active = false
    client.epoch++
  }
}
