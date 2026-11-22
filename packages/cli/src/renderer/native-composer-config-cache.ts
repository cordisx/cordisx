import type { NativeMcpBridge } from './native-mcp-request-client.js'
import { record, sameSnapshot } from './native-model-provider-state.js'
import { logComposerTiming } from './native-composer-diagnostics.js'

type Config = Record<string, unknown>
interface ConfigRead {
  readonly config: Promise<Config>
  readonly refreshed?: Promise<Config | undefined>
}

/** Share native defaults across composers in one bridge/Host; selection and submission keep live authority. */
export class NativeComposerConfigCache {
  private revision = 0
  private lastGood: Config | undefined
  private pending: { readonly revision: number; readonly result: Promise<Config> } | undefined

  invalidate(): void {
    this.revision++
    this.lastGood = undefined
  }

  read(request: () => Promise<unknown>, optimistic = false): ConfigRead {
    const cached = optimistic ? this.lastGood : undefined
    const revision = this.revision
    let pending = this.pending
    if (pending?.revision !== revision) {
      const result = Promise.resolve().then(request).then(response => {
        const config = record(record(response)?.config)
        if (!config) throw new Error('Native composer configuration unavailable')
        if (revision === this.revision) this.lastGood = config
        return config
      }).finally(() => {
        if (this.pending?.result === result) this.pending = undefined
      })
      pending = this.pending = { revision, result }
    }
    if (!cached) return { config: pending.result }
    logComposerTiming('config/read', 'cached')
    return { config: Promise.resolve(cached), refreshed: pending.result.catch(() => undefined) }
  }
}

const caches = new WeakMap<Required<NativeMcpBridge>, Map<string, NativeComposerConfigCache>>()
export function nativeComposerConfigCache(
  bridge: Required<NativeMcpBridge>,
  hostId: string,
): NativeComposerConfigCache {
  let hosts = caches.get(bridge)
  if (!hosts) caches.set(bridge, hosts = new Map())
  let cache = hosts.get(hostId)
  if (!cache) hosts.set(hostId, cache = new NativeComposerConfigCache())
  return cache
}

/** A fresh read may enrich the same confirmed tuple only while its original refresh remains current. */
export function reconcileNativeComposerConfig(
  refreshed: Promise<Config | undefined> | undefined,
  baseline: Config,
  current: () => boolean,
  reconcile: (config: Config) => Promise<void>,
): void {
  void refreshed?.then(config => {
    if (config && current() && !sameSnapshot(config, baseline)) return reconcile(config)
  })
}
