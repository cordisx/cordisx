/** Private Host configuration, not a plugin capability or renderer run payload. */
export type ScriptCommand =
  | { readonly kind: 'exec'; readonly executable: string; readonly args: readonly string[] }
  | { readonly kind: 'shell'; readonly command: string }

export interface ScriptSourceConfig {
  readonly schemaVersion: 1
  readonly command: ScriptCommand
  readonly cwd: string
  readonly environment: {
    readonly inherit: boolean
    readonly refs: Readonly<Record<string, string>>
    readonly values: Readonly<Record<string, string>>
  }
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly maxModels: number
}

export const SCRIPT_EXECUTION_NOTICE =
  'Saving trusts this local command to run with your user permissions, including file and network access. This is not a sandbox. Environment inheritance or references may expose credentials to your script. CordisX does not automatically inject managed Provider keys.'

export type ScriptMode = 'replace' | 'supplement'
export interface ScriptSourceBinding {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly mode: ScriptMode
}

export interface ScriptIntent {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly expectedRevision: number
}

export type ScriptErrorCode =
  | 'script-command-invalid'
  | 'script-output-invalid'
  | 'script-budget-exceeded'
  | 'script-exit-failed'
  | 'script-timeout'
  | 'script-cleanup-failed'
  | 'script-unsupported'
  | 'script-scope-invalid'
  | 'script-environment-missing'
  | 'cancelled'

export class ScriptSourceError extends Error {
  constructor(readonly code: ScriptErrorCode) {
    super(code)
  }
}

export interface ScriptModel {
  readonly id: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly provenance: readonly ('script' | 'script-supplement')[]
}

export interface ScriptSourceSnapshot extends ScriptSourceBinding {
  readonly authorityRevision: string
  readonly revision: number
  readonly runGeneration: number
  readonly models: readonly ScriptModel[]
  readonly complete: boolean
  readonly loading: boolean
  readonly freshness: 'unknown' | 'fresh' | 'stale'
  readonly evidence: 'script-declared'
  readonly persistence: 'session-only'
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly error?: ScriptErrorCode
}

export interface ScriptDiagnostic {
  readonly diagnosticId: string
  readonly outcome: 'ok' | ScriptErrorCode
  readonly durationMs: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
}

export interface ScriptSourceEvent {
  readonly kind: 'changed' | 'removed'
  readonly bindingRef: string
  readonly revision: number
  readonly scopeRevision: string
  readonly authorityRevision: string
  readonly runGeneration: number
}

export type ScriptRunReply = { readonly status: 'started' | 'already-running' | 'busy' }

/** Resolved only at execution time and never returned to the renderer or logs. */
export interface ScriptExecution {
  readonly config: ScriptSourceConfig
  readonly env: Readonly<Record<string, string>>
}
