import type { CdpTarget } from './cdp-session.js'

type InstalledTarget = Readonly<{ target: CdpTarget; session: { isClosed(): boolean } }>

/** Hold an already-owned target briefly while Chromium reports an empty reload URL. */
export class NativeTargetNavigationGrace {
  private readonly since = new Map<string, number>()

  constructor(private readonly limitMs = 15_000) {}

  retain(
    targets: readonly CdpTarget[],
    installed: ReadonlyMap<string, InstalledTarget>,
    now = performance.now(),
  ): ReadonlySet<string> {
    const transitional = new Set<string>()
    for (const target of targets) {
      const previous = installed.get(target.id)
      if (
        !previous || previous.session.isClosed() || target.type !== 'page'
        || !(previous.target.url === 'app://-' || previous.target.url.startsWith('app://-/'))
        || target.url !== '' && target.url !== 'about:blank'
        || target.webSocketDebuggerUrl !== previous.target.webSocketDebuggerUrl
      ) continue
      const start = this.since.get(target.id) ?? now
      this.since.set(target.id, start)
      if (now - start < this.limitMs) transitional.add(target.id)
    }
    const present = new Set(targets.filter(target => target.url === '' || target.url === 'about:blank').map(t => t.id))
    for (const id of this.since.keys()) if (!present.has(id)) this.since.delete(id)
    return transitional
  }
}
