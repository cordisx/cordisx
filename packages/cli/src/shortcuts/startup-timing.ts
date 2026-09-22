import { randomUUID } from 'node:crypto'
import type { CdpSession } from '../launcher/cdp-session.js'

const phases = [
  'probe-start',
  'editor-observed',
  'model-observed',
  'manager-observed',
  'login-observed',
  'boot-observed',
  'boot-resolved',
  'boot-rejected',
  'account-module-start',
  'account-module-ready',
  'account-read-start',
  'account-read-complete',
] as const
const statuses = ['authenticated', 'signed-out', 'unavailable', 'error', 'unknown']

/** Only finite timing values and fixed phase/status enums leave the renderer. */
export function observeStartupTiming(
  page: Pick<CdpSession, 'onEvent'>,
  hostPid: number,
  log: (value: Record<string, unknown>) => void,
): { source: string; close(): void } {
  const channel = `cordisx-startup-timing-${randomUUID()}`
  const closeConsole = page.onEvent('Runtime.consoleAPICalled', event => {
    const args = event.args as Array<{ value?: unknown }> | undefined
    if (args?.[0]?.value !== channel || typeof args[1]?.value !== 'string' || args[1].value.length > 512) return
    try {
      const value = JSON.parse(args[1].value) as Record<string, unknown>
      if (!phases.includes(value.phase as typeof phases[number])) return
      if (
        typeof value.timeOrigin !== 'number' || !Number.isFinite(value.timeOrigin)
        || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)
      ) return
      log({
        event: 'readiness-phase',
        hostPid,
        at: Date.now(),
        phase: value.phase,
        documentTimeOrigin: value.timeOrigin,
        observedAt: value.observedAt,
        ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
          ? { durationMs: value.durationMs }
          : {}),
        ...(statuses.includes(value.status as string) ? { status: value.status } : {}),
      })
    } catch { /* Diagnostics must not affect readiness. */ }
  })
  const closeNavigation = page.onEvent('Page.frameNavigated', event => {
    const frame = event.frame as { parentId?: string; url?: string } | undefined
    if (frame?.parentId === undefined && frame?.url === 'app://-/index.html') {
      try {
        log({ event: 'primary-document-navigation', hostPid, at: Date.now() })
      } catch { /* Diagnostic only. */ }
    }
  })
  return {
    source: `(phase, details = {}) => {
      try {
      if (!${JSON.stringify(phases)}.includes(phase)) return;
      const status = ${JSON.stringify(statuses)}.includes(details.status) ? details.status : undefined;
      const key = ${JSON.stringify(channel)};
      const seen = globalThis[key] ??= new Set();
      const transition = phase + ':' + (status ?? '');
      if (seen.has(transition)) return;
      seen.add(transition);
      console.debug(key, JSON.stringify({ phase, timeOrigin: performance.timeOrigin,
        observedAt: performance.timeOrigin + performance.now(),
        durationMs: typeof details.durationMs === 'number' && Number.isFinite(details.durationMs)
          && details.durationMs >= 0 ? details.durationMs : undefined, status }));
      } catch {}
    }`,
    close() {
      closeConsole()
      closeNavigation()
    },
  }
}
