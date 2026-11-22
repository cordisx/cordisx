import type { CdpSession } from './cdp-session.js'
import { bindDiagnostic } from '../diagnostics/context.js'
import {
  COMPOSER_DIAGNOSTIC_CHANNEL,
  composerDiagnosticPhases,
  composerDiagnosticStates,
} from '../renderer/native-composer-diagnostics.js'

/** Collect only bounded composer timing records into the owning launch journal. */
export function observeComposerDiagnostics(session: Pick<CdpSession, 'onEvent'>): () => void {
  const emit = bindDiagnostic()
  return session.onEvent('Runtime.consoleAPICalled', event => {
    const args = event.args as { value?: unknown }[] | undefined
    if (
      args?.[0]?.value !== COMPOSER_DIAGNOSTIC_CHANNEL || typeof args[1]?.value !== 'string'
      || args[1].value.length > 256
    ) return
    try {
      const value = JSON.parse(args[1].value) as Record<string, unknown>
      if (
        !composerDiagnosticPhases.includes(value.phase as typeof composerDiagnosticPhases[number])
        || !composerDiagnosticStates.includes(value.state as typeof composerDiagnosticStates[number])
        || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs)
        || value.elapsedMs < 0 || value.elapsedMs > 600_000
      ) return
      emit({
        event: 'composer-readiness',
        phase: value.phase as string,
        state: value.state as string,
        elapsedMs: value.elapsedMs,
      })
    } catch { /* Ignore unrelated or invalid console content. */ }
  })
}
