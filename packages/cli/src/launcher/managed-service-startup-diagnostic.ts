export interface ManagedServiceStartupDiagnostic {
  readonly pluginId: string
  readonly serviceId: string
  readonly reason: 'startup-timeout' | 'process-exited' | 'spawn-error' | 'preparation-failed' | 'activation-failed'
  readonly elapsedMs?: number
  readonly timeoutMs?: number
  readonly exitCode?: number
  readonly signal?: string
}

export class ManagedServiceStartupError extends Error {
  constructor(readonly detail: Omit<ManagedServiceStartupDiagnostic, 'pluginId' | 'serviceId'>) {
    super(`managed service ${detail.reason}`)
  }
}

export function diagnoseManagedServiceStartup(
  identity: Pick<ManagedServiceStartupDiagnostic, 'pluginId' | 'serviceId'>,
  error: unknown,
  report = reportManagedServiceStartup,
): void {
  try {
    report({
      ...identity,
      ...(error instanceof ManagedServiceStartupError ? error.detail : { reason: 'preparation-failed' as const }),
    })
  } catch {
    // Diagnostic sinks must not bypass process cleanup or state revocation.
  }
}

// Do not serialize child output, Error messages, arguments, paths or environment.
export function reportManagedServiceStartup(diagnostic: ManagedServiceStartupDiagnostic): void {
  try {
    process.stderr.write(`[cordisx-managed-service] ${JSON.stringify(diagnostic)}\n`)
  } catch {
    // Logging is best effort, including when the launcher output has closed.
  }
}
