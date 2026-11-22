/** Fixed enums and timing only: never log request parameters or response contents. */
export const COMPOSER_DIAGNOSTIC_CHANNEL = 'cordisx-composer-timing-v1'
export const composerDiagnosticPhases = [
  'thread/read',
  'config/read',
  'model/list',
  'selection/read',
  'refresh',
  'control',
  'permissions',
  'permissions/menu',
] as const
export const composerDiagnosticStates = [
  'ready',
  'failed',
  'timeout',
  'disposed',
  'pending',
  'cached',
  'stale',
] as const

export function logComposerTiming(
  phase: typeof composerDiagnosticPhases[number],
  state: typeof composerDiagnosticStates[number],
  startedAt = performance.now(),
): void {
  try {
    console.debug(
      COMPOSER_DIAGNOSTIC_CHANNEL,
      JSON.stringify({
        phase,
        state,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }),
    )
  } catch { /* Diagnostics never affect composer readiness. */ }
}
