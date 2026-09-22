import { CdpSession, type CdpTarget } from './cdp-session.js'

const VITE_LOOPBACK_PERMISSIONS = ['loopback-network', 'local-network-access'] as const

function targetOrigin(target: CdpTarget): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/iu.exec(target.url)
  if (match === null) throw new Error(`target ${target.id} has no permission origin`)
  return match[0]
}

export async function enableViteLoopbackPermission(
  session: CdpSession,
  target: CdpTarget,
): Promise<{ readonly name: string; readonly origin: string } | undefined> {
  const origin = targetOrigin(target)
  const failures: string[] = []
  for (const name of VITE_LOOPBACK_PERMISSIONS) {
    try {
      await session.send('Browser.setPermission', {
        permission: { name },
        setting: 'granted',
        origin,
        embeddedOrigin: origin,
      })
      return { name, origin }
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const version: Record<string, unknown> = await session.send('Browser.getVersion').catch(() => ({}))
  const product = typeof version.product === 'string' ? version.product : ''
  const major = Number(/\/(\d+)/u.exec(product)?.[1])
  if (Number.isFinite(major) && major < 142) return undefined
  throw new Error(`CordisX could not grant renderer loopback access (${failures.join('; ')})`)
}

export async function restoreViteLoopbackPermission(
  session: CdpSession,
  permission: { readonly name: string; readonly origin: string } | undefined,
): Promise<void> {
  if (permission === undefined) return
  await session.send('Browser.setPermission', {
    permission: { name: permission.name },
    setting: 'prompt',
    origin: permission.origin,
    embeddedOrigin: permission.origin,
  })
}

async function connectBrowserCdpSession(port: number): Promise<CdpSession> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP browser version returned HTTP ${response.status}`)
  const value = await response.json() as { readonly webSocketDebuggerUrl?: unknown }
  if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('CDP browser endpoint is unavailable')
  return await CdpSession.connect(value.webSocketDebuggerUrl)
}

type LoopbackPermission = { readonly name: string; readonly origin: string }

/** Own grants and per-acquisition leases; serialize CDP writes against acquisition and cleanup retries. */
export class ViteLoopbackPermissionCoordinator {
  readonly #origins = new Map<string, {
    readonly permission: LoopbackPermission
    readonly leases: Set<LoopbackPermission>
  }>()
  #pending: Promise<void> = Promise.resolve()

  constructor(private readonly port: number) {}

  private exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#pending.then(operation)
    this.#pending = result.then(() => undefined, () => undefined)
    return result
  }

  async acquire(
    session: CdpSession,
    target: CdpTarget,
  ): Promise<{ readonly name: string; readonly origin: string } | undefined> {
    return await this.exclusive(async () => {
      const origin = targetOrigin(target)
      const current = this.#origins.get(origin)
      if (current !== undefined) {
        const lease = { ...current.permission }
        current.leases.add(lease)
        return lease
      }
      const permission = await enableViteLoopbackPermission(session, target)
      if (permission !== undefined) this.#origins.set(origin, { permission, leases: new Set([permission]) })
      return permission
    })
  }

  async release(
    session: CdpSession,
    permission: { readonly name: string; readonly origin: string } | undefined,
  ): Promise<void> {
    await this.exclusive(async () => {
      if (permission === undefined) return
      const current = this.#origins.get(permission.origin)
      if (current === undefined) return
      // Retrying a failed release must not consume a subsequently acquired renderer's lease.
      current.leases.delete(permission)
      if (current.leases.size > 0) return
      try {
        await restoreViteLoopbackPermission(session, current.permission)
      } catch (targetError) {
        let browser: CdpSession | undefined
        try {
          browser = await connectBrowserCdpSession(this.port)
          await restoreViteLoopbackPermission(browser, current.permission)
        } catch (browserError) {
          // An empty lease set still owns the grant until restoration succeeds.
          throw new AggregateError(
            [targetError, browserError],
            `CordisX could not restore Vite loopback permission for ${permission.origin}`,
          )
        } finally {
          browser?.close()
        }
      }
      this.#origins.delete(permission.origin)
    })
  }
}
