import { bindDiagnostic, diagnosticRef } from '../diagnostics/context.js'
import { CdpSession, type CdpTarget } from './cdp-session.js'

export interface CdpTargetRetirementObserver {
  confirm(): Promise<void>
  close(): void
}

/** Observe only the first launcher-owned workspace; a disconnected socket alone proves nothing. */
export async function observeCdpTargetRetirement(
  port: number,
  target: CdpTarget,
  renderer: CdpSession,
): Promise<CdpTargetRetirementObserver> {
  const emit = bindDiagnostic()
  const fields = { resourceRef: diagnosticRef(target.id), debugPort: port }
  let browser: CdpSession | undefined
  let destroyed = false
  let crashed = false
  let disposed = false
  const listeners: (() => void)[] = []
  const close = (): void => {
    disposed = true
    for (const remove of listeners.splice(0)) remove()
    browser?.close()
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) throw new Error('Browser target observer endpoint unavailable')
    const value = await response.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('Browser target observer endpoint missing')
    const endpoint = new URL(value.webSocketDebuggerUrl)
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port) {
      throw new Error('Browser target observer endpoint identity changed')
    }
    browser = await CdpSession.connect(endpoint.href)
    listeners.push(browser.onEvent('Target.targetDestroyed', params => {
      if (params.targetId !== target.id) return
      destroyed = true
      emit({ event: 'cdp-browser-target-destroyed', ...fields })
    }))
    listeners.push(browser.onEvent('Target.targetCrashed', params => {
      if (params.targetId !== target.id) return
      crashed = true
      renderer.confirmTargetCrash(target.id)
      emit({ event: 'cdp-browser-target-crashed', ...fields })
    }))
    await browser.send('Target.setDiscoverTargets', { discover: true }, 2_000)
  } catch {
    close()
    emit({ event: 'cdp-target-observer-unavailable', ...fields })
  }
  return {
    close,
    confirm: async () => {
      if (
        disposed || crashed || browser === undefined || browser.isClosed()
        || !renderer.isClosed() || renderer.isTargetClosed() || renderer.isTargetCrashed()
      ) return
      try {
        if (!destroyed) {
          const result = await browser.send('Target.getTargets', {}, 2_000)
          const infos = result.targetInfos as { targetId?: unknown }[] | undefined
          if (!Array.isArray(infos) || infos.some(info => !info || typeof info.targetId !== 'string')) return
          if (infos.some(info => info.targetId === target.id)) return
        }
        if (disposed || crashed || browser.isClosed() || renderer.isTargetCrashed()) return
        renderer.confirmTargetRetirement(target.id)
        emit({
          event: 'cdp-target-retirement-confirmed',
          phase: destroyed ? 'browser-event' : 'browser-target-table',
          ...fields,
        })
      } catch {
        emit({ event: 'cdp-target-retirement-unconfirmed', ...fields })
      }
    },
  }
}
